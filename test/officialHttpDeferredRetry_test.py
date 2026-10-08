"""旧暂缓冻结及一次授权回归；不启动真实采集器、数据库或代理。"""
import contextlib
import copy
import fcntl
import hashlib
import importlib.util
import io
import json
import pathlib
import sys
import time
import unittest
import uuid
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('retry_batch_fixture', pathlib.Path(__file__).with_name('officialOrderHttpBatch_test.py'))
fixture = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(fixture)
batch = fixture.batch
import httpDeferredRetry as retry


class DeferredRetryTests(unittest.TestCase):
    def setUp(self):
        self.case = fixture.BatchTests('test_default_preview_never_passes_apply')
        self.case.setUp()
        self.addCleanup(self.case.doCleanups)
        self.root = self.case.root.resolve()
        self.private = self.root / 'private'
        for name in ('http-batch.lock', 'http-sample.lock', 'http-apply.lock'):
            path = self.private / name
            path.touch(mode=0o600)
        self.now = time.time()
        self.cutoff = self.now - 5
        self.name = 'http-deferred-v1-scope.json'
        self.plan_sha = retry.sha((self.private / 'plan.json').read_bytes())
        self.counter = 0
        self.ids = [1, 2]
        self.chown = patch.object(retry.os, 'fchown')
        self.chown.start()
        self.addCleanup(self.chown.stop)
        self.block = patch.object(retry, 'subprocess', create=True)
        self.block.start()
        self.addCleanup(self.block.stop)
        self.old_sample(1)
        self.old_sample(2, preflight=True)

    def save(self, name, value):
        return self.case.save(name, value)

    def old_sample(self, order, preflight=False, journal=None, prior=None):
        self.counter += 1
        finished = self.now - 10 + self.counter / 100
        value = {'attemptId': uuid.uuid4().hex, 'targetOrderId': order, 'proxyIndex': 0,
                 'outcome': 'ORDER_ATTEMPT_LIMIT', 'requests': 0, 'businessWrites': 0,
                 'startedAt': finished - 2, 'finishedAt': finished, 'elapsedSeconds': 2.0,
                 'egressHash': 'e' * 64, 'egressAfterHash': 'e' * 64, 'egressVerifiedAfter': True,
                 'cleanup': {'attempted': True, 'removed': True, 'outcome': 'REMOVED'}}
        if preflight:
            input_path = self.save('request-' + str(order) + '.json', {'private': 'old input'})
            value.update(preflightOnly=True, preflight={'version': 1, 'outcome': value['outcome'], 'orderId': order,
                'checkedAt': finished - 1, 'planSha256': self.plan_sha, 'inputSha256': retry.sha(input_path.read_bytes()),
                'accountPaused': False, 'attempts': 3}, egressHash=None, egressAfterHash=None,
                egressVerifiedAfter=False, cleanup={'attempted': False, 'removed': False, 'outcome': 'NOT_NEEDED'})
        else:
            value['containerName'] = 'apple-official-http-sample-' + value['attemptId']
        record = {'orderId': order, 'planSha256': self.plan_sha, 'batchAttemptId': uuid.uuid4().hex}
        path = self.private / (journal or batch.JOURNALS[0])
        prior = prior or []
        started = min([value['startedAt']] + [v['startedAt'] for v in prior]) - 1
        batch.append(path, dict(record, event='order_started', at=started))
        for item in prior + [value]:
            self.save('http-sample-' + str(order) + '-' + item['attemptId'] + '.json', item)
            batch.append(path, dict(record, event='sample_finished', at=item['finishedAt'] + 0.001, sample=item))
        batch.append(path, dict(record, event='order_finished', at=finished + 0.002,
                                sampleOutcome=value['outcome'], receiptOutcome=None, apply=None))
        return value

    def freeze(self, ids=None):
        result = retry.freeze_deferred(self.root, ids or self.ids, self.name, self.cutoff, batch.deferred_api())
        self.manifest_sha = result['manifestSha256']
        return result

    def authorize(self, ids=None, mode=None):
        return retry.reopen_deferred(self.root, ids or self.ids, mode or batch.JOURNALS[0],
                                     self.name, self.manifest_sha, batch.deferred_api())

    def raw(self):
        return (self.private / batch.JOURNALS[0]).read_bytes()

    def rows(self):
        return [json.loads(line) for line in self.raw().splitlines()]

    def assert_no_auth(self):
        self.assertFalse(any(row['event'] == 'deferred_retry_authorized' for row in self.rows()))

    def fresh_child(self, command, _timeout):
        order = int(command[command.index('--id') + 1])
        now = time.time()
        input_path = self.save('request-' + str(order) + '.json', {'private': 'current input'})
        sample = {'attemptId': uuid.uuid4().hex, 'targetOrderId': order, 'proxyIndex': 0,
                  'outcome': 'ORDER_ATTEMPT_LIMIT', 'requests': 0, 'businessWrites': 0,
                  'startedAt': now - 0.001, 'finishedAt': now, 'elapsedSeconds': 0.001,
                  'egressHash': None, 'egressAfterHash': None, 'egressVerifiedAfter': False,
                  'cleanup': {'attempted': False, 'removed': False, 'outcome': 'NOT_NEEDED'},
                  'preflightOnly': True, 'preflight': {'version': 2, 'outcome': 'ORDER_ATTEMPT_LIMIT',
                  'orderId': order, 'checkedAt': now, 'planSha256': self.plan_sha,
                  'inputSha256': retry.sha(input_path.read_bytes()), 'accountPaused': False, 'attempts': 10}}
        self.save('http-sample-' + str(order) + '-' + sample['attemptId'] + '.json', sample)
        return sample

    def test_freeze_is_private_exact_and_leaves_all_history_unchanged(self):
        before = self.raw()
        result = self.freeze()
        value = json.loads((self.private / self.name).read_bytes())
        self.assertEqual(self.raw(), before)
        self.assertEqual((self.private / self.name).stat().st_mode & 0o777, 0o600)
        self.assertEqual(result['journalWrites'], 0)
        self.assertEqual(value['planSha256'], self.plan_sha)
        self.assertEqual([v['orderId'] for v in value['entries']], [1, 2])
        self.assertEqual([v['sources'][0]['preflightVersion'] for v in value['entries']], [None, 1])
        self.assertNotIn('W000', json.dumps(value))
        with self.assertRaises(FileExistsError):
            self.freeze()

    def test_whole_batch_authorization_is_append_only_and_idempotent(self):
        self.freeze()
        before = self.raw()
        result = self.authorize()
        self.assertEqual(result['authorizedOrderIds'], [1, 2])
        self.assertTrue(self.raw().startswith(before))
        events = [row for row in self.rows() if row['event'] == 'deferred_retry_authorized']
        self.assertEqual(len(events), 2)
        self.assertEqual(len(set(v['authorizationId'] for v in events)), 2)
        after = self.raw()
        repeated = self.authorize()
        self.assertEqual(repeated['alreadyAuthorizedOrderIds'], [1, 2])
        self.assertEqual(repeated['authorizedOrderIds'], [])
        self.assertEqual(self.raw(), after)
        self.assertEqual(batch.journal_state(self.private / batch.JOURNALS[0], self.plan_sha, {1, 2}), set())

    def test_all_selected_validated_before_first_append(self):
        self.freeze()
        self.save('browser-receipt-bind-intent-2.json', {'state': 'APPLIED'})
        before = self.raw()
        with self.assertRaises(RuntimeError):
            self.authorize()
        self.assertEqual(self.raw(), before)
        self.assert_no_auth()

    def test_partial_append_can_only_resume_matching_unconsumed_authorization(self):
        self.freeze()
        original = batch.append
        count = [0]
        def append(path, row):
            count[0] += 1
            if count[0] == 2:
                raise OSError('synthetic failure')
            original(path, row)
        with patch.object(batch, 'append', side_effect=append), self.assertRaises(OSError):
            self.authorize()
        first = self.rows()[-1]
        result = self.authorize()
        self.assertEqual(result['alreadyAuthorizedOrderIds'], [1])
        self.assertEqual(result['authorizedOrderIds'], [2])
        self.assertEqual([v for v in self.rows() if v.get('authorizationId') == first['authorizationId']], [first])

    def test_new_v2_deferred_consumes_once_and_cannot_reopen(self):
        self.freeze()
        self.authorize([1])
        with patch.object(batch, 'child', side_effect=self.fresh_child) as child, contextlib.redirect_stdout(io.StringIO()):
            result = batch.execute(self.root, [1], 1, apply=True)
            self.assertEqual(result['processedThisRun'], 1)
            self.assertEqual(batch.execute(self.root, [1], 1, apply=True)['processedThisRun'], 0)
        self.assertEqual(child.call_count, 1)
        starts = [v for v in self.rows() if v['orderId'] == 1 and v['event'] == 'order_started']
        self.assertEqual(len(starts), 2)
        self.assertNotEqual(starts[0]['batchAttemptId'], starts[1]['batchAttemptId'])
        self.assertIn('retryAuthorizationId', starts[1])
        with self.assertRaises(RuntimeError):
            self.authorize([1])
        with patch.object(batch, 'child') as child, self.assertRaisesRegex(RuntimeError, 'MODE_MISMATCH'):
            batch.execute(self.root, [1], 1, apply=False)
        child.assert_not_called()

    def test_started_unknown_is_consumed_and_cannot_retry(self):
        self.freeze()
        self.authorize([1])
        with patch.object(batch, 'child', side_effect=RuntimeError('UNKNOWN')) as child, self.assertRaises(RuntimeError):
            batch.execute(self.root, [1], 1, apply=True)
        self.assertEqual(child.call_count, 1)
        self.assertTrue(retry.authorization_state(self.root, self.plan_sha)[1]['consumed'])
        with self.assertRaisesRegex(RuntimeError, 'RECONCILIATION_REQUIRED'):
            self.authorize([1])

    def test_retry_sample_cannot_lose_start_policy_by_dropping_row_authorization(self):
        self.freeze()
        self.authorize([1])
        with patch.object(batch, 'child', side_effect=self.fresh_child), contextlib.redirect_stdout(io.StringIO()):
            batch.execute(self.root, [1], 1, apply=True)
        rows = self.rows()
        sample_row = [row for row in rows if row['event'] == 'sample_finished' and row['orderId'] == 1][-1]
        sample_row.pop('retryAuthorizationId')
        sample_row['sample']['preflight'].update(version=1, attempts=3)
        sample = sample_row['sample']
        self.save('http-sample-1-' + sample['attemptId'] + '.json', sample)
        (self.private / batch.JOURNALS[0]).write_text(''.join(json.dumps(row) + '\n' for row in rows))
        self.assertTrue(retry.authorization_state(self.root, self.plan_sha)[1]['consumed'])
        with self.assertRaises(RuntimeError):
            batch.journal_state(self.private / batch.JOURNALS[0], self.plan_sha, {1, 2})

    def test_authorized_suffix_cannot_backdate_before_authorization(self):
        self.freeze()
        self.authorize([1])
        event = self.rows()[-1]
        before = self.raw()
        for kind in ('order_started', 'sample_finished', 'order_finished'):
            with self.subTest(event=kind):
                (self.private / batch.JOURNALS[0]).write_bytes(before)
                batch.append(self.private / batch.JOURNALS[0], {'event': kind, 'at': event['at'] - 1,
                    'orderId': 1, 'planSha256': self.plan_sha, 'batchAttemptId': uuid.uuid4().hex})
                with self.assertRaises(RuntimeError):
                    retry.authorization_state(self.root, self.plan_sha)

    def test_cross_mode_cannot_consume_and_new_start_requires_authorization_id(self):
        self.freeze()
        self.authorize([1])
        with patch.object(batch, 'child') as child, self.assertRaisesRegex(RuntimeError, 'MODE_MISMATCH'):
            batch.execute(self.root, [1], 1, apply=False)
        child.assert_not_called()
        batch.append(self.private / batch.JOURNALS[0], {'event': 'order_started', 'orderId': 1,
            'at': time.time(), 'planSha256': self.plan_sha, 'batchAttemptId': uuid.uuid4().hex})
        with self.assertRaises(RuntimeError):
            retry.authorization_state(self.root, self.plan_sha)

    def test_original_audit_or_finished_line_drift_denies_replay(self):
        self.freeze()
        self.authorize([1])
        original = self.raw()
        path = next(self.private.glob('http-sample-1-*.json'))
        raw = path.read_bytes()
        path.write_bytes(raw + b' ')
        with self.assertRaises(RuntimeError):
            retry.authorization_state(self.root, self.plan_sha)
        path.write_bytes(raw)
        (self.private / batch.JOURNALS[0]).write_bytes(original.replace(b'"receiptOutcome": null', b'"receiptOutcome":  null', 1))
        with self.assertRaises(RuntimeError):
            retry.authorization_state(self.root, self.plan_sha)

    def test_unknown_stop_cleanup_and_plan_drift_are_zero_append(self):
        self.freeze()
        before = self.raw()
        for name, value in [('http-apply-intent-99.json', {'state': 'COMMIT_UNKNOWN'}),
                            ('STOP', {}), ('http-cleanup-blocked.json', {})]:
            self.save(name, value)
            with self.assertRaises(RuntimeError):
                self.authorize()
            self.assertEqual(self.raw(), before)
            (self.private / name).unlink()
        self.case.plan['entries'][0]['rowHash'] = 'c' * 32
        self.save('plan.json', self.case.plan)
        with self.assertRaises(RuntimeError):
            self.authorize()
        self.assertEqual(self.raw(), before)

    def test_new_v2_sample_or_late_legacy_cannot_enter_old_manifest(self):
        rows = self.rows()
        sample = next(v['sample'] for v in rows if v['event'] == 'sample_finished' and v['orderId'] == 2)
        sample['preflight'].update(version=2, attempts=10)
        self.save('http-sample-2-' + sample['attemptId'] + '.json', sample)
        (self.private / batch.JOURNALS[0]).write_text(''.join(json.dumps(row) + '\n' for row in rows))
        with self.assertRaises(RuntimeError):
            self.freeze()
        sample['preflight'].update(version=1, attempts=3)
        self.save('http-sample-2-' + sample['attemptId'] + '.json', sample)
        (self.private / batch.JOURNALS[0]).write_text(''.join(json.dumps(row) + '\n' for row in rows))
        self.cutoff = self.now - 60
        with self.assertRaises(RuntimeError):
            self.freeze()

    def test_preceding_541_and_rejected_probes_are_preserved_and_rechecked(self):
        (self.private / batch.JOURNALS[0]).unlink()
        base = {'attemptId': uuid.uuid4().hex, 'targetOrderId': 1, 'proxyIndex': 0,
                'businessWrites': 0, 'startedAt': self.now - 40, 'finishedAt': self.now - 39,
                'elapsedSeconds': 1, 'egressHash': 'd' * 64, 'egressAfterHash': 'd' * 64,
                'egressVerifiedAfter': True, 'requests': 3, 'runId': 12, 'outcome': 'HTTP_541',
                'cleanup': {'attempted': True, 'removed': True, 'outcome': 'REMOVED'}}
        base['containerName'] = 'apple-official-http-sample-' + base['attemptId']
        self.old_sample(1, prior=[base])
        prior = []
        for index in range(3):
            value = {key: value for key, value in base.items() if key not in ('runId', 'requests', 'containerName')}
            value.update(targetOrderId=2, attemptId=uuid.uuid4().hex, outcome='EGRESS_PREVIOUSLY_REJECTED',
                         errorType='RuntimeError', failedStage='probe-before', egressAfterHash=None,
                         egressVerifiedAfter=False, startedAt=self.now - 30 + index * 2,
                         finishedAt=self.now - 29 + index * 2,
                         cleanup={'attempted': False, 'removed': False, 'outcome': 'NOT_NEEDED'})
            prior.append(value)
        self.old_sample(2, prior=prior)
        self.save('http-rejected-egress.json', ['d' * 64])
        self.freeze()
        value = json.loads((self.private / self.name).read_bytes())
        self.assertEqual([len(e['sources'][0]['sampleAudits']) for e in value['entries']], [2, 4])
        self.authorize()
        self.save('http-rejected-egress.json', [])
        with self.assertRaises(RuntimeError):
            retry.authorization_state(self.root, self.plan_sha)

    def test_cli_reopen_is_explicit_and_never_runs_sampler(self):
        self.freeze()
        args = ['batch', '--root', str(self.root), '--reopen-deferred', '--ids', '1,2', '--journal', 'apply',
                '--manifest', self.name, '--manifest-sha256', self.manifest_sha]
        with patch.object(sys, 'argv', args), patch.object(batch, 'child') as child, contextlib.redirect_stdout(io.StringIO()) as output:
            batch.main()
        self.assertEqual(json.loads(output.getvalue())['authorizedOrderIds'], [1, 2])
        child.assert_not_called()

    def test_two_mode_originals_are_both_bound_but_only_one_mode_can_consume(self):
        self.old_sample(1, preflight=True, journal=batch.JOURNALS[1])
        self.freeze()
        value = json.loads((self.private / self.name).read_bytes())
        self.assertEqual(len(value['entries'][0]['sources']), 2)
        self.authorize([1])
        with self.assertRaises(RuntimeError):
            self.authorize([1], batch.JOURNALS[1])
        with patch.object(batch, 'child') as child, self.assertRaisesRegex(RuntimeError, 'MODE_MISMATCH'):
            batch.execute(self.root, [1], 1, apply=False)
        child.assert_not_called()

    def test_same_manifest_different_name_or_bytes_is_not_idempotency(self):
        self.freeze()
        self.authorize([1])
        self.name = 'http-deferred-v1-another.json'
        source = self.private / 'http-deferred-v1-scope.json'
        target = self.private / self.name
        target.write_bytes(source.read_bytes())
        target.chmod(0o600)
        with self.assertRaises(RuntimeError):
            self.authorize([1])

    def test_second_authorization_event_and_duplicate_consumption_rejected(self):
        self.freeze()
        self.authorize([1])
        before = self.raw()
        event = self.rows()[-1]
        batch.append(self.private / batch.JOURNALS[0], dict(event, authorizationId=uuid.uuid4().hex))
        with self.assertRaises(RuntimeError):
            retry.authorization_state(self.root, self.plan_sha)
        (self.private / batch.JOURNALS[0]).write_bytes(before)
        for _index in range(2):
            batch.append(self.private / batch.JOURNALS[0], {'event': 'order_started', 'at': time.time(), 'orderId': 1,
                'planSha256': self.plan_sha, 'batchAttemptId': uuid.uuid4().hex, 'retryAuthorizationId': event['authorizationId']})
        with self.assertRaises(RuntimeError):
            retry.authorization_state(self.root, self.plan_sha)

    def test_new_batch_uuid_collision_stops_before_child(self):
        self.freeze()
        self.authorize([1])
        old_id = self.rows()[-1]['batchAttemptId']
        with patch.object(batch.uuid, 'uuid4', return_value=uuid.UUID(old_id)), patch.object(batch, 'child') as child:
            with self.assertRaises(RuntimeError):
                batch.execute(self.root, [1], 1, apply=True)
        child.assert_not_called()

    def test_source_activity_after_freeze_and_before_authorization_denies(self):
        self.freeze()
        self.old_sample(1, journal=batch.JOURNALS[1])
        with self.assertRaises(RuntimeError):
            self.authorize([1])
        self.assert_no_auth()

    def test_dangling_stop_symlink_lock_busy_and_missing_lock_are_zero_write(self):
        self.freeze()
        before = self.raw()
        (self.private / 'STOP').symlink_to(self.private / 'absent')
        with self.assertRaises(RuntimeError):
            self.authorize()
        (self.private / 'STOP').unlink()
        lock_path = self.private / 'http-apply.lock'
        with lock_path.open('rb') as handle:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaisesRegex(RuntimeError, 'BUSY'):
                self.authorize()
        lock_path.unlink()
        with self.assertRaises(FileNotFoundError):
            self.authorize()
        self.assertEqual(self.raw(), before)

    def test_stop_during_authorization_write_keeps_partial_without_next_event(self):
        self.freeze()
        append = batch.append
        def stop_after_first(path, row):
            append(path, row)
            self.save('STOP', {})
        with patch.object(batch, 'append', side_effect=stop_after_first), self.assertRaises(RuntimeError):
            self.authorize()
        self.assertEqual(len([row for row in self.rows() if row['event'] == 'deferred_retry_authorized']), 1)

    def test_legacy_zero_types_and_login_or_run_cannot_claim_old_deferred(self):
        original = self.raw()
        for change in ({'businessWrites': False}, {'requests': False}, {'runId': 1},
                       {'egressVerifiedAfter': False}, {'outcome': 'LOGIN_COOLDOWN'}):
            rows = [json.loads(line) for line in original.splitlines()]
            value = rows[1]['sample']
            value.update(change)
            self.save('http-sample-1-' + value['attemptId'] + '.json', value)
            rows[2]['sampleOutcome'] = value['outcome']
            (self.private / batch.JOURNALS[0]).write_text(''.join(json.dumps(row) + '\n' for row in rows))
            with self.subTest(change=change), self.assertRaises(RuntimeError):
                self.freeze()
            self.assertFalse((self.private / self.name).exists())

    def test_cli_rejects_mixed_mutation_modes_before_work(self):
        invalid = [
            ['--freeze-deferred', '--reopen-deferred'],
            ['--freeze-deferred', '--journal', 'apply'],
            ['--reopen-deferred', '--apply'],
            ['--reopen-deferred', '--quarantine-failed-read'],
            ['--reopen-deferred', '--proxy-index', '1'],
            ['--manifest', self.name],
        ]
        for flags in invalid:
            with self.subTest(flags=flags), patch.object(sys, 'argv', ['batch', '--root', str(self.root)] + flags):
                with patch.object(batch, 'child') as child, self.assertRaises(RuntimeError):
                    batch.main()
                child.assert_not_called()
        self.assert_no_auth()


if __name__ == '__main__':
    unittest.main()
