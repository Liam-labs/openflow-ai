#!/usr/bin/env python3
"""Install a Docker server with its automatic managed hostname and HTTPS."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess


def prepare_appdata(image, volume):
    """Match the volume root and installer result to the image's app user.

    Writing the address before first mount prevents Docker's empty-volume
    ownership initialization. Do not recursively change existing user data.
    """
    subprocess.run([
        'docker', 'run', '--rm', '--network', 'none', '--user', '0:0',
        '--entrypoint', 'python3', '-v', volume + ':/appdata', image, '-c',
        "import os,pwd; u=pwd.getpwnam('node'); "
        "os.chown('/appdata',u.pw_uid,u.pw_gid); "
        "p='/appdata/install-address.json'; "
        "os.path.exists(p) and os.chown(p,u.pw_uid,u.pw_gid)",
    ], check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', help='Use this already-built immutable image instead of building')
    parser.add_argument('--project', default='openflow-ai')
    parser.add_argument('--container', default='openflow')
    parser.add_argument('--port', type=int, default=3000)
    parser.add_argument('--configure-only', action='store_true', help='Configure an existing deployment; do not recreate its containers')
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error('Run scripts/setup-server; it requests administrator access for the host configuration')
    if not re.fullmatch(r'[a-z0-9][a-z0-9_-]*', args.project) or not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]*', args.container):
        parser.error('Invalid Compose project or container name')
    if not 1 <= args.port <= 65535:
        parser.error('Invalid port')
    repo = Path(__file__).resolve().parent.parent
    subprocess.run(['docker', 'compose', 'version'], check=True, stdout=subprocess.DEVNULL)
    volume = args.project + '_openflow-appdata'
    subprocess.run(['docker', 'volume', 'create', volume], check=True, stdout=subprocess.DEVNULL)
    mount = Path(subprocess.check_output(['docker', 'volume', 'inspect', volume, '--format', '{{.Mountpoint}}'], text=True).strip())
    state = mount / 'install-address.json'
    network = ['/usr/bin/python3', str(repo / 'scripts/server-address.py'),
               '--state-dir', '/var/lib/openflow-install-name/' + args.project,
               '--public-state', str(state), '--port', str(args.port),
               '--fragment', '/etc/caddy/openflow-' + args.project + '.caddy']
    subprocess.run(network, check=True)
    address = json.loads(state.read_text())
    if address['state'] != 'ready':
        raise SystemExit('Address provisioning did not finish')
    image = args.image or 'openflow-ai:local'
    if not args.image:
        subprocess.run(['docker', 'build', '-t', image, str(repo)], check=True)
    prepare_appdata(image, volume)
    host = address['url'].removeprefix('https://')
    saved_claim = Path('/var/lib/openflow-install-name') / args.project / 'public-claim.json'
    fallback = json.loads(saved_claim.read_text())['fallbackHost'] if saved_claim.exists() else host
    hosts = list(dict.fromkeys(['localhost', '127.0.0.1', host, fallback]))
    origins = list(dict.fromkeys(['https://' + host, 'https://' + fallback]))
    service = {'container_name': args.container, 'environment': {
        'DEVFLOW_SERVER_MODE': '1', 'DEVFLOW_REQUIRE_TOKEN': '1', 'OPENFLOW_HOST': host,
        'DEVFLOW_ALLOWED_HOSTS': ','.join(hosts), 'DEVFLOW_ALLOWED_ORIGINS': ','.join(origins),
    }}
    if args.image:
        service['image'] = args.image
    override = repo / ('docker-compose.address.' + args.project + '.json')
    override.write_text(json.dumps({'services': {'openflow': service}}, indent=2) + '\n')
    if not args.configure_only:
        env = dict(os.environ, OPENFLOW_PORT=str(args.port))
        command = ['docker', 'compose', '-p', args.project, '-f', str(repo / 'docker-compose.yml'), '-f', str(override), 'up', '-d']
        command += ['--no-build']
        subprocess.run(command, check=True, env=env)
    print('OpenFlow address: ' + address['url'])
    print('Installer result: ' + str(state))


if __name__ == '__main__':
    main()
