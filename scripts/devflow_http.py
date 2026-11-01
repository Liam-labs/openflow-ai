"""Authenticated requests to this installation, without forwarding its token on redirects."""
import os
import urllib.parse
import urllib.request


def _origin(url):
    parsed = urllib.parse.urlsplit(url)
    return (parsed.scheme, parsed.hostname, parsed.port or (443 if parsed.scheme == 'https' else 80))


def urlopen(url, *args, **kwargs):
    token = os.environ.get('DEVFLOW_API_TOKEN') or os.environ.get('DEVFLOW_FULL_ACCESS_TOKEN')
    address = url.full_url if isinstance(url, urllib.request.Request) else url
    own_url = os.environ.get('DEVFLOW_URL', 'http://localhost:3000')
    if token and _origin(address) == _origin(own_url):
        request = url if isinstance(url, urllib.request.Request) else urllib.request.Request(url)
        # urllib copies ordinary headers on redirects. Never redirect the server credential.
        request.remove_header('Authorization')
        request.add_unredirected_header('Authorization', 'Bearer ' + token)
        url = request
    return urllib.request.urlopen(url, *args, **kwargs)
