#!/usr/bin/env python3
"""Claim an install name through the HTTPS registry. Requires python3-cryptography.

Run claim, expose --webroot through Caddy on HTTP port 80 at
/.well-known/openflow-claim (including Host claim.openflow.invalid), then confirm.
The private state must persist with the install; only --public-state is for the app.
"""
from __future__ import annotations

import argparse
import base64
import fcntl
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey


def b64(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode().rstrip('=')


def write_json(path: Path, value: dict, mode=0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.' + secrets.token_hex(8))
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    try:
        with os.fdopen(fd, 'w') as out:
            json.dump(value, out, indent=2)
            out.write('\n')
            out.flush()
            os.fsync(out.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def request(registry: str, endpoint: str, payload=None) -> dict:
    parsed = urllib.parse.urlsplit(registry)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError('Registry must be an HTTPS origin without credentials')
    req = urllib.request.Request(registry.rstrip('/') + endpoint,
                                 data=None if payload is None else json.dumps(payload).encode(),
                                 headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.build_opener(NoRedirect()).open(req, timeout=20) as response:
            result = json.loads(response.read(16384))
    except urllib.error.HTTPError as error:
        # Never print a server response containing claim material.
        raise RuntimeError(f'Registry refused the request (HTTP {error.code})') from None
    if not isinstance(result, dict):
        raise ValueError('Invalid registry response')
    return result


def run(action: str, directory: Path, webroot: Path, public_state: Path,
        registry: str, domain: str, ip: str, call=request) -> dict:
    address = ipaddress.ip_address(ip)
    if address.version != 4 or not address.is_global or address.is_multicast:
        raise ValueError('A public IPv4 address is required')
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    directory.chmod(0o700)
    key_path = directory / 'install-key.pem'
    state_path = directory / 'claim.json'
    challenge = webroot / '.well-known' / 'openflow-claim'
    if not key_path.exists():
        if action != 'claim':
            raise ValueError('No install key; run claim first')
        key = Ed25519PrivateKey.generate()
        fd = os.open(key_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'wb') as out:
            out.write(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                        serialization.NoEncryption()))
    key = serialization.load_pem_private_key(key_path.read_bytes(), password=None)
    state = json.loads(state_path.read_text()) if state_path.exists() else None
    if state and (state['registryUrl'] != registry or state['installDomain'] != domain):
        raise ValueError('Existing claim belongs to a different registry/base')
    if action == 'claim' and not state:
        # Persist before the network call: an interrupted claim must not be replayed blindly.
        state = {'registryUrl': registry, 'installDomain': domain, 'ip': ip, 'state': 'claiming'}
        write_json(state_path, state)
        public_key = b64(key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw))
        result = call(registry, '/v1/claim', {'public_key': public_key, 'ip': ip})
        name, token = result.get('name', ''), result.get('token', '')
        if not re.fullmatch(r'[a-z]+-[a-z]+-[0-9]{4}\.' + re.escape(domain), name):
            raise ValueError('Registry returned a name outside the configured install base')
        if not isinstance(token, str) or not re.fullmatch(r'[A-Za-z0-9_-]{20,180}', token):
            raise ValueError('Registry returned an invalid challenge')
        state.update(name=name, token=token, state='pending', expiresAt=int(time.time()) + int(result['expires_in']))
        write_json(state_path, state)
    if not state or state['state'] == 'claiming':
        raise ValueError('Claim outcome unknown; reconcile it with the registry before another claim')
    name = state['name']
    if action == 'claim' and state['state'] == 'pending':
        challenge.parent.mkdir(parents=True, exist_ok=True)
        challenge.write_text(state['token'])
        challenge.chmod(0o644)
    if action == 'confirm':
        current = call(registry, '/v1/status?name=' + urllib.parse.quote(name))
        if current.get('state') != 'active':
            if state['state'] != 'pending' or int(time.time()) > state['expiresAt']:
                raise ValueError('Claim expired or unavailable; reconcile the saved claim before retrying')
            message = f"openflow-names/confirm\n{name}\n{state['token']}".encode()
            current = call(registry, '/v1/confirm', {'name': name, 'signature': b64(key.sign(message))})
        if current.get('state') != 'active':
            raise ValueError('Registry has not activated the name')
        state['state'] = 'active'
        state.pop('token', None)
        write_json(state_path, state)
        challenge.unlink(missing_ok=True)
    if action == 'update':
        if state['state'] != 'active':
            raise ValueError('Only an active name can be updated')
        ts, nonce = int(time.time()), secrets.token_urlsafe(24)
        message = f'openflow-names/update\n{name}\n{ip}\n{ts}\n{nonce}'.encode()
        result = call(registry, '/v1/update', {'name': name, 'ip': ip, 'ts': ts, 'nonce': nonce,
                                             'signature': b64(key.sign(message))})
        if result.get('state') != 'active':
            raise ValueError('Registry did not confirm the update')
        state['ip'] = ip
        write_json(state_path, state)
    result = {field: state[field] for field in ('registryUrl', 'installDomain', 'ip', 'name', 'state')}
    result['fallbackHost'] = state['ip'].replace('.', '-') + '.sslip.io'
    if action == 'status':
        current = call(registry, '/v1/status?name=' + urllib.parse.quote(name))
        result.update(state=current.get('state', 'pending'), pointed=current.get('pointed') is True)
    write_json(public_state, result, 0o644)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['claim', 'confirm', 'status', 'update'])
    parser.add_argument('--state-dir', type=Path, required=True)
    parser.add_argument('--webroot', type=Path, required=True)
    parser.add_argument('--public-state', type=Path, required=True)
    parser.add_argument('--ip', required=True)
    parser.add_argument('--registry', default='https://names.openflow-ai.com')
    parser.add_argument('--base', default='my.openflow-ai.com')
    args = parser.parse_args()
    args.state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (args.state_dir / 'operation.lock').open('a') as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        result = run(args.action, args.state_dir, args.webroot, args.public_state,
                     args.registry, args.base, args.ip)
    print(json.dumps(result))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, RuntimeError, OSError) as error:
        raise SystemExit(str(error)) from None
