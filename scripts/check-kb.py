#!/usr/bin/env python3
"""Check that every shipped OpenFlow feature has a knowledge-base page the setup assistant can read.

The registry is kb/features.json: a list of {"id", "title", "page", "paths"}.
  page   the Markdown page under kb/ for that feature
  paths  the code areas that belong to it (a folder ending in /, or an exact file)

Two rules, both run from the pull-request and push events in .github/workflows/checks.yml (no schedule):
  1. every registered feature has its page, and the page has the fixed headings
  2. a pull request that changes a feature's code (--changed BASE HEAD) must also change that feature's page

Usage:
  scripts/check-kb.py                         rule 1 over the whole registry
  scripts/check-kb.py --changed BASE HEAD     rules 1 and 2
  scripts/check-kb.py --warn-only ...         print every finding as a warning and exit 0 (the first week)

DOCS_CHECK_ROOT points at another tree (tests use it). Exit 0 clean, 1 at least one error (never with --warn-only).
"""
import json, os, subprocess, sys
from pathlib import Path

ROOT = Path(os.environ.get("DOCS_CHECK_ROOT") or Path(__file__).resolve().parent.parent).resolve()
REGISTRY = ROOT / "kb" / "features.json"
HEADINGS = ["What it does", "Why you would want it", "What it needs", "How to set it up", "How to tell it is working"]


def load():
    if not REGISTRY.exists():
        return [], []
    try:
        data = json.loads(REGISTRY.read_text(encoding="utf-8"))
    except ValueError as e:
        return [], [f"kb/features.json is not valid JSON: {e}"]
    if not isinstance(data, list):
        return [], ["kb/features.json must be a list"]
    return data, []


def check_pages(features):
    problems, seen = [], set()
    for f in features:
        fid = f.get("id") if isinstance(f, dict) else None
        if not fid or not f.get("page"):
            problems.append(f"kb/features.json: an entry needs an id and a page: {f!r}")
            continue
        if fid in seen:
            problems.append(f"kb/features.json: feature {fid} is listed twice")
        seen.add(fid)
        page = ROOT / f["page"]
        if not str(page.resolve()).startswith(str(ROOT / "kb")) or page.suffix != ".md":
            problems.append(f"{fid}: page must be a Markdown file under kb/ ({f['page']})")
        elif not page.is_file():
            problems.append(f"{fid}: no knowledge-base page at {f['page']}")
        else:
            text = page.read_text(encoding="utf-8", errors="replace").lower()
            missing = [h for h in HEADINGS if not any(l.lstrip("# ").strip().lower() == h.lower() for l in text.splitlines() if l.startswith("#"))]
            if missing:
                problems.append(f"{fid}: {f['page']} is missing the heading(s): {', '.join(missing)}")
    return problems


def check_changed(features, changed):
    problems, changed = [], set(changed)
    for f in features:
        if not isinstance(f, dict) or not f.get("page"):
            continue
        paths = f.get("paths") or []
        touched = [c for c in changed if any(c == p or (p.endswith("/") and c.startswith(p)) for p in paths)]
        if touched and f["page"] not in changed:
            problems.append(f"{f['id']}: {touched[0]} changed but {f['page']} did not. Update the page, or say in the pull request why nothing a user sees changed.")
    return problems


def main(argv):
    warn_only = "--warn-only" in argv
    features, problems = load()
    problems += check_pages(features)
    if "--changed" in argv:
        i = argv.index("--changed")
        base, head = argv[i + 1], argv[i + 2]
        out = subprocess.run(["git", "diff", "--name-only", "--no-renames", f"{base}...{head}"], cwd=ROOT, capture_output=True, text=True)
        if out.returncode != 0:
            print(out.stderr.strip(), file=sys.stderr)
            return 2
        problems += check_changed(features, [l for l in out.stdout.splitlines() if l])
    for p in problems:
        print(("::warning::" if warn_only else "ERROR ") + p)
    print(f"KB check: {len(features)} feature(s), {len(problems)} problem(s){' (warn-only)' if warn_only and problems else ''}.")
    return 0 if (warn_only or not problems) else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
