#!/usr/bin/env python3
"""Fail when a style sheet, HTML or JSON file names a web address that nobody has reviewed.

    check-outbound-assets.py [ROOT]

scripts/security-outbound.py reads code files only (.ts .tsx .js .mjs .cjs .py .sh). A style sheet can pull in a font or an image from
another site just as well (a browser contacts that site the moment the page loads), and so can an HTML or JSON file. This reads those
files for http(s):// addresses and checks each host against the reviewed list scripts/security-outbound-hosts.txt (host  # reason).
Package lock files, tests, docs and node_modules are skipped. Names and paths only. Exit 1 lists every unreviewed host.
"""
import re, sys
from pathlib import Path

SKIP_DIRS = {"node_modules", ".git", ".next", "tests", "docs", "coverage", "dist", "build", "__pycache__", ".AppData", ".UserData", "logs"}
SKIP_FILES = {"package-lock.json", "THIRD_PARTY_NOTICES.md"}
EXT = {".css", ".scss", ".html", ".htm", ".json", ".svg", ".webmanifest"}
URL = re.compile(r"""(?:https?|wss?)://([A-Za-z0-9.\-]+)""", re.I)
LOCAL = re.compile(r"^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|.*\.localhost|.*\.local|\d+\.\d+\.\d+\.\d+)$")
# Namespaces and schema identifiers inside files: nothing is fetched from these.
IGNORE_SUFFIX = ("example.com", "example.org", "example.net", "w3.org", "schema.org", "json-schema.org", "xmlns.com", "purl.org", "adaptivecards.io")


def reviewed(root: Path) -> set[str]:
    hosts = set()
    for line in (root / "scripts" / "security-outbound-hosts.txt").read_text().splitlines():
        line = line.split("#", 1)[0].strip()
        if line:
            hosts.add(line.lower())
    return hosts


def main(argv: list[str]) -> int:
    root = Path(argv[0] if argv else ".").resolve()
    known = reviewed(root)
    found: dict[str, set[str]] = {}
    for path in root.rglob("*"):
        rel = path.relative_to(root)
        if not path.is_file() or path.suffix.lower() not in EXT or path.name in SKIP_FILES or SKIP_DIRS & set(rel.parts):
            continue
        for host in URL.findall(path.read_text(encoding="utf-8", errors="ignore")):
            host = host.lower().rstrip(".")
            if LOCAL.match(host) or host.endswith(IGNORE_SUFFIX) or host in known:
                continue
            found.setdefault(host, set()).add(str(rel))
    if not found:
        print("No unreviewed web addresses in style sheets, HTML or JSON files.")
        return 0
    print("Unreviewed web addresses in style sheets, HTML or JSON files. Add each host to scripts/security-outbound-hosts.txt with a reason, or remove it:")
    for host in sorted(found):
        print("  %-40s %s" % (host, ", ".join(sorted(found[host])[:3])))
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
