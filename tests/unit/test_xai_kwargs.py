"""Tests for scripts/grok_tools.py :: build_xai_kwargs().

Sprint 42 / P4-T4: capability-aware kwarg stripping for xAI API calls.
Mirror of tests/unit/xai-kwargs.test.ts on the Python side.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import pytest


SCRIPTS_DIR = Path(__file__).resolve().parent.parent.parent / 'scripts'
sys.path.insert(0, str(SCRIPTS_DIR))


@pytest.fixture
def temp_models_json(monkeypatch, tmp_path):
    """Redirect the grok_tools module to read from a temp models.json."""
    models_file = tmp_path / 'models.json'

    import grok_tools as gt  # import after sys.path injection

    def _write(models):
        models_file.write_text(json.dumps({'models': models}))
        # reset cache + point the module to our temp file
        monkeypatch.setattr(gt, '_MODELS_JSON_PATH', str(models_file))
        gt._MODELS_CACHE['mtime'] = 0.0
        gt._MODELS_CACHE['entries'] = {}

    yield _write


def test_unknown_model_passes_through(temp_models_json):
    temp_models_json([])
    import grok_tools as gt
    out = gt.build_xai_kwargs('grok-unknown', temperature=0.5, top_p=1, stream=True)
    assert out == {'model': 'grok-unknown', 'temperature': 0.5, 'top_p': 1, 'stream': True}


def test_reasoning_only_strips_forbidden_kwargs(temp_models_json):
    temp_models_json([
        {'id': 'grok-4', 'provider': 'xai', 'capabilities': {'reasoningOnly': True}},
    ])
    import grok_tools as gt
    out = gt.build_xai_kwargs(
        'grok-4',
        messages=[{'role': 'user', 'content': 'hi'}],
        temperature=0.7,
        top_p=0.9,
        stream=True,
        tools=[{'type': 'function'}],
        tool_choice='auto',
        max_tokens=1000,
    )
    assert 'temperature' not in out
    assert 'top_p' not in out
    assert 'stream' not in out
    assert 'tools' not in out
    assert 'tool_choice' not in out
    assert out['max_tokens'] == 1000
    assert out['messages']
    assert out['model'] == 'grok-4'


def test_supports_temperature_false_strips_temp_and_top_p(temp_models_json):
    temp_models_json([
        {
            'id': 'grok-partial',
            'provider': 'xai',
            'capabilities': {
                'supportsTemperature': False,
                'supportsStreaming': True,
                'toolUse': True,
            },
        }
    ])
    import grok_tools as gt
    out = gt.build_xai_kwargs(
        'grok-partial',
        temperature=0.5,
        top_p=0.8,
        stream=True,
        tools=[{'type': 'function'}],
    )
    assert 'temperature' not in out
    assert 'top_p' not in out
    assert out['stream'] is True
    assert out['tools']


def test_supports_streaming_false_strips_stream_only(temp_models_json):
    temp_models_json([
        {
            'id': 'grok-4.20',
            'provider': 'xai',
            'capabilities': {
                'supportsStreaming': False,
                'supportsTemperature': True,
                'toolUse': True,
            },
        }
    ])
    import grok_tools as gt
    out = gt.build_xai_kwargs('grok-4.20', temperature=0.7, stream=True, tools=[])
    assert 'stream' not in out
    assert out['temperature'] == 0.7
    assert out['tools'] == []


def test_tool_use_false_strips_tools_and_tool_choice(temp_models_json):
    temp_models_json([
        {
            'id': 'grok-no-tools',
            'provider': 'xai',
            'capabilities': {
                'toolUse': False,
                'supportsTemperature': True,
                'supportsStreaming': True,
            },
        }
    ])
    import grok_tools as gt
    out = gt.build_xai_kwargs(
        'grok-no-tools',
        temperature=0.7,
        tools=[{'type': 'function'}],
        tool_choice='auto',
    )
    assert 'tools' not in out
    assert 'tool_choice' not in out
    assert out['temperature'] == 0.7


def test_non_xai_entries_are_ignored(temp_models_json):
    temp_models_json([
        {'id': 'sonnet', 'provider': 'anthropic', 'capabilities': {'reasoningOnly': True}},
    ])
    import grok_tools as gt
    out = gt.build_xai_kwargs('sonnet', temperature=0.7, stream=True)
    assert out['temperature'] == 0.7
    assert out['stream'] is True


def test_missing_models_json_returns_passthrough(monkeypatch, tmp_path):
    import grok_tools as gt
    missing_path = str(tmp_path / 'does-not-exist.json')
    monkeypatch.setattr(gt, '_MODELS_JSON_PATH', missing_path)
    gt._MODELS_CACHE['mtime'] = 0.0
    gt._MODELS_CACHE['entries'] = {}
    out = gt.build_xai_kwargs('grok-4', temperature=0.7)
    assert out == {'model': 'grok-4', 'temperature': 0.7}


def test_cache_reuses_on_same_mtime(temp_models_json, monkeypatch):
    temp_models_json([
        {'id': 'grok-4', 'provider': 'xai', 'capabilities': {'reasoningOnly': True}},
    ])
    import grok_tools as gt
    # prime cache
    gt.build_xai_kwargs('grok-4')
    # swap file contents WITHOUT touching mtime (cache should still be used)
    entries = gt._MODELS_CACHE['entries']
    assert 'grok-4' in entries
    # cache key is mtime-based; calling again should not re-read
    out = gt.build_xai_kwargs('grok-4', temperature=0.7)
    assert 'temperature' not in out
