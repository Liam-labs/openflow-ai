#!/usr/bin/env python3
"""Build a merged OpenFlow revision in isolated VPS state. Called by a main-merge event, never a timer.

Run as the dedicated OpenFlow user with Docker access. The public deployment and
its volumes are not modified. Output is a small JSON result; build/start logs stay
in the private state directory because first-run output can contain a setup code.
"""
import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import tempfile
import time
import uuid

REPOSITORY = 'https://github.com/Liam-labs/openflow-ai.git'


def run(args, *, cwd=None, log=None, env=None):
    result = subprocess.run(args, cwd=cwd, stdout=log or subprocess.PIPE,
                            stderr=subprocess.STDOUT if log else subprocess.PIPE,
                            text=True, env=env)
    if result.returncode:
        # Child output may contain setup codes. Keep it out of the caller's logs.
        raise RuntimeError(f'{args[0]} {args[1] if len(args) > 1 else ""} failed (exit {result.returncode})')
    return result.stdout.strip() if result.stdout else ''


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with tempfile.NamedTemporaryFile(mode='w', dir=path.parent, delete=False) as stream:
        json.dump(value, stream, indent=2)
        stream.write('\n')
        temporary = Path(stream.name)
    temporary.replace(path)


def load(path):
    return json.loads(path.read_text()) if path.exists() else None


def validate(revision, host, port):
    if not re.fullmatch('[0-9a-f]{40}', revision):
        raise ValueError('Use the full lowercase main commit hash.')
    if not re.fullmatch(r'(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?', host) or any(not p or len(p) > 63 or p.startswith('-') or p.endswith('-') for p in host.split('.')):
        raise ValueError('Use a hostname without a scheme, path or port.')
    if not 1024 <= port <= 65535:
        raise ValueError('The trial port must be between 1024 and 65535.')


def trial(revision, host, port, state, repository=REPOSITORY):
    validate(revision, host, port)
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(state, 0o700)
    with (state / 'deploy.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        previous = load(state / 'current-trial.json')
        result_path = state / 'results' / (revision + '.json')
        done = load(result_path)
        if done and done.get('status') == 'healthy' and previous and previous.get('revision') == revision:
            try:
                health = run(['docker', 'inspect', '--format', '{{.State.Health.Status}}', done['container']])
            except RuntimeError:
                health = 'missing'
            if health == 'healthy':
                return {**done, 'duplicate': True}
        mirror = state / 'source.git'
        if not mirror.exists():
            run(['git', 'init', '--bare', str(mirror)])
        run(['git', '-C', str(mirror), 'fetch', '--no-tags', repository, '+refs/heads/main:refs/heads/main'])
        # Only protected-main commits are eligible. Branch/PR revisions are refused.
        run(['git', '-C', str(mirror), 'merge-base', '--is-ancestor', revision, 'refs/heads/main'])
        attempt = revision[:12] + '-' + uuid.uuid4().hex[:8]
        directory = state / 'attempts' / attempt
        directory.mkdir(parents=True, mode=0o700)
        archive = directory / 'source.tar'
        with archive.open('wb') as target:
            subprocess.run(['git', '-C', str(mirror), 'archive', revision], stdout=target, check=True)
        source = directory / 'source'
        source.mkdir()
        with tarfile.open(archive) as tar:
            tar.extractall(source, filter='data')
        name = 'openflow-trial-' + attempt
        image = 'openflow-vps:' + revision
        compose = {
            'services': {'openflow': {
                'build': '.', 'image': image, 'container_name': name,
                'init': True, 'restart': 'unless-stopped',
                'ports': [f'127.0.0.1:{port}:8080'],
                'environment': {'DEVFLOW_SERVER_MODE': '1', 'DEVFLOW_REQUIRE_TOKEN': '1',
                    'OPENFLOW_HOST': host, 'DEVFLOW_ALLOWED_HOSTS': 'localhost,127.0.0.1,' + host,
                    'DEVFLOW_ALLOWED_ORIGINS': 'https://' + host},
                'volumes': ['data:/data', 'appdata:/opt/openflow/.AppData', 'userdata:/opt/openflow/.UserData', 'logs:/opt/openflow/logs']
            }}, 'volumes': {'data': {}, 'appdata': {}, 'userdata': {}, 'logs': {}}
        }
        save(source / 'compose.trial.json', compose)
        command = ['docker', 'compose', '-p', name, '-f', 'compose.trial.json']
        result = {'revision': revision, 'container': name, 'image': image, 'port': port,
                  'endpoint': f'http://127.0.0.1:{port}', 'directory': str(directory),
                  'status': 'building', 'startedAt': int(time.time()), 'duplicate': False}
        save(directory / 'result.json', result)
        previous_stopped = False
        try:
            with (directory / 'build.log').open('w') as log:
                run(command + ['build'], cwd=source, log=log)
            if previous and previous.get('port') == port:
                run(['docker', 'stop', previous['container']])
                previous_stopped = True
            with (directory / 'start.log').open('w') as log:
                run(command + ['up', '-d', '--wait', '--wait-timeout', '180'], cwd=source, log=log)
            # This proves the deployed protected health route, beyond container status.
            run(['docker', 'exec', name, 'python3', '/opt/openflow/docker/healthcheck.py'])
            result.update(status='healthy', completedAt=int(time.time()))
            save(directory / 'result.json', result)
            save(result_path, result)
            save(state / 'current-trial.json', result)
            return result
        except Exception:
            # Retain failed image, volumes and private logs for diagnosis. Restore
            # the preceding trial when this attempt took its port.
            with (directory / 'recovery.log').open('w') as log:
                subprocess.run(['docker', 'stop', name], stdout=log, stderr=subprocess.STDOUT)
                if previous_stopped:
                    subprocess.run(['docker', 'start', previous['container']], stdout=log, stderr=subprocess.STDOUT)
            result.update(status='failed', completedAt=int(time.time()))
            save(directory / 'result.json', result)
            save(result_path, result)
            raise RuntimeError(f'Trial failed. Private evidence: {directory}') from None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('revision')
    parser.add_argument('--host', required=True)
    parser.add_argument('--port', type=int, default=3102)
    parser.add_argument('--state', type=Path, default=Path.home() / '.local/state/openflow-vps')
    args = parser.parse_args()
    try:
        print(json.dumps(trial(args.revision, args.host, args.port, args.state)))
    except (ValueError, RuntimeError, OSError, subprocess.SubprocessError) as error:
        print(json.dumps({'status': 'failed', 'error': str(error)}))
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
