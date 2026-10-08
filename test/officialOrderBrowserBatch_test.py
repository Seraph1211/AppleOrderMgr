"""浏览器批处理离线测试：全部外部采集/绑定/生产查询 mock，真实校验私密回执与日志。"""
import contextlib
import copy
import datetime
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

SCRIPTS = pathlib.Path(__file__).parents[1] / 'scripts/officialOrder'
sys.path.insert(0, str(SCRIPTS))
SPEC = importlib.util.spec_from_file_location('browser_batch', SCRIPTS / 'runBrowserBatch.py')
batch = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(batch)


class BrowserBatchTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = pathlib.Path(temp.name)
        self.private = self.root / 'private'
        self.private.mkdir(mode=0o700)
        self.plan = {'schemaVersion': 3, 'scope': 'missing-fields', 'cutoff': None,
            'startedAt': (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(seconds=60)).strftime('%Y-%m-%dT%H:%M:%S.000Z'),
            'policy': dict(batch.http.POLICY), 'entries': [
                {'id': i, 'orderNumber': 'W' + str(i).zfill(10), 'rowHash': 'a' * 32,
                 'dateMissing': False, 'serialsMissing': True, 'previousDate': '2026-09-22', 'previousDevices': []}
                for i in (1, 2)]}
        self.save('plan.json', self.plan)
        self.calls = []
        self.sampleOutcome = 'SUCCEEDED'
        self.applyOutcome = None
        self.sources = {}
        self.quarantined = set()
        self.counter = 0
        self.snapshot = patch.object(batch, 'verify_snapshot')
        self.snapshotMock = self.snapshot.start()
        self.addCleanup(self.snapshot.stop)
        self.chown = patch('runHttpSample.os.chown')
        self.chown.start()
        self.addCleanup(self.chown.stop)

    def save(self, name, value):
        path = self.private / name
        path.write_text(json.dumps(value), encoding='utf-8')
        path.chmod(0o600)
        return path

    def sample(self, order, proxy=0):
        self.counter += 1
        stamp = time.time()
        attempt = format(self.counter, '032x')
        value = {'outcome': self.sampleOutcome, 'attemptId': attempt, 'targetOrderId': order,
            'proxyIndex': proxy, 'bootstrapMode': 'native-browser', 'persistSessions': False,
            'startedAt': stamp - 1, 'finishedAt': stamp, 'egressHash': 'e' * 64, 'egressAfterHash': 'e' * 64,
            'egressVerifiedAfter': True, 'businessWrites': 0, 'cleanup': {'attempted': True, 'removed': True, 'outcome': 'REMOVED'},
            'proxyHash': 'b' * 64, 'auditFile': 'browser-sample-' + str(order) + '-' + attempt + '.json',
            'receiptEgressVerifiedAfter': True}
        if self.sampleOutcome in batch.DEFERRED:
            input_path = self.save('request-' + str(order) + '.json', {'private': 'no-password'})
            value.update(requests=0, preflightOnly=True, preflight={'version': 2, 'mode': 'browser', 'requiredAttempts': 2,
                'outcome': self.sampleOutcome, 'orderId': order, 'checkedAt': stamp,
                'planSha256': hashlib.sha256((self.private / 'plan.json').read_bytes()).hexdigest(),
                'inputSha256': hashlib.sha256(input_path.read_bytes()).hexdigest(),
                'accountPaused': self.sampleOutcome == 'ACCOUNT_COOLDOWN', 'loginPaused': self.sampleOutcome == 'LOGIN_COOLDOWN',
                'attempts': 9 if self.sampleOutcome == 'RECEIPT_ATTEMPT_LIMIT' else 0},
                egressHash=None, egressAfterHash=None, egressVerifiedAfter=False, proxyHash=None,
                receiptEgressVerifiedAfter=False, cleanup={'attempted': False, 'removed': False, 'outcome': 'NOT_NEEDED'})
        else:
            value.update(orderId=order, runId=self.counter * 2, detailRunId=self.counter * 2,
                         receiptRunId=self.counter * 2 + 1, receiptOutcome='RECEIPT_CAPTURED')
        self.save(value['auditFile'], value)
        return value

    def binding(self, sample, apply):
        order = sample['targetOrderId']
        attempt = format(100 + self.counter, '032x')
        prefix = 'browser-receipt-bind-' + str(order) + '-' + attempt
        entry = copy.deepcopy(next(e for e in self.plan['entries'] if e['id'] == order))
        if order in self.sources:
            entry['stableRowHash'] = 'f' * 32
        payload = dict(self.plan, entry=entry, receipt={'runId': sample['receiptRunId'],
            'sha256': 'b' * 64, 'detailSha256': 'c' * 64, 'browserAuditFile': sample['auditFile'],
            'browserAuditSha256': hashlib.sha256((self.private / sample['auditFile']).read_bytes()).hexdigest()},
            parsed={'items': [{'serialNumber': 'A123456789'}]})
        payload.pop('entries')
        payload_path = self.save(prefix + '-payload.json', payload)
        result = {'orderId': order, 'outcome': 'SERIALS_VERIFIED', 'serialCount': 1, 'newBindings': 1,
            'serialsHash': hashlib.sha256(b'["A123456789"]').hexdigest(),
            'deviceIds': ['12345678-1234-4234-8234-123456789abc'], 'actorUserId': 1,
            'receiptRunId': sample['receiptRunId'], 'receiptSha256': 'b' * 64, 'detailSha256': 'c' * 64,
            'orderBeforeHash': 'd' * 32, 'orderAfterHash': 'd' * 32,
            'manualPickupUnchanged': True, 'inventoryReceiveCreated': False}
        audit = dict(result, mode='apply' if apply else 'dry-run', outcome='SERIALS_VERIFIED' if apply else 'DRY_RUN',
            businessWrites=None if apply else 0, businessWriteCountKnown=not apply,
            auditFile=prefix + '-audit.json', payloadFile=payload_path.name)
        if apply:
            result_path = self.save(prefix + '-result.json', result)
            audit['resultFile'] = result_path.name
            self.save('browser-receipt-bind-intent-' + str(order) + '.json', {'state': 'APPLIED', 'orderId': order,
                'attemptId': attempt, 'sourceAudit': sample['auditFile'], 'receiptRunId': sample['receiptRunId'],
                'receiptSha256': 'b' * 64, 'payloadFile': payload_path.name, 'resultFile': result_path.name,
                'auditFile': audit['auditFile'], 'payloadSha256': hashlib.sha256(payload_path.read_bytes()).hexdigest()})
        self.save(audit['auditFile'], audit)
        return audit

    def child(self, command, timeout):
        self.calls.append(command)
        if command[1].endswith('runBrowserSample.py'):
            return self.sample(int(command[command.index('--id') + 1]), int(command[command.index('--proxy-index') + 1]))
        audit = batch.load(self.root, command[command.index('--audit') + 1])
        if self.applyOutcome:
            return {'outcome': self.applyOutcome}
        return self.binding(audit, '--apply' in command)

    def execute(self, apply=False, ids=None, limit=2, mocked_sources=True):
        with patch.object(batch, 'child', side_effect=self.child), contextlib.ExitStack() as stack:
            if mocked_sources:
                stack.enter_context(patch.object(batch, 'http_sources', return_value=(self.sources, self.quarantined)))
            return batch.execute(self.root, ids, limit, apply, 0)

    def test_default_dry_run_collects_in_order_without_apply(self):
        value = self.execute()
        self.assertEqual(value['processedThisRun'], 2)
        self.assertEqual(value['verifiedThisRun'], 2)
        self.assertFalse(value['allFieldsComplete'])
        self.assertTrue(all('--apply' not in call for call in self.calls))
        self.assertEqual([call[call.index('--id') + 1] for call in self.calls if '--id' in call], ['1', '2'])
        self.assertTrue(all('--native-browser' in call for call in self.calls if '--id' in call))
        self.assertFalse(list(self.private.glob('*intent*.json')))
        self.calls = []
        self.assertEqual(self.execute()['processedThisRun'], 0)
        self.assertFalse(self.calls)

    def test_apply_persists_complete_chain_then_both_modes_skip(self):
        self.assertEqual(self.execute(apply=True)['verifiedThisRun'], 2)
        self.calls = []
        self.assertEqual(self.execute(apply=True)['previouslyConfirmedBindings'], 2)
        self.assertEqual(self.execute()['processedThisRun'], 0)
        self.assertFalse(self.calls)
        self.assertTrue(all(path.stat().st_mode & 0o077 == 0 for path in self.private.glob('*.jsonl')))

    def test_standalone_applied_binding_skips_before_changed_snapshot(self):
        self.binding(self.sample(1), True)
        self.snapshotMock.reset_mock()
        value = self.execute(ids=[1])
        self.assertEqual(value['previouslyConfirmedBindings'], 1)
        self.assertFalse(self.calls)
        self.snapshotMock.assert_not_called()

    def test_http_source_uses_existing_basis_and_audit_without_rewrite(self):
        self.plan['entries'][0].update(dateMissing=True, previousDate=None)
        self.save('plan.json', self.plan)
        self.sources[1] = {'basis': 'http-apply-basis-1-run-9.json', 'httpSourceAudit': 'http-sample-1-' + 'a' * 32 + '.json', 'afterHash': 'e' * 32}
        self.save(self.sources[1]['basis'], {'stableRowHash': 'f' * 32})
        self.execute(apply=True, ids=[1])
        command = self.calls[1]
        self.assertEqual(command[command.index('--basis') + 1], self.sources[1]['basis'])
        self.assertEqual(command[command.index('--http-source-audit') + 1], self.sources[1]['httpSourceAudit'])

    def test_no_http_missing_date_is_not_eligible(self):
        self.plan['entries'][0].update(dateMissing=True, previousDate=None)
        self.save('plan.json', self.plan)
        with self.assertRaisesRegex(RuntimeError, 'SCOPE_INVALID'):
            self.execute(ids=[1])
        self.assertFalse(self.calls)

    def test_deferred_is_not_complete_and_not_retried_across_modes(self):
        for outcome in batch.DEFERRED:
            with self.subTest(outcome=outcome):
                self.sampleOutcome = outcome
                value = self.execute(ids=[1])
                self.assertEqual(value['deferredThisRun'], 1)
                rows = [json.loads(line) for line in (self.private / batch.JOURNALS[1]).read_text().splitlines()]
                self.assertFalse(rows[-1]['targetCompleted'])
                self.assertEqual(len(self.calls), 1)
                self.calls = []
                self.assertEqual(self.execute(apply=True, ids=[1])['processedThisRun'], 0)
                self.assertFalse(self.calls)
                (self.private / batch.JOURNALS[1]).unlink()

    def rewrite_deferred(self, version, attempts, reason, account=False, login=False):
        journal = self.private / batch.JOURNALS[1]
        rows = [json.loads(line) for line in journal.read_text().splitlines()]
        value = rows[1]['sample']
        value['preflight'].update(version=version, attempts=attempts, accountPaused=account,
                                  loginPaused=login, outcome=reason)
        value['outcome'] = reason
        path = self.save(value['auditFile'], value)
        rows[1]['auditSha256'] = hashlib.sha256(path.read_bytes()).hexdigest()
        journal.write_text(''.join(json.dumps(row) + '\n' for row in rows), encoding='utf-8')

    def test_historical_v1_two_attempt_deferred_still_skips_both_modes(self):
        self.sampleOutcome = 'RECEIPT_ATTEMPT_LIMIT'
        self.execute(ids=[1])
        self.rewrite_deferred(1, 2, 'RECEIPT_ATTEMPT_LIMIT')
        self.calls.clear()
        self.assertEqual(self.execute(ids=[1])['processedThisRun'], 0)
        self.assertEqual(self.execute(apply=True, ids=[1])['processedThisRun'], 0)
        self.assertFalse(self.calls)

    def test_historical_v1_account_and_login_deferred_still_replay(self):
        self.sampleOutcome = 'ACCOUNT_COOLDOWN'
        self.execute(ids=[1])
        for reason, account, login in (('ACCOUNT_COOLDOWN', True, False), ('LOGIN_COOLDOWN', False, True)):
            self.rewrite_deferred(1, 0, reason, account, login)
            self.calls.clear()
            self.assertEqual(self.execute(apply=True, ids=[1])['processedThisRun'], 0)
            self.assertFalse(self.calls)

    def test_historical_preflight_version_keeps_its_original_threshold(self):
        self.sampleOutcome = 'RECEIPT_ATTEMPT_LIMIT'
        self.execute(ids=[1])
        for version, attempts in ((1, 1), (2, 2), (2, 8), (3, 9), (True, 2), (2.0, 9)):
            self.rewrite_deferred(version, attempts, 'RECEIPT_ATTEMPT_LIMIT')
            with self.subTest(version=version, attempts=attempts), self.assertRaisesRegex(RuntimeError, 'RECONCILIATION_REQUIRED'):
                self.execute(ids=[1])
        self.assertEqual(len(self.calls), 1)

    def test_fresh_child_cannot_return_v1_even_with_same_cooldown_reason(self):
        self.sampleOutcome = 'ACCOUNT_COOLDOWN'
        original = self.sample
        def legacy_sample(order, proxy=0):
            value = original(order, proxy)
            value['preflight']['version'] = 1
            self.save(value['auditFile'], value)
            return value
        with patch.object(self, 'sample', side_effect=legacy_sample), self.assertRaisesRegex(RuntimeError, 'SAMPLE_INVALID'):
            self.execute(ids=[1])
        self.assertEqual(len(self.calls), 1)

    def test_dry_run_then_apply_reuses_receipt_no_second_sampler(self):
        self.execute(ids=[1])
        self.calls = []
        self.execute(apply=True, ids=[1])
        self.assertEqual(len(self.calls), 1)
        self.assertTrue(self.calls[0][1].endswith('applyBrowserReceipt.py'))

    def test_expired_dry_run_apply_stops_instead_of_resampling(self):
        self.execute(ids=[1])
        self.calls = []
        self.applyOutcome = 'BROWSER_RECEIPT_TIME_INVALID'
        with self.assertRaisesRegex(RuntimeError, 'APPLY_STOPPED'):
            self.execute(apply=True, ids=[1])
        self.assertEqual(len(self.calls), 1)
        with self.assertRaisesRegex(RuntimeError, 'RECONCILIATION_REQUIRED'):
            self.execute(ids=[1])

    def test_any_collector_failure_stops_no_rotation_or_next_order(self):
        self.sampleOutcome = 'HTTP_541'
        with self.assertRaisesRegex(RuntimeError, 'SAMPLE_INVALID'):
            self.execute(apply=True)
        self.assertEqual(len(self.calls), 1)
        self.calls = []
        with self.assertRaisesRegex(RuntimeError, 'RECONCILIATION_REQUIRED'):
            self.execute()
        self.assertFalse(self.calls)

    def test_unknown_partial_and_missing_apply_result_keep_pending(self):
        for result in ('MANUAL_RECONCILIATION_REQUIRED', 'PARTIAL_BOUND', 'BROWSER_RECEIPT_FAILED'):
            with self.subTest(result=result):
                self.applyOutcome = result
                with self.assertRaisesRegex(RuntimeError, 'APPLY_STOPPED'):
                    self.execute(apply=True, ids=[1])
                with self.assertRaisesRegex(RuntimeError, 'RECONCILIATION_REQUIRED'):
                    self.execute(ids=[2])
                (self.private / batch.JOURNALS[0]).unlink()

    def test_unknown_intent_any_target_blocks_before_child(self):
        self.save('browser-receipt-bind-intent-999.json', {'state': 'APPLY_STARTED', 'orderId': 999})
        with self.assertRaisesRegex(RuntimeError, 'RECONCILIATION_REQUIRED'):
            self.execute(ids=[1])
        self.assertFalse(self.calls)

    def test_applied_chain_payload_hash_tampering_blocks_skip(self):
        sample = self.sample(1)
        self.binding(sample, True)
        intent = batch.load(self.root, 'browser-receipt-bind-intent-1.json')
        self.save(intent['payloadFile'], {'changed': True})
        with self.assertRaisesRegex(RuntimeError, 'RECONCILIATION_REQUIRED'):
            self.execute(ids=[1])
        self.assertFalse(self.calls)

    def test_journal_source_audit_change_blocks_replay(self):
        self.execute(ids=[1])
        audit = next(self.private.glob('browser-sample-1-*.json'))
        audit.write_text(audit.read_text() + ' ')
        with self.assertRaisesRegex(RuntimeError, 'RECONCILIATION_REQUIRED'):
            self.execute(ids=[2])

    def test_unterminated_journal_is_not_appended(self):
        self.execute(ids=[1])
        path = self.private / batch.JOURNALS[1]
        old = path.read_bytes().rstrip(b'\n')
        path.write_bytes(old)
        with self.assertRaisesRegex(RuntimeError, 'RECONCILIATION_REQUIRED'):
            self.execute(ids=[2])
        self.assertEqual(path.read_bytes(), old)

    def test_shared_batch_lock_and_stop_prevent_sampling(self):
        with open(str(self.private / 'http-batch.lock'), 'a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaisesRegex(RuntimeError, 'HTTP_BATCH_BUSY'):
                self.execute()
        (self.private / 'STOP').touch()
        with self.assertRaisesRegex(RuntimeError, 'BATCH_STOP_REQUESTED'):
            self.execute()
        self.assertFalse(self.calls)

    def test_quarantine_skipped_and_explicit_id_cannot_bypass(self):
        self.quarantined.add(1)
        value = self.execute()
        self.assertEqual(value['quarantinedOrderIds'], [1])
        self.assertEqual(value['processedThisRun'], 1)
        with self.assertRaisesRegex(RuntimeError, 'TARGET_QUARANTINED'):
            self.execute(ids=[1])

    def test_real_http_journal_unresolved_blocks_browser(self):
        sha = hashlib.sha256((self.private / 'plan.json').read_bytes()).hexdigest()
        batch.http.append(self.private / batch.http.JOURNALS[0], {'orderId': 1, 'planSha256': sha,
            'batchAttemptId': 'a' * 32, 'event': 'order_started', 'at': time.time()})
        with self.assertRaisesRegex(RuntimeError, 'RECONCILIATION_REQUIRED'):
            self.execute(mocked_sources=False)
        self.assertFalse(self.calls)

    def test_real_http_unknown_intent_blocks_browser(self):
        self.save('http-apply-intent-999.json', {'state': 'COMMIT_UNKNOWN'})
        with self.assertRaisesRegex(RuntimeError, 'RECONCILIATION_REQUIRED'):
            self.execute(mocked_sources=False)
        self.assertFalse(self.calls)

    def test_http_duplicate_unknown_state_or_nan_cannot_hide_as_rolled_back(self):
        path = self.private / 'http-apply-intent-999.json'
        for raw in ('{"state":"COMMIT_UNKNOWN","state":"ROLLED_BACK"}',
                    '{"state":"ROLLED_BACK","unsafe":NaN}'):
            with self.subTest(raw=raw):
                path.write_text(raw, encoding='utf-8')
                path.chmod(0o600)
                with self.assertRaisesRegex(RuntimeError, 'RECONCILIATION_REQUIRED'):
                    self.execute(mocked_sources=False)
                self.assertFalse(self.calls)

    def test_invalid_http_intent_filename_blocks_before_sampling(self):
        self.save('http-apply-intent-foo.json', {'state': 'ROLLED_BACK'})
        with self.assertRaisesRegex(RuntimeError, 'RECONCILIATION_REQUIRED'):
            self.execute(mocked_sources=False)
        self.assertFalse(self.calls)

    def test_snapshot_failure_prevents_started_record_and_all_children(self):
        self.snapshotMock.side_effect = RuntimeError('BROWSER_BATCH_SNAPSHOT_INVALID')
        with self.assertRaisesRegex(RuntimeError, 'SNAPSHOT_INVALID'):
            self.execute()
        self.assertFalse(list(self.private.glob('browser-batch-*.jsonl')))
        self.assertFalse(self.calls)

    def test_stop_during_second_snapshot_blocks_apply_and_keeps_pending(self):
        def snapshot(*_args):
            if self.snapshotMock.call_count == 2:
                (self.private / 'STOP').touch()
        self.snapshotMock.side_effect = snapshot
        with self.assertRaisesRegex(RuntimeError, 'BATCH_STOP_REQUESTED'):
            self.execute(apply=True, ids=[1])
        self.assertEqual(len(self.calls), 1)
        self.assertFalse(any('--apply' in call for call in self.calls))
        (self.private / 'STOP').unlink()
        with self.assertRaisesRegex(RuntimeError, 'RECONCILIATION_REQUIRED'):
            self.execute(ids=[1])

    def test_plan_change_during_second_snapshot_blocks_apply(self):
        def snapshot(*_args):
            if self.snapshotMock.call_count == 2:
                self.save('plan.json', dict(self.plan, changed=True))
        self.snapshotMock.side_effect = snapshot
        with self.assertRaisesRegex(RuntimeError, 'BACKFILL_SCOPE_INVALID'):
            self.execute(apply=True, ids=[1])
        self.assertEqual(len(self.calls), 1)
        self.assertFalse(any('--apply' in call for call in self.calls))

    def test_cleanup_latch_during_snapshot_blocks_apply(self):
        def snapshot(*_args):
            if self.snapshotMock.call_count == 2:
                self.save('http-cleanup-blocked.json', {'outcome': 'CONTAINER_CLEANUP_FAILED'})
        self.snapshotMock.side_effect = snapshot
        with self.assertRaisesRegex(RuntimeError, 'BROWSER_BATCH_CLEANUP_PENDING'):
            self.execute(apply=True, ids=[1])
        self.assertEqual(len(self.calls), 1)
        self.assertFalse(any('--apply' in call for call in self.calls))

    def test_other_browser_unknown_during_second_snapshot_blocks_apply(self):
        def snapshot(*_args):
            if self.snapshotMock.call_count == 2:
                self.save('browser-receipt-bind-intent-999.json', {'state': 'APPLY_STARTED', 'orderId': 999})
        self.snapshotMock.side_effect = snapshot
        with self.assertRaisesRegex(RuntimeError, 'RECONCILIATION_REQUIRED'):
            self.execute(apply=True, ids=[1])
        self.assertEqual(len(self.calls), 1)
        self.assertFalse(any('--apply' in call for call in self.calls))

    def test_other_http_unknown_during_second_snapshot_blocks_apply(self):
        def snapshot(*_args):
            if self.snapshotMock.call_count == 2:
                self.save('http-apply-intent-999.json', {'state': 'COMMIT_UNKNOWN'})
        self.snapshotMock.side_effect = snapshot
        with self.assertRaisesRegex(RuntimeError, 'RECONCILIATION_REQUIRED'):
            self.execute(apply=True, ids=[1], mocked_sources=False)
        self.assertEqual(len(self.calls), 1)
        self.assertFalse(any('--apply' in call for call in self.calls))

    def test_stop_during_first_snapshot_starts_no_journal_or_sampler(self):
        self.snapshotMock.side_effect = lambda *_args: (self.private / 'STOP').touch()
        with self.assertRaisesRegex(RuntimeError, 'BATCH_STOP_REQUESTED'):
            self.execute(ids=[1])
        self.assertFalse(self.calls)
        self.assertFalse(list(self.private.glob('browser-batch-*.jsonl')))

    def test_snapshot_runtime_checks_exact_stdout_and_hides_errors(self):
        self.snapshot.stop()
        entry = self.plan['entries'][0]
        valid = subprocess.CompletedProcess([], 0, b'{"outcome":"BROWSER_BATCH_SNAPSHOT_VERIFIED","orderId":1}', b'')
        with patch.object(batch.subprocess, 'run', return_value=valid) as run:
            batch.verify_snapshot(self.root, entry, None)
            script = run.call_args[1]['input'].decode()
            self.assertIn('REPEATABLE READ READ ONLY', script)
            self.assertIn("SET LOCAL TIME ZONE 'Asia/Shanghai'", script)
            self.assertIn('row.devices!==0', script)
            self.assertNotIn('password-value', script)
        for result in (subprocess.CompletedProcess([], 1, b'', b'secret'),
                       subprocess.CompletedProcess([], 0, b'{"outcome":"BROWSER_BATCH_SNAPSHOT_VERIFIED","orderId":true}', b'')):
            with patch.object(batch.subprocess, 'run', return_value=result):
                with self.assertRaisesRegex(RuntimeError, '^BROWSER_BATCH_SNAPSHOT_INVALID$'):
                    batch.verify_snapshot(self.root, entry, None)
        self.snapshot.start()

    def test_bounds_duplicate_scope_and_no_sn_missing_are_rejected(self):
        for kwargs in ({'limit': 21}, {'limit': 0}, {'ids': [1, 1]}, {'ids': [999]}):
            with self.assertRaisesRegex(RuntimeError, 'SCOPE_INVALID'):
                self.execute(**kwargs)
        self.plan['entries'][0].update(dateMissing=True, previousDate=None, serialsMissing=False,
                                       previousDevices=[{'id': 'prior'}])
        self.save('plan.json', self.plan)
        with self.assertRaisesRegex(RuntimeError, 'SCOPE_INVALID'):
            self.execute(ids=[1])

    def test_child_nonzero_partial_json_timeout_all_stop(self):
        for result in (subprocess.CompletedProcess([], 1, b'{"outcome":"SERIALS_VERIFIED"}', b''),
                       subprocess.CompletedProcess([], 0, b'{}\n{}', b'')):
            with patch.object(batch.subprocess, 'run', return_value=result):
                with self.assertRaisesRegex(RuntimeError, '^BROWSER_BATCH_CHILD_FAILED$'):
                    batch.child(['python3', 'fake'], 150)
        with patch.object(batch.subprocess, 'run', side_effect=subprocess.TimeoutExpired('private', 150)):
            with self.assertRaisesRegex(RuntimeError, '^BROWSER_BATCH_CHILD_FAILED$'):
                batch.child(['python3', 'fake'], 150)


if __name__ == '__main__':
    unittest.main()
