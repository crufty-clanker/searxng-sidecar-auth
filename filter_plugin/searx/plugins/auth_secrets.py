"""
SearXNG Plugin: Auth Secrets Filter

Filters the X-Authenticated-Engines-Secrets header per engine,
ensuring each engine only sees its own secret.

This plugin should be installed in:
  /etc/searxng/searx/plugins/auth_secrets.py
"""

import json


def on_request(engine_name, params, headers):
    """
    Intercept each engine request and inject only that engine's secret.
    
    Args:
        engine_name: The name of the engine being called (e.g., 'netbox')
        params: The search parameters
        headers: The request headers
    
    Returns:
        Modified headers with only the relevant secret injected
    """
    # Get all secrets from the sidecar
    secrets_header = headers.get('X-Authenticated-Engines-Secrets', '{}')
    
    try:
        secrets = json.loads(secrets_header)
    except (json.JSONDecodeError, TypeError):
        return headers
    
    # Extract only the secret for this engine
    secret = secrets.get(engine_name)
    
    if secret:
        # Inject the engine-specific secret header
        headers[f'X-Engine-Secret-{engine_name}'] = secret
    
    return headers


def on_result(result, search):
    """
    Optional: Filter or modify results before returning to the user.
    Currently not needed.
    """
    return result
