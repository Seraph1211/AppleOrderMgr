"""批调度业务状态机验收，不连接官网或生产业务库。"""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
import uuid

spec = importlib.util.spec_from_file_location('batch', str(Path(__file__).parents[1] / 'scripts/officialReceiptBatch.py'))
batch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(batch)


class FakeAdapter:
    def __init__(self):
        self.committed = set()
        self.applies = 0
        self.calls = []
        self.unknown = False
        self.failReconcile = False

    def business(self, mode, payload):
        self.calls.append(mode)
        if mode == 'reconcile':
            if self.failReconcile:
                batch.fail('BUSINESS_RESULT_UNKNOWN')
            return {'outcome': 'RECEIPT_READBACK_VERIFIED' if payload['requestKey'] in self.committed else 'RECEIPT_NOT_APPLIED', 'serialCount': 2, 'newBindings': 2, 'receiptRunId': 42}
        if mode == 'apply':
            self.applies += 1
            self.committed.add(payload['requestKey'])
            if self.unknown:
                batch.fail('BUSINESS_RESULT_UNKNOWN')
            return {}
        batch.fail('UNEXPECTED_MODE')

    def cleanup(self, name):
        return True


class BatchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.config = {'concurrency': 2}
        self.attempt = str(uuid.uuid4())
        self.job = {'orderId': 1, 'state': 'applying', 'attempts': [{'id': self.attempt, 'container': 'test'}]}
        self.state = {'configDigest': batch.digest(self.config), 'batchId': str(uuid.uuid4()), 'jobs': [self.job]}
        batch.atomic(self.root / 'state.json', self.state)
        self.attemptRoot = self.root / 'attempts' / self.attempt
        self.payload = {'requestKey': self.attempt, 'orderId': 1, 'batchId': self.state['batchId']}
        batch.atomic(self.attemptRoot / 'private/binding.json', self.payload)
        self.adapter = FakeAdapter()
        self.runner = batch.Batch(self.root, self.config, self.adapter)
        self.job = self.runner.state['jobs'][0]

    def tearDown(self):
        self.temp.cleanup()

    def test_recovery_rejects_another_order_payload(self):
        self.payload['orderId'] = 2
        batch.atomic(self.attemptRoot / 'private/binding.json', self.payload)
        self.runner.recover()
        self.assertEqual(self.job['code'], 'RECEIPT_RECOVERY_IDENTITY_CONFLICT')
        self.assertEqual(self.adapter.calls, [])

    def test_unknown_commit_reads_before_any_retry(self):
        self.adapter.unknown = True
        self.runner.reconcile(self.job, self.attemptRoot)
        self.assertEqual(self.job['state'], 'succeeded')
        self.assertEqual(self.adapter.applies, 1)
        self.assertEqual(self.adapter.calls, ['reconcile', 'apply', 'reconcile', 'reconcile'])

    def test_crash_after_commit_recovers_without_replay(self):
        self.adapter.committed.add(self.attempt)
        self.runner.recover()
        self.assertEqual(self.job['state'], 'succeeded')
        self.assertEqual(self.adapter.applies, 0)
        self.assertEqual(batch.readPrivate(self.root / 'state.json')['jobs'][0]['state'], 'succeeded')

    def test_reconcile_unavailable_keeps_manual_recovery(self):
        self.adapter.failReconcile = True
        self.runner.recover()
        self.assertTrue(self.job['recoveryRequired'])
        self.assertEqual(self.job['state'], 'review')
        self.assertEqual(self.adapter.applies, 0)

    def test_stop_before_apply_only_reads(self):
        batch.atomic(self.root / 'STOP', True)
        self.runner.reconcile(self.job, self.attemptRoot)
        self.assertEqual(self.job['state'], 'stopped')
        self.assertEqual(self.adapter.applies, 0)

    def test_restart_running_preserves_attempts_and_wait(self):
        self.job['state'] = 'running'
        (self.attemptRoot / 'private/binding.json').unlink()
        self.runner.recover()
        self.assertEqual(self.job['state'], 'retry_wait')
        self.assertEqual(len(self.job['attempts']), 1)
        self.assertGreater(self.job['retryAt'], time.time())

    def test_restart_third_interruption_is_terminal(self):
        self.job['state'] = 'running'
        self.job['attempts'] *= 3
        (self.attemptRoot / 'private/binding.json').unlink()
        self.runner.recover()
        self.assertEqual(self.job['state'], 'failed')

    def test_config_change_and_second_leader_rejected(self):
        with self.assertRaisesRegex(RuntimeError, 'BATCH_CONFIG_CHANGED'):
            batch.Batch(self.root, {'concurrency': 3})
        with batch.leader(self.root):
            with self.assertRaisesRegex(RuntimeError, 'BATCH_ALREADY_RUNNING'):
                with batch.leader(self.root):
                    pass

    def test_success_skipped_on_run(self):
        self.job['state'] = 'succeeded'
        result = self.runner.run(1)
        self.assertEqual(result['states'], {'succeeded': 1})
        self.assertEqual(self.adapter.calls, [])

    def test_scheduler_serializes_same_account_and_parallelizes_others(self):
        self.runner.state['jobs'] = [{'orderId': i, 'state': 'queued', 'attempts': [], 'accountHash': account} for i, account in [(1, 'a'), (2, 'a'), (3, 'b')]]
        current = set()
        maximum = [0]
        overlap = [False]
        def execute(job):
            with self.runner.lock:
                if job['accountHash'] in current:
                    overlap[0] = True
                current.add(job['accountHash'])
                maximum[0] = max(maximum[0], len(current))
            time.sleep(0.05)
            with self.runner.lock:
                current.remove(job['accountHash'])
                self.runner.update(job, state='succeeded')
        self.runner.execute = execute
        self.assertEqual(self.runner.run(2)['states'], {'succeeded': 3})
        self.assertEqual(maximum[0], 2)
        self.assertFalse(overlap[0])

    def test_deferred_account_lock_keeps_history_without_consuming_network_attempt(self):
        self.job['attempts'] = [{'id': self.attempt}, {'id': str(uuid.uuid4()), 'deferred': True}]
        self.assertEqual(batch.consumedAttempts(self.job), 1)
        self.assertEqual(len(self.job['attempts']), 2)

    def test_iproyal_rotation_preserves_credentials_and_lifetime(self):
        proxy = {'host': 'geo.iproyal.com', 'port': 12321, 'provider': 'iproyal', 'preemptiveAuth': True,
                 'username': 'synthetic', 'password': 'secret_country-cn_session-Abc12345_lifetime-24h'}
        file = self.root / 'proxy.json'
        batch.atomic(file, proxy)
        first, spec = batch.freshProxy(file)
        second, _ = batch.freshProxy(file)
        self.assertEqual(first['username'], proxy['username'])
        self.assertNotEqual(first['password'], second['password'])
        self.assertTrue(first['password'].startswith('secret_country-cn_session-'))
        self.assertTrue(first['password'].endswith('_lifetime-24h'))
        self.assertGreater(batch.epoch(spec['createdAt']), time.time() - 2)
        proxy['password'] = 'secret-without-session'
        batch.atomic(file, proxy)
        with self.assertRaisesRegex(RuntimeError, 'IPROYAL_TEMPLATE_INVALID'):
            batch.freshProxy(file)

    def test_auth_manual_result_wins_over_later_proxy_failure(self):
        for outcome in ['AUTH_REJECTED', 'AUTH_PRECONDITION_REQUIRED', 'HUMAN_VERIFICATION_REQUIRED']:
            self.assertEqual(batch.failureCode({'outcome': outcome}, RuntimeError('EGRESS_CHANGED')), outcome)
            self.assertEqual(batch.failureCode({'outcome': outcome}, RuntimeError('RUNTIME_COMMAND_FAILED')), outcome)
        self.assertEqual(batch.failureCode({'outcome': 'SUCCEEDED'}, RuntimeError('EGRESS_CHANGED')), 'EGRESS_CHANGED')

    def test_http_timeout_retries_only_three_times_and_never_applies(self):
        source = {'samples': [{'id': 1, 'orderNumber': 'W1234567890', 'accountHash': 'synthetic'}]}
        self.job.update(state='queued', position=0, attempts=[], identity=batch.digest([1, 'W1234567890', 'synthetic']))
        template = self.root / 'proxy.json'
        batch.atomic(template, {'host': 'geo.iproyal.com', 'port': 12321, 'username': 'test', 'password': 'test', 'provider': 'iproyal'})
        configFile = self.root / 'gate.json'
        batch.atomic(configFile, {})
        self.runner.config.update(actorUserId=1, totalRequestLimit=200, gateConfig=str(configFile), evidenceKey=str(configFile), proxies=[{'file': str(template), 'createdAt': batch.nowIso()}])
        class TimeoutAdapter(FakeAdapter):
            def business(self, mode, payload):
                if mode == 'input':
                    return source
                return super().business(mode, payload)
            def gate(self, mode, root):
                return {'outcome': 'RECEIPT_READY'}
            def probe(self, proxy):
                return 'e' * 64
            def collect(self, root, name):
                return {'outcome': 'HTTP_TIMEOUT', 'runId': 1, 'requests': 1}
        self.runner.adapter = TimeoutAdapter()
        for index in range(3):
            self.runner.execute(self.job)
            self.assertEqual(self.job['state'], 'retry_wait' if index < 2 else 'review')
        self.assertEqual(len(self.job['attempts']), 3)
        self.assertEqual(self.runner.adapter.applies, 0)

    def test_atomic_private_no_secret_summary(self):
        self.assertEqual((self.root / 'state.json').stat().st_mode & 0o777, 0o600)
        self.job['password'] = 'must-not-export'
        self.assertNotIn('must-not-export', json.dumps(batch.summary(self.runner.state)))

    def test_chinese_help_works_with_ascii_process_streams(self):
        environment = dict(os.environ, PYTHONIOENCODING='ascii', PYTHONUTF8='0', PYTHONCOERCECLOCALE='0', LC_ALL='C', LANG='C')
        result = subprocess.run([sys.executable, str(Path(batch.__file__)), '--help'], env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr.decode('utf-8'))
        self.assertIn('官网电子收据批调度器', result.stdout.decode('utf-8'))


if __name__ == '__main__':
    unittest.main()
