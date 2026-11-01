import os
import io
import importlib
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
import devflow_http


class ServerAuthTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {'DEVFLOW_URL': 'http://127.0.0.1:3000', 'DEVFLOW_API_TOKEN': 'dvf_test_only'}, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)

    def test_get_and_post_have_server_auth(self):
        for request in ['http://127.0.0.1:3000/api/collab', urllib.request.Request('http://127.0.0.1:3000/api/collab', data=b'{}')]:
            with self.subTest(request=request), patch('urllib.request.urlopen') as opened:
                devflow_http.urlopen(request, timeout=5)
                sent = opened.call_args.args[0]
                self.assertEqual(sent.get_header('Authorization'), 'Bearer dvf_test_only')
                self.assertEqual(opened.call_args.kwargs['timeout'], 5)

    def test_other_host_or_port_never_receives_server_token(self):
        for url in ['https://example.com/api/collab', 'http://127.0.0.1:3001/api/collab']:
            request = urllib.request.Request(url)
            with patch('urllib.request.urlopen') as opened:
                devflow_http.urlopen(request)
                self.assertIsNone(opened.call_args.args[0].get_header('Authorization'))

    def test_redirect_does_not_forward_token(self):
        request = urllib.request.Request('http://127.0.0.1:3000/api/collab')
        with patch('urllib.request.urlopen'):
            devflow_http.urlopen(request)
        redirected = urllib.request.HTTPRedirectHandler().redirect_request(request, None, 302, 'Found', {}, 'https://example.com/')
        self.assertIsNone(redirected.get_header('Authorization'))

    def test_wrapper_join_and_helper_post_authenticate(self):
        codex = importlib.import_module('collab-codex')
        helper = importlib.import_module('collab_helper')
        with patch.dict(os.environ, {'DEVFLOW_URL': codex.DEVFLOW_URL}):
            wrapper = codex.CollabCodexWrapper.__new__(codex.CollabCodexWrapper)
            for call in [lambda: wrapper.api_call('', 'POST', {'action': 'join'}),
                         lambda: helper._api_call('', 'POST', {'action': 'message'}),
                         lambda: wrapper._delivery_api_call({'action': 'claim'})]:
                with patch('urllib.request.urlopen', return_value=io.BytesIO(b'{"success":true}')) as opened:
                    self.assertTrue(call()['success'])
                    self.assertEqual(opened.call_args.args[0].get_header('Authorization'), 'Bearer dvf_test_only')

    def test_no_token_keeps_native_request_unchanged(self):
        with patch.dict(os.environ, {'DEVFLOW_API_TOKEN': ''}), patch('urllib.request.urlopen') as opened:
            url = 'http://127.0.0.1:3000/api/collab'
            devflow_http.urlopen(url)
            self.assertEqual(opened.call_args.args[0], url)


if __name__ == '__main__':
    unittest.main()
