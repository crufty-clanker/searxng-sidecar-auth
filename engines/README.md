# SearXNG Custom Engines

This directory contains custom SearXNG engines that require per-user authentication.

## How It Works

1. The sidecar sends `X-Authenticated-Engines-Secrets: {"netbox": "nb_tok_abc"}`
2. The SearXNG filter plugin extracts `secrets["netbox"]` and sets `X-Engine-Secret-netbox`
3. This engine reads `X-Engine-Secret-netbox` to get the user's token

## Adding a New Engine

1. Create a new Python file in this directory
2. Implement the `search(request, params)` function
3. Read the user's token from `request.headers.get('X-Engine-Secret-<engine_name>')`
4. Use it to authenticate with the upstream API
5. Return results in SearXNG format

## Example Engine Structure

```python
# searx/engines/<engine_name>.py

def search(request, params):
    secret = request.headers.get(f'X-Engine-Secret-{engine_name}')
    if not secret:
        return []
    
    # Use secret to authenticate
    headers = {'Authorization': f'Token {secret}'}
    response = requests.get(url, headers=headers)
    
    # Parse and return results
    return [...]
```
