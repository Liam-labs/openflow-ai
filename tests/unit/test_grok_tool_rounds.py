"""Regression coverage for Grok's bounded client-tool loop."""
from __future__ import annotations

import json
import sys
from pathlib import Path
from types import SimpleNamespace


SCRIPTS_DIR = Path(__file__).resolve().parent.parent.parent / 'scripts'
sys.path.insert(0, str(SCRIPTS_DIR))


def _function_call(index: int):
    return SimpleNamespace(
        type='function_call',
        name='bash_exec',
        arguments=json.dumps({'command': f'tool-{index}'}),
        call_id=f'call-{index}',
    )


def _message(text: str):
    return SimpleNamespace(
        type='message',
        content=[SimpleNamespace(text=text)],
    )


class _Responses:
    def __init__(self, outputs):
        self.outputs = list(outputs)
        self.calls = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        return SimpleNamespace(output=self.outputs.pop(0), usage=None)


def test_default_tool_budget_allows_more_than_five_rounds(monkeypatch):
    import grok_tools as gt

    responses = _Responses([
        *[[_function_call(index)] for index in range(6)],
        [_message('complete')],
    ])
    client = SimpleNamespace(responses=responses)
    executed = []
    monkeypatch.setattr(gt, 'TOOL_DEFINITIONS', [
        {'type': 'function', 'function': {'name': 'bash_exec'}},
        {'type': 'web_search'},
    ])
    monkeypatch.setattr(gt, 'execute_tool', lambda name, args: executed.append((name, args)) or 'ok')

    reply = gt.call_xai_with_tools(client, 'grok-test', [{'role': 'user', 'content': 'finish'}])

    assert reply == 'complete'
    assert len(executed) == 6
    assert len(responses.calls) == 7
    assert all('tools' in call for call in responses.calls)


def test_exhaustion_finalizer_has_no_tools_and_reports_incomplete_work(monkeypatch):
    import grok_tools as gt

    responses = _Responses([
        [_function_call(0)],
        [_message('Tool limit reached; observation and replay remain unfinished.')],
    ])
    client = SimpleNamespace(responses=responses)
    monkeypatch.setattr(gt, 'TOOL_DEFINITIONS', [
        {'type': 'function', 'function': {'name': 'bash_exec'}},
        {'type': 'web_search'},
    ])
    monkeypatch.setattr(gt, 'execute_tool', lambda _name, _args: 'ok')
    messages = [{'role': 'user', 'content': 'finish'}]

    reply = gt.call_xai_with_tools(client, 'grok-test', messages, max_tool_rounds=1)

    assert 'remain unfinished' in reply
    assert 'tools' in responses.calls[0]
    assert 'tools' not in responses.calls[1]
    assert 'explicitly name every unfinished step' in messages[-1]['content']


def test_progress_only_classifier_is_conservative():
    import grok_tools as gt

    assert gt.is_progress_only_response('Replaying the byte-identical login, then re-checking status.')
    assert gt.is_progress_only_response('Verifying postcondition and recording the observation now.')
    assert not gt.is_progress_only_response('Checking complete: all required steps passed.')
    assert not gt.is_progress_only_response('Waiting for Owner to approve Windows Hello.')
    assert not gt.is_progress_only_response('Blocked: Google requires human verification.')
    assert not gt.is_progress_only_response('The final result is authenticated.')
