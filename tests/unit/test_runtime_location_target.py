"""An explicit fresh workspace must not depend on the channel API for its note."""
import importlib.util
import json
from pathlib import Path

SPEC = importlib.util.spec_from_file_location('runtime_target_sync', Path(__file__).resolve().parents[2] / 'data/scaffolding/sync.py')
sync = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(sync)


def test_target_note_is_created_without_channel_access(tmp_path, monkeypatch):
    monkeypatch.setattr(sync, 'load_channels_data', lambda: None)
    stats = sync.deploy_runtime_location(only_dir=str(tmp_path))
    note = tmp_path / sync.RUNTIME_NOTE
    assert stats['errors'] == 0
    assert note.read_text() == sync.render_runtime_location('desktop-wsl', json.loads(sync.RUNTIME_REGISTRY.read_text()))
    assert sync.deploy_runtime_location(only_dir=str(tmp_path))['ok'] == 1


def test_target_note_check_does_not_write(tmp_path, monkeypatch):
    monkeypatch.setattr(sync, 'load_channels_data', lambda: None)
    stats = sync.deploy_runtime_location(only_dir=str(tmp_path), dry_run=True)
    assert stats['created'] == 1
    assert not (tmp_path / sync.RUNTIME_NOTE).exists()
