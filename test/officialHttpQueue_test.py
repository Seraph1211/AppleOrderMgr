"""HTTP 队列离线回归：API 提取、重试上限、出口、未知提交保护。"""
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch, MagicMock

sys.path.insert(0, str(Path('scripts/officialOrder').resolve()))
import iproyalApi
spec = importlib.util.spec_from_file_location('httpQueue', 'scripts/runOfficialOrderHttpQueue.py')
queue = importlib.util.module_from_spec(spec)
spec.loader.exec_module(queue)


class HttpQueueTest(unittest.TestCase):
    def test_api_generates_cn_sticky_without_purchase(self):
        response = MagicMock()
        response.__enter__.return_value.read.return_value = json.dumps([
            'geo.iproyal.com:12321:test:secret_country-cn_session-abc_lifetime-24h']).encode()
        opener = MagicMock()
        opener.open.return_value = response
        with patch.object(iproyalApi.urllib.request, 'build_opener', return_value=opener):
            result = iproyalApi.generate_proxy({'apiToken': 'test-token', 'subuserHash': 'test-user'})
        request = opener.open.call_args[0][0]
        self.assertEqual(request.full_url, iproyalApi.API)
        body = json.loads(request.data)
        self.assertEqual((body['proxy_count'], body['location'], body['lifetime']), (1, '_country-cn', '24h'))
        self.assertTrue(result['password'].endswith('_killswitch-1'))

    def test_api_failure_does_not_leak_token_or_retry(self):
        opener = MagicMock()
        opener.open.side_effect = Exception('test-secret-token')
        with patch.object(iproyalApi.urllib.request, 'build_opener', return_value=opener):
            with self.assertRaisesRegex(RuntimeError, '^IPROYAL_API_FAILED$'):
                iproyalApi.generate_proxy({'apiToken': 'test', 'subuserHash': 'user'})
        self.assertEqual(opener.open.call_count, 1)

    def test_541_retries_at_most_three_and_rejects_old_egress(self):
        with patch.object(queue, 'stopped', return_value=False), patch.object(queue, 'attempt') as attempt:
            attempt.return_value = ({'outcome': 'HTTP_541', 'cleanupVerified': True, 'egressBefore': 'a'}, None)
            result = queue.collect({'id': 'test', 'orderId': 1})
            self.assertEqual(result['outcome'], 'HTTP_541')
            self.assertEqual(attempt.call_count, 3)
            self.assertIn('a', attempt.call_args[0][1])

    def test_auth_and_unknown_cleanup_never_retry(self):
        for code in ['AUTHENTICATION_REQUIRED', 'HTTP_CLEANUP_PENDING', 'STATE_WRITE_FAILED', 'EGRESS_CHANGED_OR_UNVERIFIED']:
            with patch.object(queue, 'stopped', return_value=False), patch.object(queue, 'attempt') as attempt:
                attempt.return_value = ({'outcome': code, 'cleanupVerified': code != 'HTTP_CLEANUP_PENDING'}, None)
                self.assertEqual(queue.collect({'id': 'test'})['outcome'], code)
                self.assertEqual(attempt.call_count, 1)

    def test_cleanup_failure_cannot_return_business_result(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'private').mkdir()
            with patch.object(queue, 'ROOT', root), patch.object(queue, 'stopped', return_value=True), patch.object(queue, 'writePrivate'):
                audit, result = queue.attempt({'id': 'job', 'orderId': 1}, set())
                self.assertEqual(audit['outcome'], 'REQUEST_STOPPED')
                self.assertIsNone(result)

    def test_egress_history_and_active_claims_persist(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'private').mkdir()
            def write(path, value):
                path.touch(mode=0o600)
                path.write_text(json.dumps(value))
            with patch.object(queue, 'ROOT', root), patch.object(queue, 'writePrivate', side_effect=write):
                queue.egress_state('a', 'first')
                with self.assertRaisesRegex(RuntimeError, 'EGRESS_PREVIOUSLY_REJECTED'):
                    queue.egress_state('a', 'second')
                queue.egress_state('a', 'first', 'HTTP_541')
                with self.assertRaises(RuntimeError):
                    queue.egress_state('a', 'third')
                queue.egress_state('b', 'fourth')
                queue.egress_state('b', 'fourth', 'SUCCEEDED')
                queue.egress_state('b', 'fifth')

if __name__ == '__main__':
    unittest.main()
