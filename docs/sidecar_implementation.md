# Sidecar Implementation Guide

This document provides a detailed guide for implementing the Go sidecar application, including OIDC authentication, session management, engine secret resolution, and reverse proxying.

## Table of Contents

- [Go Libraries](#go-libraries)
- [Project Structure](#project-structure)
- [OIDC Authentication](#oidc-authentication)
- [Session Management](#session-management)
- [Engine Resolution](#engine-resolution)
- [Reverse Proxy](#reverse-proxy)
- [Testing](#testing)
- [References](#references)

---

## Go Libraries

### Core Libraries

| Library | Purpose | Version |
|---------|---------|---------|
| `net/http` | HTTP server and client | Standard library |
| `net/http/httputil` | Reverse proxy | Standard library |
| `golang.org/x/oauth2` | OAuth 2.0 / OIDC | Latest |
| `golang.org/x/crypto` | Secure cookies, hashing | Latest |
| `github.com/gorilla/sessions` | Session management (optional) | Latest |
| `go.uber.org/zap` | Structured logging (optional) | Latest |

### OIDC Library

**Package:** `golang.org/x/oauth2`

**Purpose:** OAuth 2.0 client implementation with OIDC support.

**Key Types:**
- `oauth2.Config` — OAuth 2.0 configuration
- `oauth2.Token` — Access/refresh token
- `oauth2.TokenSource` — Token source interface

**Example:**
```go
import (
    "golang.org/x/oauth2"
)

var config = &oauth2.Config{
    ClientID:     "your-client-id",
    ClientSecret: "your-client-secret",
    RedirectURL:  "http://localhost:8080/callback",
    Endpoint: oauth2.Endpoint{
        AuthURL:  "https://idp.example.com/oauth/authorize",
        TokenURL: "https://idp.example.com/oauth/token",
    },
    Scopes: []string{"openid", "email", "profile"},
}
```

### Secure Cookie Library

**Package:** `golang.org/x/crypto`

**Sub-packages:**
- `golang.org/x/crypto/bcrypt` — Password hashing
- `golang.org/x/crypto/chacha20poly1305` — AES-like encryption

**For sessions, use `gorilla/sessions` or implement with `crypto/rand`:**

```go
import (
    "crypto/rand"
    "encoding/hex"
)

func generateSessionID() (string, error) {
    b := make([]byte, 32)
    _, err := rand.Read(b)
    if err != nil {
        return "", err
    }
    return hex.EncodeToString(b), nil
}
```

---

## Project Structure

```
sidecar/
├── cmd/
│   └── sidecar/
│       └── main.go             # Entry point
├── internal/
│   ├── auth/
│   │   ├── handler.go          # HTTP auth endpoints
│   │   ├── oidc.go             # OIDC provider
│   │   ├── session.go          # Session management
│   │   └── types.go            # Auth types
│   ├── engines/
│   │   ├── resolver.go         # User → engine secrets
│   │   ├── injector.go         # Build X-Authenticated-Engine-* headers
│   │   └── types.go            # Engine config
│   ├── proxy/
│   │   ├── server.go           # HTTP server
│   │   └── middleware.go       # Rate limiting, logging
│   └── config/
│       ├── config.go           # Load/validate config
│       └── schema.go           # Config schema
├── pkg/
│   └── errors/
│       └── errors.go           # Custom error types
├── go.mod
└── go.sum
```

---

## OIDC Authentication

### Flow

```
1. User → GET /login → Sidecar generates OAuth URL
2. User → GET /callback?code=xxx → Sidecar exchanges code for tokens
3. Sidecar → Creates session, issues cookie → Redirects to SearXNG
```

### Implementation

**oidc.go:**

```go
package auth

import (
    "context"
    "golang.org/x/oauth2"
)

type OIDCProvider struct {
    config *oauth2.Config
}

func NewOIDCProvider(clientID, clientSecret, redirectURL, issuer string) (*OIDCProvider, error) {
    // Discover OIDC endpoints from issuer
    config, err := oauth2.Discover(context.Background(), issuer)
    if err != nil {
        return nil, err
    }
    
    return &OIDCProvider{
        config: &oauth2.Config{
            ClientID:     clientID,
            ClientSecret: clientSecret,
            RedirectURL:  redirectURL,
            Endpoint:     config.Endpoint,
            Scopes:       []string{"openid", "email", "profile"},
        },
    }, nil
}

func (p *OIDCProvider) AuthURL(state string) string {
    return p.config.AuthCodeURL(state, oauth2.AccessTypeOffline)
}

func (p *OIDCProvider) Exchange(ctx context.Context, code string) (*oauth2.Token, error) {
    return p.config.Exchange(ctx, code)
}

func (p *OIDCProvider) NewClient(ctx context.Context, token *oauth2.Token) *http.Client {
    return p.config.Client(ctx, token)
}
```

**handler.go:**

```go
package auth

import (
    "crypto/rand"
    "encoding/hex"
    "net/http"
)

func (h *Handler) Login(w http.ResponseWriter, r *http.Request) {
    // Generate state parameter
    state := generateState()
    
    // Set state cookie
    http.SetCookie(w, &http.Cookie{
        Name:  "oidc_state",
        Value: state,
        Path:  "/",
        HttpOnly: true,
        Secure: true,
        SameSite: http.SameSiteStrictMode,
    })
    
    // Redirect to IdP
    authURL := h.oidc.AuthURL(state)
    http.Redirect(w, r, authURL, http.StatusTemporaryRedirect)
}

func (h *Handler) Callback(w http.ResponseWriter, r *http.Request) {
    // Validate state
    stateCookie, err := r.Cookie("oidc_state")
    if err != nil || stateCookie.Value != r.URL.Query().Get("state") {
        http.Error(w, "Invalid state", http.StatusBadRequest)
        return
    }
    
    // Exchange code for token
    token, err := h.oidc.Exchange(r.Context(), r.URL.Query().Get("code"))
    if err != nil {
        http.Error(w, "Token exchange failed", http.StatusInternalServerError)
        return
    }
    
    // Create session
    sessionID := generateSessionID()
    session := &Session{
        ID: sessionID,
        UserID: extractUserID(token),
        ExpiresAt: time.Now().Add(sessionMaxAge),
    }
    
    // Store session
    h.sessionStore.Store(sessionID, session)
    
    // Issue session cookie
    http.SetCookie(w, &http.Cookie{
        Name:     "__session",
        Value:    sessionID,
        Path:     "/",
        HttpOnly: true,
        Secure: true,
        SameSite: http.SameSiteStrictMode,
        MaxAge:   int(sessionMaxAge.Seconds()),
    })
    
    // Redirect to SearXNG
    http.Redirect(w, r, "/", http.StatusTemporaryRedirect)
}

func generateState() string {
    b := make([]byte, 16)
    rand.Read(b)
    return hex.EncodeToString(b)
}
```

---

## Session Management

### In-Memory Store

**session.go:**

```go
package auth

import (
    "sync"
    "time"
)

type Session struct {
    ID       string
    UserID   string
    Email    string
    ExpiresAt time.Time
}

type SessionStore struct {
    mu      sync.RWMutex
    sessions map[string]*Session
}

func NewSessionStore() *SessionStore {
    return &SessionStore{
        sessions: make(map[string]*Session),
    }
}

func (s *SessionStore) Create(session *Session) {
    s.mu.Lock()
    defer s.mu.Unlock()
    s.sessions[session.ID] = session
}

func (s *SessionStore) Get(id string) (*Session, bool) {
    s.mu.RLock()
    defer s.mu.RUnlock()
    session, ok := s.sessions[id]
    if !ok || time.Now().After(session.ExpiresAt) {
        return nil, false
    }
    return session, true
}

func (s *SessionStore) Delete(id string) {
    s.mu.Lock()
    defer s.mu.Unlock()
    delete(s.sessions, id)
}

func (s *SessionStore) Cleanup() {
    s.mu.Lock()
    defer s.mu.Unlock()
    now := time.Now()
    for id, session := range s.sessions {
        if now.After(session.ExpiresAt) {
            delete(s.sessions, id)
        }
    }
}
```

---

## Engine Resolution

### Config Loading

**config.go:**

```go
package config

import (
    "encoding/json"
    "os"
)

type EngineConfig struct {
    Default map[string]string            `json:"default"`
    Users   map[string]map[string]string `json:"users"`
    Groups  map[string]map[string]string `json:"groups"`
}

func LoadEnginesConfig(path string) (*EngineConfig, error) {
    data, err := os.ReadFile(path)
    if err != nil {
        return nil, err
    }
    
    var cfg EngineConfig
    if err := json.Unmarshal(data, &cfg); err != nil {
        return nil, err
    }
    
    return &cfg, nil
}
```

### Resolver

**resolver.go:**

```go
package engines

import (
    "sync"
)

type Resolver struct {
    config *config.EngineConfig
}

func NewResolver(cfg *config.EngineConfig) *Resolver {
    return &Resolver{config: cfg}
}

func (r *Resolver) Resolve(userID string) (map[string]string, error) {
    // Check user-specific config
    if userEngines, ok := r.config.Users[userID]; ok {
        return userEngines, nil
    }
    
    // Fall back to defaults
    if r.config.Default != nil {
        return r.config.Default, nil
    }
    
    return map[string]string{}, nil
}
```

### Injector

**injector.go:**

```go
package engines

import (
    "encoding/json"
    "net/http"
)

func InjectSecrets(r *http.Request, secrets map[string]string) *http.Request {
    for engine, secret := range secrets {
        auth := map[string]string{
            "type":  "token",
            "token": secret,
        }
        data, _ := json.Marshal(auth)
        r.Header.Set("X-Authenticated-Engine-"+engine, string(data))
    }
    return r
}
```

---

## Reverse Proxy

**server.go:**

```go
package proxy

import (
    "net/http"
    "net/http/httputil"
    "net/url"
)

type Server struct {
    reverseProxy *httputil.ReverseProxy
    targetURL    *url.URL
}

func NewServer(targetURL string) (*Server, error) {
    url, err := url.Parse(targetURL)
    if err != nil {
        return nil, err
    }
    
    proxy := httputil.NewSingleHostReverseProxy(url)
    proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
        // Log and return 502
        http.Error(w, "Bad Gateway", http.StatusBadGateway)
    }
    
    return &Server{
        reverseProxy: proxy,
        targetURL:    url,
    }, nil
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    s.reverseProxy.ServeHTTP(w, r)
}
```

---

## Testing

### Unit Tests

**oidc_test.go:**

```go
package auth

import (
    "testing"
    "net/http"
    "net/http/httptest"
)

func TestLoginRedirect(t *testing.T) {
    provider := &OIDCProvider{
        config: &oauth2.Config{
            ClientID:     "test",
            ClientSecret: "test",
            RedirectURL:  "http://localhost:8080/callback",
            Endpoint: oauth2.Endpoint{
                AuthURL:  "https://idp.test/authorize",
                TokenURL: "https://idp.test/token",
            },
        },
    }
    
    handler := &Handler{oidc: provider}
    
    req := httptest.NewRequest("GET", "/login", nil)
    w := httptest.NewRecorder()
    
    handler.Login(w, req)
    
    if w.Code != http.StatusTemporaryRedirect {
        t.Errorf("Expected 307, got %d", w.Code)
    }
    
    location := w.Header().Get("Location")
    if !strings.Contains(location, "idp.test/authorize") {
        t.Errorf("Expected redirect to IdP, got %s", location)
    }
}
```

**resolver_test.go:**

```go
package engines

import (
    "testing"
    "encoding/json"
    "os"
)

func TestResolve(t *testing.T) {
    // Create temp config
    cfg := &config.EngineConfig{
        Default: map[string]string{
            "bing": "default-key",
        },
        Users: map[string]map[string]string{
            "alice@example.com": {
                "bing": "alice-key",
                "netbox": "alice-netbox",
            },
        },
    }
    
    resolver := NewResolver(cfg)
    
    // Test user-specific
    secrets, err := resolver.Resolve("alice@example.com")
    if err != nil {
        t.Fatal(err)
    }
    if secrets["bing"] != "alice-key" {
        t.Errorf("Expected alice-key, got %s", secrets["bing"])
    }
    
    // Test fallback
    secrets, err = resolver.Resolve("bob@example.com")
    if err != nil {
        t.Fatal(err)
    }
    if secrets["bing"] != "default-key" {
        t.Errorf("Expected default-key, got %s", secrets["bing"])
    }
}
```

### Integration Tests

**integration_test.go:**

```go
package main

import (
    "net/http"
    "net/http/httptest"
    "testing"
)

func TestFullFlow(t *testing.T) {
    // Start mock IdP
    idp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        if r.URL.Path == "/authorize" {
            http.Redirect(w, r, "/callback?code=test", http.StatusTemporaryRedirect)
        } else if r.URL.Path == "/callback" {
            w.Write([]byte("access_token=test&token_type=Bearer"))
        }
    }))
    defer idp.Close()
    
    // Start mock SearXNG
    searxng := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // Check auth header
        auth := r.Header.Get("X-Authenticated-Engine-NetBox")
        if auth == "" {
            t.Error("Expected auth header")
        }
        w.Write([]byte(`{"results": []}`))
    }))
    defer searxng.Close()
    
    // Start sidecar
    sidecar := startSidecar(idp.URL, searxng.URL)
    defer sidecar.Close()
    
    // Simulate user flow
    client := &http.Client{
        CheckRedirect: func(req *http.Request, via []*http.Request) error {
            return http.ErrUseLastResponse
        },
    }
    
    // Login
    resp, _ := client.Get(sidecar.URL + "/login")
    cookie := resp.Cookies()[0]
    
    // Search
    req, _ := http.NewRequest("GET", sidecar.URL+"/search?q=test", nil)
    req.AddCookie(cookie)
    resp, _ = client.Do(req)
    
    if resp.StatusCode != http.StatusOK {
        t.Errorf("Expected 200, got %d", resp.StatusCode)
    }
}
```

---

## References

- [golang.org/x/oauth2](https://pkg.go.dev/golang.org/x/oauth2) — OAuth 2.0 client
- [net/http](https://pkg.go.dev/net/http) — HTTP server
- [net/http/httputil](https://pkg.go.dev/net/http/httputil) — Reverse proxy
- [golang.org/x/crypto](https://pkg.go.dev/golang.org/x/crypto) — Cryptography
- [gorilla/sessions](https://pkg.go.dev/github.com/gorilla/sessions) — Session management
- [Go Testing](https://go.dev/doc/tutorial/add-a-test) — Testing guide
- [httptest](https://pkg.go.dev/net/http/httptest) — HTTP test utilities

---

## Checklist

- [ ] Initialize Go module (`go mod init`)
- [ ] Add dependencies (`go get golang.org/x/oauth2`)
- [ ] Implement config loading
- [ ] Implement OIDC provider
- [ ] Implement session store
- [ ] Implement auth handlers (login, callback, logout)
- [ ] Implement engine resolver
- [ ] Implement header injector
- [ ] Implement reverse proxy
- [ ] Write unit tests
- [ ] Write integration tests
- [ ] Add rate limiting middleware
- [ ] Add structured logging
- [ ] Add health check endpoint
- [ ] Test with mock IdP and SearXNG
