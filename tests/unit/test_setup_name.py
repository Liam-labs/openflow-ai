import base64
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

spec = importlib.util.spec_from_file_location('setup_name', Path(__file__).parents[2] / 'scripts/setup-name.py')
client = importlib.util.module_from_spec(spec)
spec.loader.exec_module(client)


class SetupNameTests(unittest.TestCase):
    def test_claim_confirm_and_signed_update_preserve_key_without_publishing_token(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            state, web, public = root / 'private', root / 'web', root / 'address.json'
            token = 'one_time_proof_token_with_32_characters'
            name = 'calm-otter-4821.my.openflow-ai.com'
            captured = {}

            def api(registry, endpoint, payload=None):
                if endpoint == '/v1/claim':
                    captured['key'] = Ed25519PublicKey.from_public_bytes(base64.urlsafe_b64decode(payload['public_key'] + '='))
                    return {'name': name, 'token': token, 'expires_in': 600}
                if endpoint.startswith('/v1/status'):
                    return {'name': name, 'state': 'active' if captured.get('active') else 'pending', 'pointed': True}
                signature = base64.urlsafe_b64decode(payload['signature'] + '==')
                if endpoint == '/v1/confirm':
                    self.assertEqual((web / '.well-known/openflow-claim').read_text(), token)
                    captured['key'].verify(signature, f'openflow-names/confirm\n{name}\n{token}'.encode())
                    captured['active'] = True
                else:
                    captured['key'].verify(signature, f"openflow-names/update\n{name}\n{payload['ip']}\n{payload['ts']}\n{payload['nonce']}".encode())
                return {'name': name, 'state': 'active'}

            def run(action, ip='8.8.8.8'):
                return client.run(action, state, web, public, 'https://names.example.com', 'my.openflow-ai.com', ip, api)

            self.assertEqual(run('claim')['state'], 'pending')
            key = (state / 'install-key.pem').read_bytes()
            self.assertNotIn(token, public.read_text())
            self.assertEqual((state / 'install-key.pem').stat().st_mode & 0o777, 0o600)
            self.assertEqual(run('confirm')['state'], 'active')
            self.assertFalse((web / '.well-known/openflow-claim').exists())
            self.assertNotIn('token', json.loads((state / 'claim.json').read_text()))
            # A retry reconciles the active claim without another confirm or name request.
            self.assertEqual(run('confirm')['state'], 'active')
            self.assertEqual(run('update', '1.1.1.1')['ip'], '1.1.1.1')
            self.assertEqual((state / 'install-key.pem').read_bytes(), key)

    def test_interrupted_claim_is_not_replayed(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            calls = []

            def api(*args):
                calls.append(args)
                raise TimeoutError('request timed out')

            args = ('claim', root / 'private', root / 'web', root / 'address.json',
                    'https://names.example.com', 'my.openflow-ai.com', '8.8.8.8', api)
            with self.assertRaises(TimeoutError):
                client.run(*args)
            with self.assertRaisesRegex(ValueError, 'outcome unknown'):
                client.run(*args)
            self.assertEqual(len(calls), 1)

    def test_registry_cannot_put_an_arbitrary_name_in_installer_state(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with self.assertRaisesRegex(ValueError, 'outside'):
                client.run('claim', root / 'private', root / 'web', root / 'address.json',
                           'https://names.example.com', 'my.openflow-ai.com', '8.8.8.8',
                           lambda *args: {'name': 'evil.example.com', 'token': 'x' * 32, 'expires_in': 600})
            self.assertFalse((root / 'address.json').exists())


if __name__ == '__main__':
    unittest.main()
