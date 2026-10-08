"""HTTP 单样本执行器：离线核对锁、进程结果、身份与退出清理。"""
import contextlib
import fcntl
import hashlib
import importlib.util
import io
import json
import pathlib
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
from types import SimpleNamespace

SPEC = importlib.util.spec_from_file_location(
    'http_sample', pathlib.Path(__file__).parents[1] / 'scripts/officialOrder/runHttpSample.py')
sample = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(sample)


class HttpSampleTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = pathlib.Path(self.directory.name)
        (self.root / 'private').mkdir()
        (self.root / 'release/scripts').mkdir(parents=True)
        (self.root / 'release/scripts/readOfficialOrderLinkInput.js').write_bytes(b'inputScript')
        (self.root / 'private/plan.json').write_text(json.dumps({
            'scope': 'missing-fields', 'schemaVersion': 3,
            'entries': [{'id': 240, 'orderNumber': 'W1234567890'}],
            'description': '中文冻结说明',
        }, ensure_ascii=False), encoding='utf-8')
        (self.root / 'private/iproyal-cn.json').write_text(json.dumps({'entries': [{
            'host': 'proxy.example.test', 'port': 12345,
            'username': 'private-user', 'password': 'private-password',
        }]}), encoding='utf-8')
        self.calls = []
        self.summary = {'outcome': 'SUCCEEDED', 'orderId': 240, 'runId': 12,
                        'resultFile': '/research/private/results/order-240-run-12.json'}
        self.startExit = 0
        self.containerExit = 0
        self.running = False
        self.startTimeout = False
        self.removeExit = 0
        self.removeTimeout = False
        self.inputFailure = False
        self.preflightOutcome = 'HTTP_PREFLIGHT_ALLOWED'

    def quarantineInput(self):
        original = self.root / 'private/request-240.json'
        original.write_bytes(b'{"capturedAt":"old","samples":[]}')
        original.chmod(0o600)
        digest = hashlib.sha256(original.read_bytes()).hexdigest()
        event = {'event': 'failed_read_only_quarantined', 'orderId': 240, 'sampleAttemptId': 'a' * 32,
                 'verification': {'files': {'private/request-240.json': digest}}}
        journal = self.root / 'private/http-batch-apply.jsonl'
        journal.write_text(json.dumps(event) + '\n'); journal.chmod(0o600)
        archived = self.root / ('private/http-quarantine-input-240-' + 'a' * 32 + '.json')
        return original, archived

    def test_preserve_exact_input_before_refresh_and_reuse_verified_archive(self):
        original, archived = self.quarantineInput()
        before = original.read_bytes()
        sample.preserveQuarantineInput(self.root, 240)
        self.assertEqual(archived.read_bytes(), before)
        self.assertEqual(archived.stat().st_mode & 0o777, 0o600)
        original.write_bytes(b'{"new":true}')
        sample.preserveQuarantineInput(self.root, 240)
        self.assertEqual(archived.read_bytes(), before)
        self.assertEqual(original.read_bytes(), b'{"new":true}')

    def test_preservation_fails_if_old_bytes_lost_without_matching_archive(self):
        original, archived = self.quarantineInput()
        original.write_bytes(b'{"new":true}')
        with self.assertRaisesRegex(RuntimeError, 'QUARANTINE_INPUT_PRESERVATION_FAILED'):
            sample.preserveQuarantineInput(self.root, 240)
        self.assertFalse(archived.exists())

    def test_preservation_does_not_accept_corrupt_or_linked_archive(self):
        original, archived = self.quarantineInput()
        archived.write_bytes(b'wrong'); archived.chmod(0o600)
        with self.assertRaises(RuntimeError): sample.preserveQuarantineInput(self.root, 240)
        archived.unlink(); archived.symlink_to(original)
        with self.assertRaises(RuntimeError): sample.preserveQuarantineInput(self.root, 240)

    def test_unrelated_target_has_no_preservation_writes(self):
        original, archived = self.quarantineInput()
        sample.preserveQuarantineInput(self.root, 241)
        self.assertFalse(archived.exists())

    def subprocess(self, args, **kwargs):
        self.calls.append((args, kwargs))
        if args[:2] == ['docker', 'exec']:
            if self.inputFailure:
                raise RuntimeError('private-password')
            return subprocess.CompletedProcess(args, 0, json.dumps({'samples': [{
                'id': 240, 'orderNumber': 'W1234567890', 'accountHash': 'a' * 64,
                'url': 'https://www.apple.com.cn/xc/cn/vieworder/W1234567890/a@example.test',
            }]}).encode(), b'')
        if args[:2] == ['docker', 'run']:
            return subprocess.CompletedProcess(args, 0, json.dumps({
                'version': 2, 'outcome': self.preflightOutcome, 'orderId': 240,
                'checkedAt': time.time(),
                'planSha256': hashlib.sha256((self.root / 'private/plan.json').read_bytes()).hexdigest(),
                'inputSha256': hashlib.sha256((self.root / 'private/request-240.json').read_bytes()).hexdigest(),
                'accountPaused': self.preflightOutcome == 'ACCOUNT_COOLDOWN',
                'attempts': 10 if self.preflightOutcome == 'ORDER_ATTEMPT_LIMIT' else 0,
            }).encode(), b'')
        if args[:2] == ['docker', 'start']:
            if self.startTimeout:
                raise subprocess.TimeoutExpired(args, 210)
            return subprocess.CompletedProcess(args, self.startExit, json.dumps(self.summary).encode(), b'')
        if args[:2] == ['docker', 'inspect']:
            state = {'Running': self.running, 'Status': 'running' if self.running else 'exited',
                     'ExitCode': self.containerExit, 'OOMKilled': False, 'Error': ''}
            value = state
            if '--format' in args:
                template = args[args.index('--format') + 1]
                if template == '{{.State.ExitCode}}':
                    value = self.containerExit
            return subprocess.CompletedProcess(args, 0, json.dumps(value).encode(), b'')
        if args[:2] == ['docker', 'rm']:
            if self.removeTimeout:
                raise subprocess.TimeoutExpired(args, 30)
            return subprocess.CompletedProcess(args, self.removeExit, b'', b'')
        return subprocess.CompletedProcess(args, 0, b'container-id', b'')

    def execute(self, probes=None, extra=None):
        output = io.StringIO()
        failure = None
        with patch.object(sys, 'argv', ['sample', '--root', str(self.root), '--id', '240', '--proxy-index', '0'] + (extra or [])), \
                patch.object(sample.subprocess, 'run', side_effect=self.subprocess), \
                patch.object(sample, 'probe', side_effect=probes or ['f' * 64, 'f' * 64]) as probe, \
                patch.object(sample.os, 'chown'), contextlib.redirect_stdout(output):
            try:
                sample.main()
            except Exception as error:
                failure = error
        text = output.getvalue().strip()
        return (json.loads(text.splitlines()[-1]) if text else None), failure, probe

    def test_inherited_parent_lock_allows_sample_and_survives_child_close(self):
        with open(str(self.root / 'private/http-sample.lock'), 'a') as parent:
            fcntl.flock(parent, fcntl.LOCK_EX | fcntl.LOCK_NB)
            result, error, _probe = self.execute(extra=['--sample-lock-fd', str(parent.fileno())])
            self.assertIsNone(error)
            self.assertEqual(result['outcome'], 'SUCCEEDED')
            with open(str(self.root / 'private/http-sample.lock'), 'a') as other:
                with self.assertRaises(BlockingIOError):
                    fcntl.flock(other, fcntl.LOCK_SH | fcntl.LOCK_NB)

    def test_unrelated_inherited_descriptor_is_rejected_before_probe(self):
        (self.root / 'private/http-sample.lock').touch()
        with open(str(self.root / 'private/unrelated.lock'), 'a') as other:
            result, _error, probe = self.execute(extra=['--sample-lock-fd', str(other.fileno())])
            self.assertEqual(result['outcome'], 'INPUT_INVALID')
            probe.assert_not_called()

    def test_repeated_samples_never_overwrite_proxy_configuration(self):
        first, _error, _probe = self.execute()
        path = self.root / ('private/http-config-' + first['attemptId'] + '.json')
        original = path.read_bytes()
        second, _error, _probe = self.execute()
        self.assertNotEqual(first['attemptId'], second['attemptId'])
        self.assertEqual(path.read_bytes(), original)
        self.assertEqual(len(list((self.root / 'private').glob('http-config-*.json'))), 2)
        config = json.loads(original)
        self.assertEqual(config['orderId'], 240)
        self.assertEqual(config['attemptId'], first['attemptId'])
        self.assertFalse((self.root / 'private/httpProxy.json').exists())

    def assertNotSucceeded(self, result):
        value, failure, _ = result
        self.assertTrue(failure is not None or value.get('outcome') != 'SUCCEEDED')

    def test_success_preserves_private_configs_and_has_no_password_in_command(self):
        summary, error, probe = self.execute()
        self.assertIsNone(error)
        self.assertEqual(summary['outcome'], 'SUCCEEDED')
        self.assertTrue(summary['egressVerifiedAfter'])
        self.assertEqual(summary['egressHash'], summary['egressAfterHash'])
        self.assertGreaterEqual(summary['finishedAt'], summary['startedAt'])
        self.assertRegex(summary['attemptId'], r'^[a-f0-9]{32}$')
        self.assertTrue((self.root / 'private' / ('http-sample-240-' + summary['attemptId'] + '.json')).is_file())
        self.assertEqual(probe.call_count, 2)
        for path in ['http-config-' + summary['attemptId'] + '.json', 'request-240.json']:
            self.assertEqual((self.root / 'private' / path).stat().st_mode & 0o777, 0o600)
        self.assertNotIn('private-password', json.dumps([args for args, _ in self.calls]))
        self.assertTrue(any(args[:2] == ['docker', 'rm'] for args, _ in self.calls))

    def test_shared_configuration_lock_blocks_second_sampler_before_probe(self):
        with open(str(self.root / 'private/http-sample.lock'), 'a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            value, error, probe = self.execute()
            self.assertIsNone(error)
            self.assertEqual(value['outcome'], 'HTTP_SAMPLE_BUSY')
            self.assertEqual(value['targetOrderId'], 240)
            self.assertEqual(len(list((self.root / 'private').glob('http-sample-240-*.json'))), 1)
            self.assertFalse(self.calls)
            probe.assert_not_called()

    def test_start_failure_never_promotes_success_stdout(self):
        self.startExit = 1
        self.assertNotSucceeded(self.execute())

    def test_changed_proxy_credentials_cannot_reuse_rejected_actual_egress(self):
        (self.root / 'private/http-rejected-egress.json').write_text(json.dumps(['f' * 64]))
        summary, error, probe = self.execute()
        self.assertIsNone(error)
        self.assertEqual(summary['outcome'], 'EGRESS_PREVIOUSLY_REJECTED')
        self.assertEqual(probe.call_count, 1)
        # 输入与研究库只读预检提前，但拒用出口仍不能启动采集器。
        self.assertEqual([args[:2] for args, _kwargs in self.calls], [['docker', 'exec'], ['docker', 'run']])
        self.assertFalse((self.root / 'private/httpConfig.json').exists())

    def test_nonzero_container_exit_never_promotes_success_stdout(self):
        self.containerExit = 2
        self.assertNotSucceeded(self.execute())

    def test_live_container_is_not_reported_as_complete(self):
        self.running = True
        self.assertNotSucceeded(self.execute())

    def test_wrong_stdout_order_id_is_not_silently_overwritten(self):
        self.summary['orderId'] = 999
        self.assertNotSucceeded(self.execute())

    def test_result_path_must_belong_to_same_order_and_run(self):
        self.summary['resultFile'] = '/research/private/results/order-999-run-12.json'
        self.assertNotSucceeded(self.execute())

    def test_exit_timeout_still_removes_the_isolated_container(self):
        self.startTimeout = True
        self.assertNotSucceeded(self.execute())
        self.assertTrue(any(args[:2] == ['docker', 'rm'] for args, _ in self.calls))

    def test_changed_egress_keeps_detail_outcome_but_does_not_verify_it(self):
        summary, error, _ = self.execute(['a' * 64, 'b' * 64])
        self.assertIsNone(error)
        self.assertEqual(summary['outcome'], 'EGRESS_CHANGED_OR_UNVERIFIED')
        self.assertEqual(summary['originalOutcome'], 'SUCCEEDED')
        self.assertFalse(summary['egressVerifiedAfter'])

    def test_failed_second_probe_does_not_verify_results(self):
        summary, error, _ = self.execute(['a' * 64, RuntimeError('EGRESS_LOG_UNAVAILABLE')])
        self.assertIsNone(error)
        self.assertEqual(summary['outcome'], 'EGRESS_CHANGED_OR_UNVERIFIED')
        self.assertFalse(summary['egressVerifiedAfter'])

    def test_utf8_plan_load_does_not_depend_on_ascii_locale(self):
        original = pathlib.Path.read_text
        def asciiDefault(path, *args, **kwargs):
            kwargs.setdefault('encoding', 'ascii')
            return original(path, *args, **kwargs)
        with patch.object(pathlib.Path, 'read_text', asciiDefault):
            summary, error, _ = self.execute()
        self.assertIsNone(error)
        self.assertEqual(summary['outcome'], 'SUCCEEDED')

    def test_container_cleanup_has_a_bounded_wait(self):
        self.execute()
        cleanup = [kwargs for args, kwargs in self.calls if args[:2] == ['docker', 'rm']]
        self.assertTrue(cleanup)
        self.assertGreater(cleanup[-1].get('timeout', 0), 0)

    def test_back_to_back_attempts_do_not_overwrite_private_evidence(self):
        with patch.object(sample.time, 'time', return_value=1000.125):
            first = self.execute()
            self.assertIsNone(first[1])
            second = self.execute()
            self.assertIsNone(second[1])
        self.assertEqual(len(list((self.root / 'private').glob('http-sample-240-*.json'))), 2)

    def test_timeout_saves_target_correlated_failure_evidence(self):
        self.startTimeout = True
        self.execute()
        paths = list((self.root / 'private').glob('http-sample-240-*.json'))
        self.assertEqual(len(paths), 1)
        evidence = json.loads(paths[0].read_text(encoding='utf-8'))
        self.assertEqual(evidence['targetOrderId'], 240)
        self.assertFalse(evidence.get('egressVerifiedAfter', False))
        self.assertNotEqual(evidence['outcome'], 'SUCCEEDED')

    def test_cleanup_failure_is_recorded_and_never_success(self):
        self.removeExit = 1
        value, error, _ = self.execute()
        self.assertIsNone(error)
        self.assertEqual(value['outcome'], 'CONTAINER_CLEANUP_FAILED')
        self.assertEqual(value['originalOutcome'], 'SUCCEEDED')
        self.assertFalse(value['cleanup']['removed'])
        self.assertTrue(value['cleanup']['attempted'])

    def test_cleanup_failure_blocks_later_shared_configuration_changes(self):
        self.removeExit = 1
        first, error, _ = self.execute()
        self.assertIsNone(error)
        self.assertTrue(first['cleanup']['blockRecorded'])
        configPath = self.root / ('private/http-config-' + first['attemptId'] + '.json')
        previousConfig = configPath.read_bytes()
        self.calls = []
        second, error, probe = self.execute()
        self.assertIsNone(error)
        self.assertEqual(second['outcome'], 'HTTP_SAMPLE_CLEANUP_PENDING')
        self.assertFalse(self.calls)
        probe.assert_not_called()
        self.assertEqual(previousConfig, configPath.read_bytes())
        self.assertEqual(len(list((self.root / 'private').glob('http-config-*.json'))), 1)

    def test_cleanup_timeout_is_recorded_and_releases_lock(self):
        self.removeTimeout = True
        value, error, _ = self.execute()
        self.assertIsNone(error)
        self.assertEqual(value['outcome'], 'CONTAINER_CLEANUP_TIMEOUT')
        with open(str(self.root / 'private/http-sample.lock'), 'a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)

    def test_early_probe_failure_is_audited_without_container_or_secrets(self):
        value, error, probe = self.execute([RuntimeError('private-password')])
        self.assertIsNone(error)
        self.assertEqual(value['outcome'], 'HTTP_SAMPLE_FAILED')
        self.assertEqual(value['failedStage'], 'probe-before')
        self.assertEqual(value['targetOrderId'], 240)
        self.assertIsNone(value['egressAfterHash'])
        self.assertFalse(value['egressVerifiedAfter'])
        self.assertEqual(probe.call_count, 1)
        self.assertEqual([args[:2] for args, _kwargs in self.calls], [['docker', 'exec'], ['docker', 'run']])
        self.assertNotIn('private-password', json.dumps(value))
        self.assertEqual(len(list((self.root / 'private').glob('http-sample-240-*.json'))), 1)
        with open(str(self.root / 'private/http-sample.lock'), 'a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)

    def test_input_failure_is_audited_before_container_creation(self):
        self.inputFailure = True
        value, error, _ = self.execute()
        self.assertIsNone(error)
        self.assertEqual(value['failedStage'], 'input-read')
        self.assertEqual(value['targetOrderId'], 240)
        self.assertFalse(value['cleanup']['attempted'])
        self.assertFalse(any(args[:2] == ['docker', 'create'] for args, _ in self.calls))
        self.assertNotIn('private-password', json.dumps(value))

    def test_unknown_child_fields_are_not_copied_to_audit(self):
        self.summary['password'] = 'private-password'
        self.summary['debug'] = {'url': 'https://private-user:private-password@example.test'}
        value, error, _ = self.execute()
        self.assertIsNone(error)
        self.assertEqual(value['outcome'], 'SUCCEEDED')
        self.assertNotIn('private-password', json.dumps(value))

    def test_failed_probe_preserves_null_after_hash(self):
        value, error, _ = self.execute(['a' * 64, RuntimeError('API_HEALTH_FAILED')])
        self.assertIsNone(error)
        self.assertIsNone(value['egressAfterHash'])
        self.assertEqual(value['egressAfterError'], 'API_HEALTH_FAILED')
        self.assertGreaterEqual(value['finishedAt'], value['startedAt'])

    def test_audit_write_failure_releases_lock_and_does_not_claim_success(self):
        original = sample.writePrivate
        def failAudit(path, value):
            if path.name.startswith('http-sample-'):
                raise OSError('private-password')
            return original(path, value)
        with patch.object(sample, 'writePrivate', side_effect=failAudit):
            value, error, _ = self.execute()
        self.assertIsNone(error)
        self.assertEqual(value['outcome'], 'AUDIT_WRITE_FAILED')
        self.assertNotIn('private-password', json.dumps(value))
        with open(str(self.root / 'private/http-sample.lock'), 'a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)


class EgressProbeTests(unittest.TestCase):
    proxy = {'host': 'proxy.example.test', 'port': 12345,
             'username': 'private-user', 'password': 'private-password'}
    token = 'http-rebuild-' + '1' * 32

    def probe(self, addresses, health=True):
        log = ''.join(address + ' - - GET /api/health/ready?' + self.token + '\n'
                      for address in addresses).encode()
        with patch.object(sample.uuid, 'uuid4', return_value=SimpleNamespace(hex='1' * 32)), \
                patch.object(sample, 'run', return_value=json.dumps({'success': health}).encode()) as command, \
                patch('builtins.open', return_value=io.BytesIO(log)):
            result = sample.probe(self.proxy)
        return result, command

    def test_unique_public_egress_is_hashed_without_exposing_credentials(self):
        value, command = self.probe(['8.8.8.8'])
        self.assertEqual(value, hashlib.sha256(b'8.8.8.8').hexdigest())
        self.assertNotIn('private-password', json.dumps(command.call_args[0]))
        self.assertEqual(command.call_args[1]['timeout'], 25)

    def test_multiple_log_matches_are_not_assumed_one_exit(self):
        with self.assertRaisesRegex(RuntimeError, 'EGRESS_LOG_UNAVAILABLE'):
            self.probe(['8.8.8.8', '8.8.8.8'])

    def test_private_address_is_not_accepted_as_public_egress(self):
        with self.assertRaisesRegex(RuntimeError, 'EGRESS_NOT_PUBLIC'):
            self.probe(['10.0.0.1'])

    def test_unhealthy_probe_never_confirms_egress(self):
        with self.assertRaisesRegex(RuntimeError, 'API_HEALTH_FAILED'):
            self.probe(['8.8.8.8'], health=False)


if __name__ == '__main__':
    unittest.main()
