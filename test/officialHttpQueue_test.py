"""HTTP 队列离线回归：API 提取、重试上限、出口、未知提交保护。"""
import importlib.util
import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch, MagicMock

sys.path.insert(0, str(Path('scripts/officialOrder').resolve()))
import iproyalApi
import runHttpSample
spec = importlib.util.spec_from_file_location('httpQueue', 'scripts/runOfficialOrderHttpQueue.py')
queue = importlib.util.module_from_spec(spec)
spec.loader.exec_module(queue)


class HttpQueueTest(unittest.TestCase):
    def test_command_failure_keeps_exit_code_without_secret_output(self):
        result = MagicMock(returncode=28, stderr=b'https://secret:password@proxy', stdout=b'secret')
        with patch.object(runHttpSample.subprocess, 'run', return_value=result):
            with self.assertRaises(runHttpSample.RuntimeCommandError) as caught:
                runHttpSample.run(['curl'])
        self.assertEqual(caught.exception.exit_code, 28)
        self.assertEqual(str(caught.exception), 'RUNTIME_COMMAND_FAILED')
        self.assertNotIn('secret', repr(vars(caught.exception)))

    def test_probe_failures_are_classified_by_exit_not_exception_text(self):
        for exit_code, expected in [(28, 'TIMEOUT'), (7, 'CONNECTION_FAILED'), (22, 'HTTP_FAILED'), (60, 'TLS_FAILED')]:
            self.assertEqual(queue.failure_code(runHttpSample.RuntimeCommandError(exit_code), 'probe-before'),
                             'EGRESS_PROBE_' + expected)
        self.assertEqual(queue.failure_code(RuntimeError('EGRESS_CHANGED_OR_UNVERIFIED'), 'probe-after'),
                         'EGRESS_CHANGED_OR_UNVERIFIED')

    def test_only_pre_collection_probe_network_failure_can_retry(self):
        for code in ('EGRESS_PROBE_TIMEOUT', 'EGRESS_PROBE_CONNECTION_FAILED', 'EGRESS_PROBE_HTTP_FAILED'):
            for stage, calls in [('probe-before', 3), ('probe-after', 1)]:
                with self.subTest(code=code, stage=stage):
                    audit = {'outcome': code, 'cleanupVerified': True, 'failedStage': stage}
                    with patch.object(queue, 'stopped', return_value=False), patch.object(queue, 'attempt', return_value=(audit, None)) as attempt:
                        queue.collect({'id': 'test', 'orderId': 1})
                    self.assertEqual(attempt.call_count, calls)

    def test_pre_probe_http_retry_stops_after_success(self):
        failed = ({'outcome': 'EGRESS_PROBE_HTTP_FAILED', 'cleanupVerified': True, 'failedStage': 'probe-before'}, None)
        succeeded = ({'outcome': 'SUCCEEDED', 'cleanupVerified': True}, {'verified': True})
        with patch.object(queue, 'stopped', return_value=False), patch.object(queue, 'attempt', side_effect=[failed, succeeded]) as attempt:
            result = queue.collect({'id': 'test', 'orderId': 1})
        self.assertEqual(attempt.call_count, 2)
        self.assertEqual(result['outcome'], 'SUCCEEDED')

    def test_probe_tls_and_unverified_cleanup_do_not_retry(self):
        for code, cleaned in [('EGRESS_PROBE_TLS_FAILED', True), ('EGRESS_PROBE_HTTP_FAILED', False)]:
            audit = {'outcome': code, 'cleanupVerified': cleaned, 'failedStage': 'probe-before'}
            with patch.object(queue, 'stopped', return_value=False), patch.object(queue, 'attempt', return_value=(audit, None)) as attempt:
                queue.collect({'id': 'test', 'orderId': 1})
            self.assertEqual(attempt.call_count, 1)

    def test_probe_retries_same_proxy_once_without_recollecting(self):
        proxy = {'session': 'same'}
        for key in ('probeBeforeAttempts', 'probeAfterAttempts'):
            audit = {}
            with patch.object(queue, 'stopped', return_value=False), \
                    patch.object(queue, 'probe', side_effect=[runHttpSample.RuntimeCommandError(22), 'verified']) as probe:
                self.assertEqual(queue.probe_with_retry(proxy, audit, key), 'verified')
            self.assertEqual(audit[key], 2)
            self.assertEqual([call.args for call in probe.call_args_list], [(proxy,), (proxy,)])

    def test_probe_retry_does_not_accept_tls_or_unverified_egress(self):
        for error in (runHttpSample.RuntimeCommandError(60), RuntimeError('EGRESS_LOG_UNAVAILABLE'), RuntimeError('API_HEALTH_FAILED')):
            with patch.object(queue, 'stopped', return_value=False), patch.object(queue, 'probe', side_effect=error) as probe:
                with self.assertRaises(RuntimeError):
                    queue.probe_with_retry({}, {}, 'probeAfterAttempts')
            self.assertEqual(probe.call_count, 1)

    def test_probe_retry_is_bounded_and_obeys_stop(self):
        with patch.object(queue, 'stopped', return_value=False), \
                patch.object(queue, 'probe', side_effect=runHttpSample.RuntimeCommandError(28)) as probe:
            with self.assertRaises(runHttpSample.RuntimeCommandError):
                queue.probe_with_retry({}, {}, 'probeAfterAttempts')
        self.assertEqual(probe.call_count, 2)
        with patch.object(queue, 'stopped', side_effect=[False, True]), \
                patch.object(queue, 'probe', side_effect=runHttpSample.RuntimeCommandError(22)) as probe:
            with self.assertRaisesRegex(RuntimeError, 'REQUEST_STOPPED'):
                queue.probe_with_retry({}, {}, 'probeAfterAttempts')
        self.assertEqual(probe.call_count, 1)

    def test_post_probe_failure_preserves_site_failure_and_denies_success_write(self):
        for code, expected in [('SHIELD_HTTP_404', 'SHIELD_HTTP_404'), ('SUCCEEDED', 'EGRESS_PROBE_TIMEOUT')]:
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                (root / 'private').mkdir()
                source = root / 'release/scripts'
                source.mkdir(parents=True)
                (source / 'readOfficialOrderLinkInput.js').write_text('synthetic')
                data = {'capturedAt': 'synthetic', 'samples': [{'id': 1, 'orderNumber': 'W1234567890'}]}
                output = MagicMock(stdout=json.dumps({'outcome': code, 'runId': 12}).encode(), returncode=0)
                with patch.object(queue, 'ROOT', root), patch.object(queue, 'stopped', return_value=False), \
                        patch.object(queue, 'read_private', return_value={}), patch.object(queue, 'writePrivate'), \
                        patch.object(queue, 'generate_proxy', return_value={}), patch.object(queue, 'egress_state'), \
                        patch.object(queue, 'run', return_value=json.dumps(data).encode()), \
                        patch.object(queue.subprocess, 'run', return_value=output), \
                        patch.object(queue, 'probe', side_effect=['verified-before', runHttpSample.RuntimeCommandError(28), runHttpSample.RuntimeCommandError(28)]):
                    audit, result = queue.attempt({'id': 'job', 'orderId': 1, 'orderNumber': 'W1234567890'}, set())
            self.assertIsNone(result)
            self.assertEqual(audit['outcome'], expected)
            self.assertEqual(audit['collectorOutcome'], code)
            self.assertEqual(audit['egressAfterError'], 'EGRESS_PROBE_TIMEOUT')
            self.assertEqual(audit['failedStage'], 'probe-after')
            self.assertEqual(audit['commandExitCode'], 28)
            self.assertTrue(audit['cleanupVerified'])

    def test_main_executes_ten_jobs_simultaneously(self):
        started = []
        finished = []
        all_started = threading.Event()
        release = threading.Event()
        mutex = threading.Lock()
        claimed = 0
        overlapped = False

        def collect(job):
            with mutex:
                started.append(job['id'])
                if len(started) == 10:
                    all_started.set()
            release.wait(5)
            return dict(job, outcome='NO_VALID_ORDER_DATA')

        def command(action, payload=None):
            nonlocal claimed, overlapped
            if action == 'finish':
                finished.append(payload['id'])
                return {'finished': True}
            if claimed < 10:
                claimed += 1
                return {'id': str(claimed), 'orderId': claimed}
            overlapped = all_started.wait(3)
            queue.STOPPING = True
            release.set()
            return None

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'private').mkdir()
            with patch.object(queue, 'ROOT', root), patch.object(queue, 'STOPPING', False), \
                    patch.object(queue, 'read_private', return_value={}), \
                    patch.object(queue, 'writePrivate'), patch.object(queue, 'command', side_effect=command), \
                    patch.object(queue, 'collect', side_effect=collect), \
                    patch.object(queue.signal, 'signal'), patch.object(queue.os, 'umask'):
                queue.main()
        self.assertTrue(overlapped, '十单应在释放任何一个任务之前全部开始')
        self.assertEqual(len(set(started)), 10)
        self.assertCountEqual(started, finished)

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
