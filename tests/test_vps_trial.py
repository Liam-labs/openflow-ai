import importlib.util
import json
from pathlib import Path
import subprocess
import pytest

ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location('vps_trial', ROOT / 'scripts/vps-trial.py')
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)


def git(repo, *args):
    return subprocess.check_output(['git', '-C', str(repo), *args], text=True, stderr=subprocess.DEVNULL).strip()


@pytest.fixture
def repository(tmp_path):
    repo = tmp_path / 'repo'
    repo.mkdir()
    git(repo, 'init', '-b', 'main')
    git(repo, 'config', 'user.name', 'Test')
    git(repo, 'config', 'user.email', 'test@example.org')
    (repo / 'Dockerfile').write_text('FROM scratch\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'first')
    return repo


def fake_docker(monkeypatch, fail=False):
    actual = module.run
    commands = []
    def run(args, **kwargs):
        if args[0] != 'docker':
            return actual(args, **kwargs)
        commands.append(args)
        if fail and 'build' in args:
            raise RuntimeError('build failed')
        return 'healthy' if 'inspect' in args else ''
    monkeypatch.setattr(module, 'run', run)
    return commands


def test_exact_main_revision_and_duplicate_delivery(repository, tmp_path, monkeypatch):
    commands = fake_docker(monkeypatch)
    sha = git(repository, 'rev-parse', 'HEAD')
    state = tmp_path / 'state'
    first = module.trial(sha, 'trial.example.org', 3102, state, str(repository))
    second = module.trial(sha, 'trial.example.org', 3102, state, str(repository))
    assert first['revision'] == sha and second['duplicate']
    assert sum('build' in command for command in commands) == 1
    source = Path(first['directory']) / 'source'
    assert (source / 'Dockerfile').read_text() == 'FROM scratch\n'
    config = json.loads((source / 'compose.trial.json').read_text())
    service = config['services']['openflow']
    assert service['ports'] == ['127.0.0.1:3102:8080']
    assert service['environment']['DEVFLOW_REQUIRE_TOKEN'] == '1'
    assert state.stat().st_mode & 0o777 == 0o700


def test_unmerged_revision_is_refused_before_docker(repository, tmp_path, monkeypatch):
    commands = fake_docker(monkeypatch)
    git(repository, 'checkout', '-b', 'unmerged')
    (repository / 'private.txt').write_text('not merged')
    git(repository, 'add', '.')
    git(repository, 'commit', '-m', 'proposal')
    sha = git(repository, 'rev-parse', 'HEAD')
    with pytest.raises(RuntimeError):
        module.trial(sha, 'trial.example.org', 3102, tmp_path / 'state', str(repository))
    assert not commands


def test_failed_build_preserves_previous_trial_and_retry_has_fresh_state(repository, tmp_path, monkeypatch):
    state = tmp_path / 'state'
    fake_docker(monkeypatch)
    sha = git(repository, 'rev-parse', 'HEAD')
    previous = module.trial(sha, 'trial.example.org', 3102, state, str(repository))
    (repository / 'next.txt').write_text('new')
    git(repository, 'add', '.')
    git(repository, 'commit', '-m', 'second')
    next_sha = git(repository, 'rev-parse', 'HEAD')
    actual = module.run
    def fail_build(args, **kwargs):
        if args[0] == 'docker' and 'build' in args:
            raise RuntimeError('broken image')
        return actual(args, **kwargs)
    monkeypatch.setattr(module, 'run', fail_build)
    # Recovery commands are separately suppressed. No real Docker runs in tests.
    actual_subprocess = subprocess.run
    monkeypatch.setattr(module.subprocess, 'run', lambda args, **kw: subprocess.CompletedProcess(args, 0) if args[0] == 'docker' else actual_subprocess(args, **kw))
    with pytest.raises(RuntimeError):
        module.trial(next_sha, 'trial.example.org', 3102, state, str(repository))
    assert module.load(state / 'current-trial.json') == previous
    failed = module.load(state / 'results' / (next_sha + '.json'))
    monkeypatch.setattr(module, 'run', actual)
    retried = module.trial(next_sha, 'trial.example.org', 3102, state, str(repository))
    assert retried['status'] == 'healthy'
    assert failed['directory'] != retried['directory']


@pytest.mark.parametrize('revision,host,port', [('bad', 'test.example', 3102), ('a'*40, 'https://bad', 3102), ('a'*40, 'ok.example', 80)])
def test_bad_inputs_fail_before_any_command(tmp_path, revision, host, port):
    with pytest.raises(ValueError):
        module.trial(revision, host, port, tmp_path / 'state')
    assert not (tmp_path / 'state').exists()


def test_failed_start_restores_previous_trial(repository, tmp_path, monkeypatch):
    commands = fake_docker(monkeypatch)
    state = tmp_path / 'state'
    previous = module.trial(git(repository, 'rev-parse', 'HEAD'), 'trial.example.org', 3102, state, str(repository))
    (repository / 'next.txt').write_text('new')
    git(repository, 'add', '.')
    git(repository, 'commit', '-m', 'second')
    actual = module.run
    def fail_start(args, **kwargs):
        if args[0] == 'docker' and 'up' in args:
            raise RuntimeError('unhealthy startup')
        return actual(args, **kwargs)
    monkeypatch.setattr(module, 'run', fail_start)
    actual_subprocess = subprocess.run
    recovery = []
    def capture(args, **kwargs):
        if args[0] == 'docker':
            recovery.append(args)
            return subprocess.CompletedProcess(args, 0)
        return actual_subprocess(args, **kwargs)
    monkeypatch.setattr(module.subprocess, 'run', capture)
    with pytest.raises(RuntimeError):
        module.trial(git(repository, 'rev-parse', 'HEAD'), 'trial.example.org', 3102, state, str(repository))
    assert ['docker', 'stop', previous['container']] in commands
    assert ['docker', 'start', previous['container']] in recovery
    assert module.load(state / 'current-trial.json') == previous
