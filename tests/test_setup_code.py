import hashlib
import importlib.util
import json
import shutil
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location('setup_code', ROOT / 'scripts/setup-code.py')
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)


def test_issued_code_is_hashed_private_expiring_and_never_replaces_password():
    with tempfile.TemporaryDirectory() as temp:
        repo = Path(temp)
        (repo / 'scripts').mkdir()
        shutil.copy(ROOT / 'scripts/setup.py', repo / 'scripts/setup.py')
        (repo / '.env').write_text('DEVFLOW_APP_DATA_DIR=.AppData\n')
        (repo / '.AppData').mkdir()
        code = module.issue(repo)
        target = repo / '.AppData/setup-code.json'
        issued = json.loads(target.read_text())
        assert issued['hash'] == hashlib.sha256(code.encode()).hexdigest()
        assert code not in target.read_text()
        assert 3590000 < issued['expiresAt'] - time.time() * 1000 <= 3600000
        assert target.stat().st_mode & 0o777 == 0o600
        (repo / '.AppData/dashboard-auth.json').write_text(json.dumps({'password': {'hash': 'existing'}}))
        before = target.read_bytes()
        assert module.issue(repo) is None
        assert target.read_bytes() == before
