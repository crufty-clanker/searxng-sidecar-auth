# Architecture: SearXNG Sidecar with SSO-Driven Engine Authentication

## 1. Problem Statement

SearXNG is a metasearch engine that aggregates results from external search engines. Many engines (e.g., Netbox, internal APIs, proprietary search services) require per-user authentication — typically API tokens or session cookies.

**Constraints:**
- Unauthenticated search on the SearXNG instance is disabled (all users must log in).
- The IdP is Authentik, used by both the sidecar and target applications (e.g., Netbox).
- The sidecar must **never handle user passwords**.
- The goal: a user logs into SearXNG via Authentik SSO and can then search Netbox as if they were directly logged into Netbox.

## 2. Why This Is Non-Trivial

SearXNG engines are Python modules that make HTTP requests to downstream services. Each engine's `request()` function builds a URL with optional `headers`, `cookies`, and `api_key` parameters. There is **no built-in per-user authentication mechanism** in SearXNG engines — the `api_key` is a global, instance-wide setting.

Netbox's authentication landscape adds further complexity:
- **Web UI** uses SSO (OIDC via python-social-auth, compatible with Authentik).
- **REST API** uses token-based authentication (`Authorization: Token <uuid>`).
- The web UI calls the API from the browser, so the browser needs either a valid session cookie or an API token.
- API tokens are created via `POST /api/users/<id>/tokens/`, which requires an authenticated Netbox session.

This creates a chicken-and-egg problem: to get API access, you need a session; to get a session, you need to authenticate.

## 3. Architecture Overview

```
┌─────────────┐     ┌──────────────────────────────────────┐     ┌──────────┐
│   Browser    │────▶│          Auth Sidecar                 │────▶│  SearXNG │
│             │     │                                      │     │          │
│ search.example.com │  • OIDC login (Authentik)            │     │  :8888   │
│             │     │  • Per-user per-engine session cache  │     │          │
└─────────────┘     │  • SSO relay for authenticated engines│     └──────────┘
                    │  • Request interception & key injection│          ▲
                    └──────────────────────────────────────┘          │
                                  │                                   │
                    ┌─────────────┼─────────────┐                     │
                    ▼             ▼             ▼                     │
              ┌────────────┐ ┌──────────┐ ┌──────────┐                │
              │ Authentik  │ │  Netbox   │ │  Other   │                │
              │    IdP     │ │  (SSO +   │ │ Engines  │                │
              │            │ │  Token)   │ │          │                │
              └────────────┘ └──────────┘ └──────────┘                │
                                                                       │
                                                              (direct engine HTTP)
```

### Core Design Principles

1. **The sidecar is the authentication boundary.** It terminates SSO and manages per-user sessions with downstream engines.
2. **Passwords never touch the sidecar.** The sidecar only receives OIDC tokens from the IdP and session cookies/tokens from downstream engines.
3. **Engine auth is session-based, not credential-based.** The sidecar performs SSO flows to obtain engine sessions, then reuses those sessions for API calls.
4. **SearXNG is untouched.** No modifications to SearXNG source code. The sidecar operates as a transparent reverse proxy.

## 4. Component Breakdown

### 4.1 Sidecar — Authentication Layer

**Responsibilities:**
- Terminate OIDC login (Authentik as IdP).
- Maintain per-user sessions.
- Provide a user-facing login/logout UX.

**Flow:**
```
Browser → Sidecar (/login) → Authentik (OIDC Authorization Code flow)
                                    ↓
                              Sidecar receives ID token + access token
                                    ↓
                              Sidecar issues HttpOnly, SameSite=Strict session cookie
                                    ↓
                              Sidecar redirects browser back to SearXNG
```

The sidecar stores in-memory (or Redis-backed) session state:
```
sessionId → {
  userId: "<authentik-uid>",
  username: "alice",
  email: "alice@example.com",
  groups: ["network-team", "readers"],
  engineSessions: {
    "netbox": "<netbox-session-cookie>",
    "bing": "<bing-api-key>",
    ...
  }
}
```

### 4.2 Sidecar — SSO Relay (Engine Session Provisioning)

**Responsibilities:**
- For each authenticated user, obtain and maintain sessions with downstream engines.
- Trigger SSO flows when a user first accesses an engine.
- Refresh sessions before expiration.

**Netbox SSO Relay Flow:**

```
User searches "devices" in SearXNG
        │
        ▼
Sidecar intercepts request
        │
        ├─ Does user have a Netbox session?
        │     │
        │     ├─ YES → inject Netbox session cookie into engine request
        │     │
        │     └─ NO → initiate SSO relay:
        │           │
        │           ▼
        │      Check if user has active Authentik session
        │           │
        │           ├─ YES (browser has ak_session cookie)
        │           │    └─ Sidecar redirects browser to Netbox SSO URL
        │           │         │
        │           │         ▼
        │           │    Netbox redirects to Authentik
        │           │    Authentik validates session → auto-approves
        │           │    Netbox creates session → redirects back
        │           │    Sidecar captures Netbox session cookie
        │           │    Sidecar stores: sessionId → netboxSessionCookie
        │           │    Sidecar retries Netbox engine request with cookie
        │           │
        │           └─ NO (no active Authentik session)
        │                └─ Sidecar redirects browser to Authentik login
        │                     (one-time password entry, then same flow as above)
        │
        ▼
SearXNG receives request with Netbox session cookie injected
        │
        ▼
Netbox authenticates request as the user
        │
        ▼
Results flow back → Sidecar → SearXNG → Browser
```

**Key insight:** If the user is already authenticated to Authentik (which they are, because they logged into the sidecar via Authentik), the Netbox SSO flow is **automatic** — Authentik sees the existing session and approves without prompting for credentials. The user experiences zero friction.

### 4.3 Sidecar — Request Interception

SearXNG exposes a search API (`GET /search?q=...&engines=netbox`). The sidecar sits in front of SearXNG and intercepts these calls.

**Interception Logic:**
```
Incoming request to sidecar
    │
    ├─ Is it a SearXNG search API call?
    │     │
    │     ├─ YES → check if any requested engines need auth
    │     │     │
    │     │     ├─ YES → for each auth-required engine:
    │     │     │     ├─ Look up user's engine session
    │     │     │     ├─ If missing → trigger SSO relay (see 4.2)
    │     │     │     ├─ Inject session cookie / API token into request
    │     │     │     └─ Forward to SearXNG
    │     │     │
    │     │     └─ NO → pass through unchanged
    │     │
    │     └─ NO → pass through (static assets, health checks, etc.)
    │
    └─ Is it a login/logout/auth callback?
          │
          ├─ YES → handle via auth layer (4.1)
          │
          └─ NO → return 401
```

### 4.4 Netbox Token Provisioning (Optional Enhancement)

For engines that require API tokens rather than session cookies (or for automation), the sidecar can **provision API tokens on behalf of the user**:

```
Sidecar has Netbox session cookie for user Alice
    │
    ▼
POST /api/users/5/tokens/  (with session cookie)
Body: {"description": "SearXNG sidecar", "write_enabled": false}
    │
    ▼
Netbox returns: {"key": "a1b2c3d4..."}  (one-time, shown once)
    │
    ▼
Sidecar stores: userId → netboxApiKey
    │
    ▼
All subsequent Netbox API calls use: Authorization: Token a1b2c3d4...
```

This is preferred over session cookies for API-only interactions because:
- Tokens don't expire with session timeout.
- Tokens can be scoped (read-only, specific permissions).
- No need to manage cookie rotation.

**Caveat:** The token is only shown once by Netbox. The sidecar must capture and store it immediately.

## 5. Data Flow: Complete Example

### Scenario: Alice searches for "switch" on Netbox via SearXNG

```
1. Alice opens https://search.example.com
   → Sidecar detects no session
   → Redirects to Authentik OIDC login
   → Alice enters credentials once
   → Authentik issues OIDC tokens
   → Sidecar creates session, issues cookie
   → Alice lands on SearXNG UI

2. Alice types "switch" in SearXNG, selects "netbox" engine
   → SearXNG calls GET /search?q=switch&engines=netbox
   → Request hits sidecar (reverse proxy)

3. Sidecar inspects request:
   - User: Alice (sessionId=abc123)
   - Engine: netbox (requires auth)
   - Netbox session? Not yet for Alice

4. Sidecar checks: does Alice's browser have an Authentik session cookie?
   → YES (Alice is already logged into Authentik)

5. Sidecar initiates SSO relay:
   → Sets a tracking cookie: __sidecar_netbox_pending=abc123
   → Redirects browser to https://netbox.example.com/account/login/?next=/sidecar-callback
   → Netbox redirects to Authentik
   → Authentik validates existing session → auto-approves
   → Netbox creates session for Alice → redirects to callback
   → Sidecar receives callback with Netbox session cookie
   → Sidecar stores: abc123.netbox = <netbox-session-cookie>
   → Sidecar deletes tracking cookie
   → Sidecar follows redirect back to SearXNG search results

6. SearXNG re-issues the search (browser redirected)
   → Sidecar intercepts again
   → Now finds Netbox session for Alice
   → Injects cookie: X-Netbox-Session=... into the engine request
   → Forwards to SearXNG

7. SearXNG's Netbox engine makes request to Netbox API
   → Netbox validates the session cookie
   → Netbox returns results as Alice
   → Results flow back through SearXNG → Sidecar → Browser

8. Alice's next Netbox search:
   → Sidecar has cached Netbox session for Alice
   → No additional SSO flow needed
   → Instant results
```

## 6. Authentication Methods by Engine Type

| Engine Type | Auth Method | How Sidecar Obtains It |
|---|---|---|
| **OIDC-aware app** (Netbox, Grafana) | Session cookie or API token | SSO relay via IdP (automatic if user has IdP session) |
| **SAML-aware app** | Session cookie | SAML assertion relay via IdP |
| **API token required** (custom APIs) | Bearer token | Pre-provisioned mapping or token creation via authenticated session |
| **HTTP header auth** (RemoteUserBackend) | `X-Remote-User` header | Sidecar sets header from IdP user identity |
| **Public API with rate limiting** | No auth | Sidecar handles rate limiting per user |

### Netbox-Specific Auth Strategies

Netbox supports multiple authentication paths. The sidecar selects the best one:

1. **Preferred: OIDC Session Cookie**
   - Netbox is configured with `REMOTE_AUTH_BACKEND = social_core.backends.open_id_connect.OpenIdConnectAuth`
   - Sidecar relays the user's Authentik session to Netbox
   - Netbox validates the OIDC token and creates a Django session

2. **Alternative: API Token Provisioning**
   - After obtaining a Netbox session, sidecar calls `POST /api/users/<id>/tokens/`
   - Stores the one-time key
   - Uses `Authorization: Token <key>` for all subsequent API calls

3. **Fallback: Remote User Header**
   - Netbox configured with `REMOTE_AUTH_BACKEND = netbox.authentication.RemoteUserBackend`
   - Sidecar sets `X-Remote-User: alice` header
   - Netbox creates/updates user on each request
   - **Limitation:** doesn't work for API calls (Netbox strips remote-user headers from API, see [discussion #12359](https://github.com/netbox-community/netbox/discussions/12359))

## 7. Security Model

### What the Sidecar Sees
- **OIDC tokens** from Authentik (ID token, access token) — standard SSO, expected.
- **Engine session cookies** — standard auth state from downstream apps.
- **Engine API tokens** — if provisioning is used, stored encrypted at rest.

### What the Sidecar Never Sees
- User passwords (Authentik handles authentication; sidecar only receives tokens).
- Engine passwords (no engine uses passwords in this model; all auth is token/session-based).

### Session Security
- Sidecar session cookies: `HttpOnly; SameSite=Strict; Secure; Path=/`
- Engine sessions stored encrypted (AES-256-GCM) with key from `SESSION_SECRET` env var.
- Engine sessions bound to sidecar session ID (not independently accessible).
- Engine sessions expire with the sidecar session (or earlier, configurable per engine).

### Network Security
- Sidecar ↔ Authentik: TLS (mandatory).
- Sidecar ↔ SearXNG: typically localhost (no TLS needed).
- Sidecar ↔ Netbox: TLS (mandatory).
- Sidecar listens only on specified interface (default `127.0.0.1` for backend, `0.0.0.0` for frontend).

### Rate Limiting
- Per-user rate limiting before forwarding to engines (protects API quotas).
- Configurable per-engine limits (e.g., Netbox: 30 req/min, Bing: 100 req/min).

## 8. Session Lifecycle

```
User logs in
    │
    ▼
Authentik OIDC flow → sidecar session created (default 24h)
    │
    ▼
User triggers first Netbox search
    │
    ▼
SSO relay → Netbox session obtained (bound to sidecar session)
    │
    ▼
Netbox session cached, encrypted, keyed by sidecar sessionId
    │
    ▼
Subsequent searches → sidecar reuses cached Netbox session
    │
    ▼
Netbox session expires (e.g., 8h) or sidecar session expires (24h)
    │
    ├─ Netbox session expires first → next search triggers SSO relay again
    │   (Authentik session still valid → automatic, no user interaction)
    │
    └─ Sidecar session expires first → user must re-authenticate
        (redirected to Authentik login)
```

### Refresh Strategy

For engines with long-lived sessions, the sidecar can proactively refresh:
1. Track Netbox session creation time.
2. Before session expires (e.g., at 80% of lifetime), trigger a background refresh.
3. Refresh uses the still-valid Authentik session → silent SSO relay.
4. User never notices.

## 9. Configuration Model

```json
{
  "engines": {
    "netbox": {
      "type": "oidc-sso",
      "baseUrl": "https://netbox.example.com",
      "authMethod": "session-cookie",
      "authConfig": {
        "idpIssuer": "https://authentik.example.com/application/o/netbox/",
        "idpClientId": "netbox",
        "redirectTo": "https://netbox.example.com/account/login/"
      },
      "tokenProvisioning": true,
      "tokenProvisioningConfig": {
        "endpoint": "/api/users/{userId}/tokens/",
        "tokenField": "key",
        "description": "SearXNG Sidecar"
      },
      "rateLimit": {
        "maxRequests": 30,
        "windowSeconds": 60
      },
      "sessionMaxAge": 28800
    },
    "bing": {
      "type": "api-key",
      "authMethod": "static-key",
      "authConfig": {
        "keySource": "env",
        "keyEnvVar": "ENGINE_BING_KEY"
      }
    }
  }
}
```

## 10. Comparison of Alternative Approaches

| Approach | Pros | Cons | Password Required? |
|---|---|---|---|
| **SSO Relay (recommended)** | Transparent to user after initial login; works with any OIDC/SAML app | Requires browser-based SSO flow on first use | No |
| **Remote User Header** | Simple; no session management | Doesn't work for API calls (Netbox strips headers from /api/) | No |
| **Pre-provisioned API Keys** | Simple; no runtime SSO | Requires admin to manage keys per user; no dynamic auth | No (but manual) |
| **Password Vault** | Maximum flexibility | Sidecar handles passwords; security risk; UX burden | **Yes** |
| **Browser Extension** | Full access to browser cookies | Requires extension install; not a sidecar | No |
| **SearXNG Plugin/Modification** | Deep integration | Modifies upstream code; harder to maintain; not a sidecar | Varies |

## 11. Implementation Phases

### Phase 1: Core Sidecar (MVP)
- OIDC login flow with Authentik.
- Reverse proxy to SearXNG.
- Static API key injection for engines that support it (e.g., Bing).

### Phase 2: SSO Relay
- Browser-based SSO relay for OIDC-enabled engines (Netbox).
- Session caching and injection.
- First-use SSO flow with transparent retry.

### Phase 3: Token Provisioning
- Auto-provision API tokens for engines that support it.
- Token storage and rotation.
- Background session refresh.

### Phase 4: Advanced Features
- Group-based engine access (e.g., "researchers" group gets Scholar access).
- Per-user engine configuration UI.
- Multi-engine batch search with mixed auth methods.
- Audit logging of engine access per user.

## 12. Open Questions

1. **Netbox API token scope:** Can we create read-only tokens that restrict the user to their own data? (Netbox permissions are user-scoped, so a token for Alice returns only Alice's visible data — this is correct behavior.)

2. **Multi-tenancy:** If multiple SearXNG instances share the same Netbox, does each need its own OIDC app in Authentik? (Yes — each app is a separate OIDC client with its own client ID/secret.)

3. **Session coalescing:** Can we detect that the user's Authentik session is the "same identity" across sidecar and Netbox without browser cookies? (Yes — the OIDC subject (`sub`) claim is the same. The sidecar can match by `sub` to correlate sessions server-side.)

4. **SearXNG private engines:** SearXNG supports per-engine tokens via `tokens` in `settings.yml` (`require_api_key: true` + `tokens: {engine: token}`). Could the sidecar dynamically rewrite this? (Possible but fragile — would require modifying SearXNG's settings at request time. Better to handle at the proxy level.)

5. **What if the user's Authentik session expires mid-search?** The SSO relay handles this gracefully — the user is redirected to re-authenticate, then the search is retried automatically.
