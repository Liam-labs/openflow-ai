"""./scripts/setup --server writes the two settings that make every request need the access token (a proxy on this machine must not be trusted as the owner)."""
import importlib.util
import tempfile
from pathlib import Path

SPEC = importlib.util.spec_from_file_location("openflow_setup", Path(__file__).resolve().parent.parent / "scripts" / "setup.py")
setup = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(setup)


def make_repo(root: Path) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    (root / ".env.example").write_text("PORT=3000\n")
    return root


def test_server_flag_sets_both_settings_and_a_normal_run_does_not():
    with tempfile.TemporaryDirectory() as tmp:
        plain = make_repo(Path(tmp) / "plain")
        setup.configure(plain)
        assert "DEVFLOW_REQUIRE_TOKEN" not in setup.parse_env((plain / ".env").read_text())

        server = make_repo(Path(tmp) / "server")
        result = setup.configure(server, server=True)
        values = setup.parse_env((server / ".env").read_text())
        assert values["DEVFLOW_SERVER_MODE"] == "1"
        assert values["DEVFLOW_REQUIRE_TOKEN"] == "1"
        assert "set DEVFLOW_REQUIRE_TOKEN" in result["changes"]
        again = setup.configure(server, server=True)           # safe to run again: nothing to change
        assert "set DEVFLOW_REQUIRE_TOKEN" not in again["changes"]


def test_server_flag_corrects_a_file_that_turned_the_requirement_off():
    with tempfile.TemporaryDirectory() as tmp:
        repo = make_repo(Path(tmp))
        (repo / ".env").write_text("PORT=3000\nDEVFLOW_REQUIRE_TOKEN=0\n")
        setup.configure(repo, server=True)
        assert setup.parse_env((repo / ".env").read_text())["DEVFLOW_REQUIRE_TOKEN"] == "1"


def test_public_host_is_written_and_unsafe_hosts_are_rejected_before_writes():
    with tempfile.TemporaryDirectory() as tmp:
        repo = make_repo(Path(tmp))
        setup.configure(repo, server=True, host='trial.example.org')
        values = setup.parse_env((repo / '.env').read_text())
        assert values['DEVFLOW_ALLOWED_HOSTS'] == 'localhost,127.0.0.1,trial.example.org'
        assert values['DEVFLOW_ALLOWED_ORIGINS'] == 'https://trial.example.org'
        assert values['DEVFLOW_URL'] == 'https://trial.example.org'
        for bad in ['https://trial.example.org', 'x\nEVIL=1', '*.example.org', '-bad.example', 'a..b', 'a:443', 'a/path']:
            before = (repo / '.env').read_bytes()
            try:
                setup.configure(repo, server=True, host=bad)
                raise AssertionError('accepted unsafe host')
            except SystemExit:
                assert (repo / '.env').read_bytes() == before
