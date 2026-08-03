# SearXNG Sidecar Authentication

A sidecar application for [SearXNG](https://github.com/searxng/searxng) that enables **SSO-based per-user engine authentication**.

## Languages

| Component | Language | Runtime |
|-----------|----------|---------|
| **Sidecar** | Go | None (single static binary) |
| **Filter Plugin** | Python | SearXNG runtime |
| **Custom Engines** | Python | SearXNG runtime |

## Overview

SearXNG instances often rely on third-party search engines (Google, Bing, YouTube, etc.) that require individual API keys or authentication tokens. This sidecar sits between the user's browser and the SearXNG instance, intercepting search requests and injecting per-user engine credentials via SSO — eliminating the need for each user to manually configure API keys.

### How It Works

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

**The sidecar owns identity. SearXNG is anonymous.**

1. User navigates to the SearXNG instance behind the sidecar.
2. The sidecar intercepts unauthenticated requests and redirects to the configured SSO provider (OIDC, SAML, LDAP, etc.).
3. After successful authentication, the sidecar issues a session cookie and resolves the user's engine credentials from a backend store.
4. On each search request, the user's browser sends the session cookie to the sidecar.
5. The sidecar uses the session to identify the user, resolves all per-engine secrets, and proxies the request to SearXNG — sending them in a single header:
   ```
   X-Authenticated-Engines-Secrets: {"netbox": "nb_tok_abc", "bing": "bing_key_xyz"}
   ```
6. A SearXNG plugin intercepts the request and, for each engine call, extracts only the secret matching that engine's name (e.g., `secrets["netbox"]` for the NetBox engine).
7. The custom engine reads its own secret and uses it to authenticate with the upstream API.
8. The authenticated response flows back through Engine → SearXNG → sidecar → user transparently.

The sidecar is the **correlation point**: it knows who the user is (via session/API key), resolves the right credentials, and forwards them to SearXNG. SearXNG has no concept of user identity — it only sees engine-scoped secrets filtered by the plugin.

**No token is ever issued directly to downstream applications.** The sidecar remains the trust boundary; all engine authentication happens server-side between the sidecar and SearXNG.

## Features

- **SSO Integration** — Pluggable authentication backends (OIDC, SAML, LDAP, CAS).
- **Per-User Engine Secrets** — Each authenticated user gets their own set of search engine credentials.
- **Transparent Proxy** — Users experience SearXNG as usual; secret injection is invisible.
- **Session Management** — Secure session cookies with configurable expiration.
- **Multi-Engine Support** — Configurable mapping of users/groups to specific engines and secrets.
- **Plugin-Based Secret Filtering** — SearXNG plugin ensures each engine only sees its own secret.
- **Rate Limiting** — Per-user rate limiting to protect backend API quotas.

## Architecture

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

### Security Considerations

- **HTTP headers are global to the request** — standard engines could theoretically read all secrets.
- **Mitigations:**
  - Short-lived tokens (5-15 min) with narrow scopes (search-only).
  - The plugin only exposes the matching engine's secret.
  - Standard engines (DuckDuckGo, Wikipedia) don't look for auth headers.
  - Custom engines you write only read their own secret.
- **Trust boundary:** SearXNG is not a security boundary — it trusts its engines. For highly sensitive engines, consider bypassing SearXNG and having the sidecar call the engine directly.
- **Risk is low in practice:** Typical deployments are private (home labs, club administration, company networks).

## Quick Start

### Prerequisites

- Docker / Docker Compose
- A running SearXNG instance (with the auth plugin installed)
- An SSO identity provider (Keycloak, Authentik, Okta, etc.)

### Using Docker Compose

```yaml
services:
  searxng:
    image: searxng/searxng:latest
    ports:
      - "8888:8080"
    volumes:
      - ./filter_plugin:/etc/searxng/searx/plugins  # Auth plugin
    networks:
      - searxng

  sidecar:
    build: ./sidecar
    ports:
      - "8080:8080"
    environment:
      - SEARXNG_BACKEND_URL=http://searxng:8080
      - SSO_PROVIDER=oidc
      - SSO_ISSUER=https://idp.example.com/realms/searxng
      - SSO_CLIENT_ID=searxng-sidecar
      - SSO_CLIENT_SECRET=${SSO_CLIENT_SECRET}
      - SSO_REDIRECT_URI=http://search.example.com/callback
      - ENGINES_CONFIG=/etc/sidecar/engines.json
    depends_on:
      - searxng
    networks:
      - searxng

networks:
  searxng:
```

### Configuration

Create `engines.json` to map users/groups to engine credentials:

```json
{
  "default": {
    "bing": "BING_KEY_DEFAULT"
  },
  "users": {
    "alice@example.com": {
      "bing": "BING_KEY_ALICE",
      "netbox": "NETBOX_TOKEN_ALICE"
    }
  },
  "groups": {
    "researchers": {
      "bing": "BING_KEY_TEAM",
      "scholar": "SCHOLAR_KEY_TEAM"
    }
  }
}
```

## Configuration Reference

| Environment Variable          | Description                                    | Default                  |
|-------------------------------|------------------------------------------------|--------------------------|
| `LISTEN_ADDR`                 | Address to listen on                           | `0.0.0.0:8080`           |
| `SEARXNG_BACKEND_URL`         | URL of the upstream SearXNG instance           | `http://localhost:8888`  |
| `SSO_PROVIDER`                | Auth provider type: `oidc`, `saml`, `ldap`     | `oidc`                   |
| `SSO_ISSUER`                  | OIDC issuer URL                                | —                        |
| `SSO_CLIENT_ID`               | OIDC client ID                                 | —                        |
| `SSO_CLIENT_SECRET`           | OIDC client secret                             | —                        |
| `SSO_REDIRECT_URI`            | Callback URL after auth                        | —                        |
| `ENGINES_CONFIG`              | Path to engines JSON config                    | `/etc/sidecar/engines.json` |
| `SESSION_SECRET`              | Session encryption key                         | (random on startup)      |
| `SESSION_MAX_AGE`             | Session lifetime in seconds                    | `86400`                  |
| `RATE_LIMIT_PER_MIN`          | Max search requests per user per minute        | `60`                     |
| `LOG_LEVEL`                   | Log level: `debug`, `info`, `warn`, `error`    | `info`                   |

## Development

### Sidecar (Go)

```bash
# Install dependencies
cd sidecar
go mod tidy

# Run in development mode
go run ./cmd/sidecar

# Run tests
go test ./...

# Build static binary
go build -o sidecar ./cmd/sidecar
```

### Filter Plugin & Engines (Python)

```bash
# Install dependencies (if needed)
pip install -r filter_plugin/requirements.txt

# Test plugin (requires SearXNG runtime)
pytest filter_plugin/
```

## Project Structure

```
.
├── sidecar/                  # Go sidecar application
│   ├── cmd/
│   │   └── sidecar/
│   │       └── main.go       # Entry point
│   ├── internal/
│   │   ├── auth/             # SSO/authentication modules
│   │   ├── engines/          # Engine secret resolution & injection
│   │   ├── proxy/            # Reverse proxy logic
│   │   └── config/           # Configuration loading
│   ├── pkg/
│   │   └── errors/           # Public error types
│   └── go.mod
├── engines/                  # Custom SearXNG engines (Python)
│   └── netbox.py
├── filter_plugin/            # SearXNG plugin for secret filtering (Python)
│   └── searx/
│       └── plugins/
│           └── auth_secrets.py
├── docker-compose.yml        # Example deployment
└── README.md
```

## License

MIT — see [LICENSE](LICENSE).

## Contributing

Contributions are welcome. Please open an issue or pull request on GitHub.
