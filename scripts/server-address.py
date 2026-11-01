#!/usr/bin/env python3
"""Automatic host-side name/proof/HTTPS provisioning, invoked by server setup."""
from __future__ import annotations

import argparse
import fcntl
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import re
import shutil
import socket
import ssl
import subprocess
import time
import urllib.error
import urllib.request

spec = importlib.util.spec_from_file_location('setup_name', Path(__file__).with_name('setup-name.py'))
names = importlib.util.module_from_spec(spec)
spec.loader.exec_module(names)


def public_ip() -> str:
    rows = json.loads(subprocess.check_output(['ip', '-j', '-4', 'address', 'show', 'scope', 'global']))
    for interface in rows:
        for entry in interface.get('addr_info', []):
            value = entry.get('local', '')
            if value and ipaddress.ip_address(value).is_global:
                return value
    with urllib.request.urlopen('https://api.ipify.org', timeout=10) as response:
        value = response.read(64).decode().strip()
    parsed = ipaddress.ip_address(value)
    if parsed.version != 4 or not parsed.is_global:
        raise ValueError('Could not discover the public IPv4 address')
    return value


def network_unreachable(error: Exception) -> bool:
    # HTTP refusal, bad TLS, invalid responses, quota/proof errors are explicit failures.
    if isinstance(error, urllib.error.HTTPError):
        return False
    reason = error.reason if isinstance(error, urllib.error.URLError) else error
    return not isinstance(reason, ssl.SSLError) and isinstance(reason, (socket.gaierror, TimeoutError, ConnectionError))


def caddy_fragment(fragment: Path, content: str, config: Path) -> None:
    """Add only our exact managed import, validate before loading, preserve other sites."""
    fragment.parent.mkdir(parents=True, exist_ok=True)
    previous_fragment = fragment.read_text() if fragment.exists() else None
    previous_config = config.read_text() if config.exists() else ''
    # A Caddyfile path is code; do not allow a caller's path to inject directives.
    if not re.fullmatch(r'/[A-Za-z0-9_./-]+', str(fragment)):
        raise ValueError('Unsupported Caddy fragment path')
    directive = 'import ' + str(fragment)
    config.parent.mkdir(parents=True, exist_ok=True)
    if not content.strip():
        # Caddy rejects an empty import; there is no site to import here.
        # The main config already owns this site: remove our import on retries.
        config.write_text('\n'.join(line for line in previous_config.splitlines()
                                    if line.strip() != directive) + '\n')
        content = '# Site already provided by the main Caddyfile; not imported.\n'
    elif directive not in previous_config.splitlines():
        config.write_text(previous_config.rstrip() + '\n' + directive + '\n')
    fragment.write_text(content)
    result = subprocess.run(['caddy', 'validate', '--config', str(config)], capture_output=True)
    if result.returncode:
        config.write_text(previous_config)
        if previous_fragment is None:
            fragment.unlink()
        else:
            fragment.write_text(previous_fragment)
        raise RuntimeError('Caddy rejected the address configuration; previous configuration restored')
    subprocess.run(['systemctl', 'enable', '--now', 'caddy'], check=True, stdout=subprocess.DEVNULL)
    subprocess.run(['systemctl', 'reload', 'caddy'], check=True)


def trusted_tls(host: str, ip: str) -> bool:
    # DNS must resolve to the claimed server; handshake validates hostname, chain and dates.
    if ip not in {entry[4][0] for entry in socket.getaddrinfo(host, 443, socket.AF_INET)}:
        return False
    with socket.create_connection((ip, 443), timeout=5) as connection:
        with ssl.create_default_context().wrap_socket(connection, server_hostname=host):
            return True


def provision(state_dir: Path, public_state: Path, webroot: Path, fragment: Path,
              caddy_config: Path, registry: str, base: str, ip: str, port: int,
              timeout: int = 180) -> dict:
    result = {'url': '', 'state': 'claiming', 'source': 'managed'}
    def save():
        names.write_json(public_state, result, 0o644)
    save()
    parsed_ip = ipaddress.ip_address(ip)
    if parsed_ip.version != 4 or not parsed_ip.is_global or parsed_ip.is_multicast:
        raise ValueError('A public IPv4 address is required')
    if not 1 <= port <= 65535:
        raise ValueError('Invalid upstream port')
    if not re.fullmatch(r'/[A-Za-z0-9_./-]+', str(webroot)):
        raise ValueError('Unsupported proof directory')
    challenge_config = ('http://claim.openflow.invalid {\n'
                        '    handle /.well-known/openflow-claim {\n'
                        f'        root * {webroot}\n        file_server\n    }}\n    handle {{\n        respond 404\n    }}\n}}\n')
    try:
        if not shutil.which('caddy'):
            raise RuntimeError('Caddy must be installed before server address setup')
        state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        webroot.mkdir(parents=True, exist_ok=True, mode=0o755)
        raw_state = state_dir / 'public-claim.json'
        # Reuse a saved claim without another health/claim request on reinstall.
        existing = json.loads((state_dir / 'claim.json').read_text()) if (state_dir / 'claim.json').exists() else None
        fallback = False
        if existing is None:
            try:
                names.request(registry, '/v1/health')
            except Exception as error:
                if not network_unreachable(error):
                    raise
                fallback = True
        if fallback:
            host = ip.replace('.', '-') + '.sslip.io'
            result.update(url='https://' + host, source='fallback', reason='unreachable')
        else:
            claim = names.run('claim', state_dir, webroot, raw_state, registry, base, ip)
            host = claim['name']
            result['url'] = 'https://' + host
            save()
            if claim['state'] != 'active':
                caddy_fragment(fragment.parent / 'openflow-claim.caddy', challenge_config, caddy_config)
            names.run('confirm', state_dir, webroot, raw_state, registry, base, ip)
            if claim['ip'] != ip:
                names.run('update', state_dir, webroot, raw_state, registry, base, ip)
        result['state'] = 'certificate'
        save()
        site = f'{host} {{\n    tls {{\n        issuer acme\n    }}\n    reverse_proxy 127.0.0.1:{port}\n}}\n'
        if caddy_config.exists() and re.search(r'^' + re.escape(host) + r'\s*\{', caddy_config.read_text(), re.M):
            site = ''  # Retain an existing fallback site instead of declaring it twice.
        caddy_fragment(fragment, site, caddy_config)
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                if trusted_tls(host, ip):
                    result['state'] = 'ready'
                    save()
                    return result
            except (OSError, ssl.SSLError):
                pass
            time.sleep(3)
        raise RuntimeError('The selected address has not passed public DNS and trusted HTTPS checks. Retry setup; the same name will be reused.')
    except Exception as error:
        result.update(state='failed', reason=str(error)[:400])
        save()
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state-dir', type=Path, required=True)
    parser.add_argument('--public-state', type=Path, required=True)
    parser.add_argument('--webroot', type=Path, default=Path('/var/lib/openflow-claim'))
    parser.add_argument('--fragment', type=Path, default=Path('/etc/caddy/openflow-install.caddy'))
    parser.add_argument('--caddy-config', type=Path, default=Path('/etc/caddy/Caddyfile'))
    parser.add_argument('--registry', default='https://names.openflow-ai.com')
    parser.add_argument('--base', default='my.openflow-ai.com')
    parser.add_argument('--ip')
    parser.add_argument('--port', type=int, default=3000)
    parser.add_argument('--timeout', type=int, default=180)
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error('Server network setup requires administrator access (run through the installer).')
    args.state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    # All installs on this host share port 80's proof path. Serialize across projects.
    with Path('/run/lock/openflow-name-provision.lock').open('a') as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        result = provision(args.state_dir, args.public_state, args.webroot, args.fragment,
                           args.caddy_config, args.registry, args.base, args.ip or public_ip(), args.port, args.timeout)
    print(json.dumps(result))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, RuntimeError, OSError, subprocess.CalledProcessError) as error:
        raise SystemExit(str(error)) from None
