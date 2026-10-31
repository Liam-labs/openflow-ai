#!/usr/bin/env python3
"""Check the public Markdown files: README, CONTRIBUTING, SECURITY, ARCHITECTURE and docs/.

Checks every Markdown file in the repo root and under docs/ for:
  1. links      relative links and #anchors that do not resolve
  2. private    secrets, private hosts/IPs, home paths, personal emails

Usage:
  scripts/check-public-docs.py                check all public Markdown files
  scripts/check-public-docs.py README.md ...  check only these files
  scripts/check-public-docs.py --json         machine-readable output

Exit code: 0 clean (warnings allowed), 1 at least one error.
External links are listed, never fetched.
"""
import json, re, sys
from pathlib import Path

import os
ROOT = Path(os.environ.get("DOCS_CHECK_ROOT") or Path(__file__).resolve().parent.parent).resolve()
DOCS = ROOT / "docs"

PUBLIC_RESOLVERS = {"1.1.1.1", "1.0.0.1", "8.8.8.8", "8.8.4.4", "9.9.9.9"}  # well-known, not private

# (name, regex, severity). Examples in docs must use made-up values (example.com, 192.0.2.x).
PRIVATE = [
    ("private key block", r"-----BEGIN [A-Z ]*PRIVATE KEY-----", "error"),
    ("GitHub token", r"\bgh[pousr]_[A-Za-z0-9]{20,}\b", "error"),
    ("API key (sk-/pk-)", r"\b[sp]k-[A-Za-z0-9_-]{20,}\b", "error"),
    ("AWS access key", r"\bAKIA[0-9A-Z]{16}\b", "error"),
    ("Cloudflare/long token", r"\b[A-Za-z0-9_-]{40,}\b(?<![/.])", "warn"),
    ("JWT", r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}", "error"),
    ("credential assignment", r"(?i)\b(password|passwd|secret|api[_-]?key|token)\b\s*[:=]\s*[\"']?(?!<|\$|\{|your|example|changeme|xxx|\.\.\.|\*+)[^\s\"'<>]{8,}", "error"),
    ("WireGuard private key line", r"(?i)\bPrivateKey\s*=\s*(?!<|\$|\{)[A-Za-z0-9+/]{43}=", "error"),
    ("1Password reference", r"\bop://[^\s)]+", "error"),
    ("home path", r"/home/[a-z0-9_-]+|/mnt/[a-z]/Users/|C:\\Users\\", "error"),
    ("Tailscale/internal host", r"(?i)\b(amdesktop|devflow-server|[a-z0-9-]+\.ts\.net|\.tailnet)\b", "error"),
    ("internal service port", r"(?i)\b(localhost|127\.0\.0\.1):(6333|7007|7001|7003|54321|5678|11434)\b", "error"),
    ("personal/business email", r"(?i)\b[\w.+-]+@(airframemedia\.co\.uk|live\.co\.uk|gmail\.com)\b", "error"),
    ("private IPv4", r"\b(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3})\b", "warn"),
    ("public IPv4 (use 192.0.2.x/198.51.100.x/203.0.113.x)", r"\b(?!10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|127\.|0\.|100\.|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.|255\.)(?:\d{1,3}\.){3}\d{1,3}\b", "warn"),
    ("client name", r"(?i)\b(london excel|taylor wimpey|compass group|boreham|airframe media)\b", "warn"),
    ("internal planning path", r"(?i)\bSG-1/plans\b|\bTeam/[A-Z][a-z]+/", "warn"),
]

def slug(heading):
    s = heading.strip().lower()
    s = re.sub(r"[`*_~]", "", s)
    s = re.sub(r"[^\w\s-]", "", s)
    return re.sub(r"\s", "-", s)

def anchors(path, _cache={}):
    if path in _cache:
        return _cache[path]
    seen, out, fence = {}, set(), False
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        if line.lstrip().startswith("```"):
            fence = not fence
            continue
        m = None if fence else re.match(r"^#{1,6}\s+(.*?)\s*#*$", line)
        if m:
            s = slug(m.group(1))
            n = seen.get(s, 0)
            seen[s] = n + 1
            out.add(s if n == 0 else f"{s}-{n}")
    _cache[path] = out
    return out

def check_file(path):
    rel = path.relative_to(ROOT)
    findings, externals = [], []
    text = path.read_text(encoding="utf-8", errors="replace")
    lines = text.splitlines()

    def add(sev, kind, ln, msg):
        findings.append({"file": str(rel), "line": ln, "severity": sev, "kind": kind, "message": msg})

    # links
    fence = False
    for i, line in enumerate(lines, 1):
        if line.lstrip().startswith("```"):
            fence = not fence
            continue
        if fence:
            continue
        no_inline = re.sub(r"`[^`]*`", "", line)
        for m in re.finditer(r"!?\[[^\]]*\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)", no_inline):
            target = m.group(1)
            if re.match(r"^(https?:)?//", target):
                externals.append((str(rel), i, target))
                if target.startswith("http://"):
                    add("warn", "links", i, f"insecure http link: {target}")
                continue
            if re.match(r"^(mailto:|tel:)", target):
                continue
            base, _, frag = target.partition("#")
            dest = path if base == "" else (path.parent / base).resolve()
            if base and not dest.exists():
                add("error", "links", i, f"broken link, file not found: {target}")
                continue
            try:
                dest.relative_to(ROOT)
            except ValueError:
                add("error", "links", i, f"link leaves the repo: {target}")
                continue
            if frag and dest.suffix == ".md" and dest.is_file():
                if slug(frag) not in anchors(dest) and frag not in anchors(dest):
                    add("error", "links", i, f"broken anchor: {target}")

    # private strings
    in_fence = False
    for i, line in enumerate(lines, 1):
        if line.lstrip().startswith("```"):
            in_fence = not in_fence
        for name, rx, sev in PRIVATE:
            for m in re.finditer(rx, line):
                snippet = m.group(0)
                if name.startswith("Cloudflare/long") and (snippet.count("-") > 3 or "/" in line and "http" in line or snippet.islower() and "_" not in snippet and re.fullmatch(r"[a-z-]+", snippet)):
                    continue
                if name.startswith("public IPv4") and snippet in PUBLIC_RESOLVERS:
                    continue
                if name.startswith("Cloudflare/long") and any(f["line"] == i and f["kind"] == "private" and f["severity"] == "error" for f in findings):
                    continue
                shown = snippet if len(snippet) < 12 else snippet[:6] + "…(" + str(len(snippet)) + " chars)"
                add(sev, "private", i, f"{name}: {shown}" + (" [in code block]" if in_fence else ""))
    # placeholders left behind
    for i, line in enumerate(lines, 1):
        if re.search(r"\b(TODO|FIXME|TBD|XXX|lorem ipsum)\b", line):
            add("warn", "structure", i, "unfinished marker: " + line.strip()[:60])
    return findings, externals


def main(argv):
    as_json = "--json" in argv
    args = [a for a in argv if not a.startswith("--")]
    if args:
        files = [Path(a).resolve() for a in args]
        for f in files:
            if not f.exists():
                print(f"not found: {f}", file=sys.stderr); return 2
    else:
        files = sorted(ROOT.glob("*.md")) + (sorted(DOCS.rglob("*.md")) if DOCS.exists() else [])
    findings, externals = [], []
    for f in files:
        a, b = check_file(f)
        findings += a; externals += b
    errors = [f for f in findings if f["severity"] == "error"]
    warns = [f for f in findings if f["severity"] == "warn"]
    if as_json:
        print(json.dumps({"files": len(files), "errors": len(errors), "warnings": len(warns),
                          "findings": findings, "external_links": externals}, indent=2))
    else:
        for f in sorted(findings, key=lambda x: (x["severity"] != "error", x["file"], x["line"])):
            loc = f"{f['file']}:{f['line']}" if f["line"] else f["file"]
            print(f"{f['severity'].upper():5} {f['kind']:9} {loc}  {f['message']}")
        if externals:
            print(f"\nExternal links (not fetched, review before publishing): {len(externals)}")
            for fl, ln, t in externals:
                print(f"  {fl}:{ln}  {t}")
        print(f"\nChecked {len(files)} file(s): {len(errors)} error(s), {len(warns)} warning(s).")
    return 1 if errors else 0

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
