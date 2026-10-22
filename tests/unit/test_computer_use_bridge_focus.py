"""Unit tests for the Alt-Tab focus fallback in scripts/computer_use_bridge.py.

Verifies the SendInput Alt-tap migration (replacing the legacy keybd_event
idiom), the GetForegroundWindow post-check, the strategy reporting in
focus_info, and the env-gated AttachThreadInput fallback.

Bridge runs on Windows (win32 / ctypes); these tests run from WSL2 and
mock the platform calls. Live verification is performed when Owner exercises
the bridge in his actual Windows environment — see Sprint 7b10854f notes.
"""

from __future__ import annotations

import importlib.util
import os
import sys
import types
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest


def _load_bridge_module() -> types.ModuleType:
    """Import scripts/computer_use_bridge.py with Windows-only deps stubbed.

    The bridge imports `mss`, `pyautogui`, `uvicorn`, `fastapi`, `pydantic`,
    and pulls in `win32api`/`win32gui`/`win32process` lazily inside functions.
    Stub all of those out before import so the module loads on Linux.
    """
    bridge_path = Path(__file__).resolve().parents[2] / "scripts" / "computer_use_bridge.py"

    stubs: dict[str, types.ModuleType] = {}
    for name in (
        "mss",
        "pyautogui",
        "uvicorn",
        "fastapi",
        "fastapi.responses",
        "PIL",
        "PIL.Image",
        "win32api",
        "win32con",
        "win32gui",
        "win32process",
        "pydantic",
    ):
        if name not in sys.modules:
            mod = types.ModuleType(name)
            stubs[name] = mod
            sys.modules[name] = mod

    # Minimal API shapes the bridge module touches at import time.
    sys.modules["pyautogui"].FAILSAFE = False
    sys.modules["pyautogui"].PAUSE = 0.0
    sys.modules["fastapi"].FastAPI = MagicMock(return_value=MagicMock())
    sys.modules["fastapi"].HTTPException = type("HTTPException", (Exception,), {})
    sys.modules["fastapi"].Query = MagicMock()
    sys.modules["fastapi.responses"].JSONResponse = MagicMock
    sys.modules["PIL"].Image = MagicMock()
    sys.modules["PIL.Image"].Image = MagicMock()

    # pydantic.BaseModel + Field — the module declares request models at module scope.
    class _BaseModel:
        def __init_subclass__(cls, **kw):  # type: ignore[no-untyped-def]
            super().__init_subclass__(**kw)

        def __init__(self, **kwargs):  # type: ignore[no-untyped-def]
            for k, v in kwargs.items():
                setattr(self, k, v)

    sys.modules["pydantic"].BaseModel = _BaseModel
    sys.modules["pydantic"].Field = lambda *a, **k: None  # type: ignore[assignment]

    # Force the on-import platform-detection block to behave as if non-Windows
    # (skips the SetProcessDpiAwareness ctypes calls during test load).
    real_platform = sys.platform
    sys.platform = "linux"  # type: ignore[assignment]
    try:
        spec = importlib.util.spec_from_file_location("_bridge_under_test", bridge_path)
        assert spec and spec.loader
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    finally:
        sys.platform = real_platform  # type: ignore[assignment]
    return module


@pytest.fixture(scope="module")
def bridge():
    return _load_bridge_module()


# ─── SendInput Alt-tap ──────────────────────────────────────────────────────

class TestSendAltTap:
    def test_uses_sendinput_on_windows(self, bridge):
        """The unstick call must reach ctypes.windll.user32.SendInput with two
        keyboard events (Alt-down, Alt-up) — confirming the migration away from
        the legacy keybd_event idiom."""
        send_input_mock = MagicMock(return_value=2)
        with patch.object(bridge.sys, "platform", "win32"), \
             patch.object(bridge.ctypes, "windll", create=True) as windll:
            windll.user32.SendInput = send_input_mock
            ok = bridge._send_alt_tap_via_sendinput()

        assert ok is True
        send_input_mock.assert_called_once()
        # First positional arg is the event count (2 — down + up)
        args, _ = send_input_mock.call_args
        assert args[0] == 2

    def test_sendinput_no_op_off_windows(self, bridge):
        """Linux/macOS path: returns False without touching ctypes."""
        with patch.object(bridge.sys, "platform", "linux"):
            assert bridge._send_alt_tap_via_sendinput() is False

    def test_unstick_swallows_sendinput_exception(self, bridge):
        """Exceptions in the SendInput path must be logged but not re-raised —
        the bridge already treats focus failures as best-effort."""
        with patch.object(bridge, "_send_alt_tap_via_sendinput", side_effect=RuntimeError("boom")):
            # Should not raise
            bridge._unstick_foreground_lock()


# ─── _set_foreground_with_unstick ───────────────────────────────────────────

class TestSetForegroundStrategy:
    def _patch_win32gui(self, before_hwnd=10, after_hwnd=42):
        """Build a win32gui mock with configurable foreground states."""
        m = MagicMock()
        m.GetForegroundWindow.side_effect = [before_hwnd, after_hwnd]
        m.BringWindowToTop = MagicMock()
        m.SetForegroundWindow = MagicMock()
        return m

    def test_alt_tap_reports_strategy_and_before_after(self, bridge):
        """Happy path: the post-check sees the target hwnd as foreground →
        strategy='alt_tap' with before/after hwnds in the dict."""
        win32gui = self._patch_win32gui(before_hwnd=10, after_hwnd=42)
        with patch.dict(sys.modules, {"win32gui": win32gui}), \
             patch.object(bridge, "_unstick_foreground_lock") as unstick:
            result = bridge._set_foreground_with_unstick(42)

        assert result == {"strategy": "alt_tap", "before": 10, "after": 42}
        unstick.assert_called_once()
        win32gui.SetForegroundWindow.assert_called_once_with(42)
        win32gui.BringWindowToTop.assert_called_once_with(42)

    def test_returns_failed_when_post_check_mismatches_and_no_fallback(self, bridge):
        """SetForegroundWindow returned silently but the foreground didn't
        actually change — and FOCUS_FALLBACK env var is NOT set, so we don't
        try AttachThreadInput. Result must report strategy='failed' with
        tried=['alt_tap'] only."""
        win32gui = self._patch_win32gui(before_hwnd=10, after_hwnd=99)
        with patch.dict(sys.modules, {"win32gui": win32gui}), \
             patch.object(bridge, "_unstick_foreground_lock"), \
             patch.dict(os.environ, {}, clear=False):
            os.environ.pop("FOCUS_FALLBACK", None)
            result = bridge._set_foreground_with_unstick(42)

        assert result["strategy"] == "failed"
        assert result["before"] == 10
        assert result["after"] == 99
        assert result["tried"] == ["alt_tap"]

    def test_attach_thread_input_fallback_engaged_when_env_set(self, bridge):
        """FOCUS_FALLBACK=1 + primary fails → AttachThreadInput is attempted.
        On success, strategy='attach_thread_input'."""
        # GetForegroundWindow called: 1) before primary, 2) after primary,
        # 3) after AttachThreadInput
        win32gui = MagicMock()
        win32gui.GetForegroundWindow.side_effect = [10, 99, 42]
        win32gui.BringWindowToTop = MagicMock()
        win32gui.SetForegroundWindow = MagicMock()

        with patch.dict(sys.modules, {"win32gui": win32gui}), \
             patch.object(bridge, "_unstick_foreground_lock"), \
             patch.object(bridge, "_attach_thread_input_focus", return_value=True) as fallback, \
             patch.dict(os.environ, {"FOCUS_FALLBACK": "1"}, clear=False):
            result = bridge._set_foreground_with_unstick(42)

        fallback.assert_called_once_with(42)
        assert result["strategy"] == "attach_thread_input"
        assert result["before"] == 10
        assert result["after"] == 42

    def test_set_foreground_exception_does_not_crash_strategy_pipeline(self, bridge):
        """SetForegroundWindow can raise pywintypes.error on heavily-locked
        sessions — the function must catch this and fall through to the
        post-check + (optional) fallback rather than propagating."""
        win32gui = self._patch_win32gui(before_hwnd=10, after_hwnd=10)
        win32gui.SetForegroundWindow.side_effect = RuntimeError("denied")
        with patch.dict(sys.modules, {"win32gui": win32gui}), \
             patch.object(bridge, "_unstick_foreground_lock"), \
             patch.dict(os.environ, {}, clear=False):
            os.environ.pop("FOCUS_FALLBACK", None)
            result = bridge._set_foreground_with_unstick(42)

        # No exception bubbled; result reports the failure path
        assert result["strategy"] == "failed"
        assert result["after"] == 10  # foreground unchanged


# ─── End-to-end (mocked) — windows.focus endpoint behaviour ─────────────────

class TestFocusInfoSurface:
    def test_ensure_window_focus_propagates_strategy_into_focus_info(self, bridge):
        """`_ensure_window_focus` must surface strategy + before/after hwnds in
        the returned focus_info dict so the listener / TS caller can log
        silent-failure cases."""
        win32gui = MagicMock()
        win32gui.IsWindowVisible = MagicMock(return_value=True)
        win32gui.GetWindowText = MagicMock(return_value="My App")
        win32gui.IsIconic = MagicMock(return_value=False)
        win32gui.EnumWindows = MagicMock(side_effect=lambda cb, _: cb(123, None))

        win32con = MagicMock()
        win32con.SW_RESTORE = 9

        # _set_foreground_with_unstick returns a strategy dict — patch it directly
        # so this test is independent of the inner pipeline (already covered above).
        with patch.dict(sys.modules, {"win32gui": win32gui, "win32con": win32con}), \
             patch.object(bridge, "_set_foreground_with_unstick",
                          return_value={"strategy": "alt_tap", "before": 7, "after": 123}):
            result = bridge._ensure_window_focus("My App")

        assert result is not None
        assert result["handle"] == 123
        assert result["title"] == "My App"
        assert result["strategy"] == "alt_tap"
        assert result["foregroundBefore"] == 7
        assert result["foregroundAfter"] == 123
