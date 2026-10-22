"""Unit tests for first-run dialog dismissal in scripts/computer_use_bridge.py
(task 7e334167).

Covers:
  • JSON registry hot-reload via mtime
  • last-known-good fallback on parse error
  • _find_firstrun_window match logic (title regex, class_name, process_name)
  • _verify_firstrun_dismissed polling
  • /firstrun/dismiss endpoint: dismiss success, no-match no-op, verify
    failure surfaces FIRSTRUN_DISMISS_FAILED
  • /firstrun/presets list endpoint
"""

from __future__ import annotations

import asyncio
import importlib.util
import json
import sys
import tempfile
import time
import types
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest


def _load_bridge_module() -> types.ModuleType:
    bridge_path = Path(__file__).resolve().parents[2] / "scripts" / "computer_use_bridge.py"

    for name in (
        "mss", "pyautogui", "uvicorn", "fastapi", "fastapi.responses",
        "PIL", "PIL.Image", "win32api", "win32con", "win32gui", "win32process",
        "pywinauto", "pydantic",
    ):
        if name not in sys.modules:
            sys.modules[name] = types.ModuleType(name)

    sys.modules["pyautogui"].FAILSAFE = False
    sys.modules["pyautogui"].PAUSE = 0.0
    sys.modules["pyautogui"].press = MagicMock()
    sys.modules["pyautogui"].hotkey = MagicMock()

    class _PassthroughApp:
        def __init__(self, *a, **k): pass
        def _decorator(self, *_a, **_k):
            return lambda fn: fn
        post = get = put = delete = patch = head = options = _decorator

    sys.modules["fastapi"].FastAPI = _PassthroughApp
    sys.modules["fastapi"].HTTPException = type("HTTPException", (Exception,), {})
    sys.modules["fastapi"].Query = MagicMock()
    sys.modules["fastapi.responses"].JSONResponse = MagicMock
    sys.modules["PIL"].Image = MagicMock()
    sys.modules["PIL.Image"].Image = MagicMock()

    class _BaseModel:
        def __init__(self, **kwargs):
            for k, v in kwargs.items():
                setattr(self, k, v)
    sys.modules["pydantic"].BaseModel = _BaseModel
    sys.modules["pydantic"].Field = lambda *a, **k: None  # type: ignore[assignment]

    real_platform = sys.platform
    sys.platform = "linux"  # type: ignore[assignment]
    try:
        spec = importlib.util.spec_from_file_location("_bridge_under_test_firstrun", bridge_path)
        assert spec and spec.loader
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    finally:
        sys.platform = real_platform  # type: ignore[assignment]
    return module


@pytest.fixture(scope="module")
def bridge():
    return _load_bridge_module()


# ─── Hot-reload + parse-error fallback ──────────────────────────────────────

class TestPresetRegistry:
    def test_load_presets_hot_reloads_on_mtime_change(self, bridge, tmp_path):
        original = bridge._FIRSTRUN_PRESETS_PATH
        bridge._firstrun_cache.update(mtime=0.0, data=[])
        try:
            f = tmp_path / "presets.json"
            f.write_text(json.dumps({"version": 1, "presets": [{"id": "alpha"}]}))
            bridge._FIRSTRUN_PRESETS_PATH = str(f)

            first = bridge._load_firstrun_presets()
            assert [p["id"] for p in first] == ["alpha"]

            # Update file with new content + bump mtime explicitly
            time.sleep(0.01)
            f.write_text(json.dumps({"version": 1, "presets": [{"id": "alpha"}, {"id": "beta"}]}))
            import os
            os.utime(f, None)
            second = bridge._load_firstrun_presets()
            assert [p["id"] for p in second] == ["alpha", "beta"]
        finally:
            bridge._FIRSTRUN_PRESETS_PATH = original
            bridge._firstrun_cache.update(mtime=0.0, data=[])

    def test_load_presets_keeps_last_known_good_on_parse_error(self, bridge, tmp_path):
        original = bridge._FIRSTRUN_PRESETS_PATH
        bridge._firstrun_cache.update(mtime=0.0, data=[])
        try:
            f = tmp_path / "presets.json"
            f.write_text(json.dumps({"version": 1, "presets": [{"id": "alpha"}]}))
            bridge._FIRSTRUN_PRESETS_PATH = str(f)
            assert [p["id"] for p in bridge._load_firstrun_presets()] == ["alpha"]

            # Now write garbage; cache keeps "alpha"
            time.sleep(0.01)
            f.write_text("{not json")
            import os
            os.utime(f, None)
            second = bridge._load_firstrun_presets()
            assert [p["id"] for p in second] == ["alpha"]
        finally:
            bridge._FIRSTRUN_PRESETS_PATH = original
            bridge._firstrun_cache.update(mtime=0.0, data=[])

    def test_load_presets_returns_empty_when_file_missing(self, bridge):
        original = bridge._FIRSTRUN_PRESETS_PATH
        bridge._firstrun_cache.update(mtime=0.0, data=[])
        try:
            bridge._FIRSTRUN_PRESETS_PATH = "/nonexistent/firstrun_presets.json"
            assert bridge._load_firstrun_presets() == []
        finally:
            bridge._FIRSTRUN_PRESETS_PATH = original


# ─── Window matching ────────────────────────────────────────────────────────

class TestFindWindow:
    def test_returns_none_off_windows(self, bridge):
        with patch.object(bridge.sys, "platform", "linux"):
            assert bridge._find_firstrun_window({"title_regex": "anything"}) is None

    def _setup_win32(self, bridge, windows: list[tuple[int, str, str, int, str]],
                    foreground_hwnd: int = 0):
        """Stub win32gui + win32process. `windows` is a list of
        (hwnd, title, class_name, pid, process_name) tuples."""
        win32gui = MagicMock()
        win32process = MagicMock()
        win32gui.IsWindowVisible = MagicMock(return_value=True)
        win32gui.GetForegroundWindow = MagicMock(return_value=foreground_hwnd)

        def _enum(cb, _ctx):
            for hwnd, *_ in windows:
                cb(hwnd, None)
        win32gui.EnumWindows = MagicMock(side_effect=_enum)

        def _get_text(hwnd):
            for h, title, *_ in windows:
                if h == hwnd: return title
            return ""
        win32gui.GetWindowText = MagicMock(side_effect=_get_text)

        def _get_class(hwnd):
            for h, _t, cls, *_ in windows:
                if h == hwnd: return cls
            return ""
        win32gui.GetClassName = MagicMock(side_effect=_get_class)

        def _get_pid(hwnd):
            for h, _t, _c, pid, _p in windows:
                if h == hwnd: return (None, pid)
            return (None, 0)
        win32process.GetWindowThreadProcessId = MagicMock(side_effect=_get_pid)

        process_lookup = {pid: pname for _, _, _, pid, pname in windows}
        return win32gui, win32process, process_lookup

    def test_matches_by_title_regex(self, bridge):
        win32gui, win32process, _ = self._setup_win32(bridge, [
            (100, "Choose Profile", "#32770", 200, "outlook.exe"),
            (101, "Some other window", "Notepad", 201, "notepad.exe"),
        ])
        with patch.dict(sys.modules, {"win32gui": win32gui, "win32process": win32process}), \
             patch.object(bridge.sys, "platform", "win32"), \
             patch.object(bridge, "_process_name_for_pid", side_effect=lambda pid: {200: "outlook.exe", 201: "notepad.exe"}.get(pid)):
            hwnd = bridge._find_firstrun_window({"title_regex": "^Choose Profile$"})
            assert hwnd == 100

    def test_class_name_constraint_filters(self, bridge):
        # Two windows with the same title but different classes
        win32gui, win32process, _ = self._setup_win32(bridge, [
            (100, "Welcome", "WrongClass", 200, "outlook.exe"),
            (101, "Welcome", "#32770",     201, "outlook.exe"),
        ])
        with patch.dict(sys.modules, {"win32gui": win32gui, "win32process": win32process}), \
             patch.object(bridge.sys, "platform", "win32"), \
             patch.object(bridge, "_process_name_for_pid", side_effect=lambda pid: "outlook.exe"):
            hwnd = bridge._find_firstrun_window({"title_regex": "Welcome", "class_name": "#32770"})
            assert hwnd == 101

    def test_process_name_constraint_filters_case_insensitive(self, bridge):
        win32gui, win32process, _ = self._setup_win32(bridge, [
            (100, "Welcome", "#32770", 200, "outlook.EXE"),
            (101, "Welcome", "#32770", 201, "powerpoint.exe"),
        ])
        with patch.dict(sys.modules, {"win32gui": win32gui, "win32process": win32process}), \
             patch.object(bridge.sys, "platform", "win32"), \
             patch.object(bridge, "_process_name_for_pid", side_effect=lambda pid: {200: "outlook.EXE", 201: "powerpoint.exe"}[pid]):
            hwnd = bridge._find_firstrun_window({"title_regex": "Welcome", "process_name": "outlook.exe"})
            assert hwnd == 100  # Case-insensitive match

    def test_returns_foreground_when_multiple_match(self, bridge):
        win32gui, win32process, _ = self._setup_win32(bridge, [
            (100, "Choose Profile", "#32770", 200, "outlook.exe"),
            (101, "Choose Profile", "#32770", 201, "outlook.exe"),
        ], foreground_hwnd=101)
        with patch.dict(sys.modules, {"win32gui": win32gui, "win32process": win32process}), \
             patch.object(bridge.sys, "platform", "win32"), \
             patch.object(bridge, "_process_name_for_pid", side_effect=lambda pid: "outlook.exe"):
            hwnd = bridge._find_firstrun_window({"title_regex": "^Choose Profile$"})
            assert hwnd == 101  # Foreground preferred over first-found

    def test_returns_none_when_no_match(self, bridge):
        win32gui, win32process, _ = self._setup_win32(bridge, [
            (100, "Random window", "Notepad", 200, "notepad.exe"),
        ])
        with patch.dict(sys.modules, {"win32gui": win32gui, "win32process": win32process}), \
             patch.object(bridge.sys, "platform", "win32"), \
             patch.object(bridge, "_process_name_for_pid", side_effect=lambda pid: "notepad.exe"):
            assert bridge._find_firstrun_window({"title_regex": "^Choose Profile$"}) is None


# ─── /firstrun/dismiss endpoint ─────────────────────────────────────────────

class TestDismissEndpoint:
    def test_dismiss_no_match_returns_no_op_success(self, bridge):
        from types import SimpleNamespace
        req = SimpleNamespace(preset_ids=None, deadline_ms=300)
        with patch.object(bridge, "_load_firstrun_presets", return_value=[
                {"id": "outlook-choose-profile", "match": {"title_regex": "X"}, "actions": []}
             ]), \
             patch.object(bridge, "_find_firstrun_window", return_value=None):
            result = asyncio.run(bridge.firstrun_dismiss(req))
        assert result["success"] is True
        assert result["dismissed"] is None
        assert "no preset matched" in result.get("reason", "")

    def test_dismiss_success_returns_preset_id(self, bridge):
        from types import SimpleNamespace
        req = SimpleNamespace(preset_ids=None, deadline_ms=2000)
        preset = {
            "id": "outlook-choose-profile",
            "match": {"title_regex": "^Choose Profile$"},
            "actions": [{"type": "press", "key": "enter"}],
            "verify": {"title_gone_within_ms": 500},
        }
        with patch.object(bridge, "_load_firstrun_presets", return_value=[preset]), \
             patch.object(bridge, "_find_firstrun_window", return_value=42), \
             patch.object(bridge, "_set_foreground_with_unstick", return_value={"strategy": "alt_tap"}), \
             patch.object(bridge, "_verify_firstrun_dismissed", return_value=True):
            result = asyncio.run(bridge.firstrun_dismiss(req))
        assert result["success"] is True
        assert result["dismissed"] == "outlook-choose-profile"
        assert result["stepsExecuted"] == 1

    def test_dismiss_verify_failure_surfaces_FIRSTRUN_DISMISS_FAILED(self, bridge):
        from types import SimpleNamespace
        req = SimpleNamespace(preset_ids=None, deadline_ms=2000)
        preset = {
            "id": "smartscreen-protected",
            "match": {"title_regex": "^Windows protected your PC$"},
            "actions": [{"type": "press", "key": "escape"}],
            "verify": {"title_gone_within_ms": 200},
        }
        with patch.object(bridge, "_load_firstrun_presets", return_value=[preset]), \
             patch.object(bridge, "_find_firstrun_window", return_value=99), \
             patch.object(bridge, "_set_foreground_with_unstick", return_value={"strategy": "alt_tap"}), \
             patch.object(bridge, "_verify_firstrun_dismissed", return_value=False):
            result = asyncio.run(bridge.firstrun_dismiss(req))
        assert result["success"] is False
        assert result["code"] == "FIRSTRUN_DISMISS_FAILED"
        assert result["preset"] == "smartscreen-protected"
        assert result["verified"] is False

    def test_dismiss_filters_by_preset_ids_when_supplied(self, bridge):
        from types import SimpleNamespace
        req = SimpleNamespace(preset_ids=["edge-firstrun-welcome"], deadline_ms=300)
        find_calls: list[dict] = []

        def _find_stub(match):
            find_calls.append(match)
            return None
        with patch.object(bridge, "_load_firstrun_presets", return_value=[
                {"id": "outlook-choose-profile", "match": {"title_regex": "Outlook"}, "actions": []},
                {"id": "edge-firstrun-welcome", "match": {"title_regex": "Edge"}, "actions": []},
             ]), \
             patch.object(bridge, "_find_firstrun_window", side_effect=_find_stub):
            asyncio.run(bridge.firstrun_dismiss(req))

        # Only the Edge preset's match block was probed — Outlook was filtered out by preset_ids
        for m in find_calls:
            assert m["title_regex"] == "Edge"


class TestListPresetsEndpoint:
    def test_lists_loaded_presets(self, bridge):
        with patch.object(bridge, "_load_firstrun_presets", return_value=[
                {"id": "outlook-choose-profile", "match": {"title_regex": "X"}, "actions": [{"type": "press"}]},
                {"id": "smartscreen-protected", "match": {"title_regex": "Y"}, "actions": [{"type": "click_button"}, {"type": "click_button"}]},
             ]):
            result = asyncio.run(bridge.firstrun_list_presets())
        assert result["success"] is True
        assert len(result["presets"]) == 2
        assert result["presets"][0]["id"] == "outlook-choose-profile"
        assert result["presets"][0]["actions_count"] == 1
        assert result["presets"][1]["actions_count"] == 2


# ─── Verify polling ─────────────────────────────────────────────────────────

class TestVerifyDismissed:
    def test_returns_true_off_windows(self, bridge):
        with patch.object(bridge.sys, "platform", "linux"):
            assert bridge._verify_firstrun_dismissed(42, 100) is True

    def test_returns_true_when_window_disappears(self, bridge):
        win32gui = MagicMock()
        # First call: still alive. Subsequent: gone.
        win32gui.IsWindow = MagicMock(side_effect=[True, False])
        win32gui.IsWindowVisible = MagicMock(return_value=True)
        with patch.dict(sys.modules, {"win32gui": win32gui}), \
             patch.object(bridge.sys, "platform", "win32"):
            assert bridge._verify_firstrun_dismissed(42, 1000) is True

    def test_returns_false_on_timeout(self, bridge):
        win32gui = MagicMock()
        win32gui.IsWindow = MagicMock(return_value=True)
        win32gui.IsWindowVisible = MagicMock(return_value=True)
        with patch.dict(sys.modules, {"win32gui": win32gui}), \
             patch.object(bridge.sys, "platform", "win32"):
            assert bridge._verify_firstrun_dismissed(42, 200) is False
