#!/usr/bin/env python3
"""Issue a first-login code on the server. Only its hash is stored. Run before startup or to renew an expired code."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import secrets
import time


def issue(repo: Path) -> str | None:
    spec = importlib.util.spec_from_file_location("installer", repo / "scripts/setup.py")
    installer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(installer)
    values = installer.parse_env((repo / ".env").read_text())
    data = Path(values.get("DEVFLOW_APP_DATA_DIR") or ".AppData")
    data = data if data.is_absolute() else repo / data
    auth = data / "dashboard-auth.json"
    if auth.exists() and json.loads(auth.read_text()).get("password"):
        return None
    code = secrets.token_urlsafe(32)
    installer.write_private(data / "setup-code.json", json.dumps({"hash": hashlib.sha256(code.encode()).hexdigest(), "expiresAt": int(time.time() * 1000) + 3600000}))
    return code


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parent.parent)
    code = issue(parser.parse_args().repo)
    if code:
        print(code)
    else:
        print("A login already exists. No setup code issued.")
