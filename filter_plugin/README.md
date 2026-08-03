# SearXNG Auth Secrets Filter Plugin

This plugin filters the `X-Authenticated-Engines-Secrets` header sent by the sidecar,
ensuring each engine only sees its own secret.

## Installation

1. Copy the plugin to your SearXNG plugins directory:
   ```bash
   cp searx/plugins/auth_secrets.py /path/to/searxng/searx/plugins/
   ```

2. Ensure the plugins directory is enabled in SearXNG config:
   ```yaml
   # settings.yml
   use_default_settings: true
   ```

3. Restart SearXNG

## How It Works

1. The sidecar sends all user secrets in one header:
   ```
   X-Authenticated-Engines-Secrets: {"netbox": "nb_tok_abc", "bing": "bing_key_xyz"}
   ```

2. The plugin intercepts each engine request and extracts only the matching secret:
   ```python
   # For the netbox engine:
   secret = secrets.get('netbox')  # Returns "nb_tok_abc"
   headers['X-Engine-Secret-netbox'] = secret
   ```

3. The engine reads `X-Engine-Secret-<engine_name>` and uses it to authenticate.

## Security

- Each engine only sees its own secret
- Standard engines (DuckDuckGo, Wikipedia) don't look for auth headers
- Short-lived tokens (5-15 min) limit exposure
- The header is stripped from responses to prevent leakage
