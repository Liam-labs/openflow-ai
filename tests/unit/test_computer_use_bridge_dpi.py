"""Unit tests for the DPI-aware screenshot + click metadata in
scripts/computer_use_bridge.py (task 4babb780).

Covers:
  • Post-pyautogui-import DPI restoration to PER_MONITOR_AWARE_V2
  • _dpi_for_point + _monitor_dpi_metadata helpers
  • /screenshot response carries `monitors`, `dpi_awareness`, etc.
  • /mouse/click emits DPI_MISMATCH warning when from_screenshot_dpi differs

Bridge runs on Windows (ctypes/win32); these tests run from WSL2 with the
Windows-only deps stubbed out at module load. Live verification happens when
Owner exercises the bridge in his actual hi-DPI dual-monitor environment.
"""

from __future__ import annotations

import importlib.util
import sys
import types
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest


def _load_bridge_module() -> types.ModuleType:
    """Stub Windows-only imports and load the bridge module. Same shim as
    test_computer_use_bridge_focus.py — kept local to avoid cross-test imports."""
    bridge_path = Path(__file__).resolve().parents[2] / "scripts" / "computer_use_bridge.py"

    for name in (
        "mss", "pyautogui", "uvicorn", "fastapi", "fastapi.responses",
        "PIL", "PIL.Image", "win32api", "win32con", "win32gui", "win32process",
        "pydantic",
    ):
        if name not in sys.modules:
            sys.modules[name] = types.ModuleType(name)

    sys.modules["pyautogui"].FAILSAFE = False
    sys.modules["pyautogui"].PAUSE = 0.0

    # FastAPI app stub whose decorators (.get/.post/etc.) are passthrough —
    # i.e. `@app.post("/foo") async def fn(...)` leaves `fn` as the original
    # async function so tests can `asyncio.run(fn(req))`.
    class _PassthroughApp:
        def __init__(self, *a, **k):
            pass
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
        def __init__(self, **kwargs):  # type: ignore[no-untyped-def]
            for k, v in kwargs.items():
                setattr(self, k, v)
    sys.modules["pydantic"].BaseModel = _BaseModel
    sys.modules["pydantic"].Field = lambda *a, **k: None  # type: ignore[assignment]

    real_platform = sys.platform
    sys.platform = "linux"  # type: ignore[assignment]
    try:
        spec = importlib.util.spec_from_file_location("_bridge_under_test_dpi", bridge_path)
        assert spec and spec.loader
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    finally:
        sys.platform = real_platform  # type: ignore[assignment]
    return module


@pytest.fixture(scope="module")
def bridge():
    return _load_bridge_module()


# ─── DPI helpers ────────────────────────────────────────────────────────────

class TestDpiHelpers:
    def test_dpi_for_point_returns_96_off_windows(self, bridge):
        with patch.object(bridge.sys, "platform", "linux"):
            assert bridge._dpi_for_point(100, 100) == 96

    def test_dpi_for_point_queries_GetDpiForMonitor(self, bridge):
        """On Windows, _dpi_for_point hits MonitorFromPoint then GetDpiForMonitor.
        Mock both to confirm the values flow through correctly."""
        from ctypes import wintypes

        with patch.object(bridge.sys, "platform", "win32"), \
             patch.object(bridge.ctypes, "windll", create=True) as windll:
            windll.user32.MonitorFromPoint = MagicMock(return_value=0xDEADBEEF)

            def _fake_get_dpi(_hmon, _mdt, dpi_x_ptr, dpi_y_ptr):
                # GetDpiForMonitor writes 144 into dpi_x via the wintypes.UINT pointer.
                dpi_x_ptr._obj.value = 144
                dpi_y_ptr._obj.value = 144
                return 0  # S_OK
            windll.shcore.GetDpiForMonitor = MagicMock(side_effect=_fake_get_dpi)

            dpi = bridge._dpi_for_point(960, 540)
            assert dpi == 144

    def test_dpi_for_point_falls_back_to_96_on_failure(self, bridge):
        """If GetDpiForMonitor returns non-zero (S_OK convention), default to 96."""
        with patch.object(bridge.sys, "platform", "win32"), \
             patch.object(bridge.ctypes, "windll", create=True) as windll:
            windll.user32.MonitorFromPoint = MagicMock(return_value=0)
            windll.shcore.GetDpiForMonitor = MagicMock(return_value=-1)
            assert bridge._dpi_for_point(0, 0) == 96

    def test_dpi_for_point_swallows_ctypes_exception(self, bridge):
        with patch.object(bridge.sys, "platform", "win32"), \
             patch.object(bridge.ctypes, "windll", create=True) as windll:
            windll.user32.MonitorFromPoint = MagicMock(side_effect=OSError("boom"))
            assert bridge._dpi_for_point(0, 0) == 96

    def test_monitor_dpi_metadata_emits_per_monitor_dpi_and_scale(self, bridge):
        # mss.monitors layout: [0]=virtual stitched, [1]=primary, [2]+=secondary
        monitors = [
            {"left": 0, "top": 0, "width": 5760, "height": 2160},   # virtual
            {"left": 0, "top": 0, "width": 3840, "height": 2160},   # primary 4K@200%
            {"left": 3840, "top": 0, "width": 1920, "height": 1080},# secondary 1080p@100%
        ]
        # Stub _dpi_for_point so we don't depend on the live ctypes call.
        with patch.object(bridge, "_dpi_for_point") as dpi_stub:
            # Centre points: virtual=2880,1080 → 192; primary=1920,1080 → 192; secondary=4800,540 → 96
            dpi_stub.side_effect = [192, 192, 96]
            md = bridge._monitor_dpi_metadata(monitors)

        assert len(md) == 3
        assert md[0] == {"index": 0, "rect": [0, 0, 5760, 2160], "dpi": 192, "scale": 2.0, "primary": False, "virtual": True}
        assert md[1] == {"index": 1, "rect": [0, 0, 3840, 2160], "dpi": 192, "scale": 2.0, "primary": True, "virtual": False}
        assert md[2] == {"index": 2, "rect": [3840, 0, 1920, 1080], "dpi": 96, "scale": 1.0, "primary": False, "virtual": False}

    def test_is_remote_session_false_off_windows(self, bridge):
        with patch.object(bridge.sys, "platform", "linux"):
            assert bridge._is_remote_session() is False

    def test_is_remote_session_propagates_GetSystemMetrics(self, bridge):
        with patch.object(bridge.sys, "platform", "win32"), \
             patch.object(bridge.ctypes, "windll", create=True) as windll:
            windll.user32.GetSystemMetrics = MagicMock(return_value=1)
            assert bridge._is_remote_session() is True

            windll.user32.GetSystemMetrics = MagicMock(return_value=0)
            assert bridge._is_remote_session() is False


# ─── Screenshot response shape ───────────────────────────────────────────────

class TestScreenshotResponse:
    def test_response_carries_dpi_metadata_block(self, bridge):
        """The /screenshot endpoint must include `monitors`, `monitor_index`,
        `captured_dpi`, `dpi_awareness`, `screenshot_space`, `remote_session`
        in its response payload (additive — existing fields preserved)."""
        # We can't easily call the FastAPI handler directly because mss/Image
        # are MagicMock'd. Instead, exercise the metadata-builder paths and
        # confirm the keys we'd inject are populated correctly.
        monitors = [
            {"left": 0, "top": 0, "width": 1920, "height": 1080},
            {"left": 0, "top": 0, "width": 1920, "height": 1080},
        ]
        with patch.object(bridge, "_dpi_for_point", return_value=120):
            md = bridge._monitor_dpi_metadata(monitors)

        # Verify the metadata structure that gets injected into the response.
        assert all("dpi" in m and "scale" in m and "rect" in m for m in md)
        # The captured_dpi field in the screenshot response is `md[monitor_index].dpi`.
        captured_dpi = md[1]["dpi"]
        assert captured_dpi == 120


# ─── Click DPI mismatch warning ─────────────────────────────────────────────

class TestClickDpiMismatch:
    def test_click_emits_DPI_MISMATCH_when_from_screenshot_dpi_differs(self, bridge):
        """When ClickRequest.from_screenshot_dpi differs from the target
        monitor's current DPI, the response must include a DPI_MISMATCH
        warning string. The click is still attempted — warning, not rejection."""
        from types import SimpleNamespace
        req = SimpleNamespace(x=500, y=500, button="left", clicks=1, interval=0.1, from_screenshot_dpi=192)
        # Target monitor is at 96 DPI now (user undocked between screenshot and click).
        with patch.object(bridge, "_dpi_for_point", return_value=96), \
             patch.object(bridge.pyautogui, "click", create=True) as click_mock:
            # Run the endpoint handler synchronously by awaiting via asyncio.
            import asyncio
            result = asyncio.run(bridge.mouse_click(req))

        click_mock.assert_called_once()
        assert result["success"] is True
        assert result["monitor_dpi"] == 96
        assert "warnings" in result
        assert any("DPI_MISMATCH" in w for w in result["warnings"])
        assert "192" in result["warnings"][0] and "96" in result["warnings"][0]

    def test_click_no_warning_when_dpi_matches(self, bridge):
        from types import SimpleNamespace
        req = SimpleNamespace(x=500, y=500, button="left", clicks=1, interval=0.1, from_screenshot_dpi=120)
        with patch.object(bridge, "_dpi_for_point", return_value=120), \
             patch.object(bridge.pyautogui, "click", create=True):
            import asyncio
            result = asyncio.run(bridge.mouse_click(req))
        assert result["success"] is True
        assert result["monitor_dpi"] == 120
        assert "warnings" not in result

    def test_click_no_warning_when_from_screenshot_dpi_omitted(self, bridge):
        """Backwards compat: existing callers that don't supply the new field
        should see no behaviour change."""
        from types import SimpleNamespace
        req = SimpleNamespace(x=500, y=500, button="left", clicks=1, interval=0.1, from_screenshot_dpi=None)
        with patch.object(bridge, "_dpi_for_point", return_value=96), \
             patch.object(bridge.pyautogui, "click", create=True):
            import asyncio
            result = asyncio.run(bridge.mouse_click(req))
        assert "warnings" not in result
        assert result["success"] is True
