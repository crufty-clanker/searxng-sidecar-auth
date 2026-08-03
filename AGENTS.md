# AGENTS.md — Instructions for AI Coding Agents

## Project Overview

This is a **SearXNG sidecar** that enables SSO-based per-user engine authentication. It sits in front of SearXNG, handles user authentication via an identity provider, resolves per-user search engine credentials, and injects them into search requests before forwarding to SearXNG.

### Languages

| Component | Language | Runtime |
|-----------|----------|---------|
| **Sidecar** | Go | None (single static binary) |
| **Filter Plugin** | Python | SearXNG runtime |
| **Custom Engines** | Python | SearXNG runtime |

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

- **Sidecar:** Go (single static binary, no runtime dependencies)
- **HTTP:** `net/http` standard library
- **Authentication:** `golang.org/x/oauth2` for OIDC, pluggable SAML/LDAP backends
- **Sessions:** Secure cookie-based sessions (`golang.org/x/crypto`)
- **Testing:** `testing` standard library, `httptest` for HTTP tests
- **Build:** `go build` → single binary
- **Container:** Docker (multi-stage build)

## Conventions

### Go Code Style
- Follow [Effective Go](https://go.dev/doc/effective_go) and [Go Code Review Comments](https://github.com/golang/go/wiki/CodeReviewComments)
- Use `gofmt` and `go vet`
- 4-space indentation (tabs)
- Package names: short, lowercase, no underscores
- Error handling: explicit error returns, never panic in production code

### File Naming
- Source files: `snake_case.go` (e.g., `auth_handler.go`)
- Test files: `<source-file>_test.go` colocated alongside source
- Config: `config.go` (single source of truth, loaded from env + config file)

### Sidecar Module Structure (`sidecar/`)

```
sidecar/
├── cmd/
│   └── sidecar/
│       └── main.go             # Entry point
├── internal/
│   ├── auth/
│   │   ├── handler.go          # HTTP request handlers
│   │   ├── oidc.go             # OIDC provider implementation
│   │   ├── session.go          # Session creation/validation
│   │   └── types.go            # Shared auth types
│   ├── engines/
│   │   ├── resolver.go         # Resolves engine secrets for a user
│   │   ├── injector.go         # Builds X-Authenticated-Engines-Secrets header
│   │   └── types.go            # Engine config types
│   ├── proxy/
│   │   ├── server.go           # HTTP server setup
│   │   └── middleware.go       # Rate limiting, logging, etc.
│   └── config/
│       ├── config.go           # Load and validate config
│       └── schema.go           # Env var validation
├── pkg/
│   └── errors/                 # Public error types
└── go.mod
```

### Error Handling
- Use custom error types in `pkg/errors/` (e.g., `AuthError`, `ConfigError`)
- Never leak internal details to clients; return generic messages with codes
- Log at appropriate levels; include correlation IDs for request tracing
- Use `errors.Is()` and `errors.As()` for error comparison

### Testing
- Each public function should have unit tests
- Integration tests use a mock SSO server and a real SearXNG container
- Use `net/http/httptest` for HTTP handler tests

## Common Tasks

### Adding a New SSO Provider
1. Implement the provider interface in `internal/auth/` (e.g., `saml.go`).
2. Add provider-specific config to `internal/config/config.go`.
3. Add tests in `internal/auth/<provider>_test.go`.

### Adding a New Authenticated Engine
1. Define engine metadata in `internal/engines/types.go`.
2. Add secret resolution logic in `internal/engines/resolver.go`.
3. Add SearXNG custom engine code in `engines/` (Python).
4. Add SearXNG plugin entry in the engine config mapping.
5. Add tests in `internal/engines/<engine>_test.go`.

### Adding a New Non-Authenticated Engine
Standard SearXNG engines work as-is — no sidecar changes needed. Just enable in SearXNG config.

### Configuration Changes
- All env vars are validated in `internal/config/config.go`.
- Document new env vars in `README.md` configuration reference.

## Running Locally

```bash
cd sidecar
go mod tidy
go run ./cmd/sidecar    # Starts sidecar on :8080, proxies to default SearXNG
go test ./...            # Runs test suite
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
