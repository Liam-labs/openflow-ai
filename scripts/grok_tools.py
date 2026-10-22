#!/usr/bin/env python3
"""
grok_tools.py — Tool execution layer for collab-grok.py.

Defines the tools Grok can use (file ops, bash) and the executor function
that runs them. Wired into CollabGrokWrapper.tool_executor.

Tool call flow:
  1. xAI API responds with tool_calls in the message
  2. CollabGrokWrapper._call_xai_with_tools() executes each tool
  3. Results are appended to the conversation and a follow-up API call is made
  4. Final text response is returned to the collab channel

Security:
  - bash_exec runs with a configurable timeout (default 30s)
  - Path-sensitive operations reject attempts to access system credential files
  - write_file requires explicit confirmation paths (only within allowed dirs)
"""

import os
import sys
import json
import hashlib
import re
import subprocess
import traceback
import contextlib
from pathlib import Path
from typing import Any
from datetime import datetime

# ─── Suppress HuggingFace Hub noise before importing ML libraries ───────────────
# Must be set before sentence_transformers / fastembed are imported.
# HF_HUB_DISABLE_PROGRESS_BARS  — suppresses tqdm weight-loading bars
# HUGGINGFACE_HUB_VERBOSITY      — reduces HF hub log level (hides auth warnings)
# TOKENIZERS_PARALLELISM         — prevents deadlock warnings in forked processes
os.environ.setdefault('HF_HUB_DISABLE_PROGRESS_BARS', '1')
os.environ.setdefault('HUGGINGFACE_HUB_VERBOSITY', 'error')
os.environ.setdefault('TOKENIZERS_PARALLELISM', 'false')

# ─── RAG dependencies (sentence-transformers, qdrant_client, fastembed) ────────
# These live in the rag-stack venv; inject the site-packages path so imports work
# without requiring a separate venv activation step.
_RAG_VENV_SITE = os.path.join(os.path.expanduser("~"), "rag-stack/venv/lib/python3.12/site-packages")
if _RAG_VENV_SITE not in sys.path:
    sys.path.insert(0, _RAG_VENV_SITE)

_RAG_AVAILABLE = False
try:
    from sentence_transformers import SentenceTransformer as _SentenceTransformer
    from fastembed import SparseTextEmbedding as _SparseTextEmbedding, LateInteractionTextEmbedding as _LateInteractionTextEmbedding
    from qdrant_client import QdrantClient as _QdrantClient
    from qdrant_client.models import (
        PointStruct as _PointStruct,
        Prefetch as _Prefetch,
        SparseVector as _SparseVector,
    )
    _RAG_AVAILABLE = True
except ImportError as _e:
    pass  # RAG tools will return helpful error messages if called

# ─── RAG configuration ─────────────────────────────────────────────────────────
_QDRANT_URL = "http://localhost:6333"
_QDRANT_COLLECTION = "agent-memory"
_DENSE_MODEL_NAME = "BAAI/bge-m3"
_SPARSE_MODEL_NAME = "Qdrant/minicoil-v1"
_MINICOIL_AVG_LEN = 400  # average document length for miniCOIL BM25 scoring
_COLBERT_MODEL_NAME = "colbert-ir/colbertv2.0"
_RAG_MIN_SCORE = 0.35
_RAG_DEFAULT_LIMIT = 5

# Lazy-loaded singletons (avoid loading heavy ML models until first RAG call)
_dense_model = None
_sparse_model = None
_colbert_model = None
_qdrant_client = None


def _get_dense_model():
    global _dense_model
    if _dense_model is None:
        _dense_model = _SentenceTransformer(_DENSE_MODEL_NAME)
    return _dense_model


def _get_sparse_model():
    global _sparse_model
    if _sparse_model is None:
        _sparse_model = _SparseTextEmbedding(model_name=_SPARSE_MODEL_NAME, avg_len=_MINICOIL_AVG_LEN)
    return _sparse_model


def _get_colbert_model():
    global _colbert_model
    if _colbert_model is None:
        _colbert_model = _LateInteractionTextEmbedding(_COLBERT_MODEL_NAME)
    return _colbert_model


def _get_qdrant_client():
    global _qdrant_client
    if _qdrant_client is None:
        _qdrant_client = _QdrantClient(url=_QDRANT_URL)
    return _qdrant_client


def preload_rag_models() -> None:
    """Pre-load RAG embedding models in a background thread to reduce first-query latency.

    stdout/stderr are suppressed during loading to prevent HuggingFace/tqdm progress bars
    from appearing in the agent's tmux pane when a user opens 'Open in Terminal'.
    """
    if not _RAG_AVAILABLE:
        return
    try:
        with open(os.devnull, 'w') as devnull:
            with contextlib.redirect_stdout(devnull), contextlib.redirect_stderr(devnull):
                _get_dense_model()
                _get_sparse_model()
                _get_colbert_model()
                _get_qdrant_client()
    except Exception:
        pass  # Non-fatal — models will lazy-load on first actual RAG query


# ─── RAG tool implementations ──────────────────────────────────────────────────

def _qdrant_find(query: str, limit: int = _RAG_DEFAULT_LIMIT, full: bool = False) -> str:
    """Hybrid search (dense BGE-M3 + sparse miniCOIL prefetch → ColBERT reranking) against agent-memory."""
    if not _RAG_AVAILABLE:
        return "Error: RAG dependencies not available (rag-stack venv missing)."
    try:
        dense = _get_dense_model().encode(query).tolist()
        sparse_emb = list(_get_sparse_model().embed([query]))[0]
        sparse = _SparseVector(
            indices=sparse_emb.indices.tolist(),
            values=sparse_emb.values.tolist(),
        )
        colbert_emb = list(_get_colbert_model().query_embed(query))[0].tolist()
        client = _get_qdrant_client()
        results = client.query_points(
            collection_name=_QDRANT_COLLECTION,
            prefetch=[
                _Prefetch(query=dense, using="dense", limit=30),
                _Prefetch(query=sparse, using="sparse", limit=30),
            ],
            query=colbert_emb,
            using="colbert",
            limit=max(1, min(int(limit), 20)),
            with_payload=True,
            with_vectors=False,
        )
        if not results.points:
            return "No results found."

        output = []
        for point in results.points:
            if point.score < _RAG_MIN_SCORE:
                continue
            payload = point.payload or {}
            text = payload.get("text", "")
            source = payload.get("source", "unknown")
            project = payload.get("project", "")
            heading = payload.get("heading", "")
            header = f"[{project}] {heading}" if heading else f"[{project}]"
            if full:
                output.append(f"### {header} (score: {point.score:.3f})\nSource: {source}\n\n{text}")
            else:
                preview = text[:700].rsplit(" ", 1)[0] + "..." if len(text) > 700 else text
                output.append(
                    f"**{header}** (score: {point.score:.3f}) [id: {point.id}]\n"
                    f"Source: {source}\n{preview}"
                )

        return "\n\n---\n\n".join(output) if output else "No results above confidence threshold."
    except Exception as e:
        return f"Error during qdrant_find: {e}"


def _qdrant_get(point_id: int) -> str:
    """Retrieve the full text of a specific memory by point ID (from qdrant_find results)."""
    if not _RAG_AVAILABLE:
        return "Error: RAG dependencies not available."
    try:
        client = _get_qdrant_client()
        points = client.retrieve(
            collection_name=_QDRANT_COLLECTION,
            ids=[int(point_id)],
            with_payload=True,
            with_vectors=False,
        )
        if not points:
            return f"No memory found with id {point_id}."
        payload = points[0].payload or {}
        text = payload.get("text", "")
        source = payload.get("source", "unknown")
        project = payload.get("project", "")
        heading = payload.get("heading", "")
        header = f"[{project}] {heading}" if heading else f"[{project}]"
        return f"### {header}\nSource: {source}\n\n{text}"
    except Exception as e:
        return f"Error during qdrant_get: {e}"


def _qdrant_store(information: str, metadata: dict | None = None) -> str:
    """Store information in the agent-memory knowledge base for future retrieval."""
    if not _RAG_AVAILABLE:
        return "Error: RAG dependencies not available."
    try:
        dense = _get_dense_model().encode(information).tolist()
        sparse_emb = list(_get_sparse_model().embed([information]))[0]
        colbert_emb = list(_get_colbert_model().embed([information]))[0].tolist()
        client = _get_qdrant_client()

        point_id = int(hashlib.md5(
            f"grok-store::{information[:100]}::{datetime.now().isoformat()}".encode()
        ).hexdigest()[:16], 16)

        payload = {
            "text": information,
            "source": "grok-store",
            "source_name": "agent-memory",
            "heading": "Stored Memory",
            "heading_level": 0,
            "project": "agent-memory",
            "ingested_at": datetime.now().isoformat(),
        }
        if metadata:
            payload["metadata"] = metadata

        client.upsert(
            collection_name=_QDRANT_COLLECTION,
            points=[_PointStruct(
                id=point_id,
                vector={
                    "dense": dense,
                    "sparse": {
                        "indices": sparse_emb.indices.tolist(),
                        "values": sparse_emb.values.tolist(),
                    },
                    "colbert": colbert_emb,
                },
                payload=payload,
            )],
        )
        return f"Stored in agent-memory (id: {point_id})"
    except Exception as e:
        return f"Error during qdrant_store: {e}"


# Paths that read_file/write_file will never access
_BLOCKED_PATH_PATTERNS = [
    "/etc/shadow",
    "/etc/passwd",
    "/etc/sudoers",
    "/.ssh/",
    "/proc/",
    "/sys/",
]

# Directories where write_file is permitted
_DEVFLOW_HOME = (os.environ.get('DEVFLOW_HOME') or str(Path.home() / 'DevFlow'))
_WRITE_ALLOWED_DIRS = [
    _DEVFLOW_HOME,
    "/tmp",
    os.path.join(_DEVFLOW_HOME, "Team"),
]

# ─── Tool definitions (OpenAI-compatible JSON schema) ─────────────────────────

TOOL_DEFINITIONS = [
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": (
                "Read the contents of a file. Returns file content as a string. "
                "Use for reading source code, config files, logs, or data files."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Absolute path to the file to read.",
                    },
                    "start_line": {
                        "type": "integer",
                        "description": "1-based line number to start reading from (optional).",
                    },
                    "end_line": {
                        "type": "integer",
                        "description": "1-based line number to stop reading at (optional, inclusive).",
                    },
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "write_file",
            "description": (
                "Write content to a file. Creates the file if it doesn't exist; "
                "overwrites it if it does. Only permitted within allowed directories."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Absolute path to write the file.",
                    },
                    "content": {
                        "type": "string",
                        "description": "Content to write to the file.",
                    },
                },
                "required": ["path", "content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "bash_exec",
            "description": (
                "Execute a bash command and return its stdout and stderr. "
                "Use for running scripts, git commands, npm builds, file operations, etc. "
                "Has a 30-second timeout. Avoid long-running or interactive commands."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {
                        "type": "string",
                        "description": "The bash command to execute.",
                    },
                    "cwd": {
                        "type": "string",
                        "description": "Working directory for the command (optional, defaults to DEVFLOW_HOME).",
                    },
                    "timeout": {
                        "type": "integer",
                        "description": "Timeout in seconds (optional, max 60).",
                    },
                },
                "required": ["command"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "qdrant_find",
            "description": (
                "Search the agent knowledge base using hybrid semantic + keyword search. "
                "Returns relevant results from ~14,500 vectors covering DevFlow code, docs, and memory. "
                "Use this to look up past decisions, system architecture, debugging insights, "
                "project patterns, or anything that might be in the team knowledge base. "
                "By default returns 700-char previews with source info and point IDs. "
                "Use qdrant_get with a point ID to retrieve the full text of a specific result."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Natural language search query.",
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Number of results to return (default 5, max 20).",
                    },
                    "full": {
                        "type": "boolean",
                        "description": "Return full text instead of 700-char previews (default false).",
                    },
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "qdrant_get",
            "description": (
                "Retrieve the full text of a specific memory by its point ID. "
                "Use after qdrant_find to get the complete content of a result."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "point_id": {
                        "type": "integer",
                        "description": "Point ID from qdrant_find results.",
                    },
                },
                "required": ["point_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "qdrant_store",
            "description": (
                "Save information to the agent knowledge base for future retrieval by any agent. "
                "Use to persist important findings, decisions, debugging insights, or facts "
                "that should be remembered across sessions."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "information": {
                        "type": "string",
                        "description": "The text to store in the knowledge base.",
                    },
                    "metadata": {
                        "type": "object",
                        "description": "Optional metadata to attach (e.g. {topic: 'auth', date: '...'}).",
                    },
                },
                "required": ["information"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_directory",
            "description": (
                "List files and directories at a given path. "
                "Returns names, types (file/dir), and sizes."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Absolute directory path to list.",
                    },
                    "show_hidden": {
                        "type": "boolean",
                        "description": "Include hidden files (starting with .) — default false.",
                    },
                },
                "required": ["path"],
            },
        },
    },
    # web_search is a native xAI server-side tool — only available via Responses API.
    # The model executes searches automatically; results are returned inline with citations.
    {
        "type": "web_search",
        "user_location": {
            "type": "approximate",
        },
    },
]


# ─── Tool executor ─────────────────────────────────────────────────────────────

def _is_blocked_path(path: str) -> bool:
    """Return True if the path matches a blocked pattern."""
    resolved = str(Path(path).resolve())
    for pattern in _BLOCKED_PATH_PATTERNS:
        if pattern in resolved:
            return True
    return False


def _is_write_allowed(path: str) -> bool:
    """Return True if writing to this path is permitted."""
    resolved = str(Path(path).resolve())
    # Grant write access to the agent's own CWD — equivalent to Claude's
    # --dangerously-skip-permissions, scoped to a single directory instead of
    # full filesystem. Required for Model-Switch-Handoff.md writes when grok
    # agents are spawned under non-DevFlow project trees (e.g. ~/SG-1/).
    cwd = os.getcwd()
    if resolved.startswith(cwd):
        return True
    return any(resolved.startswith(allowed) for allowed in _WRITE_ALLOWED_DIRS)


def execute_tool(tool_name: str, tool_args: dict[str, Any]) -> str:
    """Dispatch a tool call and return the result as a string.

    This is the function wired into CollabGrokWrapper as tool_executor.
    All exceptions are caught and returned as error strings so the API
    conversation can continue rather than crashing.
    """
    try:
        if tool_name == "read_file":
            return _read_file(**tool_args)
        elif tool_name == "write_file":
            return _write_file(**tool_args)
        elif tool_name == "bash_exec":
            return _bash_exec(**tool_args)
        elif tool_name == "list_directory":
            return _list_directory(**tool_args)
        elif tool_name == "qdrant_find":
            return _qdrant_find(**tool_args)
        elif tool_name == "qdrant_get":
            return _qdrant_get(**tool_args)
        elif tool_name == "qdrant_store":
            return _qdrant_store(**tool_args)
        elif tool_name == "web_search":
            # Server-side tool — xAI executes the search, results land in the model response.
            # This dispatch exists for completeness; in practice the Responses API loop
            # does NOT route web_search through execute_tool().
            return json.dumps({"status": "search_executed", "note": "Server-side tool — results are in the model response"})
        else:
            return f"Error: Unknown tool '{tool_name}'"
    except Exception as e:
        return f"Error executing {tool_name}: {e}\n{traceback.format_exc()}"


def _read_file(path: str, start_line: int = None, end_line: int = None) -> str:
    """Read a file, optionally sliced to a line range."""
    if _is_blocked_path(path):
        return f"Error: Access to '{path}' is blocked."

    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
    except FileNotFoundError:
        return f"Error: File not found: {path}"
    except PermissionError:
        return f"Error: Permission denied reading: {path}"

    # Apply line range (1-based, inclusive)
    if start_line is not None or end_line is not None:
        s = (start_line - 1) if start_line else 0
        e = end_line if end_line else len(lines)
        lines = lines[s:e]

    content = "".join(lines)
    total_lines = len(lines)

    # Truncate very large files
    MAX_CHARS = 20000
    if len(content) > MAX_CHARS:
        content = content[:MAX_CHARS] + f"\n...[truncated — {total_lines} total lines]"

    return content


def _write_file(path: str, content: str) -> str:
    """Write content to a file (within allowed directories)."""
    if _is_blocked_path(path):
        return f"Error: Access to '{path}' is blocked."

    if not _is_write_allowed(path):
        allowed = ", ".join(_WRITE_ALLOWED_DIRS)
        return f"Error: Writing to '{path}' is not permitted. Allowed directories: {allowed}"

    try:
        parent = Path(path).parent
        parent.mkdir(parents=True, exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)
        return f"Written successfully: {path} ({len(content)} chars)"
    except PermissionError:
        return f"Error: Permission denied writing: {path}"
    except Exception as e:
        return f"Error writing file: {e}"


def _bash_exec(command: str, cwd: str = None, timeout: int = 30) -> str:
    """Execute a bash command and return its output."""
    if cwd is None:
        cwd = _DEVFLOW_HOME
    # Cap timeout at 60 seconds
    timeout = min(int(timeout), 60)

    # Validate cwd exists
    if not os.path.isdir(cwd):
        cwd = _DEVFLOW_HOME

    try:
        result = subprocess.run(
            command,
            shell=True,
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        output_parts = []
        if result.stdout:
            output_parts.append(f"stdout:\n{result.stdout}")
        if result.stderr:
            output_parts.append(f"stderr:\n{result.stderr}")
        if result.returncode != 0:
            output_parts.append(f"exit code: {result.returncode}")

        output = "\n".join(output_parts) if output_parts else "(no output)"

        # Truncate very long outputs
        MAX_OUTPUT = 10000
        if len(output) > MAX_OUTPUT:
            output = output[:MAX_OUTPUT] + "\n...[output truncated]"

        return output

    except subprocess.TimeoutExpired:
        return f"Error: Command timed out after {timeout}s"
    except Exception as e:
        return f"Error executing command: {e}"


def _list_directory(path: str, show_hidden: bool = False) -> str:
    """List directory contents with type and size info."""
    if _is_blocked_path(path):
        return f"Error: Access to '{path}' is blocked."

    try:
        entries = sorted(os.scandir(path), key=lambda e: (not e.is_dir(), e.name.lower()))
    except FileNotFoundError:
        return f"Error: Directory not found: {path}"
    except PermissionError:
        return f"Error: Permission denied: {path}"
    except NotADirectoryError:
        return f"Error: Not a directory: {path}"

    lines = [f"Contents of {path}:"]
    count = 0
    for entry in entries:
        if not show_hidden and entry.name.startswith("."):
            continue
        try:
            stat = entry.stat()
            size = stat.st_size
            kind = "dir " if entry.is_dir() else "file"
            size_str = f"{size:>10,} B" if not entry.is_dir() else "           "
            lines.append(f"  {kind}  {size_str}  {entry.name}")
            count += 1
        except Exception:
            lines.append(f"  ???               {entry.name}")
            count += 1

    lines.append(f"\n{count} entries")
    return "\n".join(lines)


# ─── Capability-aware request builder ─────────────────────────────────────────

_MODELS_JSON_PATH = str(Path(__file__).resolve().parent.parent / '.AppData' / 'models.json')
_MODELS_CACHE: dict[str, Any] = {'mtime': 0.0, 'entries': {}}


def _load_xai_capabilities() -> dict[str, dict]:
    """Load xAI model capabilities from models.json. Re-reads on mtime change."""
    try:
        mtime = os.path.getmtime(_MODELS_JSON_PATH)
    except OSError:
        return {}
    if mtime == _MODELS_CACHE['mtime'] and _MODELS_CACHE['entries']:
        return _MODELS_CACHE['entries']
    try:
        with open(_MODELS_JSON_PATH, 'r', encoding='utf-8') as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}
    entries = {
        m['id']: m.get('capabilities') or {}
        for m in data.get('models', [])
        if m.get('provider') == 'xai'
    }
    _MODELS_CACHE['mtime'] = mtime
    _MODELS_CACHE['entries'] = entries
    return entries


def build_xai_kwargs(model: str, **base_kwargs: Any) -> dict[str, Any]:
    """Strip kwargs forbidden by a model's capability flags.

    Reads capabilities from models.json. If the model has:
      - reasoningOnly=True: drop temperature, top_p, stream, tools, tool_choice
      - supportsTemperature=False: drop temperature, top_p
      - supportsStreaming=False: drop stream (or force False at call site)
      - toolUse=False: drop tools, tool_choice

    Unknown models (not in registry) pass through unchanged.
    """
    caps = _load_xai_capabilities().get(model)
    out = {'model': model, **base_kwargs}
    if not caps:
        return out

    drop: set[str] = set()
    if caps.get('reasoningOnly'):
        drop.update({'temperature', 'top_p', 'stream', 'tools', 'tool_choice'})
    if caps.get('supportsTemperature') is False:
        drop.update({'temperature', 'top_p'})
    if caps.get('supportsStreaming') is False:
        drop.add('stream')
    if caps.get('toolUse') is False:
        drop.update({'tools', 'tool_choice'})

    for k in drop:
        out.pop(k, None)
    return out


# ─── Tool-aware xAI API call ──────────────────────────────────────────────────

DEFAULT_MAX_TOOL_ROUNDS = 12
_PROGRESS_ONLY_START = re.compile(
    r"^\s*(?:i(?:'|’)?m\s+)?(?:now\s+)?"
    r"(?:checking|continuing|executing|investigating|proceeding|recording|replaying|running|starting|testing|verifying)\b",
    re.IGNORECASE,
)
_PROGRESS_ONLY_TERMINAL = re.compile(
    r"\b(?:blocked|cannot|can't|complete|completed|done|error|failed|finished|need\s+(?:human|you)|requires?\s+(?:human|your)|result|waiting)\b",
    re.IGNORECASE,
)


def is_progress_only_response(value: str) -> bool:
    """Recognize a short future-tense work update that is not a final answer.

    The direct Grok wrapper publishes every returned text as the turn result.
    A model can therefore strand a multi-step action by returning "Replaying…"
    after its tool calls. Keep this deliberately conservative: only short text
    beginning with a work-in-progress verb, and never an explicit terminal,
    blocked, failed, or human-waiting result, qualifies for one bounded
    automatic continuation.
    """
    text = value.strip()
    return bool(
        text
        and len(text) <= 500
        and _PROGRESS_ONLY_START.search(text)
        and not _PROGRESS_ONLY_TERMINAL.search(text)
    )


def call_xai_with_tools(
    client,
    model: str,
    messages: list,
    max_tool_rounds: int = DEFAULT_MAX_TOOL_ROUNDS,
    usage_accumulator: list | None = None,
) -> str:
    """Call xAI API with tool support; handle tool call loops.

    Args:
        client: OpenAI client pointed at xAI base URL
        model: Model name (e.g. "grok-3")
        messages: Full conversation history with system + user messages
        max_tool_rounds: Maximum number of tool call rounds to prevent infinite
            loops. Twelve is enough for a guarded account action plus its
            independent postcondition and receipt while remaining bounded.

    Returns:
        Final text response as a string.
    """
    # web_search is a server-side tool only available via the Responses API.
    # When it's in the tool list, route through client.responses.create() instead
    # of the existing chat.completions.create() path.
    has_web_search = any(t.get("type") == "web_search" for t in TOOL_DEFINITIONS)

    if has_web_search:
        return _call_via_responses_api(client, model, messages, max_tool_rounds, usage_accumulator)

    for round_num in range(max_tool_rounds):
        kwargs = build_xai_kwargs(
            model,
            messages=messages,
            tools=TOOL_DEFINITIONS,
            tool_choice="auto",
            max_tokens=2000,
            temperature=0.7,
        )
        response = client.chat.completions.create(**kwargs)

        if usage_accumulator is not None and response.usage:
            usage_accumulator.append(response.usage)

        choice = response.choices[0]
        message = choice.message

        # No tool calls — return the text response
        if not message.tool_calls:
            return message.content or ""

        # Append assistant message with tool_calls to conversation
        messages.append({
            "role": "assistant",
            "content": message.content or "",
            "tool_calls": [
                {
                    "id": tc.id,
                    "type": "function",
                    "function": {
                        "name": tc.function.name,
                        "arguments": tc.function.arguments,
                    },
                }
                for tc in message.tool_calls
            ],
        })

        # Execute each tool call and append results
        for tool_call in message.tool_calls:
            tool_name = tool_call.function.name
            try:
                tool_args = json.loads(tool_call.function.arguments)
            except json.JSONDecodeError:
                tool_args = {}

            # Show tool usage in terminal so 'Open in Terminal' reflects live work
            _tool_arg_summary = ", ".join(
                f"{k}={repr(v)[:40]}" for k, v in list(tool_args.items())[:2]
            )
            print(f"[Grok] Tool: {tool_name}({_tool_arg_summary})", file=sys.stderr)

            result = execute_tool(tool_name, tool_args)

            messages.append({
                "role": "tool",
                "tool_call_id": tool_call.id,
                "content": result,
            })

    # Safety net: if we exhaust rounds, ask for a plain response
    messages.append({
        "role": "user",
        "content": (
            "The bounded tool-round limit was reached. Do not say you are continuing "
            "or imply unfinished work completed. Give a truthful final answer based "
            "only on completed tool results and explicitly name every unfinished step."
        ),
    })
    final_kwargs = build_xai_kwargs(
        model,
        messages=messages,
        max_tokens=1000,
        temperature=0.7,
    )
    final = client.chat.completions.create(**final_kwargs)
    if usage_accumulator is not None and final.usage:
        usage_accumulator.append(final.usage)
    return final.choices[0].message.content or ""


def _to_responses_tools(chat_tools: list) -> list:
    """Convert Chat Completions tool format to Responses API tool format.

    Chat Completions nests function metadata under a "function" key:
        {"type": "function", "function": {"name": "...", "description": "...", ...}}

    Responses API expects a flat shape with "name" at the top level:
        {"type": "function", "name": "...", "description": "...", ...}

    Native tools (web_search, code_interpreter, etc.) pass through unchanged.
    """
    out = []
    for t in chat_tools:
        if t.get("type") == "function" and "function" in t:
            fn = t["function"]
            out.append({
                "type": "function",
                "name": fn["name"],
                "description": fn.get("description", ""),
                "parameters": fn.get("parameters", {}),
            })
        else:
            out.append(t)
    return out


def _call_via_responses_api(client, model: str, messages: list, max_tool_rounds: int, usage_accumulator: list | None) -> str:
    """Call xAI via the Responses API (client.responses.create).

    Used when web_search is in the tool list, since web_search is only available
    on the Responses API endpoint. Handles both server-side tools (web_search)
    and client-side function calls (read_file, bash_exec, etc.) within the same
    response.output stream.
    """
    response_tools = _to_responses_tools(TOOL_DEFINITIONS)

    for round_num in range(max_tool_rounds):
        response = client.responses.create(
            model=model,
            input=messages,
            tools=response_tools,
            tool_choice="auto",
        )

        if usage_accumulator is not None and response.usage:
            usage_accumulator.append(response.usage)

        # Separate function_call items from the final message and other output
        function_calls = []
        assistant_content = ""

        for item in response.output:
            if item.type == "function_call":
                function_calls.append(item)
            elif item.type == "message":
                for c in (getattr(item, 'content', []) or []):
                    if hasattr(c, 'text'):
                        assistant_content += c.text

        # No client-side function calls — return the text response.
        # web_search results (if any) are already incorporated by xAI.
        if not function_calls:
            return assistant_content

        # Append assistant turn to conversation
        messages.append({
            "role": "assistant",
            "content": assistant_content,
        })

        # Execute each function call and append results as function_call_output items
        tool_outputs = []
        for fc in function_calls:
            tool_name = fc.name
            try:
                tool_args = json.loads(fc.arguments)
            except json.JSONDecodeError:
                tool_args = {}

            _tool_arg_summary = ", ".join(
                f"{k}={repr(v)[:40]}" for k, v in list(tool_args.items())[:2]
            )
            print(f"[Grok] Tool: {tool_name}({_tool_arg_summary})", file=sys.stderr)

            result = execute_tool(tool_name, tool_args)

            tool_outputs.append({
                "type": "function_call_output",
                "call_id": fc.call_id,
                "output": result,
            })

        # Extend messages with tool outputs for the next round
        messages.extend(tool_outputs)

    # Safety net: exhausted rounds, ask for final answer
    messages.append({
        "role": "user",
        "content": (
            "The bounded tool-round limit was reached. Do not say you are continuing "
            "or imply unfinished work completed. Give a truthful final answer based "
            "only on completed tool results and explicitly name every unfinished step."
        ),
    })
    final = client.responses.create(
        model=model,
        input=messages,
    )
    if usage_accumulator is not None and final.usage:
        usage_accumulator.append(final.usage)
    for item in final.output:
        if item.type == "message":
            content = ""
            for c in (getattr(item, 'content', []) or []):
                if hasattr(c, 'text'):
                    content += c.text
            return content
    return ""
