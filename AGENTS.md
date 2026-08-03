# AGENTS.md — Instructions for AI Coding Agents

## Project Overview

This is a **SearXNG sidecar** that enables SSO-based per-user engine authentication. It sits in front of SearXNG, handles user authentication via an identity provider, resolves per-user search engine credentials, and injects them into search requests before forwarding to SearXNG.

### Architecture

```
┌──────────┐      ┌──────────────────────┐      ┌──────────┐      ┌──────────┐
│  Browser  │─────▶│  Auth Sidecar (this)  │─────▶│ SearXNG  │─────▶│  Engine   │
│           │      │  (SSO + secrets)      │      │ + plugin │      │ (NetBox,  │
│           │      │                      │      │          │      │  Bing..)  │
└──────────┘      └──────────────────────┘      └──────────┘      └──────────┘
                         │                            │
                         ▼                            ▼
                  ┌──────────────┐             ┌──────────────┐
                  │   Identity   │             │ Engine API   │
                  │    Provider  │             │ (with user   │
                  │              │             │  token)      │
                  └──────────────┘             └──────────────┘
```

**Key design principle: The sidecar owns identity. SearXNG is anonymous.**

1. User logs into the sidecar via SSO (OIDC/SAML/LDAP).
2. The sidecar issues a session cookie identifying the user.
3. Every search request the user makes goes through the sidecar.
4. The sidecar resolves the user's per-engine credentials.
5. The sidecar proxies the request to SearXNG, sending all engine secrets in a single header:
   `X-Authenticated-Engines-Secrets: {"netbox": "nb_tok_abc", "bing": "bing_key_xyz"}`
6. A SearXNG plugin intercepts the request, and for each engine call, extracts only the secret matching that engine's name (e.g., `secrets["netbox"]` for the NetBox engine).
7. The custom engine reads its own secret and uses it to authenticate with the upstream API.
8. Results flow back: Engine → SearXNG → Sidecar → User.

The sidecar is the **correlation point**: it knows who the user is (via session/API key), resolves the right credentials, and forwards them to SearXNG. SearXNG itself has no concept of user identity — it only sees engine-scoped secrets filtered by the plugin.

**No token is ever issued directly to downstream applications.** The sidecar remains the trust boundary; all engine authentication happens server-side between the sidecar and SearXNG.

### The Two-Sided Requirement

Authenticated engines require coordination on **both** sides:

| Side | Responsibility |
|------|---------------|
| **SearXNG** | Custom engine or plugin that reads the filtered secret and uses it to authenticate with the upstream API |
| **Sidecar** | Configuration mapping each engine to its secret resolution mechanism (config file, vault, etc.) |

For most engines that need per-user auth (NetBox, private Bing, custom APIs), the standard SearXNG engine doesn't exist or doesn't support authentication. So you're writing custom engines anyway — the plugin just handles the secret distribution cleanly.

### Plugin Architecture: `X-Authenticated-Engines-Secrets`

The sidecar sends a single header containing all user secrets as a JSON dictionary:

```
X-Authenticated-Engines-Secrets: {"netbox": "nb_tok_abc", "bing": "bing_key_xyz"}
```

The SearXNG plugin filters this per engine:

```python
# searx/plugins/auth_secrets.py
def on_request(engine_name, params, headers):
    secrets = json.loads(headers.get('X-Authenticated-Engines-Secrets', '{}'))
    secret = secrets.get(engine_name)
    if secret:
        headers[f'X-Engine-Secret-{engine_name}'] = secret
    return headers
```

The custom engine reads only its own secret:

```python
# searx/engines/netbox.py
def search(request, params):
    secret = request.headers.get('X-Engine-Secret-netbox')
    if not secret:
        return error("Missing NetBox authentication")
    response = requests.get('https://netbox.example.com/api/',
                           headers={'Authorization': f'Token {secret}'})
    return parse_results(response.json())
```

**Security considerations:**
- HTTP headers are global to the request — standard engines could theoretically read all secrets
- **Mitigation:** Short-lived tokens (5-15 min), narrowly scoped (search-only), and the plugin only exposes the matching engine's secret
- **Trust boundary:** SearXNG is not a security boundary — it trusts its engines. For highly sensitive engines, consider bypassing SearXNG and having the sidecar call the engine directly
- **Risk is low in practice:** Standard engines (DuckDuckGo, Wikipedia) don't look for auth headers; custom engines you write only read their own secret

## Tech Stack

- **Runtime:** Node.js (TypeScript)
- **HTTP Framework:** Fastify (preferred for performance and schema validation)
- **Authentication:** OIDC (primary), with pluggable SAML/LDAP backends
- **Sessions:** Secure cookie-based sessions
- **Testing:** Vitest
- **Build:** tsup or ts-node for dev
- **Container:** Docker (multi-stage build)

## Conventions

### Code Style
- TypeScript with strict mode enabled
- ESLint + Prettier (config in `.eslintrc.cjs` / `.prettierrc`)
- 2-space indentation, single quotes, semicolons
- Named exports preferred over default exports
- Function-first declarations (not hoisted)

### File Naming
- Source files: `kebab-case.ts` (e.g., `auth-handler.ts`)
- Test files: `<source-file>.test.ts` colocated alongside source
- Config: `config.ts` (single source of truth, loaded from env + config file)

### Module Structure (`src/`)

```
src/
├── auth/
│   ├── index.ts              # Auth module barrel
│   ├── handler.ts            # Fastify request handlers
│   ├── oidc.ts               # OIDC provider implementation
│   ├── session.ts            # Session creation/validation
│   └── types.ts              # Shared auth types
├── engines/
│   ├── resolver.ts           # Resolves engine secrets for a user
│   ├── injector.ts           # Builds X-Authenticated-Engines-Secrets header
│   └── types.ts              # Engine config types
├── proxy/
│   ├── server.ts             # Fastify server setup
│   └── middleware/           # Rate limiting, logging, etc.
├── config/
│   ├── index.ts              # Load and validate config
│   └── schema.ts             # Zod/Yup validation schema
├── app.ts                    # Entry point
└── index.ts                  # Named export for testing
```

### Error Handling
- Use custom error classes in `src/errors/` (e.g., `AuthError`, `ConfigError`)
- Never leak internal details to clients; return generic messages with codes
- Log at appropriate levels; include correlation IDs for request tracing

### Testing
- Each public function should have unit tests
- Integration tests use a mock SSO server and a real SearXNG container
- Test files import from `src/`, never from `dist/`

## Common Tasks

### Adding a New SSO Provider
1. Implement the provider interface in `src/auth/` (e.g., `saml.ts`).
2. Export it from `src/auth/index.ts`.
3. Add provider-specific config to `src/config/schema.ts`.
4. Add tests in `src/auth/<provider>.test.ts`.

### Adding a New Authenticated Engine
1. Define engine metadata in `src/engines/types.ts`.
2. Add secret resolution logic in `src/engines/resolver.ts`.
3. Add SearXNG custom engine code (in a companion SearXNG fork or plugin repo).
4. Add SearXNG plugin entry in the engine config mapping.
5. Add tests in `src/engines/<engine>.test.ts`.

### Adding a New Non-Authenticated Engine
Standard SearXNG engines work as-is — no sidecar changes needed. Just enable in SearXNG config.

### Configuration Changes
- All env vars are validated against the schema in `src/config/schema.ts`.
- Defaults are set in the schema; don't use `||` fallbacks in business logic.
- Document new env vars in `README.md` configuration reference.

## Running Locally

```bash
npm install
npm run dev          # Starts sidecar on :8080, proxies to default SearXNG
npm test             # Runs test suite
npm run lint         # Lint and format
```

## Docker

```bash
docker build -t searxng-sidecar-auth .
docker run -p 8080:8080 --env-file .env searxng-sidecar-auth
```

## Constraints
- **Do not** modify SearXNG source code directly; use a plugin for secret filtering and custom engines in a companion repo.
- **Do not** store engine secrets in session data; resolve them per-request from the config backend.
- **Do** ensure all secrets come from environment variables or mounted files, never from config committed to git.
- **Do** issue short-lived tokens (5-15 min) with narrow scopes (search-only).
- **Do** strip the `X-Authenticated-Engines-Secrets` header from responses to prevent leakage.
