import importlib.util
import json
from pathlib import Path
import socket
import ssl
import tempfile
import unittest
from unittest.mock import patch
import urllib.error

spec = importlib.util.spec_from_file_location('server_address', Path(__file__).parents[2] / 'scripts/server-address.py')
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


class ServerAddressTests(unittest.TestCase):
    def test_only_network_unreachability_allows_fallback(self):
        self.assertTrue(adapter.network_unreachable(urllib.error.URLError(socket.gaierror('DNS unavailable'))))
        self.assertTrue(adapter.network_unreachable(TimeoutError()))
        self.assertFalse(adapter.network_unreachable(urllib.error.HTTPError('https://x', 429, 'quota', {}, None)))
        self.assertFalse(adapter.network_unreachable(urllib.error.URLError(ssl.SSLCertVerificationError('bad certificate'))))
        self.assertFalse(adapter.network_unreachable(RuntimeError('proof refused')))

    def exercise(self, root, health_error=None, proof_error=None, tls=True):
        def request(*args):
            if health_error:
                raise health_error
            return {'ok': True}
        calls = []
        def run(action, *args):
            calls.append(action)
            if action == 'confirm' and proof_error:
                raise proof_error
            return {'name': 'calm-otter-4821.my.openflow-ai.com', 'state': 'pending', 'ip': '8.8.8.8'}
        with patch.object(adapter.names, 'request', side_effect=request), \
             patch.object(adapter.names, 'run', side_effect=run), \
             patch.object(adapter, 'caddy_fragment'), \
             patch.object(adapter.shutil, 'which', return_value='/usr/bin/caddy'), \
             patch.object(adapter, 'trusted_tls', return_value=tls):
            result = adapter.provision(root / 'private', root / 'address.json', root / 'web', root / 'site.caddy',
                                       root / 'Caddyfile', 'https://names.example.com', 'my.openflow-ai.com', '8.8.8.8', 3000,
                                       timeout=1 if tls else 0)
        return result, calls

    def test_default_claims_confirms_then_requires_tls(self):
        with tempfile.TemporaryDirectory() as temporary:
            result, calls = self.exercise(Path(temporary))
            self.assertEqual(calls, ['claim', 'confirm'])
            self.assertEqual(result, {'url': 'https://calm-otter-4821.my.openflow-ai.com', 'state': 'ready', 'source': 'managed'})

    def test_unreachable_registry_uses_fallback_without_claim(self):
        with tempfile.TemporaryDirectory() as temporary:
            result, calls = self.exercise(Path(temporary), health_error=urllib.error.URLError(socket.gaierror()))
            self.assertEqual(calls, [])
            self.assertEqual(result['source'], 'fallback')
            self.assertEqual(result['url'], 'https://8-8-8-8.sslip.io')

    def test_quota_proof_and_certificate_failures_never_select_fallback(self):
        cases = [dict(health_error=RuntimeError('Registry refused (HTTP 429)')),
                 dict(proof_error=RuntimeError('Proof failed')), dict(tls=False)]
        for case in cases:
            with self.subTest(case=case), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                with self.assertRaises(RuntimeError):
                    self.exercise(root, **case)
                result = json.loads((root / 'address.json').read_text())
                self.assertEqual(result['state'], 'failed')
                self.assertEqual(result['source'], 'managed')


if __name__ == '__main__':
    unittest.main()
