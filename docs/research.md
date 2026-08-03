# Research Notes: SSO-Based Engine Authentication for SearXNG

## Key Findings

### 1. SearXNG Engine Architecture

SearXNG engines are Python modules located in `searx/engines/`. Each engine implements:
- `request(query, params)` — builds the HTTP request (URL, headers, cookies, data)
- `response(resp)` — parses the HTTP response into result items

Engines receive these parameters in `params`:
- `url` — target URL
- `headers` — HTTP headers (dict)
- `cookies` — cookies (dict)
- `api_key` — set globally in `settings.yml`, not per-user

**Relevant SearXNG settings (from `settings_engines.html`):**
- `api_key` — API key for the engine (global, instance-wide)
- `proxies` — proxy configuration per engine
- Engines can set custom `headers` and `cookies` in their `request()` function

**Limitation:** There is no built-in per-user authentication in SearXNG engines. The `api_key` is shared across all users. This is why a sidecar is needed — to inject per-user credentials before the request reaches the engine.

**Relevant discussion:** [searxng/searxng#3486](https://github.com/searxng/searxng/discussions/3486) — confirms that end users cannot set per-engine API keys; only instance owners can configure them.

### 2. Netbox Authentication

Netbox supports multiple authentication backends ([Netbox docs](https://netbox.readthedocs.io/en/stable/administration/authentication/overview/)):

| Backend | Type | Works with API? |
|---|---|---|
| `RemoteUserBackend` | HTTP header (`X-Remote-User`) | **No** — Netbox strips remote-user headers from API endpoints |
| `social_core.backends.open_id_connect.OpenIdConnectAuth` | OIDC SSO | **Partially** — web UI SSO works; API needs token |
| `netbox.authentication.LDAPBackend` | LDAP | No (direct bind, not proxyable) |
| Token auth | `Authorization: Token <uuid>` | **Yes** — primary API auth method |

**Netbox API auth (from Netbox docs):**
- REST API uses token-based auth: `Authorization: Token <uuid>`
- Cookie-based auth works for the browsable API (web UI)
- API tokens are created via `POST /api/users/<id>/tokens/`
- Tokens are tied to user permissions — a token for Alice can only access Alice's data

**Key discussion:** [netbox#12359](https://github.com/netbox-community/netbox/discussions/12359) — confirms that RemoteUser headers don't work for the API. The Apache mod_openidc approach (checking both OIDC auth AND Token auth) is the proven pattern for mixed web+API access.

### 3. Authentik Integration with Netbox

Authentik provides a [formal integration guide for Netbox](https://integrations.goauthentik.io/documentation/netbox/):

**Authentik OIDC + Netbox configuration:**
```
REMOTE_AUTH_ENABLED = true
REMOTE_AUTH_BACKEND = social_core.backends.open_id_connect.OpenIdConnectAuth
SOCIAL_AUTH_OIDC_OIDC_ENDPOINT = https://authentik.example.com/application/o/<slug>/
SOCIAL_AUTH_OIDC_KEY = <client_id>
SOCIAL_AUTH_OIDC_SECRET = <client_secret>
SOCIAL_AUTH_OIDC_SCOPE = ["openid", "email", "profile"]
```

This proves that Netbox and Authentik work together seamlessly via OIDC. The user logs in once to Authentik and is automatically authenticated in Netbox.

**Authentik Proxy Outpost:**
- Can proxy traffic and set user headers (`X-authentik-username`, `X-authentik-groups`, etc.)
- Operates in proxy mode (sits in front of the app) or forward-auth mode (checks auth, passes through)
- Maintains session cookies for the protected application
- Supports dynamic backend selection and custom headers

**Key insight:** Authentik's proxy outpost demonstrates that a reverse proxy CAN maintain user sessions with downstream applications by leveraging the IdP's session state. This is the foundation of our sidecar approach.

### 4. Existing SearXNG Proxy Projects

[loonylabs-dev/searxng-proxy](https://github.com/loonylabs-dev/searxng-proxy) — a Node.js proxy for SearXNG with API key authentication. It:
- Sits in front of SearXNG
- Requires Bearer token auth for all search API calls
- Forwards requests to SearXNG backend
- Does NOT handle per-engine authentication (just access control to SearXNG itself)

This project is closest to ours but lacks the engine authentication dimension.

### 5. The Core Insight

**The sidecar can act as an SSO relay between the user's IdP session and downstream engines.**

Since:
1. The user authenticates to the sidecar via OIDC (Authentik)
2. Netbox (and similar apps) also authenticate via OIDC (Authentik)
3. Authentik maintains the user's session

Then: when the user accesses Netbox through the sidecar, the sidecar can present the user's existing Authentik session to Netbox, and Netbox will authenticate the user automatically — no password required.

This works because:
- Authentik issues session cookies (`ak_session`) that are valid across all applications trusting the same IdP.
- Netbox's OIDC flow validates the Authentik session and creates a Netbox session for the user.
- The sidecar captures the Netbox session and reuses it for API calls.

### 6. Session Correlation

The critical technical question: **how does the sidecar know that the Authentik session and the Netbox session belong to the same user?**

Answer: the OIDC `sub` (subject) claim. Authentik issues the same `sub` for a given user across all OIDC clients. The sidecar can:
1. Extract `sub` from the user's OIDC ID token (received during sidecar login).
2. After SSO relay to Netbox, extract `sub` from Netbox's OIDC callback.
3. Match by `sub` to bind the Netbox session to the sidecar session.

This requires no password exchange — just token validation against the shared IdP.

## References

- [SearXNG Engine Overview](https://docs.searxng.org/dev/engines/engine_overview.html)
- [SearXNG Engine Settings](https://docs.searxng.org/admin/settings/settings_engines.html)
- [Netbox Authentication Overview](https://netbox.readthedocs.io/en/stable/administration/authentication/overview/)
- [Netbox REST API Authentication](https://netbox.readthedocs.io/en/stable/rest-api/authentication/)
- [Netbox + Authentik Integration Guide](https://integrations.goauthentik.io/documentation/netbox/)
- [Netbox Discussion: API auth + remote user](https://github.com/netbox-community/netbox/discussions/12359)
- [Authentik Proxy Provider Docs](https://docs.goauthentik.io/add-secure-apps/providers/proxy/)
- [SearXNG Proxy (existing project)](https://github.com/loonylabs-dev/searxng-proxy)
- [SearXNG Discussion: per-user engine keys](https://github.com/searxng/searxng/discussions/3486)
- [DeepWiki: SearXNG Engine Integration Framework](https://deepwiki.com/searxng/searxng/4.1-engine-integration-framework)
- [DeepWiki: Netbox Authentication](https://deepwiki.com/netbox-community/netbox/9.2-authentication-backends-and-permissions)
- [DeepWiki: Authentik Proxy Outpost Implementation](https://deepwiki.com/goauthentik/authentik/4.2-proxy-outpost-implementation)
