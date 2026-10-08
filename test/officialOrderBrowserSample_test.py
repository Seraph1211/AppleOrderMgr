"""浏览器单样本离线测试：同锁、租约、凭据范围、运行关联和收据出口。"""
import contextlib
import copy
import fcntl
import hashlib
import importlib.util
import io
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPTS = pathlib.Path(__file__).parents[1] / 'scripts/officialOrder'
with patch.object(sys, 'path', [str(SCRIPTS)] + sys.path):
    SPEC = importlib.util.spec_from_file_location('browser_sample', SCRIPTS / 'runBrowserSample.py')
    sample = importlib.util.module_from_spec(SPEC)
    SPEC.loader.exec_module(sample)


class BrowserSampleTests(unittest.TestCase):
    nativeBrowser = False

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = pathlib.Path(self.directory.name)
        self.private = self.root / 'private'
        self.private.mkdir()
        (self.root / 'release/scripts').mkdir(parents=True)
        (self.root / 'release/scripts/readOfficialOrderInput.js').write_bytes(b'readPrivateInput')
        (self.root / 'release/scripts/readOfficialOrderLinkInput.js').write_bytes(b'readLinkInput')
        self.now = 1791417600.125
        self.email = 'owner@example.test'
        self.order = 'W1234567890'
        self.proxy = {'host': 'proxy.example.test', 'port': 12345,
                      'username': 'private-user', 'password': 'private-proxy-password'}
        self.hash = hashlib.sha256(json.dumps([self.proxy[k] for k in ('host', 'port', 'username', 'password')],
                                             separators=(',', ':')).encode()).hexdigest()
        self.plan = {'schemaVersion': 3, 'scope': 'missing-fields', 'cutoff': None,
                     'policy': sample.POLICY, 'startedAt': sample.isoTime(self.now - 60),
                     'entries': [{'id': 240, 'orderNumber': self.order,
                                  'accountKey': hashlib.md5(self.email.encode()).hexdigest(),
                                  'dateMissing': True, 'serialsMissing': True}]}
        self.write(self.private / 'plan.json', self.plan)
        self.write(self.private / 'iproyal-cn.json', {'entries': [self.proxy]})
        self.input = {'samples': [{'id': 240, 'orderNumber': self.order, 'email': self.email,
                      'password': 'private-apple-password',
                      'accountHash': hashlib.sha256(self.email.encode()).hexdigest()}]}
        self.linkInput = {'capturedAt': sample.isoTime(self.now), 'samples': [{'id': 240,
            'orderNumber': self.order, 'accountHash': hashlib.sha256(self.email.encode()).hexdigest(),
            'beforeRowHash': 'a' * 32, 'url': 'https://www.apple.com.cn/shop/order/list/' + self.order + '/owner'}]}
        self.preflightOutcome = 'BROWSER_PREFLIGHT_ALLOWED'
        self.summary = {'outcome': 'SUCCEEDED', 'systemOrderId': 240, 'runId': 12,
                        'passwordSubmitted': True, 'serverSessionRestored': False,
                        'results': [{'orderId': 240, 'outcome': 'SUCCEEDED', 'runId': 12, 'attempted': True,
                          'resultFile': '/research/private/results/order-240-run-12.json',
                          'receipt': {'orderId': 240, 'detailRun': 12, 'runId': 13, 'outcome': 'RECEIPT_CAPTURED'}}]}
        self.metadata = {'systemOrderId': 240, 'orderNumber': self.order, 'detailRun': 12,
                         'runId': 13, 'transport': 'same-browser', 'egressVerifiedAfter': False,
                         'egressHash': 'f' * 64, 'status': 200, 'contentType': 'text/html;charset=utf-8',
                         'file': 'receipt-probe-13.enc', 'sha256': 'a' * 64, 'urlHash': 'b' * 64,
                         'detailSha256': 'c' * 64, 'observedAt': sample.isoTime(self.now)}
        self.detail = {'systemOrderId': 240, 'orderNumber': self.order,
                       'source': {'runId': 12, 'sha256': 'c' * 64, 'observedAt': sample.isoTime(self.now)}}
        self.calls = []
        self.startExit = 0
        self.state = {'Running': False, 'ExitCode': 0, 'OOMKilled': False}
        self.timeout = False
        self.removeExit = 0
        self.inputExit = 0
        self.modifyConfig = False

    def write(self, path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value), encoding='utf-8')
        path.chmod(0o600)

    def command(self, args, **kwargs):
        self.calls.append((args, kwargs))
        if args[:2] == ['docker', 'exec']:
            if kwargs.get('input') == b'readLinkInput':
                return subprocess.CompletedProcess(args, 0, json.dumps(self.linkInput).encode(), b'')
            return subprocess.CompletedProcess(args, self.inputExit, json.dumps(self.input).encode(),
                b'{"outcome":"ACCOUNT_MARKED_INVALID"}')
        if args[:2] == ['docker', 'run'] and '--browser' in args:
            value = {'version': 2, 'mode': 'browser', 'requiredAttempts': 2, 'outcome': self.preflightOutcome,
                'orderId': 240, 'checkedAt': self.now,
                'planSha256': hashlib.sha256((self.private / 'plan.json').read_bytes()).hexdigest(),
                'inputSha256': hashlib.sha256((self.private / 'request-240.json').read_bytes()).hexdigest(),
                'accountPaused': self.preflightOutcome == 'ACCOUNT_COOLDOWN',
                'loginPaused': self.preflightOutcome == 'LOGIN_COOLDOWN',
                'attempts': 9 if self.preflightOutcome == 'RECEIPT_ATTEMPT_LIMIT' else 1}
            return subprocess.CompletedProcess(args, 0, json.dumps(value).encode(), b'')
        if args[:2] == ['docker', 'start']:
            if self.timeout:
                raise subprocess.TimeoutExpired(args, 240)
            self.write(self.private / 'receipt-probe-240.json', self.metadata)
            self.write(self.private / 'results/order-240-run-12.json', self.detail)
            if self.modifyConfig:
                self.write(self.private / 'collectorConfig.json', {'leaseContext': {'provider': 'wrong'}})
            return subprocess.CompletedProcess(args, self.startExit, json.dumps(self.summary).encode(), b'')
        if args[:2] == ['docker', 'inspect']:
            return subprocess.CompletedProcess(args, 0, json.dumps(self.state).encode(), b'')
        if args[:2] == ['docker', 'rm']:
            return subprocess.CompletedProcess(args, self.removeExit, b'', b'')
        return subprocess.CompletedProcess(args, 0, b'container-id', b'')

    def execute(self, probes=None):
        output = io.StringIO()
        arguments = ['browser', '--root', str(self.root), '--id', '240', '--proxy-index', '0']
        if self.nativeBrowser:
            arguments.append('--native-browser')
        with patch.object(sys, 'argv', arguments), \
                patch.object(sample, 'call', side_effect=self.command), \
                patch.object(sample, 'probe', side_effect=probes or ['f' * 64, 'f' * 64]) as probe, \
                patch.object(sample.time, 'time', return_value=self.now), patch.object(os, 'chown'), \
                contextlib.redirect_stdout(output):
            value = sample.main()
        self.assertEqual(len(output.getvalue().splitlines()), 1)
        self.assertEqual(value, json.loads(output.getvalue()))
        self.assertEqual(value['bootstrapMode'], 'native-browser' if self.nativeBrowser else 'http-bootstrap')
        self.assertIs(value['persistSessions'], False)
        return value, probe

    def test_success_links_private_receipt_to_verified_browser_audit(self):
        value, probe = self.execute()
        self.assertEqual(value['outcome'], 'SUCCEEDED')
        self.assertEqual(probe.call_count, 2)
        self.assertTrue(value['receiptEgressVerifiedAfter'])
        self.assertEqual(value['receiptRunId'], 13)
        self.assertEqual(value['detailRunId'], 12)
        metadata = sample.readPrivate(self.private / 'receipt-probe-240.json')
        self.assertTrue(metadata['egressVerifiedAfter'])
        self.assertEqual(metadata['browserAuditFile'], value['auditFile'])
        self.assertEqual(metadata['browserAuditSha256'], hashlib.sha256((self.private / value['auditFile']).read_bytes()).hexdigest())
        self.assertEqual(metadata['egressAfterHash'], 'f' * 64)
        self.assertEqual(metadata['proxyHash'], self.hash)

    def test_preflight_deferred_never_probes_reads_password_creates_run_or_writes_config(self):
        for outcome in ('ACCOUNT_COOLDOWN', 'LOGIN_COOLDOWN', 'RECEIPT_ATTEMPT_LIMIT'):
            with self.subTest(outcome=outcome):
                self.preflightOutcome = outcome
                self.calls = []
                value, probe = self.execute()
                self.assertEqual(value['outcome'], outcome)
                self.assertTrue(value['preflightOnly'])
                self.assertEqual(value['requests'], 0)
                self.assertEqual(value['businessWrites'], 0)
                self.assertIsNone(value['egressHash'])
                self.assertIsNone(value['proxyHash'])
                self.assertFalse(value['receiptEgressVerifiedAfter'])
                self.assertNotIn('runId', value)
                probe.assert_not_called()
                self.assertEqual(len(self.calls), 2)
                self.assertFalse(any(args[:2] == ['docker', 'create'] or kwargs.get('input') == b'readPrivateInput'
                                     for args, kwargs in self.calls))
                self.assertFalse((self.private / 'collectorConfig.json').exists())
                self.assertFalse((self.private / 'browser-proxy-leases.json').exists())
                self.assertEqual(self.calls[1][0].count('--network'), 1)
                self.assertIn('apple-account-research-internal', self.calls[1][0])

    def test_preflight_database_failure_is_error_not_deferred(self):
        original = self.command
        def command(args, **kwargs):
            if args[:2] == ['docker', 'run']:
                return subprocess.CompletedProcess(args, 1, b'', b'private-query-error')
            return original(args, **kwargs)
        with patch.object(self, 'command', side_effect=command):
            value, probe = self.execute()
        self.assertEqual(value['outcome'], 'GATE_PREFLIGHT_FAILED')
        probe.assert_not_called()
        self.assertNotIn('private-query-error', json.dumps(value))

    def test_preflight_rejects_forged_hash_boolean_attempt_and_wrong_mode(self):
        original = self.command
        for change in ({'version': 1}, {'version': 3}, {'version': True}, {'version': 2.0},
                       {'inputSha256': 'a' * 64}, {'attempts': True}, {'mode': 'http'},
                       {'requiredAttempts': 1}, {'checkedAt': self.now + 1}, {'loginPaused': 0}):
            def command(args, **kwargs):
                result = original(args, **kwargs)
                if args[:2] == ['docker', 'run']:
                    body = json.loads(result.stdout)
                    body.update(change)
                    return subprocess.CompletedProcess(args, 0, json.dumps(body).encode(), b'')
                return result
            with self.subTest(change=change), patch.object(self, 'command', side_effect=command):
                value, probe = self.execute()
            self.assertEqual(value['outcome'], 'GATE_PREFLIGHT_FAILED')
            probe.assert_not_called()

    def test_v2_preflight_reserves_two_of_ten_attempts_and_checks_reported_reason(self):
        original = self.command
        cases = [(2, 'BROWSER_PREFLIGHT_ALLOWED', 'SUCCEEDED'),
                 (8, 'BROWSER_PREFLIGHT_ALLOWED', 'SUCCEEDED'),
                 (9, 'RECEIPT_ATTEMPT_LIMIT', 'RECEIPT_ATTEMPT_LIMIT'),
                 (10, 'RECEIPT_ATTEMPT_LIMIT', 'RECEIPT_ATTEMPT_LIMIT'),
                 (8, 'RECEIPT_ATTEMPT_LIMIT', 'GATE_PREFLIGHT_FAILED'),
                 (9, 'BROWSER_PREFLIGHT_ALLOWED', 'GATE_PREFLIGHT_FAILED')]
        for attempts, reason, expected in cases:
            def command(args, **kwargs):
                result = original(args, **kwargs)
                if args[:2] == ['docker', 'run']:
                    value = json.loads(result.stdout)
                    value.update(attempts=attempts, outcome=reason)
                    return subprocess.CompletedProcess(args, 0, json.dumps(value).encode(), b'')
                return result
            with self.subTest(attempts=attempts, reason=reason), patch.object(self, 'command', side_effect=command):
                value, probe = self.execute()
            self.assertEqual(value['outcome'], expected)
            self.assertEqual(probe.call_count, 2 if expected == 'SUCCEEDED' else 0)

    def test_preflight_timeout_cleanup_is_bounded(self):
        original = self.command
        def command(args, **kwargs):
            if args[:2] == ['docker', 'run']:
                raise subprocess.TimeoutExpired(args, 30)
            return original(args, **kwargs)
        with patch.object(self, 'command', side_effect=command):
            value, probe = self.execute()
        self.assertEqual(value['outcome'], 'GATE_PREFLIGHT_FAILED')
        probe.assert_not_called()
        cleanup = [kwargs['timeout'] for args, kwargs in self.calls if args[:2] == ['docker', 'rm']]
        self.assertEqual(cleanup, [10])

    def test_link_identity_mismatch_before_research_or_password(self):
        self.linkInput['samples'][0]['id'] = 241
        value, probe = self.execute()
        self.assertEqual(value['outcome'], 'INPUT_IDENTITY_INVALID')
        probe.assert_not_called()
        self.assertEqual(len(self.calls), 1)

    def test_credential_account_must_match_preflight_current_account(self):
        self.linkInput['samples'][0]['accountHash'] = 'c' * 64
        value, _ = self.execute()
        self.assertEqual(value['outcome'], 'INPUT_IDENTITY_INVALID')
        self.assertFalse(any(args[:2] == ['docker', 'create'] for args, _ in self.calls))
        self.assertNotIn('private-apple-password', json.dumps(value))
        self.assertNotIn('private-proxy-password', json.dumps([args for args, _ in self.calls]))

    def test_input_and_browser_configuration_are_private_and_bounded(self):
        self.execute()
        config = sample.readPrivate(self.private / 'collectorConfig.json')
        self.assertTrue(config['captureReceipt'])
        self.assertEqual(config['httpBootstrap'], not self.nativeBrowser)
        self.assertIs(config['persistSessions'], False)
        self.assertEqual(config['maxRunRequests'], 300)
        self.assertEqual(config['maxTotalRequests'], 201470)
        self.assertEqual(config['leaseContext']['proxyHash'], self.hash)
        self.assertEqual(config['leaseContext']['startedAt'], sample.isoTime(self.now))
        for name in ('request-240.json', 'collectorConfig.json', 'browserProxy.json'):
            self.assertEqual((self.private / name).stat().st_mode & 0o777, 0o600)
        command = next(args for args, _ in self.calls if args[:2] == ['docker', 'create'])
        for flag, value in (('--memory', '1024m'), ('--pids-limit', '256'), ('--shm-size', '256m'), ('--entrypoint', 'xvfb-run')):
            self.assertEqual(command[command.index(flag) + 1], value)
        self.assertEqual(command[-1], 'backfill')
        self.assertNotIn('/app', ' '.join(command))

    def test_shared_http_lock_blocks_browser_before_any_network(self):
        with open(str(self.private / 'http-sample.lock'), 'a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            value, probe = self.execute()
        self.assertEqual(value['outcome'], 'HTTP_SAMPLE_BUSY')
        probe.assert_not_called()
        self.assertFalse(self.calls)

    def test_cleanup_block_prevents_any_new_sample(self):
        self.write(self.private / 'http-cleanup-blocked.json', {})
        value, probe = self.execute()
        self.assertEqual(value['outcome'], 'HTTP_SAMPLE_CLEANUP_PENDING')
        probe.assert_not_called()

    def test_stop_before_start_prevents_proxy_probe_and_credential_read(self):
        (self.private / 'STOP').write_text('stop')
        value, probe = self.execute()
        self.assertEqual(value['outcome'], 'REQUEST_STOPPED')
        probe.assert_not_called()
        self.assertFalse(self.calls)

    def test_stop_after_input_read_prevents_browser_creation(self):
        original = self.command
        def command(args, **kwargs):
            result = original(args, **kwargs)
            if args[:2] == ['docker', 'exec']:
                (self.private / 'STOP').write_text('stop')
            return result
        with patch.object(self, 'command', side_effect=command):
            value, probe = self.execute()
        self.assertEqual(value['outcome'], 'REQUEST_STOPPED')
        self.assertEqual(probe.call_count, 0)
        self.assertFalse(any(args[:2] == ['docker', 'create'] for args, _ in self.calls))

    def test_rejected_actual_egress_blocks_changed_proxy_session(self):
        self.write(self.private / 'http-rejected-egress.json', ['f' * 64])
        value, probe = self.execute()
        self.assertEqual(value['outcome'], 'EGRESS_PREVIOUSLY_REJECTED')
        self.assertEqual(probe.call_count, 1)
        self.assertEqual(len(self.calls), 2)
        self.assertEqual(self.calls[0][1]['input'], b'readLinkInput')
        self.assertIn('--browser', self.calls[1][0])

    def test_lease_origin_is_preserved_on_reuse(self):
        start = sample.isoTime(self.now - 600)
        self.write(self.private / 'browser-proxy-leases.json', {self.hash: {'startedAt': start, 'egressHash': 'f' * 64}})
        value, _ = self.execute()
        self.assertEqual(value['leaseContext']['startedAt'], start)

    def test_matching_http_proxy_hash_supplies_earlier_observation_origin(self):
        self.write(self.private / ('http-sample-1-' + 'b' * 32 + '.json'), {'proxyHash': self.hash, 'startedAt': self.now - 300})
        value, _ = self.execute()
        self.assertEqual(value['leaseContext']['startedAt'], sample.isoTime(self.now - 300))

    def test_expired_lease_is_never_reset(self):
        start = sample.isoTime(self.now - 86400)
        self.write(self.private / 'browser-proxy-leases.json', {self.hash: {'startedAt': start, 'egressHash': 'f' * 64}})
        value, probe = self.execute()
        self.assertEqual(value['outcome'], 'PROXY_LEASE_EXPIRED')
        probe.assert_not_called()

    def test_changed_existing_lease_egress_is_rejected_before_input(self):
        self.write(self.private / 'browser-proxy-leases.json', {self.hash: {'startedAt': sample.isoTime(self.now - 60), 'egressHash': 'a' * 64}})
        value, _ = self.execute()
        self.assertEqual(value['outcome'], 'PROXY_LEASE_EGRESS_CHANGED')
        self.assertEqual(len(self.calls), 2)
        self.assertFalse(any(kwargs.get('input') == b'readPrivateInput' for _, kwargs in self.calls))
        self.assertEqual(set(sample.readPrivate(self.private / 'http-rejected-egress.json')), {'a' * 64, 'f' * 64})

    def test_changed_post_egress_never_marks_receipt_verified(self):
        value, _ = self.execute(['f' * 64, 'a' * 64])
        self.assertEqual(value['outcome'], 'EGRESS_CHANGED_OR_UNVERIFIED')
        self.assertFalse(sample.readPrivate(self.private / 'receipt-probe-240.json')['egressVerifiedAfter'])

    def test_failed_post_probe_never_marks_receipt_verified(self):
        value, _ = self.execute(['f' * 64, RuntimeError('private-password')])
        self.assertEqual(value['outcome'], 'EGRESS_CHANGED_OR_UNVERIFIED')
        self.assertNotIn('private-password', json.dumps(value))

    def test_541_persists_actual_egress_rejection(self):
        self.summary['outcome'] = 'HTTP_541'
        value, _ = self.execute()
        self.assertEqual(value['outcome'], 'HTTP_541')
        self.assertIn('f' * 64, sample.readPrivate(self.private / 'http-rejected-egress.json'))

    def test_input_cannot_expand_single_order_scope(self):
        self.input['samples'].append(copy.deepcopy(self.input['samples'][0]))
        value, _ = self.execute()
        self.assertEqual(value['outcome'], 'INPUT_IDENTITY_INVALID')
        self.assertFalse(any(args[:2] == ['docker', 'create'] for args, _ in self.calls))

    def test_changed_account_snapshot_stops_before_browser(self):
        self.input['samples'][0]['email'] = 'someone@example.test'
        self.assertEqual(self.execute()[0]['outcome'], 'INPUT_IDENTITY_INVALID')

    def test_credential_input_failure_preserves_safe_reason(self):
        self.inputExit = 1
        self.assertEqual(self.execute()[0]['outcome'], 'ACCOUNT_MARKED_INVALID')

    def test_wrong_result_identity_does_not_become_success(self):
        self.summary['results'][0]['orderId'] = 999
        self.assertEqual(self.execute()[0]['outcome'], 'COLLECTOR_IDENTITY_INVALID')

    def test_wrong_detail_run_does_not_become_success(self):
        self.summary['runId'] = 99
        self.assertEqual(self.execute()[0]['outcome'], 'COLLECTOR_IDENTITY_INVALID')

    def test_nonzero_exit_cannot_promote_successful_json(self):
        self.startExit = 2
        self.assertEqual(self.execute()[0]['outcome'], 'COLLECTOR_EXIT_INVALID')

    def test_live_or_oom_container_cannot_promote_success(self):
        self.state['OOMKilled'] = True
        self.assertEqual(self.execute()[0]['outcome'], 'COLLECTOR_EXIT_INVALID')

    def test_timeout_cleans_up_and_keeps_target_audit(self):
        self.timeout = True
        value, _ = self.execute()
        self.assertNotEqual(value['outcome'], 'SUCCEEDED')
        self.assertEqual(value['targetOrderId'], 240)
        self.assertTrue(value['cleanup']['removed'])
        self.assertTrue((self.private / value['auditFile']).is_file())

    def test_cleanup_failure_blocks_new_sampler_and_never_verifies_receipt(self):
        self.removeExit = 1
        value, _ = self.execute()
        self.assertEqual(value['outcome'], 'CONTAINER_CLEANUP_FAILED')
        self.assertTrue((self.private / 'http-cleanup-blocked.json').is_file())
        self.assertFalse(sample.readPrivate(self.private / 'receipt-probe-240.json')['egressVerifiedAfter'])
        cleanup = next(kwargs for args, kwargs in self.calls if args[:2] == ['docker', 'rm'])
        self.assertEqual(cleanup['timeout'], 30)

    def test_wrong_receipt_run_is_not_upgraded(self):
        self.metadata['runId'] = 999
        self.assertEqual(self.execute()[0]['outcome'], 'RECEIPT_METADATA_INVALID')
        self.assertFalse(sample.readPrivate(self.private / 'receipt-probe-240.json')['egressVerifiedAfter'])

    def test_stale_receipt_timestamp_is_not_upgraded(self):
        self.metadata['observedAt'] = sample.isoTime(self.now - 1)
        self.assertEqual(self.execute()[0]['outcome'], 'RECEIPT_METADATA_INVALID')

    def test_changed_runtime_lease_is_not_upgraded(self):
        self.modifyConfig = True
        self.assertEqual(self.execute()[0]['outcome'], 'RECEIPT_METADATA_INVALID')

    def test_bootstrap_ready_never_means_order_or_login_success(self):
        self.summary = {'outcome': 'HTTP_LOGIN_BOOTSTRAP_READY'}
        value, _ = self.execute()
        self.assertNotEqual(value['outcome'], 'SUCCEEDED')
        self.assertNotIn('serverSessionRestored', value)
        self.assertFalse(sample.readPrivate(self.private / 'receipt-probe-240.json')['egressVerifiedAfter'])


class NativeBrowserSampleTests(BrowserSampleTests):
    """对原生模式复用完整范围、STOP、冷却、租约、出口与双运行号测试。"""
    nativeBrowser = True


if __name__ == '__main__':
    unittest.main()
