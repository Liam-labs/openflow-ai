#!/usr/bin/env python3
"""PreToolUse(Bash) hook: keep Claude Code's dangerous-removal prompt away from agents.

Claude Code asks before an `rm`/`rmdir` whose target could expand to the
filesystem root. That prompt is bypass-immune (it fires under
--dangerously-skip-permissions and a hook "allow" cannot approve it), so an
unattended agent simply stops on the dialog until a human presses a key.

Two cases are handled before the permission check sees the command:

* Unguarded variable targets (`rm -rf $OUT/*`) are rewritten to the guarded
  form Claude Code itself recommends (`rm -rf "${OUT:?}"/*`). For a set,
  non-empty variable the command is unchanged in effect; for an empty or unset
  one the shell now stops with an error instead of deleting from `/`.
* A relative glob removal after a `cd` in the same command cannot be resolved
  statically and has no safe rewrite. It is denied with instructions, so the
  agent retries with an absolute path instead of waiting on a prompt.

Anything else passes through untouched. The hook never approves a command; the
normal permission pipeline still evaluates the (possibly rewritten) input.
"""

from __future__ import annotations

import json
import re
import sys

NAME_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
ASSIGNMENT_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=")
REDIRECT_RE = re.compile(r"(\d*|&)(>>|>&|>\||<<<|<<-|<<|<&|<>|>|<)")
REMOVAL_COMMANDS = {"rm", "rmdir"}
DIRECTORY_CHANGES = {"cd", "pushd", "popd"}
# Words that leave the next word in command position.
COMMAND_PREFIXES = {
    "!", "{", "then", "do", "else", "elif", "if", "while", "until", "time",
    "sudo", "command", "builtin", "exec", "nohup", "env", "nice", "timeout",
}
# Claude Code's own list of variables that are normally set: a `:?` guard on
# them would not stop the removal, so Claude Code still asks. Leave them alone.
NORMALLY_SET = {
    "HOME", "USERPROFILE", "HOMEPATH", "HOMEDRIVE", "XDG_CONFIG_HOME",
    "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "APPDATA",
    "LOCALAPPDATA", "SYSTEMDRIVE", "SYSTEMROOT", "WINDIR", "PROGRAMFILES",
    "PROGRAMW6432", "PROGRAMDATA", "ALLUSERSPROFILE", "PUBLIC", "HOMESHARE",
    "XDG_RUNTIME_DIR", "PWD", "OLDPWD", "TMPDIR", "TMP", "TEMP",
}
WORD_END = set(" \t\n;&|()<>")

DENY_RELATIVE_GLOB = (
    "Blocked before Claude Code's approval prompt: `{target}` is a relative glob "
    "removal after a directory change in the same command, which Claude Code "
    "cannot resolve and would stop to ask a human about. Re-run it with an "
    "absolute path (for example `rm -rf /abs/dir/*`, or `rm -rf \"${{DIR:?}}\"/*` "
    "with DIR set to an absolute path)."
)


class Unparseable(Exception):
    """The command uses syntax this scanner does not model; leave it alone."""


def _skip_quoted(src: str, i: int, quote: str) -> int:
    """Return the index after the closing quote of a quote opened at src[i]."""
    j = i + 1
    while j < len(src):
        c = src[j]
        if quote == '"' and c == "\\":
            j += 2
            continue
        if quote == "$'" and c == "\\":
            j += 2
            continue
        if c == quote[-1]:
            return j + 1
        if quote == '"' and c == "$" and src.startswith("$(", j):
            j = _skip_balanced(src, j + 1, "(", ")")
            continue
        if quote == '"' and c == "`":
            j = _skip_backtick(src, j)
            continue
        j += 1
    raise Unparseable("unterminated quote")


def _skip_backtick(src: str, i: int) -> int:
    j = i + 1
    while j < len(src):
        if src[j] == "\\":
            j += 2
            continue
        if src[j] == "`":
            return j + 1
        j += 1
    raise Unparseable("unterminated backtick")


def _skip_balanced(src: str, i: int, open_c: str, close_c: str) -> int:
    """src[i] is open_c; return the index after its matching close_c."""
    depth = 0
    j = i
    while j < len(src):
        c = src[j]
        if c == "\\":
            j += 2
            continue
        if c == "'":
            j = _skip_quoted(src, j, "'")
            continue
        if c == '"':
            j = _skip_quoted(src, j, '"')
            continue
        if c == "`":
            j = _skip_backtick(src, j)
            continue
        if c == open_c:
            depth += 1
        elif c == close_c:
            depth -= 1
            if depth == 0:
                return j + 1
        j += 1
    raise Unparseable("unbalanced " + open_c)


def _read_word(src: str, i: int) -> int:
    """Return the end index of the shell word starting at src[i]."""
    j = i
    while j < len(src) and src[j] not in WORD_END:
        c = src[j]
        if c == "\\":
            j += 2
        elif c == "'":
            j = _skip_quoted(src, j, "'")
        elif c == '"':
            j = _skip_quoted(src, j, '"')
        elif c == "`":
            j = _skip_backtick(src, j)
        elif src.startswith("$'", j):
            j = _skip_quoted(src, j + 1, "$'")
        elif src.startswith("$(", j):
            j = _skip_balanced(src, j + 1, "(", ")")
        elif src.startswith("${", j):
            j = _skip_balanced(src, j + 1, "{", "}")
        else:
            j += 1
    return min(j, len(src))


def _unquote(word: str) -> str:
    out, i, quote = [], 0, None
    while i < len(word):
        c = word[i]
        if quote is None and c in "'\"":
            quote = c
        elif quote == c:
            quote = None
        elif c == "\\" and quote != "'" and i + 1 < len(word):
            out.append(word[i + 1])
            i += 1
        else:
            out.append(c)
        i += 1
    return "".join(out)


def _guard_word(word: str, removal_arg: bool, changes: list[str]) -> str:
    """Guard bare variable references in a removal argument and recurse into
    command substitutions of any word."""
    out: list[str] = []
    i, in_dq = 0, False
    while i < len(word):
        c = word[i]
        if c == "\\":
            out.append(word[i:i + 2])
            i += 2
        elif c == "'" and not in_dq:
            end = _skip_quoted(word, i, "'")
            out.append(word[i:end])
            i = end
        elif c == '"':
            in_dq = not in_dq
            out.append(c)
            i += 1
        elif word.startswith("$'", i) and not in_dq:
            end = _skip_quoted(word, i + 1, "$'")
            out.append(word[i:end])
            i = end
        elif word.startswith("$((", i):
            end = _skip_balanced(word, i + 1, "(", ")")
            out.append(word[i:end])
            i = end
        elif word.startswith("$(", i):
            end = _skip_balanced(word, i + 1, "(", ")")
            out.append("$(" + _guard(word[i + 2:end - 1], changes) + ")")
            i = end
        elif c == "`":
            end = _skip_backtick(word, i)
            out.append("`" + _guard(word[i + 1:end - 1], changes) + "`")
            i = end
        elif c == "$" and removal_arg:
            braced = word.startswith("${", i)
            if braced:
                end = _skip_balanced(word, i + 1, "{", "}")
                name = word[i + 2:end - 1]
            else:
                match = NAME_RE.match(word, i + 1)
                end = match.end() if match else i + 1
                name = match.group(0) if match else ""
            if NAME_RE.fullmatch(name) and name not in NORMALLY_SET:
                guarded = "${" + name + ":?}"
                out.append(guarded if in_dq else '"' + guarded + '"')
            else:
                out.append(word[i:max(end, i + 1)])
            i = max(end, i + 1)
        else:
            out.append(c)
            i += 1
    return "".join(out)


def _is_relative_glob(target: str) -> bool:
    """A literal relative target whose last segment is a bare `*`, such as `*`,
    `./*` or `dist/*` - the shape Claude Code cannot resolve after a `cd`.
    Partial globs like `old-*` resolve statically and are left alone."""
    if "$" in target or "`" in target:
        return False
    plain = _unquote(target)
    if plain.startswith(("/", "~", "-")):
        return False
    return re.fullmatch(r"(.*/)?\*+/*", plain) is not None


def _guard(src: str, changes: list[str], blocked: list[str] | None = None) -> str:
    """Rewrite one command string. `changes` collects a note per rewrite and
    `blocked` collects relative-glob targets that follow a directory change."""
    blocked = blocked if blocked is not None else []
    out: list[str] = []
    heredocs: list[tuple[str, bool]] = []
    i = 0
    command_position = True
    current: str | None = None
    seen_cd = False
    skip_next_arg = False
    while i < len(src):
        c = src[i]
        if c in " \t":
            out.append(c)
            i += 1
            continue
        if c == "\\" and src.startswith("\\\n", i):
            out.append("\\\n")
            i += 2
            continue
        if c == "\n":
            out.append(c)
            i += 1
            for delim, strip_tabs in heredocs:
                while i < len(src):
                    end = src.find("\n", i)
                    line = src[i:] if end == -1 else src[i:end]
                    i = len(src) if end == -1 else end + 1
                    out.append(line + ("" if end == -1 else "\n"))
                    if (line.lstrip("\t") if strip_tabs else line) == delim:
                        break
            heredocs = []
            command_position, current = True, None
            continue
        if c == "#" and command_position:
            end = src.find("\n", i)
            end = len(src) if end == -1 else end
            out.append(src[i:end])
            i = end
            continue
        redirect = REDIRECT_RE.match(src, i)
        if redirect and redirect.group(1) == "&" and not redirect.group(2).startswith(">"):
            redirect = None
        if redirect:
            op = redirect.group(2)
            out.append(redirect.group(0))
            i = redirect.end()
            while i < len(src) and src[i] in " \t":
                out.append(src[i])
                i += 1
            end = _read_word(src, i)
            target = src[i:end]
            if op in ("<<", "<<-"):
                heredocs.append((_unquote(target), op == "<<-"))
                out.append(target)
            else:
                out.append(_guard_word(target, False, changes))
            i = end
            continue
        if c in ";&|()":
            j = i + 1
            if src.startswith(("&&", "||", ";;", "|&"), i):
                j = i + 2
            out.append(src[i:j])
            i = j
            command_position, current = True, None
            continue
        end = _read_word(src, i)
        word = src[i:end]
        i = end
        if command_position:
            if ASSIGNMENT_RE.match(word):
                out.append(_guard_word(word, False, changes))
                continue
            plain = _unquote(word)
            if plain in COMMAND_PREFIXES:
                out.append(word)
                skip_next_arg = plain == "timeout"
                continue
            if plain.startswith("-") or skip_next_arg:
                out.append(word)
                skip_next_arg = False
                continue
            current = plain.rsplit("/", 1)[-1]
            command_position = False
            if current in DIRECTORY_CHANGES:
                seen_cd = True
            out.append(_guard_word(word, False, changes))
            continue
        removal = current in REMOVAL_COMMANDS
        guarded = _guard_word(word, removal, changes)
        if guarded != word:
            changes.append(f"{word} -> {guarded}")
        elif removal and seen_cd and _is_relative_glob(word):
            blocked.append(word)
        out.append(guarded)
    return "".join(out)


def decide(command: str) -> dict | None:
    """Return the hook response for a Bash command, or None to pass through."""
    if not re.search(r"\brm(dir)?\b", command):
        return None
    changes: list[str] = []
    blocked: list[str] = []
    try:
        rewritten = _guard(command, changes, blocked)
    except (Unparseable, IndexError):
        return None
    if blocked:
        return {"hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": DENY_RELATIVE_GLOB.format(target=blocked[0]),
        }}
    if rewritten == command:
        return None
    return {"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "updatedInput": {"command": rewritten},
        "additionalContext": (
            "rm_guard rewrote variable removal targets to the ${VAR:?} guarded "
            "form so they fail safely when empty: " + "; ".join(changes)
        ),
    }}


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        return 0
    if payload.get("tool_name") != "Bash":
        return 0
    tool_input = payload.get("tool_input") or {}
    command = tool_input.get("command")
    if not isinstance(command, str):
        return 0
    response = decide(command)
    if response is None:
        return 0
    updated = response["hookSpecificOutput"].get("updatedInput")
    if updated is not None:
        response["hookSpecificOutput"]["updatedInput"] = {**tool_input, **updated}
    json.dump(response, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
