# SearXNG Engine Implementation Guide

This document provides a detailed guide for implementing custom SearXNG engines that consume per-user authentication secrets from the sidecar.

## Table of Contents

- [Engine Structure](#engine-structure)
- [Core Functions](#core-functions)
- [Example: Authenticated NetBox Engine](#example-authenticated-netbox-engine)
- [Testing](#testing)
- [Configuration](#configuration)
- [References](#references)

---

## Engine Structure

A SearXNG engine is a Python module with a specific structure:

```
engines/
└── authenticated_netbox.py     # The engine module
```

The module must define:
- Module-level variables (categories, paging, etc.)
- `about` metadata
- `request(query, params)` function
- `response(resp)` function

---

## Core Functions

### `request(query, params)`

Builds the HTTP request parameters. Receives the search query and SearXNG's params dict.

**Signature:**
```python
def request(query: str, params: "OnlineParams") -> None:
    """
    Args:
        query: The search query string
        params: Dict with url, headers, method, cookies, etc.
    
    Modifies params in-place. Returns None.
    """
```

**Params dict keys:**
| Key | Type | Description |
|-----|------|-------------|
| `url` | str | Request URL |
| `method` | str | HTTP method (GET, POST, etc.) |
| `headers` | dict | HTTP headers |
| `cookies` | dict | HTTP cookies |
| `data` | dict | POST data |
| `verify` | bool | SSL verification |
| `pageno` | int | Current page number |
| `category` | str | Search category |

### `response(resp)`

Parses the HTTP response and returns results.

**Signature:**
```python
def response(resp: "SXNG_Response") -> "EngineResults":
    """
    Args:
        resp: The HTTP response object (has .json(), .text, .status_code, etc.)
    
    Returns:
        EngineResults object containing parsed results
    """
```

---

## Example: Authenticated NetBox Engine

### Module Variables

```python
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Authenticated NetBox engine for SearXNG."""

import json
import typing as t

from searx.result_types import EngineResults
from searx.enginelib import EngineAbout

engine_type = "online"
categories = ["it"]
paging = False
page_size = 20
timeout = 10.0

about = EngineAbout(
    website="https://netbox.example.com",
    official_api_documentation="https://netbox.example.com/api/docs/",
    use_official_api=True,
    require_api_key=False,  # Auth comes from sidecar
    results="JSON",
)
```

### Request Function

```python
def request(query: str, params: "OnlineParams") -> None:
    """Build the NetBox API request with authentication."""
    
    # Read auth secret from sidecar header
    auth_header = params['headers'].get('X-Authenticated-Engine-NetBox')
    if not auth_header:
        raise Exception("Missing NetBox authentication from sidecar")
    
    auth = json.loads(auth_header)
    
    # Extract token based on auth type
    token = None
    if auth.get('type') == 'token':
        token = auth['token']
    elif auth.get('type') == 'bearer':
        token = auth['bearer']
    else:
        raise Exception(f"Unsupported auth type: {auth.get('type')}")
    
    # Build API URL
    base_url = "https://netbox.example.com/api"
    search_url = f"{base_url}/dcim/devices/?q={query}"
    
    # Set headers with auth
    params['url'] = search_url
    params['headers']['Authorization'] = f'Token {token}'
    params['headers']['Accept'] = 'application/json'
```

### Response Function

```python
def response(resp: "SXNG_Response") -> EngineResults:
    """Parse NetBox API response into SearXNG results."""
    res = EngineResults()
    
    try:
        data = resp.json()
    except Exception:
        return res
    
    for device in data.get('results', []):
        kwargs = {
            'url': f"https://netbox.example.com/dcim/devices/{device['id']}/",
            'title': f"{device['display']} ({device['device_type']['model']})",
            'content': f"Status: {device['status']['label']} | Site: {device['site']['display']}",
            'engine': 'authenticated_netbox',
            'template': 'default.html',
        }
        res.add(res.types.LegacyResult(**kwargs))
    
    return res
```

---

## Testing

### Unit Tests

Create test files in the same directory:

```
engines/
├── authenticated_netbox.py
└── tests/
    ├── __init__.py
    └── test_authenticated_netbox.py
```

**test_authenticated_netbox.py:**

```python
"""Tests for authenticated_netbox engine."""

import json
import pytest
from unittest.mock import Mock, patch
from searx.result_types import EngineResults


class TestRequest:
    """Test the request function."""
    
    def test_missing_auth_header(self):
        """Should raise exception when auth header is missing."""
        from authenticated_netbox import request
        params = {'headers': {}}
        
        with pytest.raises(Exception, match="Missing NetBox authentication"):
            request("test query", params)
    
    def test_token_auth(self):
        """Should set Authorization header with token."""
        from authenticated_netbox import request
        params = {
            'headers': {},
            'url': '',
        }
        
        auth = json.dumps({'type': 'token', 'token': 'nb_tok_123'})
        params['headers']['X-Authenticated-Engine-NetBox'] = auth
        
        request("switch", params)
        
        assert params['headers']['Authorization'] == 'Token nb_tok_123'
        assert 'netbox.example.com/api' in params['url']
    
    def test_bearer_auth(self):
        """Should handle bearer token auth."""
        from authenticated_netbox import request
        params = {
            'headers': {},
            'url': '',
        }
        
        auth = json.dumps({'type': 'bearer', 'bearer': 'eyJhbGc...'})
        params['headers']['X-Authenticated-Engine-NetBox'] = auth
        
        request("router", params)
        
        assert params['headers']['Authorization'] == 'Bearer eyJhbGc...'


class TestResponse:
    """Test the response function."""
    
    def test_parse_results(self):
        """Should parse NetBox API response into SearXNG results."""
        from authenticated_netbox import response
        
        mock_resp = Mock()
        mock_resp.json.return_value = {
            'results': [
                {
                    'id': 1,
                    'display': 'sw-core-01',
                    'device_type': {'model': 'CX4130-48Y'},
                    'status': {'label': 'active'},
                    'site': {'display': 'DC1'},
                }
            ]
        }
        
        res = response(mock_resp)
        
        assert len(res) == 1
        assert res[0]['title'] == 'sw-core-01 (CX4130-48Y)'
        assert 'active' in res[0]['content']
    
    def test_empty_results(self):
        """Should return empty results for no matches."""
        from authenticated_netbox import response
        
        mock_resp = Mock()
        mock_resp.json.return_value = {'results': []}
        
        res = response(mock_resp)
        
        assert len(res) == 0
```

### Integration Tests

Test with a real SearXNG instance:

```bash
# Start SearXNG with your engine
docker-compose up -d searxng

# Run search via SearXNG API
curl "http://localhost:8888/search?q=switch&engines=authenticated_netbox" \
  -H "X-Authenticated-Engine-NetBox: {\"type\": \"token\", \"token\": \"nb_tok_123\"}"
```

---

## Configuration

### settings.yml

Add your engine to SearXNG's `settings.yml`:

```yaml
engines:
  - name: NetBox (Authenticated)
    engine: authenticated_netbox
    shortcut: nb
    disabled: false
    categories: it
    timeout: 10
```

### Engine Module

The engine module can override settings:

```python
# Override categories from settings
categories = ['it']

# Enable paging if supported
paging = False

# Set page size
page_size = 20

# Timeout
timeout = 10
```

---

## References

- [SearXNG Engine Overview](https://docs.searxng.org/dev/engines/engine_overview.html)
- [SearXNG Engine Library](https://docs.searxng.org/dev/engines/enginelib.html)
- [SearXNG Result Types](https://docs.searxng.org/dev/result_types/index.html)
- [Demo Online Engine](https://docs.searxng.org/dev/engines/demo/demo_online.html)
- [SearXNG Source: wikipedia.py](https://github.com/searxng/searxng/blob/master/searx/engines/wikipedia.py)
- [SearXNG Source: demo_online.py](https://github.com/searxng/searxng/blob/master/searx/engines/demo_online.py)

---

## Checklist

- [ ] Create engine module (`authenticated_netbox.py`)
- [ ] Define module variables (categories, paging, timeout)
- [ ] Define `about` metadata
- [ ] Implement `request()` function
  - [ ] Read `X-Authenticated-Engine-{engine}` header
  - [ ] Parse JSON payload
  - [ ] Extract token based on `type` field
  - [ ] Set `Authorization` header
  - [ ] Build API URL
- [ ] Implement `response()` function
  - [ ] Parse JSON response
  - [ ] Map to SearXNG result types
  - [ ] Add results to `EngineResults`
- [ ] Write unit tests
  - [ ] Test `request()` with valid/invalid auth
  - [ ] Test `response()` with mock API responses
  - [ ] Test error handling
- [ ] Add to SearXNG `settings.yml`
- [ ] Test with SearXNG instance
- [ ] Test with sidecar integration
