"""`sync.py --check` must only report. Every call that deploys something and is given the dry-run flag must be given --check too."""
import re
from pathlib import Path

SYNC = Path(__file__).resolve().parents[2] / "data" / "scaffolding" / "sync.py"


def test_every_deploy_call_in_main_treats_check_like_dry_run():
    source = SYNC.read_text(encoding="utf-8")
    main = source[source.index("def main("):]
    calls = re.findall(r"(deploy_[a-z_]+|run_sync)\(([^)]*?dry_run=([^,\n]+))", main, re.S)
    assert calls, "no deploy calls found in main()"
    for name, _, flag in calls:
        if name == "run_sync":
            continue  # run_sync takes check_only separately
        assert "args.check" in flag, "%s ignores --check (dry_run=%s)" % (name, flag.strip())
