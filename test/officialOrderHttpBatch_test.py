"""批处理恢复与写入边界；全部使用本地替身，不访问生产或官网。"""
import datetime
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

DIRECTORY = pathlib.Path(__file__).parents[1] / 'scripts/officialOrder'
sys.path.insert(0, str(DIRECTORY))
SPEC = importlib.util.spec_from_file_location('http_batch', DIRECTORY / 'runHttpBatch.py')
batch = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(batch)


class BatchTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = pathlib.Path(directory.name)
        (self.root / 'private').mkdir(mode=0o700)
        self.plan = {'schemaVersion': 3, 'scope': 'missing-fields', 'cutoff': None,
                     'startedAt': (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(seconds=3)).strftime('%Y-%m-%dT%H:%M:%S.000Z'),
                     'policy': dict(batch.POLICY), 'entries': [
                         {'id': i, 'orderNumber': 'W' + str(i).zfill(10), 'rowHash': 'a' * 32,
                          'dateMissing': True, 'serialsMissing': True, 'previousDate': None, 'previousDevices': []}
                         for i in (1, 2)]}
        self.save('plan.json', self.plan)
        self.save('iproyal-cn.json', {'entries': [{}, {}, {}, {}]})
        self.calls = []
        self.outcomes = []
        self.after_sample = None
        self.sample_override = None
        self.apply_override = None
        self.chown = patch('runHttpSample.os.chown')
        self.chown.start()
        self.addCleanup(self.chown.stop)

    def save(self, name, value):
        path = self.root / 'private' / name
        path.write_text(json.dumps(value), encoding='utf-8')
        path.chmod(0o600)
        return path

    def child(self, command, timeout):
        self.calls.append(command)
        if command[1].endswith('runHttpSample.py'):
            order = int(command[command.index('--id') + 1])
            proxy = int(command[-1])
            index = len([call for call in self.calls if call[1].endswith('runHttpSample.py')])
            outcome = self.outcomes.pop(0) if self.outcomes else 'SUCCEEDED'
            result = {'outcome': outcome, 'orderId': order, 'targetOrderId': order, 'proxyIndex': proxy,
                      'runId': index, 'attemptId': format(index, '032x'), 'egressHash': format(proxy + 10, '064x'),
                      'egressAfterHash': format(proxy + 10, '064x'), 'egressVerifiedAfter': True,
                      'businessWrites': 0, 'cleanup': {'attempted': True, 'removed': True},
                      'receiptOutcome': 'RECEIPT_LINK_MISSING'}
            if self.sample_override:
                result.update(self.sample_override(result))
            self.save('http-sample-' + str(order) + '-' + result['attemptId'] + '.json', result)
            if self.after_sample:
                self.after_sample(result)
            return result
        order = int(command[command.index('--audit') + 1].split('-')[2])
        run = int(command[command.index('--audit') + 1].split('-')[3][:-5], 16)
        applying = '--apply' in command
        result = {'outcome': 'SUCCEEDED' if applying else 'DRY_RUN', 'mode': 'apply' if applying else 'dry-run',
                  'orderId': order, 'runId': run, 'businessWrites': 1 if applying else 0}
        if self.apply_override:
            result.update(self.apply_override)
        return result

    def execute(self, ids=None, limit=2, apply=False, proxy_index=0):
        with patch.object(batch, 'child', side_effect=self.child):
            return batch.execute(self.root, ids or [1], limit, apply=apply, proxy_index=proxy_index)

    def seed_confirmed(self, order_id=1):
        plan_sha = hashlib.sha256((self.root / 'private/plan.json').read_bytes()).hexdigest()
        sample_name = 'http-sample-' + str(order_id) + '-' + 'a' * 32 + '.json'
        source = {'outcome': 'SUCCEEDED', 'attemptId': 'a' * 32, 'orderId': order_id,
                  'targetOrderId': order_id, 'runId': 10, 'businessWrites': 0,
                  'cleanup': {'removed': True}, 'egressVerifiedAfter': True,
                  'egressHash': 'd' * 64, 'egressAfterHash': 'd' * 64}
        source_path = self.save(sample_name, source)
        entry = next(row for row in self.plan['entries'] if row['id'] == order_id)
        basis = {'version': 1, 'planSha256': plan_sha, 'orderId': order_id, 'originalRowHash': entry['rowHash'],
                 'stableRowHash': 'b' * 32, 'runId': 10,
                 'auditSha256': hashlib.sha256(source_path.read_bytes()).hexdigest()}
        prefix = 'http-apply-' + str(order_id) + '-' + 'c' * 32
        result = {'version': 1, 'mode': 'apply', 'orderId': order_id, 'runId': 10,
                  'businessWrites': 1, 'basis': basis, 'beforeHash': 'd' * 32,
                  'afterHash': 'e' * 32, 'sha256': 'f' * 64}
        basis_name = 'http-apply-basis-' + str(order_id) + '-run-10.json'
        self.save(prefix + '-result.json', result)
        self.save(prefix + '-payload.json', {'planSha256': plan_sha, 'entry': entry, 'audit': source})
        self.save(prefix + '-preview.json', {'basis': basis})
        self.save(prefix + '-audit.json', dict(result, outcome='SUCCEEDED',
                  resultFile=prefix + '-result.json', auditFile=prefix + '-audit.json', basisFile=basis_name))
        self.save(basis_name, basis)
        intent = {'state': 'APPLIED', 'orderId': order_id, 'runId': 10, 'attemptId': 'c' * 32,
                  'sourceAudit': sample_name, 'payloadFile': prefix + '-payload.json',
                  'previewFile': prefix + '-preview.json', 'resultFile': prefix + '-result.json',
                  'auditFile': prefix + '-audit.json'}
        self.save('http-apply-intent-' + str(order_id) + '.json', intent)
        return intent

    def browser_intent(self, state='APPLY_STARTED'):
        prefix = 'browser-receipt-bind-999-' + 'f' * 32
        value = {'state': state, 'orderId': 999, 'attemptId': 'f' * 32,
                 'sourceAudit': 'browser-sample-999-' + 'e' * 32 + '.json', 'receiptRunId': 88,
                 'receiptSha256': 'a' * 64, 'payloadSha256': 'b' * 64,
                 'payloadFile': prefix + '-payload.json', 'resultFile': prefix + '-result.json',
                 'auditFile': prefix + '-audit.json'}
        return self.save('browser-receipt-bind-intent-999.json', value)

    def test_other_browser_apply_started_blocks_before_journal_sampler_and_probe(self):
        self.browser_intent()
        for applying in (False, True):
            with self.assertRaisesRegex(RuntimeError, 'BATCH_RECONCILIATION_REQUIRED'):
                self.execute(apply=applying)
        self.assertEqual(self.calls, [])
        self.assertFalse(list((self.root / 'private').glob('http-batch-*.jsonl')))

    def test_legacy_complete_browser_applied_without_started_at_allows_new_work(self):
        self.browser_intent('APPLIED')
        self.assertEqual(self.execute()['processedThisRun'], 1)
        self.assertEqual(len(self.calls), 2)

    def test_malformed_or_multimeaning_browser_intents_block_before_child(self):
        raw_cases = (b'{"state":"APPLY_STARTED","state":"APPLIED"}',
                     b'{"state":"APPLIED","orderId":999}',
                     b'{"state":"APPLIED","orderId":true}',
                     b'{"state":"APPLIED","orderId":999,"extra":NaN}',
                     b'{"state":"APPLIED","orderId":999,"extra":1e999}', b'{')
        path = self.root / 'private/browser-receipt-bind-intent-999.json'
        for raw in raw_cases:
            path.write_bytes(raw); path.chmod(0o600)
            with self.assertRaisesRegex(RuntimeError, 'BATCH_RECONCILIATION_REQUIRED'): self.execute()
        path.unlink()
        for kind in ('name', 'symlink', 'public'):
            path = self.browser_intent('APPLIED')
            if kind == 'name':
                target = path.with_name('browser-receipt-bind-intent-foo.json')
                path.rename(target)
                path = target
            elif kind == 'symlink': path.unlink(); path.symlink_to('plan.json')
            else: path.chmod(0o644)
            with self.assertRaisesRegex(RuntimeError, 'BATCH_RECONCILIATION_REQUIRED'): self.execute()
            path.unlink()
        self.assertEqual(self.calls, [])

    def test_browser_unknown_created_during_sample_blocks_apply_and_next_sample(self):
        self.after_sample = lambda result: self.browser_intent()
        with self.assertRaisesRegex(RuntimeError, 'BATCH_RECONCILIATION_REQUIRED'):
            self.execute([1, 2], apply=True)
        self.assertEqual(len(self.calls), 1)
        self.assertTrue(self.calls[0][1].endswith('runHttpSample.py'))
        rows = [json.loads(row) for row in (self.root / 'private/http-batch-apply.jsonl').read_text().splitlines()]
        self.assertEqual([row['event'] for row in rows], ['order_started', 'sample_finished'])

    def test_541_rejected_exit_is_saved_before_new_stop_blocks_rotation(self):
        self.outcomes = ['HTTP_541']
        self.after_sample = lambda result: self.save('STOP', {})
        with self.assertRaisesRegex(RuntimeError, 'BATCH_STOP_REQUESTED'):
            self.execute([1, 2], apply=True)
        self.assertEqual(len(self.calls), 1)
        rejected = json.loads((self.root / 'private/http-rejected-egress.json').read_text())
        self.assertEqual(rejected, [format(10, '064x')])
        rows = [json.loads(row) for row in (self.root / 'private/http-batch-apply.jsonl').read_text().splitlines()]
        self.assertEqual([row['event'] for row in rows], ['order_started', 'sample_finished'])

    def test_changed_exits_are_saved_before_new_unknown_blocks_further_work(self):
        self.outcomes = ['EGRESS_CHANGED_OR_UNVERIFIED']
        self.sample_override = lambda result: {'egressAfterHash': 'e' * 64, 'egressVerifiedAfter': False}
        self.after_sample = lambda result: self.browser_intent()
        with self.assertRaisesRegex(RuntimeError, 'BATCH_RECONCILIATION_REQUIRED'):
            self.execute([1, 2], apply=True)
        self.assertEqual(len(self.calls), 1)
        rejected = json.loads((self.root / 'private/http-rejected-egress.json').read_text())
        self.assertEqual(rejected, [format(10, '064x'), 'e' * 64])
        rows = [json.loads(row) for row in (self.root / 'private/http-batch-apply.jsonl').read_text().splitlines()]
        self.assertEqual([row['event'] for row in rows], ['order_started', 'sample_finished'])

    def test_http_rollback_missing_existing_required_fields_is_not_terminal_proof(self):
        self.save('http-apply-intent-999.json', {'state': 'ROLLED_BACK', 'orderId': 999})
        with self.assertRaisesRegex(RuntimeError, 'BATCH_RECONCILIATION_REQUIRED'): self.execute()
        self.assertEqual(self.calls, [])

    def test_global_unknown_created_after_child_apply_stops_before_next_target(self):
        original = self.child
        def child(command, timeout):
            value = original(command, timeout)
            if command[1].endswith('applyHttpSample.py'):
                self.browser_intent()
            return value
        with patch.object(batch, 'child', side_effect=child):
            with self.assertRaisesRegex(RuntimeError, 'BATCH_RECONCILIATION_REQUIRED'):
                batch.execute(self.root, [1, 2], 2, apply=True)
        self.assertEqual(len(self.calls), 2)
        rows = [json.loads(row) for row in (self.root / 'private/http-batch-apply.jsonl').read_text().splitlines()]
        self.assertNotIn('order_finished', [row['event'] for row in rows])

    def test_cleanup_and_dangling_stop_prevent_new_child(self):
        path = self.save('http-cleanup-blocked.json', {})
        with self.assertRaisesRegex(RuntimeError, 'BATCH_SAMPLE_CLEANUP_REQUIRED'): self.execute()
        path.unlink()
        (self.root / 'private/STOP').symlink_to('absent')
        with self.assertRaisesRegex(RuntimeError, 'BATCH_STOP_REQUESTED'): self.execute()
        self.assertEqual(self.calls, [])

    def test_default_preview_never_passes_apply(self):
        result = self.execute()
        self.assertEqual(result['processedThisRun'], 1)
        self.assertFalse(result['allFieldsComplete'])
        self.assertNotIn('--apply', self.calls[1])

    def test_confirmed_completion_is_not_replayed(self):
        self.execute(apply=True)
        self.assertIn('--apply', self.calls[1])
        self.assertEqual(self.execute(apply=True)['processedThisRun'], 0)
        self.assertEqual(len(self.calls), 2)

    def test_unknown_commit_stops_and_prevents_cross_mode_replay(self):
        self.apply_override = {'outcome': 'MANUAL_RECONCILIATION_REQUIRED', 'businessWrites': None}
        with self.assertRaisesRegex(RuntimeError, 'BATCH_APPLY_STOPPED'):
            self.execute([1, 2], apply=True)
        for mode in (False, True):
            with self.assertRaisesRegex(RuntimeError, 'BATCH_RECONCILIATION_REQUIRED'):
                self.execute([1, 2], apply=mode)
        self.assertEqual(len(self.calls), 2)

    def test_frozen_scope_and_duplicate_ids_fail_before_request(self):
        for ids in ([3], [1, 1], [True]):
            with self.assertRaisesRegex(RuntimeError, 'BACKFILL_SCOPE_INVALID'):
                self.execute(ids)
        self.assertEqual(self.calls, [])

    def test_invalid_limits_and_proxy_fail_before_request(self):
        for limit, proxy in ((0, 0), (True, 0), (2, -1), (2, True), (2, 99)):
            with self.assertRaises(RuntimeError):
                self.execute(limit=limit, proxy_index=proxy)
        self.assertEqual(self.calls, [])

    def test_full_frozen_plan_contract_is_required(self):
        modifications = [('schemaVersion', 2), ('scope', 'all-picked-up'), ('cutoff', '2026-01-01'),
                         ('policy', {}), ('entries', []), ('startedAt', '2000-01-01T00:00:00Z')]
        for key, value in modifications:
            self.save('plan.json', dict(self.plan, **{key: value}))
            with self.assertRaisesRegex(RuntimeError, 'BACKFILL_SCOPE_INVALID'):
                self.execute()
        self.assertEqual(self.calls, [])

    def test_cooldown_keeps_old_data_and_moves_to_next_target(self):
        self.outcomes = ['ACCOUNT_COOLDOWN', 'SUCCEEDED']
        self.assertEqual(self.execute([1, 2], apply=True)['processedThisRun'], 2)
        self.assertEqual(len(self.calls), 3)

    def test_daily_gate_limit_is_not_retried_or_bypassed(self):
        self.outcomes = ['ORDER_ATTEMPT_LIMIT']
        self.assertEqual(self.execute(apply=True)['processedThisRun'], 1)
        self.assertEqual(len(self.calls), 1)
        self.assertTrue(self.calls[0][1].endswith('runHttpSample.py'))
        self.assertNotIn('--skip-gate', self.calls[0])

    def test_541_marks_actual_egress_and_uses_different_actual_exit(self):
        self.outcomes = ['HTTP_541', 'SUCCEEDED']
        self.execute(apply=True)
        rejected = json.loads((self.root / 'private/http-rejected-egress.json').read_text())
        self.assertEqual(rejected, [format(10, '064x')])
        self.assertEqual(self.calls[1][-1], '1')
        self.assertEqual(len(self.calls), 3)

    def test_rotated_proxy_cannot_reuse_rejected_actual_egress(self):
        self.outcomes = ['HTTP_541', 'SUCCEEDED']
        self.sample_override = lambda result: {'egressHash': format(10, '064x'), 'egressAfterHash': format(10, '064x')}
        with self.assertRaisesRegex(RuntimeError, 'BATCH_REJECTED_EGRESS_REUSED'):
            self.execute(apply=True)
        self.assertEqual(len(self.calls), 2)

    def test_541_has_maximum_three_order_attempts(self):
        self.outcomes = ['HTTP_541'] * 3
        result = self.execute(apply=True)
        self.assertEqual(result['processedThisRun'], 1)
        self.assertEqual(len(self.calls), 3)
        self.assertEqual([call[-1] for call in self.calls], ['0', '1', '2'])
        self.assertFalse(result['allFieldsComplete'])

    def test_rejected_probe_does_not_spend_local_order_attempt(self):
        self.outcomes = ['EGRESS_PREVIOUSLY_REJECTED', 'SUCCEEDED']
        self.sample_override = lambda result: {'runId': None} if result['outcome'] != 'SUCCEEDED' else {}
        self.execute(apply=True)
        self.assertEqual(len(self.calls), 3)

    def test_stop_file_prevents_any_new_sample(self):
        (self.root / 'private/STOP').write_text('stop')
        self.assertEqual(self.execute()['processedThisRun'], 0)
        self.assertEqual(self.calls, [])

    def test_stop_after_541_prevents_retry(self):
        self.outcomes = ['HTTP_541']
        self.after_sample = lambda result: (self.root / 'private/STOP').write_text('stop')
        with self.assertRaisesRegex(RuntimeError, 'BATCH_STOP_REQUESTED'):
            self.execute(apply=True)
        self.assertEqual(len(self.calls), 1)

    def test_stop_after_success_prevents_apply(self):
        self.after_sample = lambda result: (self.root / 'private/STOP').write_text('stop')
        with self.assertRaisesRegex(RuntimeError, 'BATCH_STOP_REQUESTED'):
            self.execute(apply=True)
        self.assertEqual(len(self.calls), 1)

    def test_plan_change_after_sample_prevents_retry_or_apply(self):
        self.after_sample = lambda result: self.save('plan.json', dict(self.plan, scope='changed'))
        for outcome in ('SUCCEEDED', 'HTTP_541'):
            self.save('plan.json', self.plan)
            self.outcomes = [outcome]
            journal = self.root / 'private/http-batch-apply.jsonl'
            if journal.exists():
                journal.unlink()
            with self.assertRaisesRegex(RuntimeError, 'BACKFILL_SCOPE_INVALID'):
                self.execute(apply=True)
        self.assertEqual(len(self.calls), 2)

    def test_sample_audit_is_checked_against_stdout(self):
        self.after_sample = lambda result: self.save('http-sample-1-' + result['attemptId'] + '.json', {})
        with self.assertRaisesRegex(RuntimeError, 'BATCH_SAMPLE_AUDIT_INVALID'):
            self.execute(apply=True)
        self.assertEqual(len(self.calls), 1)

    def test_collector_541_error_can_omit_order_id_but_sampler_target_is_required(self):
        self.outcomes = ['HTTP_541', 'SUCCEEDED']
        self.sample_override = lambda result: {'orderId': None} if result['outcome'] == 'HTTP_541' else {}
        self.execute(apply=True)
        self.assertEqual(len(self.calls), 3)

    def test_unresolved_manual_apply_intent_stops_before_new_collection(self):
        self.save('http-apply-intent-2.json', {'state': 'APPLY_STARTED', 'orderId': 2})
        with self.assertRaisesRegex(RuntimeError, 'BATCH_RECONCILIATION_REQUIRED'):
            self.execute([1], apply=True)
        self.assertEqual(self.calls, [])

    def test_confirmed_manual_canary_is_skipped_but_sn_is_not_reported_complete(self):
        self.seed_confirmed()
        result = self.execute([1, 2], apply=True)
        self.assertEqual(result['previouslyConfirmedStatusDate'], 1)
        self.assertEqual(result['processedThisRun'], 1)
        self.assertFalse(result['allFieldsComplete'])
        self.assertEqual(self.calls[0][self.calls[0].index('--id') + 1], '2')
        self.assertEqual(len(self.calls), 2)

    def test_applied_flag_alone_cannot_skip_missing_private_result(self):
        intent = self.seed_confirmed()
        (self.root / 'private' / intent['resultFile']).unlink()
        with self.assertRaisesRegex(RuntimeError, 'BATCH_CONFIRMED_APPLY_INVALID'):
            self.execute(apply=True)
        self.assertEqual(self.calls, [])

    def test_canary_source_audit_tampering_prevents_skip_or_replay(self):
        intent = self.seed_confirmed()
        self.save(intent['sourceAudit'], {'outcome': 'SUCCEEDED'})
        with self.assertRaisesRegex(RuntimeError, 'BATCH_CONFIRMED_APPLY_INVALID'):
            self.execute(apply=True)
        self.assertEqual(self.calls, [])

    def test_confirmed_apply_from_another_plan_does_not_skip_target(self):
        self.seed_confirmed()
        self.plan['startedAt'] = self.plan['startedAt'].replace('.000Z', '.001Z')
        self.save('plan.json', self.plan)
        result = self.execute(apply=True)
        self.assertEqual(result['previouslyConfirmedStatusDate'], 0)
        self.assertEqual(len(self.calls), 2)

    def test_cleanup_failure_prevents_any_followup(self):
        self.sample_override = lambda result: {'cleanup': {'attempted': True, 'removed': False}}
        with self.assertRaisesRegex(RuntimeError, 'BATCH_SAMPLE_CLEANUP_REQUIRED'):
            self.execute(apply=True)
        self.assertEqual(len(self.calls), 1)

    def test_wrong_apply_identity_requires_reconciliation_without_replay(self):
        self.apply_override = {'orderId': 2}
        with self.assertRaisesRegex(RuntimeError, 'BATCH_APPLY_OUTPUT_INVALID'):
            self.execute(apply=True)
        with self.assertRaisesRegex(RuntimeError, 'BATCH_RECONCILIATION_REQUIRED'):
            self.execute(apply=True)
        self.assertEqual(len(self.calls), 2)

    def test_actual_exit_change_records_both_then_stops(self):
        self.outcomes = ['EGRESS_CHANGED_OR_UNVERIFIED']
        self.sample_override = lambda result: {'egressAfterHash': format(20, '064x'), 'egressVerifiedAfter': False}
        with self.assertRaisesRegex(RuntimeError, 'BATCH_COLLECTOR_STOPPED'):
            self.execute(apply=True)
        self.assertEqual(json.loads((self.root / 'private/http-rejected-egress.json').read_text()),
                         [format(10, '064x'), format(20, '064x')])

    def test_child_timeout_leaves_unresolved_intent(self):
        with patch.object(batch, 'child', side_effect=RuntimeError('BATCH_CHILD_TIMEOUT')):
            with self.assertRaisesRegex(RuntimeError, 'BATCH_CHILD_TIMEOUT'):
                batch.execute(self.root, [1], 1, apply=True)
        with self.assertRaisesRegex(RuntimeError, 'BATCH_RECONCILIATION_REQUIRED'):
            self.execute(apply=True)
        self.assertEqual(self.calls, [])

    def test_journal_attempt_pairing_is_exact(self):
        plan_sha = hashlib.sha256((self.root / 'private/plan.json').read_bytes()).hexdigest()
        row = {'orderId': 1, 'planSha256': plan_sha, 'batchAttemptId': 'a' * 32}
        journal = self.root / 'private/http-batch-apply.jsonl'
        batch.append(journal, dict(row, event='order_started'))
        batch.append(journal, dict(row, event='order_finished', batchAttemptId='b' * 32))
        with self.assertRaisesRegex(RuntimeError, 'BATCH_RECONCILIATION_REQUIRED'):
            self.execute(apply=True)
        self.assertEqual(self.calls, [])

    def test_partial_journal_line_prevents_replay(self):
        journal = self.root / 'private/http-batch-apply.jsonl'
        journal.write_text('{')
        journal.chmod(0o600)
        with self.assertRaisesRegex(RuntimeError, 'BATCH_RECONCILIATION_REQUIRED'):
            self.execute()
        self.assertEqual(self.calls, [])

    def test_finished_record_without_sample_or_apply_proof_is_not_accepted(self):
        plan_sha = hashlib.sha256((self.root / 'private/plan.json').read_bytes()).hexdigest()
        row = {'orderId': 1, 'planSha256': plan_sha, 'batchAttemptId': 'a' * 32}
        journal = self.root / 'private/http-batch-apply.jsonl'
        batch.append(journal, dict(row, event='order_started'))
        batch.append(journal, dict(row, event='order_finished', sampleOutcome='SUCCEEDED'))
        with self.assertRaisesRegex(RuntimeError, 'BATCH_RECONCILIATION_REQUIRED'):
            self.execute(apply=True)
        self.assertEqual(self.calls, [])

    def test_journal_terminal_outcome_cannot_differ_from_sample(self):
        self.execute(apply=True)
        journal = self.root / 'private/http-batch-apply.jsonl'
        rows = [json.loads(line) for line in journal.read_text().splitlines()]
        rows[-1]['sampleOutcome'] = 'ACCOUNT_COOLDOWN'
        journal.write_text(''.join(json.dumps(row) + '\n' for row in rows))
        with self.assertRaisesRegex(RuntimeError, 'BATCH_RECONCILIATION_REQUIRED'):
            self.execute(apply=True)
        self.assertEqual(len(self.calls), 2)

    def test_execute_itself_is_locked_not_only_cli(self):
        with open(str(self.root / 'private/http-batch.lock'), 'a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaisesRegex(RuntimeError, 'HTTP_BATCH_BUSY'):
                self.execute()
        self.assertEqual(self.calls, [])

    def test_append_refuses_symlink_and_is_private(self):
        path = self.root / 'private/journal.jsonl'
        batch.append(path, {'event': 'test'})
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        link = self.root / 'private/link.jsonl'
        link.symlink_to(path)
        with self.assertRaises(OSError):
            batch.append(link, {'event': 'unsafe'})
        self.assertEqual(len(path.read_text().splitlines()), 1)

    def test_child_strict_protocol_and_exit(self):
        for output, code in ((b'noise\n{"outcome":"SUCCEEDED"}', 0),
                             (b'{"outcome":"SUCCEEDED"}', 1),
                             (b'{"outcome":false}', 0), (b'\xff', 0),
                             (b'x' * (batch.MAX_CHILD_BYTES + 1), 0)):
            with patch.object(batch.subprocess, 'run', return_value=subprocess.CompletedProcess([], code, output, b'')):
                with self.assertRaises(RuntimeError):
                    batch.child(['example'], 1)

    def test_child_timeout_has_fixed_error_code(self):
        with patch.object(batch.subprocess, 'run', side_effect=subprocess.TimeoutExpired('private-command', 1)):
            with self.assertRaisesRegex(RuntimeError, '^BATCH_CHILD_TIMEOUT$'):
                batch.child(['example'], 1)

    def seed_probe_failure(self, mode='apply'):
        journal = self.root / 'private' / ('http-batch-' + mode + '.jsonl')
        if journal.exists():
            journal.unlink()
        now = time.time()
        record = {'orderId': 1, 'planSha256': hashlib.sha256((self.root / 'private/plan.json').read_bytes()).hexdigest(),
                  'batchAttemptId': 'a' * 32}
        sample = {'outcome': 'RUNTIME_COMMAND_FAILED', 'failedStage': 'probe-before', 'errorType': 'RuntimeError',
                  'attemptId': 'b' * 32, 'targetOrderId': 1, 'proxyIndex': 2,
                  'startedAt': now - 2, 'finishedAt': now - 1, 'elapsedSeconds': 1.0,
                  'egressHash': None, 'egressAfterHash': None, 'egressVerifiedAfter': False,
                  'businessWrites': 0, 'cleanup': {'attempted': False, 'removed': False, 'outcome': 'NOT_NEEDED'}}
        batch.append(journal, dict(record, event='order_started', at=now - 3))
        batch.append(journal, dict(record, event='sample_finished', sample=sample, at=now))
        audit = self.save('http-sample-1-' + sample['attemptId'] + '.json', sample)
        return journal, record, sample, audit

    def reconcile(self, mode='apply', order_id=1, batch_attempt='a' * 32, sample_attempt='b' * 32):
        with patch.object(batch, 'child', side_effect=AssertionError('must not execute child')):
            return batch.reconcile_probe_failure(self.root, 'http-batch-' + mode + '.jsonl',
                                                 order_id, batch_attempt, sample_attempt)

    def replace_probe_sample(self, journal, sample, audit):
        rows = [json.loads(line) for line in journal.read_text().splitlines()]
        rows[1]['sample'] = sample
        journal.write_text(''.join(json.dumps(row) + '\n' for row in rows), encoding='utf-8')
        audit.write_text(json.dumps(sample), encoding='utf-8')

    def test_probe_reconciliation_appends_without_completing_target_and_new_uuid_can_retry(self):
        for mode in ('apply', 'dry-run'):
            with self.subTest(mode=mode):
                for name in batch.JOURNALS:
                    previous = self.root / 'private' / name
                    if previous.exists():
                        previous.unlink()
                journal, record, sample, audit = self.seed_probe_failure(mode)
                before = journal.read_bytes()
                audit_before = audit.read_bytes()
                result = self.reconcile(mode)
                self.assertEqual(result['outcome'], 'BATCH_PROBE_FAILURE_RECONCILED')
                self.assertFalse(result['targetCompleted'])
                self.assertEqual(result['businessWrites'], 0)
                self.assertTrue(journal.read_bytes().startswith(before))
                self.assertEqual(audit.read_bytes(), audit_before)
                rows = [json.loads(line) for line in journal.read_text().splitlines()]
                self.assertEqual(len(rows), 3)
                self.assertEqual(rows[-1]['event'], 'probe_failure_reconciled')
                self.assertEqual(rows[-1]['batchAttemptId'], record['batchAttemptId'])
                self.assertEqual(rows[-1]['sampleAttemptId'], sample['attemptId'])
                self.assertEqual(rows[-1]['auditSha256'], hashlib.sha256(audit_before).hexdigest())
                self.assertEqual(batch.journal_state(journal, record['planSha256'], {1, 2}), set())
                self.assertEqual(self.execute(apply=mode == 'apply')['processedThisRun'], 1)
                rows = [json.loads(line) for line in journal.read_text().splitlines()]
                self.assertEqual(rows[3]['event'], 'order_started')
                self.assertNotEqual(rows[3]['batchAttemptId'], record['batchAttemptId'])

    def test_probe_reconciliation_exact_target_and_attempts_required(self):
        journal, _, _, _ = self.seed_probe_failure()
        before = journal.read_bytes()
        for arguments in ({'order_id': 2}, {'batch_attempt': 'c' * 32}, {'sample_attempt': 'c' * 32},
                          {'mode': 'dry-run'}, {'order_id': True}, {'batch_attempt': '../a'}):
            with self.subTest(arguments=arguments), self.assertRaises(RuntimeError):
                self.reconcile(**arguments)
        self.assertEqual(journal.read_bytes(), before)

    def reconcile_541(self):
        with patch.object(batch, 'runtime_boundary'):
            return self.reconcile()

    def seed_541_then_probe(self, count=1):
        journal, record, sample, audit = self.seed_probe_failure()
        now = sample['finishedAt'] + 1
        rows = [dict(record, event='order_started', at=now - 12)]
        priors = []
        for index in range(count):
            item = {'outcome': 'HTTP_541', 'runId': 20 + index, 'requests': 3,
                    'attemptId': format(index + 100, '032x'), 'targetOrderId': 1, 'proxyIndex': index,
                    'startedAt': now - 10 + index * 2, 'finishedAt': now - 9 + index * 2, 'elapsedSeconds': 1.0,
                    'egressHash': format(index + 20, '064x'), 'egressAfterHash': format(index + 20, '064x'),
                    'egressVerifiedAfter': True, 'businessWrites': 0,
                    'cleanup': {'attempted': True, 'removed': True, 'outcome': 'REMOVED'}}
            item['containerName'] = 'apple-official-http-sample-' + item['attemptId']
            self.save('http-sample-1-' + item['attemptId'] + '.json', item)
            rows.append(dict(record, event='sample_finished', sample=item, at=item['finishedAt'] + .1))
            priors.append(item)
        rows.append(dict(record, event='sample_finished', sample=sample, at=now))
        journal.write_text(''.join(json.dumps(row) + '\n' for row in rows), encoding='utf-8')
        self.save('http-rejected-egress.json', [x['egressHash'] for x in priors])
        return journal, record, sample, priors

    def test_541_then_probe_reconciliation_preserves_history_and_allows_fresh_gate(self):
        for count in (1, 2):
            with self.subTest(count=count):
                journal, record, sample, priors = self.seed_541_then_probe(count)
                before = journal.read_bytes()
                result = self.reconcile_541()
                self.assertFalse(result['targetCompleted'])
                self.assertTrue(journal.read_bytes().startswith(before))
                event = json.loads(journal.read_text().splitlines()[-1])
                self.assertEqual(event['resolution'], 'FAILED_541_THEN_CANCELLED_BEFORE_COLLECTOR')
                self.assertEqual(len(event['precedingFailures']), count)
                self.assertEqual(batch.journal_state(journal, record['planSha256'], {1, 2}), set())

    def test_541_probe_replay_does_not_reject_later_success_artifacts(self):
        journal, record, _, _ = self.seed_541_then_probe()
        self.reconcile_541()
        path = self.root / 'private/results'
        path.mkdir()
        self.save('results/order-1-run-999.json', {'later': 'success'})
        self.assertEqual(batch.journal_state(journal, record['planSha256'], {1, 2}), set())

    def test_541_probe_refuses_mutated_prior_evidence_and_preserves_journal(self):
        for change in ('outcome', 'runId', 'egressVerifiedAfter', 'cleanup', 'businessWrites', 'startedAt'):
            with self.subTest(change=change):
                journal, _, _, priors = self.seed_541_then_probe(2)
                rows = [json.loads(x) for x in journal.read_text().splitlines()]
                values = {'outcome': 'SUCCEEDED', 'runId': priors[1]['runId'], 'egressVerifiedAfter': False,
                          'cleanup': {'removed': False}, 'businessWrites': 1, 'startedAt': time.time()}
                rows[1]['sample'][change] = values[change]
                self.save('http-sample-1-' + priors[0]['attemptId'] + '.json', rows[1]['sample'])
                journal.write_text(''.join(json.dumps(x) + '\n' for x in rows), encoding='utf-8')
                before = journal.read_bytes()
                with self.assertRaises(RuntimeError):
                    self.reconcile_541()
                self.assertEqual(journal.read_bytes(), before)

    def test_541_probe_requires_rejected_egress_and_no_success_artifact(self):
        journal, _, _, _ = self.seed_541_then_probe()
        self.save('http-rejected-egress.json', [])
        with self.assertRaises(RuntimeError):
            self.reconcile_541()
        journal, _, _, _ = self.seed_541_then_probe()
        self.save('http-apply-1-forbidden.json', {})
        before = journal.read_bytes()
        with self.assertRaises(RuntimeError):
            self.reconcile_541()
        self.assertEqual(journal.read_bytes(), before)

    def test_541_probe_replay_requires_original_audit_bytes(self):
        journal, record, _, priors = self.seed_541_then_probe()
        self.reconcile_541()
        path = self.root / 'private' / ('http-sample-1-' + priors[0]['attemptId'] + '.json')
        path.write_bytes(path.read_bytes() + b' ')
        with self.assertRaises(RuntimeError):
            batch.journal_state(journal, record['planSha256'], {1, 2})

    def test_541_probe_runtime_failure_appends_nothing(self):
        journal, _, _, _ = self.seed_541_then_probe()
        before = journal.read_bytes()
        with patch.object(batch, 'runtime_boundary', side_effect=RuntimeError('RUNTIME_UNVERIFIED')):
            with self.assertRaisesRegex(RuntimeError, 'RUNTIME_UNVERIFIED'):
                self.reconcile()
        self.assertEqual(journal.read_bytes(), before)

    def test_541_probe_fresh_retry_still_runs_sampler(self):
        journal, record, _, _ = self.seed_541_then_probe()
        self.reconcile_541()
        result = self.execute(apply=True)
        self.assertEqual(result['processedThisRun'], 1)
        starts = [json.loads(x) for x in journal.read_text().splitlines() if json.loads(x)['event'] == 'order_started']
        self.assertEqual(len(starts), 2)
        self.assertNotEqual(starts[1]['batchAttemptId'], record['batchAttemptId'])
        self.assertTrue(any('runHttpSample.py' in call[1] for call in self.calls))

    def test_probe_reconciliation_refuses_collector_activity_unknown_results_and_wrong_types(self):
        changes = [{'outcome': 'HTTP_541'}, {'outcome': 'HTTP_SAMPLE_FAILED'}, {'failedStage': 'collector'},
                   {'failedStage': 'probe-after'}, {'runId': None}, {'runId': 10}, {'orderId': None},
                   {'containerName': None}, {'receiptOutcome': 'RECEIPT_LINK_MISSING'}, {'businessWrites': False},
                   {'businessWrites': 0.0}, {'businessWrites': None}, {'errorType': 'TimeoutExpired'},
                   {'proxyIndex': True}, {'targetOrderId': True}, {'egressHash': 'a' * 64},
                   {'egressAfterHash': 'a' * 64}, {'egressVerifiedAfter': 0},
                   {'cleanup': {'attempted': 0, 'removed': False, 'outcome': 'NOT_NEEDED'}},
                   {'cleanup': {'attempted': True, 'removed': True, 'outcome': 'REMOVED'}},
                   {'cleanup': {'attempted': False, 'removed': False, 'outcome': 'NOT_NEEDED', 'extra': True}},
                   {'elapsedSeconds': True}, {'elapsedSeconds': 999}, {'startedAt': False},
                   {'finishedAt': time.time() + 100}, {'originalOutcome': 'SUCCEEDED'}]
        for change in changes:
            with self.subTest(change=change):
                journal, _, sample, audit = self.seed_probe_failure()
                sample.update(change)
                self.replace_probe_sample(journal, sample, audit)
                before = journal.read_bytes()
                with self.assertRaisesRegex(RuntimeError, 'BATCH_PROBE_RECONCILIATION_DENIED'):
                    self.reconcile()
                self.assertEqual(journal.read_bytes(), before)

    def test_probe_reconciliation_requires_matching_private_audit_and_rejects_duplicate_keys(self):
        for mutation in ('mismatch', 'duplicate', 'nonfinite', 'public', 'missing', 'symlink'):
            with self.subTest(mutation=mutation):
                journal, _, sample, audit = self.seed_probe_failure()
                before = journal.read_bytes()
                if mutation == 'mismatch':
                    audit.write_text(json.dumps(dict(sample, proxyIndex=3)))
                elif mutation == 'duplicate':
                    audit.write_text(audit.read_text()[:-1] + ', "businessWrites": 0}')
                elif mutation == 'nonfinite':
                    audit.write_text(audit.read_text().replace('"elapsedSeconds": 1.0', '"elapsedSeconds": NaN'))
                elif mutation == 'public':
                    audit.chmod(0o644)
                else:
                    audit.unlink()
                    if mutation == 'symlink':
                        other = self.save('other-audit.json', sample)
                        audit.symlink_to(other)
                with self.assertRaises(RuntimeError):
                    self.reconcile()
                self.assertEqual(journal.read_bytes(), before)

    def test_probe_reconciliation_refuses_multiple_samples_or_apply_failure(self):
        for extra in ('sample_finished', 'apply_failed'):
            with self.subTest(extra=extra):
                journal, record, sample, _ = self.seed_probe_failure()
                batch.append(journal, dict(record, event=extra, sample=sample, at=time.time()))
                before = journal.read_bytes()
                with self.assertRaisesRegex(RuntimeError, 'BATCH_PROBE_RECONCILIATION_DENIED'):
                    self.reconcile()
                self.assertEqual(journal.read_bytes(), before)

    def test_probe_reconciliation_does_not_append_to_unterminated_journal_line(self):
        journal, _, _, _ = self.seed_probe_failure()
        journal.write_bytes(journal.read_bytes().rstrip(b'\n'))
        before = journal.read_bytes()
        with self.assertRaisesRegex(RuntimeError, 'BATCH_RECONCILIATION_REQUIRED'):
            self.reconcile()
        self.assertEqual(journal.read_bytes(), before)

    def test_probe_reconciliation_refuses_other_mode_pending_and_unknown_write_intents(self):
        journal, record, _, _ = self.seed_probe_failure()
        other = self.root / 'private/http-batch-dry-run.jsonl'
        batch.append(other, dict(record, event='order_started', orderId=2, batchAttemptId='c' * 32))
        before = journal.read_bytes()
        with self.assertRaisesRegex(RuntimeError, 'BATCH_RECONCILIATION_REQUIRED'):
            self.reconcile()
        self.assertEqual(journal.read_bytes(), before)
        other.unlink()
        for prefix in ('http-apply-intent-', 'browser-receipt-bind-intent-'):
            for order_id, state in ((1, 'APPLIED'), (1, 'ROLLED_BACK'), (2, 'APPLY_STARTED')):
                with self.subTest(prefix=prefix, order_id=order_id, state=state):
                    intent = self.save(prefix + str(order_id) + '.json', {'orderId': order_id, 'state': state})
                    with self.assertRaisesRegex(RuntimeError, 'BATCH_RECONCILIATION_REQUIRED'):
                        self.reconcile()
                    self.assertEqual(journal.read_bytes(), before)
                    intent.unlink()

    def test_probe_reconciliation_checks_scope_stop_cleanup_and_shared_locks(self):
        journal, _, _, _ = self.seed_probe_failure()
        before = journal.read_bytes()
        for name in ('http-batch.lock', 'http-sample.lock', 'http-apply.lock'):
            with open(str(self.root / 'private' / name), 'a') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                with self.assertRaisesRegex(RuntimeError, 'BATCH_RECONCILIATION_BUSY'):
                    self.reconcile()
        for name in ('STOP', 'http-cleanup-blocked.json'):
            blocker = self.save(name, {})
            with self.assertRaises(RuntimeError):
                self.reconcile()
            blocker.unlink()
        self.save('plan.json', dict(self.plan, scope='all-picked-up'))
        with self.assertRaisesRegex(RuntimeError, 'BACKFILL_SCOPE_INVALID'):
            self.reconcile()
        self.assertEqual(journal.read_bytes(), before)

    def test_probe_reconciliation_cannot_be_repeated_or_reuse_cancelled_uuid(self):
        journal, record, _, _ = self.seed_probe_failure()
        self.reconcile()
        before = journal.read_bytes()
        with self.assertRaisesRegex(RuntimeError, 'BATCH_PROBE_RECONCILIATION_DENIED'):
            self.reconcile()
        self.assertEqual(journal.read_bytes(), before)
        batch.append(journal, dict(record, event='order_started', at=time.time()))
        with self.assertRaisesRegex(RuntimeError, 'BATCH_RECONCILIATION_REQUIRED'):
            self.execute()
        self.assertEqual(self.calls, [])

    def test_replayed_reconciliation_rechecks_exact_audit_bytes_and_event_binding(self):
        for change in ('audit-bytes', 'hash', 'sample', 'batch', 'resolution'):
            with self.subTest(change=change):
                journal, _, sample, audit = self.seed_probe_failure()
                self.reconcile()
                if change == 'audit-bytes':
                    audit.write_text(json.dumps(sample, indent=2))
                else:
                    rows = [json.loads(line) for line in journal.read_text().splitlines()]
                    field, value = {'hash': ('auditSha256', 'c' * 64), 'sample': ('sampleAttemptId', 'c' * 32),
                                    'batch': ('batchAttemptId', 'c' * 32),
                                    'resolution': ('resolution', 'COMMITTED')}[change]
                    rows[-1][field] = value
                    journal.write_text(''.join(json.dumps(row) + '\n' for row in rows))
                with self.assertRaises(RuntimeError):
                    self.execute()
                self.assertEqual(self.calls, [])

    def test_reconciliation_cli_requires_explicit_selection_and_never_executes_batch(self):
        self.seed_probe_failure()
        arguments = ['batch', '--root', str(self.root), '--reconcile-probe-failure', '--journal', 'apply',
                     '--order-id', '1', '--batch-attempt-id', 'a' * 32, '--sample-attempt-id', 'b' * 32]
        for extra in ('--apply', '--ids=1', '--limit=2', '--proxy-index=1'):
            with patch.object(sys, 'argv', arguments + [extra]), self.assertRaisesRegex(
                    RuntimeError, 'BATCH_RECONCILIATION_ARGUMENT_INVALID'):
                batch.main()
        output = io.StringIO()
        with patch.object(sys, 'argv', arguments), patch.object(batch, 'execute') as execute, \
                contextlib.redirect_stdout(output):
            batch.main()
        execute.assert_not_called()
        self.assertEqual(json.loads(output.getvalue())['outcome'], 'BATCH_PROBE_FAILURE_RECONCILED')


if __name__ == '__main__':
    unittest.main()
