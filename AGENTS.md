# AGENTS.md — Instructions for AI Coding Agents

## Project Overview

This is a **SearXNG sidecar** that enables SSO-based per-user engine authentication. It sits in front of SearXNG, handles user authentication via an identity provider, resolves per-user search engine credentials, and injects them into search requests before forwarding to SearXNG.

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
│   ├── handler.ts            # Express/Fastify request handlers
│   ├── oidc.ts               # OIDC provider implementation
│   ├── session.ts            # Session creation/validation
│   └── types.ts              # Shared auth types
├── engines/
│   ├── resolver.ts           # Resolves engine keys for a user
│   ├── injector.ts           # Injects keys into SearXNG requests
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

### Adding a New Engine
1. Define engine metadata in `src/engines/types.ts`.
2. Add key injection logic in `src/engines/injector.ts`.
3. Update `engines.json` schema if the config format changes.

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
- **Do not** modify SearXNG source code; this sidecar is entirely external.
- **Do not** store engine keys in session data; resolve them per-request from the config backend.
- **Do** ensure all secrets come from environment variables or mounted files, never from config committed to git.
