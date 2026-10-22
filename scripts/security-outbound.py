#!/usr/bin/env python3
"""List every external web address the source code can contact, grouped by host.

    security-outbound.py [ROOT] [--json] [--fail-on-new]

Scans code files (not tests, docs or node_modules) for http(s):// and wss:// literals, drops this machine's own addresses and
well-formed XML/schema namespaces, and groups the rest by host with the files that mention them. Each host must be on the
reviewed list scripts/security-outbound-hosts.txt (host  # what it is for); --fail-on-new exits 1 for any host that is not,
so a new destination cannot appear without someone reading this. Names and paths only.
"""
import collections, json, re, sys
from pathlib import Path

SKIP_DIRS = {"node_modules", ".git", ".next", ".next-staging", "tests", "docs", "coverage", "dist", "build", "__pycache__", "open-source", ".AppData"}
EXT = {".ts", ".tsx", ".js", ".mjs", ".cjs", ".py", ".sh"}
URL = re.compile(r"""(?:https?|wss?)://([A-Za-z0-9.\-]+|\[[0-9a-f:]+\])(?::\d+)?""", re.I)
LOCAL = re.compile(r"^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1?\]|::1|host\.docker\.internal|.*\.localhost|.*\.local|\d+\.\d+\.\d+\.\d+)$")
IGNORE_SUFFIX = ("example.com", "example.org", "example.net", "w3.org", "schema.org", "json-schema.org", "xmlns.com", "purl.org")


def scan(root: Path):
    hosts = collections.defaultdict(set)
    for path in root.rglob("*"):
        if not path.is_file() or path.suffix not in EXT or SKIP_DIRS & set(path.relative_to(root).parts):
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        for line in text.splitlines():
            stripped = line.strip()
            if stripped.startswith(("//", "#", "*", "/*")):
                continue
            for host in URL.findall(line):
                host = host.lower().rstrip(".")
                if "${" in host or LOCAL.match(host) or host.endswith(IGNORE_SUFFIX) or "." not in host:
                    continue
                hosts[host].add(path.relative_to(root).as_posix())
    return hosts


def main(argv):
    args = [a for a in argv if not a.startswith("--")]
    root = Path(args[0]) if args else Path(__file__).resolve().parent.parent
    reviewed_file = Path(__file__).with_name("security-outbound-hosts.txt")
    reviewed = {}
    if reviewed_file.exists():
        for line in reviewed_file.read_text().splitlines():
            host, _, why = line.partition("#")
            if host.strip():
                reviewed[host.strip().lower()] = why.strip()
    hosts = scan(root)
    new = sorted(h for h in hosts if h not in reviewed and not any(h.endswith("." + r) for r in reviewed))
    if "--json" in argv:
        print(json.dumps({"hosts": len(hosts), "notReviewed": new, "detail": {h: sorted(f)[:6] for h, f in sorted(hosts.items())}}, indent=1))
    else:
        print("%d external hosts in the source, %d not on the reviewed list" % (len(hosts), len(new)))
        for host in sorted(hosts):
            mark = "  " if host not in new else "NEW"
            print("  %s %-44s %d file(s)  e.g. %s" % (mark, host, len(hosts[host]), sorted(hosts[host])[0]))
    return 1 if "--fail-on-new" in argv and new else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
