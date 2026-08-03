"""
Custom NetBox engine for SearXNG.
Reads the user's NetBox token from the X-Engine-Secret-netbox header.
"""

# Engine metadata
about = {
    "website": "https://netbox.example.com",
    "wikidata_id": None,
    "official_api_documentation": "https://netbox.example.com/api/docs/",
    "use_official_api": False,
    "require_api_key": False,
    "results": "JSON",
}

# Engine config
engine = "netbox"
engine_type = "online"

# Default search URL (overridden per-user via injected token)
base_url = "https://netbox.example.com"


def search(request, params):
    """
    Search NetBox for devices, IPs, prefixes, etc.
    Uses the user's token from the injected header.
    """
    # Get the user's NetBox token from the header set by the SearXNG plugin
    secret = request.headers.get("X-Engine-Secret-netbox")
    
    if not secret:
        return []
    
    # Construct the API request with the user's token
    url = f"{base_url}/api/"
    headers = {
        "Authorization": f"Token {secret}",
        "Accept": "application/json",
    }
    
    # Add query parameters
    query = params.get("query", "")
    if query:
        url = f"{base_url}/api/dcim/devices/?q={query}"
    
    # Make the request
    import requests
    response = requests.get(url, headers=headers, timeout=10)
    
    if response.status_code != 200:
        return []
    
    # Parse results
    data = response.json()
    results = []
    
    for item in data.get("results", []):
        results.append({
            "url": f"{base_url}/devices/{item['id']}/",
            "title": item.get("name", "Unknown"),
            "content": f"Device: {item.get('name')}, Site: {item.get('site', {}).get('name', 'Unknown')}",
        })
    
    return results
