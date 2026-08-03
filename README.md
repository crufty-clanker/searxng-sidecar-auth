# SearXNG Sidecar Authentication

A sidecar application for [SearXNG](https://github.com/searxng/searxng) that enables **SSO-based per-user engine authentication**.

## Overview

SearXNG instances often rely on third-party search engines (Google, Bing, YouTube, etc.) that require individual API keys or authentication tokens. This sidecar sits between the user's browser and the SearXNG instance, intercepting search requests and injecting per-user engine credentials via SSO — eliminating the need for each user to manually configure API keys.

### How It Works

```
┌──────────┐      ┌──────────────────────┐      ┌──────────┐
│  Browser  │─────▶│  Auth Sidecar (this)  │─────▶│ SearXNG  │
│           │      │  (SSO + key injection)│      │ instance │
└──────────┘      └──────────────────────┘      └──────────┘
                         │
                         ▼
                  ┌──────────────┐
                  │   Identity   │
                  │    Provider  │
                  └──────────────┘
```

1. User navigates to the SearXNG instance behind the sidecar.
2. The sidecar intercepts unauthenticated requests and redirects to the configured SSO provider (OIDC, SAML, LDAP, etc.).
3. After successful authentication, the sidecar resolves the user's engine credentials from a backend store.
4. On each search request, the sidecar injects the appropriate engine API keys/tokens before forwarding the request to SearXNG.
5. The authenticated response is returned to the user transparently.

## Features

- **SSO Integration** — Pluggable authentication backends (OIDC, SAML, LDAP, CAS).
- **Per-User Engine Keys** — Each authenticated user gets their own set of search engine credentials.
- **Transparent Proxy** — Users experience SearXNG as usual; key injection is invisible.
- **Session Management** — Secure session cookies with configurable expiration.
- **Multi-Engine Support** — Configurable mapping of users/groups to specific engines and keys.
- **Rate Limiting** — Per-user rate limiting to protect backend API quotas.

## Architecture

- **Sidecar mode** — Runs alongside SearXNG (typically in the same pod or behind the same reverse proxy).
- **Reverse proxy** — Terminates TLS / SSO and forwards authenticated requests to SearXNG on `127.0.0.1`.
- **Configuration-driven** — Engine mappings and SSO settings are loaded from environment variables or a config file at startup.

## Quick Start

### Prerequisites

- Docker / Docker Compose
- A running SearXNG instance
- An SSO identity provider (Keycloak, Authentik, Okta, etc.)

### Using Docker Compose

```yaml
services:
  searxng:
    image: searxng/searxng:latest
    ports:
      - "8888:8080"
    networks:
      - searxng

  sidecar:
    build: .
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
      "google": "GOOGLE_KEY_ALICE"
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

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Run tests
npm test

# Build Docker image
docker build -t searxng-sidecar-auth .
```

## Project Structure

```
.
├── src/                  # Application source code
│   ├── auth/             # SSO/authentication modules
│   ├── engines/          # Engine key resolution & injection
│   ├── proxy/            # Reverse proxy logic
│   └── config/           # Configuration loading
├── tests/                # Test suite
├── docker-compose.yml    # Example deployment
└── README.md
```

## License

MIT — see [LICENSE](LICENSE).

## Contributing

Contributions are welcome. Please open an issue or pull request on GitHub.
