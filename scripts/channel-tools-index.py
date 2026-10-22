#!/usr/bin/env python3
"""Rewrite <project>/channel-tools/tools.json: the list of a channel's tools for its agents.

Usage: channel-tools-index.py <channel-tools folder | project folder> [--check]

Run it after adding, changing or removing a tool. Agents read tools.json at task start to see what tools exist
for the owner in the channel and when to use them. Safe to run any time: if nothing changed the file is left alone.
No dependencies. The validation rules match lib/channel-tools.ts (DevFlow's launcher); both are tested against
tests/fixtures/channel-tools-manifest-cases.json so they cannot drift apart.
Exit 0 on success (skipped tools are listed in tools.json under "errors", not fatal); 2 on a bad folder.
"""
import json, math, os, re, sys, tempfile
from datetime import datetime, timezone
from urllib.parse import urlsplit

DIRNAME = "channel-tools"
INDEX = "tools.json"
MANIFEST = "tool.json"
TOOL_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
MAX_MANIFEST = 64 * 1024
MAX_TOOLS = 100


def safe_tool_path(rel):
    if not isinstance(rel, str) or not rel or len(rel) > 400 or "\0" in rel or "\\" in rel:
        return None
    segs = rel.split("/")
    if any(not s or s in (".", "..") or s.startswith(".") for s in segs):
        return None
    return segs


def _str(v, limit):
    return v.strip()[:limit] if isinstance(v, str) and v.strip() else None


def _valid_link(url):
    if url.startswith("/"):
        return not url.startswith("//") and "\\" not in url and not re.search(r"[\x00-\x1f]", url)
    try:
        u = urlsplit(url)
    except ValueError:
        return False
    return u.scheme in ("http", "https") and bool(u.netloc)


def parse_tool_manifest(tool_id, raw, channel=None):
    """Same contract as parseToolManifest in lib/channel-tools.ts: {'tool':..} | {'warning':..} | {'hidden':True}."""
    try:
        o = json.loads(raw)
    except (ValueError, TypeError):
        return {"warning": "tool.json is not valid JSON"}
    if not isinstance(o, dict):
        return {"warning": "tool.json must be a JSON object"}

    if "channels" in o:
        ch = o["channels"]
        if not isinstance(ch, list) or any(not isinstance(c, str) for c in ch):
            return {"warning": '"channels" must be a list of channel names or ids'}
        wanted = [c.strip().lower() for c in ch]
        if channel and wanted and channel["id"].lower() not in wanted and channel["name"].strip().lower() not in wanted:
            return {"hidden": True}

    typ = o.get("type")
    if "type" not in o:
        typ = "link" if o.get("url") else "script" if o.get("run") else "html" if o.get("entry") else None
    if typ not in ("link", "html", "script"):
        return {"warning": '"type" must be link, html or script'}

    order = o.get("order")
    tool = {
        "id": tool_id,
        "name": _str(o.get("name"), 80) or tool_id,
        "description": _str(o.get("description"), 300) or "",
        "type": typ,
        "order": order if isinstance(order, (int, float)) and not isinstance(order, bool) and math.isfinite(order) else 100,
    }
    when = _str(o.get("whenToUse"), 400)
    if when:
        tool["whenToUse"] = when
    icon = _str(o.get("icon"), 8)
    if icon:
        tool["icon"] = icon

    if typ == "link":
        url = _str(o.get("url"), 2000)
        if not url or not _valid_link(url):
            return {"warning": 'a link tool needs "url" starting with http://, https:// or /'}
        tool["url"] = url
    elif typ == "html":
        entry = _str(o.get("entry"), 300) or "index.html"
        if not safe_tool_path(entry) or not re.search(r"\.html?$", entry, re.I):
            return {"warning": '"entry" must be an .html file inside the tool folder'}
        tool["entry"] = entry
    else:
        run = _str(o.get("run"), 500)
        if not run:
            return {"warning": 'a script tool needs "run" (the command to copy and run)'}
        tool["run"] = run
        cwd = _str(o.get("cwd"), 300)
        if cwd and cwd != ".":
            if not safe_tool_path(cwd):
                return {"warning": '"cwd" must stay inside the tool folder'}
            tool["cwd"] = cwd
    if isinstance(o.get("channels"), list) and o["channels"]:
        tool["channels"] = [c.strip() for c in o["channels"]]
    return {"tool": tool}


def scan(root):
    """Tool folders under root as (id, manifest_text|None, error|None). Same rules as agent-hostd's channel-tools-list."""
    out = []
    for name in sorted(os.listdir(root)):
        full = os.path.join(root, name)
        if name.startswith(".") or os.path.islink(full) or not os.path.isdir(full):
            continue  # dot-folders, symlinks and loose files (including tools.json itself) are not tools
        if len(out) >= MAX_TOOLS:
            break
        mf = os.path.join(full, MANIFEST)
        if not TOOL_ID_RE.match(name):
            out.append((name, None, "folder name may only use letters, numbers, dot, dash and underscore"))
        elif os.path.islink(mf) or not os.path.isfile(mf):
            out.append((name, None, "missing tool.json"))
        elif os.path.getsize(mf) > MAX_MANIFEST:
            out.append((name, None, "tool.json is too large"))
        else:
            try:
                with open(mf, "r", encoding="utf-8", errors="replace") as f:
                    out.append((name, f.read(), None))
            except OSError as e:
                out.append((name, None, "cannot read tool.json: " + e.__class__.__name__))
    return out


def build_index(root):
    tools, errors = [], []
    for tool_id, raw, err in scan(root):
        if err or raw is None:
            errors.append({"id": tool_id, "message": err or "missing tool.json"})
            continue
        parsed = parse_tool_manifest(tool_id, raw)
        if "tool" in parsed:
            tools.append(parsed["tool"])
        elif "warning" in parsed:
            errors.append({"id": tool_id, "message": parsed["warning"]})
    tools.sort(key=lambda t: (t["order"], t["name"].lower()))
    for t in tools:
        t.setdefault("whenToUse", "")
    return tools, errors


def resolve_dir(arg):
    d = os.path.abspath(arg.rstrip("/") or "/")
    if os.path.basename(d) != DIRNAME:
        d = os.path.join(d, DIRNAME)
    return d


def write_index(root, now=None):
    """Rewrite tools.json. Returns (changed, tools, errors). Unchanged content keeps the old generatedAt."""
    tools, errors = build_index(root)
    path = os.path.join(root, INDEX)
    doc = {"generatedAt": (now or datetime.now(timezone.utc)).strftime("%Y-%m-%dT%H:%M:%SZ"),
           "about": "Generated by ~/DevFlow/scripts/channel-tools-index.py - do not edit. Tools the owner can open from this channel's Channel tools launcher; use whenToUse to decide when to point him to one or use it yourself.",
           "tools": tools, "errors": errors}
    try:
        with open(path, "r", encoding="utf-8") as f:
            old = json.load(f)
        if isinstance(old, dict) and {k: v for k, v in old.items() if k != "generatedAt"} == {k: v for k, v in doc.items() if k != "generatedAt"}:
            return False, tools, errors
    except (OSError, ValueError):
        pass
    fd, tmp = tempfile.mkstemp(prefix=".tools.json.", dir=root)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(doc, f, indent=2, ensure_ascii=False)
            f.write("\n")
        os.chmod(tmp, 0o644)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise
    return True, tools, errors


def main(argv):
    args = [a for a in argv[1:] if not a.startswith("--")]
    if len(args) != 1 or any(a not in ("--check",) for a in argv[1:] if a.startswith("--")):
        print(__doc__.strip().splitlines()[0] + "\nUsage: channel-tools-index.py <channel-tools folder | project folder> [--check]", file=sys.stderr)
        return 2
    root = resolve_dir(args[0])
    if not os.path.isdir(root) or os.path.islink(root):
        print(f"no channel-tools folder at {root}", file=sys.stderr)
        return 2
    if "--check" in argv:
        tools, errors = build_index(root)
    else:
        changed, tools, errors = write_index(root)
        print(f"{INDEX} {'updated' if changed else 'already up to date'}: {os.path.join(root, INDEX)}")
    print(f"{len(tools)} tool(s), {len(errors)} skipped")
    for e in errors:
        print(f"  skipped {e['id']}: {e['message']}")
    missing = [t["id"] for t in tools if not t.get("whenToUse")]
    if missing:
        print("  add whenToUse to: " + ", ".join(missing))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
