"""隔离已确认只读失败：全为临时文件和子进程替身，不操作生产。"""
import contextlib
import fcntl
import hashlib
import importlib.util
import io
import json
import pathlib
import subprocess
import sys
import time
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('batch_fixture', pathlib.Path(__file__).with_name('officialOrderHttpBatch_test.py'))
fixture = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(fixture)
batch = fixture.batch
import httpFailureQuarantine as quarantine


class QuarantineTests(unittest.TestCase):
    def setUp(self):
        self.case = fixture.BatchTests('test_default_preview_never_passes_apply')
        self.case.setUp()
        self.addCleanup(self.case.doCleanups)
        self.root = self.case.root
        self.now = time.time()
        self.attempt = 'b' * 32
        self.batch_id = 'a' * 32
        self.plan_sha = hashlib.sha256((self.root / 'private/plan.json').read_bytes()).hexdigest()
        self.sample = {'outcome': 'EGRESS_CHANGED_OR_UNVERIFIED', 'originalOutcome': 'HTTP_541',
            'egressAfterError': 'RUNTIME_COMMAND_FAILED', 'runId': 959, 'requests': 3,
            'attemptId': self.attempt, 'targetOrderId': 1, 'proxyIndex': 0,
            'startedAt': self.now - 10, 'finishedAt': self.now - 5, 'elapsedSeconds': 5.0,
            'egressHash': 'c' * 64, 'egressAfterHash': None, 'egressVerifiedAfter': False,
            'businessWrites': 0, 'cleanup': {'attempted': True, 'removed': True, 'outcome': 'REMOVED'},
            'containerName': 'apple-official-http-sample-' + self.attempt}
        self.original_sample = dict(self.sample)
        self.audit = self.case.save('http-sample-1-' + self.attempt + '.json', self.sample)
        self.audit_sha = hashlib.sha256(self.audit.read_bytes()).hexdigest()
        self.proof_name = 'http-failure-proof-1-' + self.attempt + '.json'
        self.proof = {'planSha256': self.plan_sha, 'orderId': 1, 'runId': 959, 'batchAttemptId': self.batch_id,
                      'sampleAttemptId': self.attempt, 'sampleAuditSha256': self.audit_sha}
        self.proof_path = self.case.save(self.proof_name, self.proof)
        self.proof_sha = hashlib.sha256(self.proof_path.read_bytes()).hexdigest()
        self.case.save('http-rejected-egress.json', ['c' * 64])
        self.journal = self.root / 'private/http-batch-apply.jsonl'
        self.record = {'orderId': 1, 'batchAttemptId': self.batch_id, 'planSha256': self.plan_sha}
        batch.append(self.journal, dict(self.record, event='order_started', at=self.now - 11))
        batch.append(self.journal, dict(self.record, event='sample_finished', at=self.now - 4, sample=self.sample))
        self.evidence = dict(self.proof, outcome='HTTP_FAILURE_QUARANTINE_VERIFIED',
                            proofSha256=self.proof_sha, egressHash='c' * 64, proxyHash='d' * 64,
                            files={'private/plan.json': self.plan_sha})
        node_patch = patch.object(quarantine, 'verify_node', return_value=self.evidence)
        self.node = node_patch.start()
        self.addCleanup(node_patch.stop)
        docker_patch = patch.object(quarantine.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, b'other-container\n', b''))
        self.docker = docker_patch.start()
        self.addCleanup(docker_patch.stop)

    def execute(self):
        return batch.quarantine_failed_read(self.root, self.journal.name, 1, self.batch_id,
                                           self.attempt, self.proof_name, self.proof_sha)

    def replace_sample(self, change):
        self.sample.update(change)
        self.audit.write_text(json.dumps(self.sample), encoding='utf-8')
        rows = [json.loads(line) for line in self.journal.read_text().splitlines()]
        rows[1]['sample'] = self.sample
        self.journal.write_text(''.join(json.dumps(row) + '\n' for row in rows), encoding='utf-8')

    def add_preceding_failures(self, count=1):
        rows = [dict(self.record, event='order_started', at=self.now - 20 * count - 11)]
        self.preceding = []
        for index in range(count):
            started = self.now - 20 * (count - index) - 10
            sample = {key: value for key, value in self.sample.items() if key in batch.KNOWN_541_KEYS}
            attempt = ('d', 'e', 'f')[index] * 32
            egress = ('d', 'e', 'f')[index] * 64
            sample.update(outcome='HTTP_541', runId=959 - count + index, requests=1,
                          attemptId=attempt, startedAt=started, finishedAt=started + 5,
                          elapsedSeconds=5.0, egressHash=egress, egressAfterHash=egress,
                          egressVerifiedAfter=True, containerName='apple-official-http-sample-' + attempt)
            self.preceding.append(sample)
            self.case.save('http-sample-1-' + attempt + '.json', sample)
            rows.append(dict(self.record, event='sample_finished', at=started + 6, sample=sample))
        rows.append(dict(self.record, event='sample_finished', at=self.now - 4, sample=self.sample))
        self.journal.write_text(''.join(json.dumps(row) + '\n' for row in rows), encoding='utf-8')
        self.case.save('http-rejected-egress.json', ['c' * 64] + [row['egressHash'] for row in self.preceding])
        self.case.save(self.audit.name, self.sample)

    def replace_preceding(self, change, index=0):
        sample = self.preceding[index]
        sample.update(change)
        rows = [json.loads(line) for line in self.journal.read_text().splitlines()]
        rows[index + 1]['sample'] = sample
        self.journal.write_text(''.join(json.dumps(row) + '\n' for row in rows), encoding='utf-8')
        return self.case.save('http-sample-1-' + sample['attemptId'] + '.json', sample)

    def changed_egress_fixture(self):
        """四 GET 的精确新形状；Node 替身只替代密文/研究证明核验，不替代宿主文件边界。"""
        self.sample = dict(self.original_sample)
        del self.sample['egressAfterError']
        self.sample.update(originalOutcome='PROXY_CONNECTION_FAILED', requests=4, egressAfterHash='f' * 64)
        self.add_preceding_failures()
        self.refresh_changed_proof()
        self.case.save('http-rejected-egress.json', ['c' * 64, 'd' * 64, 'f' * 64])

    def refresh_changed_proof(self):
        self.audit = self.case.save(self.audit.name, self.sample)
        self.audit_sha = hashlib.sha256(self.audit.read_bytes()).hexdigest()
        self.proof['sampleAuditSha256'] = self.audit_sha
        self.proof_path = self.case.save(self.proof_name, self.proof)
        self.proof_sha = hashlib.sha256(self.proof_path.read_bytes()).hexdigest()
        self.evidence.update(sampleAuditSha256=self.audit_sha, proofSha256=self.proof_sha,
                             egressAfterHash=self.sample.get('egressAfterHash'))
        rows = [json.loads(line) for line in self.journal.read_text().splitlines()]
        rows[-1]['sample'] = self.sample
        self.journal.write_text(''.join(json.dumps(row) + '\n' for row in rows), encoding='utf-8')

    def complete_unverified_fixture(self):
        del self.sample['requests']
        self.sample.update(originalOutcome='SUCCEEDED', orderId=1,
                           receiptOutcome='RECEIPT_NOT_REQUESTED',
                           resultFile='/research/private/results/order-1-run-959.json')
        (self.root / 'private/results').mkdir(exist_ok=True)
        self.case.save('results/order-1-run-959.json', {'untrusted': True})
        self.refresh_changed_proof()

    def test_third_get_connection_failure_and_unknown_exit_are_bound_to_original_run(self):
        self.sample['originalOutcome'] = 'PROXY_CONNECTION_FAILED'
        self.refresh_changed_proof()
        result = self.execute()
        self.assertFalse(result['targetCompleted'])
        self.assertFalse(result['egressVerifiedAfter'])
        self.assertEqual(result['businessWrites'], 0)

    def test_completed_read_with_unverified_exit_is_only_quarantined(self):
        self.complete_unverified_fixture()
        result = self.execute()
        self.assertEqual(result['outcome'], 'BATCH_FAILURE_QUARANTINED')
        self.assertFalse(result['targetCompleted'])
        self.assertFalse(result['egressVerifiedAfter'])
        self.assertEqual(result['businessWrites'], 0)
        self.assertTrue((self.root / 'private/results/order-1-run-959.json').exists())

    def test_closed_history_accepts_later_result_without_reopening_old_attempt(self):
        self.complete_unverified_fixture()
        self.execute()
        self.case.save('results/order-1-run-1000.json', {'later': True})
        closed = set()
        self.assertEqual(batch.journal_state(self.journal, self.plan_sha, {1, 2}, quarantined=closed), set())
        self.assertEqual(closed, {1})
        self.assertTrue(self.node.call_args[1]['replay_closed'])
        with self.assertRaises(RuntimeError):
            self.execute()

    def test_history_new_unknown_write_still_globally_blocks_execution(self):
        self.complete_unverified_fixture()
        self.execute()
        self.case.save('results/order-1-run-1000.json', {'later': True})
        self.case.save('http-apply-intent-1.json', {'state': 'APPLY_STARTED'})
        with self.assertRaises(RuntimeError):
            batch.execute(self.root, [], 1, apply=True)
        self.assertEqual(self.case.calls, [])

    def test_preceding_541_history_accepts_new_result_but_preserves_exit_rejection(self):
        self.add_preceding_failures()
        self.execute()
        (self.root / 'private/results').mkdir()
        self.case.save('results/order-1-run-1000.json', {'later': True})
        self.assertEqual(batch.journal_state(self.journal, self.plan_sha, {1, 2}), set())
        self.case.save('http-rejected-egress.json', ['c' * 64])
        with self.assertRaises(RuntimeError):
            batch.journal_state(self.journal, self.plan_sha, {1, 2})

    def test_completed_read_cannot_hide_a_second_result(self):
        self.complete_unverified_fixture()
        self.case.save('results/order-1-run-958.json', {})
        with self.assertRaises(RuntimeError):
            self.execute()

    def test_completed_read_cannot_hide_an_apply_intent(self):
        self.complete_unverified_fixture()
        self.case.save('http-apply-intent-1.json', {'state': 'APPLY_STARTED'})
        with self.assertRaises(RuntimeError):
            self.execute()

    def test_quarantine_one_of_two_pending_orders_preserves_the_other(self):
        other = {'orderId': 2, 'batchAttemptId': '9' * 32, 'planSha256': self.plan_sha,
                 'event': 'order_started', 'at': self.now - 2}
        batch.append(self.journal, other)
        result = self.execute()
        self.assertFalse(result['targetCompleted'])
        remaining = {}
        batch.journal_state(self.journal, self.plan_sha, {1, 2, 3}, pending_by_order=remaining)
        self.assertEqual(set(remaining), {2})
        with self.assertRaises(RuntimeError):
            batch.journal_state(self.journal, self.plan_sha, {1, 2, 3})

    def test_completed_read_changed_egress(self):
        self.complete_unverified_fixture()
        del self.sample['egressAfterError']
        self.sample['egressAfterHash'] = 'f' * 64
        self.case.save('http-rejected-egress.json', ['c' * 64, 'f' * 64])
        self.refresh_changed_proof()
        self.assertFalse(self.execute()['egressVerifiedAfter'])

    def test_four_get_unknown_egress(self):
        self.sample.update(originalOutcome='PROXY_CONNECTION_FAILED', requests=4)
        self.refresh_changed_proof()
        self.assertFalse(self.execute()['egressVerifiedAfter'])

    def test_three_get_failure_preserves_verified_egress_without_business_success(self):
        del self.sample['originalOutcome']
        del self.sample['egressAfterError']
        self.sample.update(outcome='PROXY_CONNECTION_FAILED', egressAfterHash='c' * 64, egressVerifiedAfter=True)
        self.refresh_changed_proof()
        result = self.execute()
        self.assertTrue(result['egressVerifiedAfter'])
        self.assertFalse(result['targetCompleted'])
        event = json.loads(self.journal.read_text().splitlines()[-1])
        self.assertEqual(event['resolution'], 'FAILED_WITHOUT_APPLY_VERIFIED_EGRESS')

    def test_four_get_connection_failure_seals_changed_exit_and_replays_both_batches(self):
        import runBrowserBatch as browser_batch
        self.changed_egress_fixture()
        before = self.journal.read_bytes()
        result = self.execute()
        self.assertEqual(result['outcome'], 'BATCH_FAILURE_QUARANTINED')
        self.assertIs(result['targetCompleted'], False)
        self.assertIs(result['egressVerifiedAfter'], False)
        self.assertEqual(result['businessWrites'], 0)
        self.assertTrue(self.journal.read_bytes().startswith(before))
        event = json.loads(self.journal.read_text().splitlines()[-1])
        self.assertEqual(event['verification']['egressAfterHash'], 'f' * 64)
        self.assertEqual(len(event['precedingFailures']), 1)
        quarantined = set()
        self.assertEqual(batch.journal_state(self.journal, self.plan_sha, {1, 2}, quarantined=quarantined), set())
        self.assertEqual(quarantined, {1})
        with patch.object(browser_batch, 'child') as child:
            for applying in (False, True):
                with self.assertRaisesRegex(RuntimeError, 'BATCH_TARGET_QUARANTINED'):
                    batch.execute(self.root, [1], 1, apply=applying)
                with self.assertRaisesRegex(RuntimeError, 'BATCH_TARGET_QUARANTINED'):
                    browser_batch.execute(self.root, [1], apply=applying)
            child.assert_not_called()
        self.assertEqual(self.case.calls, [])

    def redirect_limit_fixture(self):
        self.sample = dict(self.original_sample, originalOutcome='REDIRECT_LIMIT', requests=9)
        self.refresh_changed_proof()
        self.evidence.pop('egressAfterHash', None)

    def test_redirect_limit_seals_failure_without_completion_and_blocks_both_modes(self):
        self.redirect_limit_fixture()
        before = self.journal.read_bytes()
        result = self.execute()
        self.assertEqual(result['outcome'], 'BATCH_FAILURE_QUARANTINED')
        self.assertIs(result['targetCompleted'], False)
        self.assertIs(result['egressVerifiedAfter'], False)
        self.assertEqual(result['businessWrites'], 0)
        self.assertTrue(self.journal.read_bytes().startswith(before))
        self.assertEqual(len(json.loads(self.journal.read_text().splitlines()[-1])['precedingFailures']), 0)
        quarantined = set()
        self.assertEqual(batch.journal_state(self.journal, self.plan_sha, {1, 2}, quarantined=quarantined), set())
        self.assertEqual(quarantined, {1})
        for applying in (False, True):
            with self.assertRaisesRegex(RuntimeError, 'BATCH_TARGET_QUARANTINED'):
                batch.execute(self.root, [1], 1, apply=applying)
        self.assertEqual(self.case.calls, [])

    def test_redirect_limit_cannot_borrow_other_request_or_exit_shapes(self):
        changes = [{'originalOutcome': 'HTTP_541'}, {'originalOutcome': 'HTTP_TIMEOUT'},
                   {'originalOutcome': 'PROXY_CONNECTION_FAILED'}, {'originalOutcome': 'SUCCEEDED'},
                   {'requests': 3}, {'requests': 4}, {'requests': 8}, {'requests': 10},
                   {'requests': 9.0}, {'requests': True}, {'egressAfterHash': 'f' * 64},
                   {'egressAfterError': 'HTTP_TIMEOUT'}, {'egressVerifiedAfter': True},
                   {'businessWrites': False}, {'businessWrites': 0.0}, {'runId': True},
                   {'targetOrderId': True}, {'orderId': 1}, {'resultFile': 'synthetic.json'},
                   {'cleanup': {'attempted': True, 'removed': False, 'outcome': 'REMOVED'}}]
        for change in changes:
            with self.subTest(change=change):
                self.redirect_limit_fixture()
                self.sample.update(change)
                self.refresh_changed_proof()
                before = self.journal.read_bytes()
                with self.assertRaisesRegex(RuntimeError, 'BATCH_FAILURE_QUARANTINE_DENIED'):
                    self.execute()
                self.assertEqual(self.journal.read_bytes(), before)
        self.node.assert_not_called()
        self.assertEqual(self.case.calls, [])

    def test_redirect_limit_still_requires_original_audit_node_and_replay_chain(self):
        self.redirect_limit_fixture()
        self.node.side_effect = RuntimeError('encrypted chain invalid')
        before = self.journal.read_bytes()
        with self.assertRaisesRegex(RuntimeError, 'BATCH_FAILURE_QUARANTINE_DENIED'):
            self.execute()
        self.assertEqual(self.journal.read_bytes(), before)
        self.node.side_effect = None
        self.execute()
        self.audit.write_text(json.dumps(self.sample, indent=2), encoding='utf-8')
        with self.assertRaises(RuntimeError):
            batch.journal_state(self.journal, self.plan_sha, {1, 2})
        self.assertEqual(self.case.calls, [])

    def test_redirect_limit_preserves_rejection_success_artifact_and_unknown_protections(self):
        self.redirect_limit_fixture()
        before = self.journal.read_bytes()
        for name, value in (('http-rejected-egress.json', []),
                            ('http-receipt-1-run-959.json', {}),
                            ('http-apply-intent-1.json', {'state': 'APPLIED'}),
                            ('browser-receipt-bind-intent-999.json', {'state': 'UNKNOWN'})):
            path = self.case.save(name, value)
            with self.assertRaises(RuntimeError): self.execute()
            self.assertEqual(self.journal.read_bytes(), before)
            if name == 'http-rejected-egress.json':
                self.case.save(name, ['c' * 64])
            else:
                path.unlink()
        self.node.assert_not_called()
        self.assertEqual(self.case.calls, [])

    def test_redirect_limit_does_not_expand_old_three_or_four_get_outcomes(self):
        for count in (3, 4):
            self.redirect_limit_fixture()
            self.sample['requests'] = count
            self.refresh_changed_proof()
            with self.assertRaises(RuntimeError): self.execute()
        self.node.assert_not_called()

    def test_four_get_connection_failure_has_exact_keys_types_and_distinct_actual_hash(self):
        changes = [{'originalOutcome': 'HTTP_TIMEOUT'}, {'originalOutcome': 'HTTP_541'},
                   {'originalOutcome': 'SUCCEEDED'}, {'outcome': 'PROXY_CONNECTION_FAILED'},
                   {'requests': 3}, {'requests': 5}, {'requests': 4.0}, {'requests': True},
                   {'egressAfterError': None}, {'egressAfterError': 'RUNTIME_COMMAND_FAILED'},
                   {'egressAfterHash': None}, {'egressAfterHash': True}, {'egressAfterHash': 'c' * 64},
                   {'egressAfterHash': 'F' * 64}, {'egressAfterHash': 'unknown'},
                   {'egressVerifiedAfter': True}, {'egressVerifiedAfter': 0},
                   {'businessWrites': False}, {'businessWrites': 0.0}, {'businessWrites': 1},
                   {'runId': True}, {'targetOrderId': True}, {'targetOrderId': 2},
                   {'proxyIndex': False}, {'proxyIndex': -1}, {'elapsedSeconds': True},
                   {'cleanup': {'attempted': True, 'removed': False, 'outcome': 'REMOVED'}},
                   {'resultFile': '/research/private/results/order-1-run-959.json'}]
        for change in changes:
            with self.subTest(change=change):
                self.changed_egress_fixture()
                self.sample.update(change)
                self.refresh_changed_proof()
                before = self.journal.read_bytes()
                with self.assertRaises(RuntimeError): self.execute()
                self.assertEqual(self.journal.read_bytes(), before)
        self.node.assert_not_called()
        self.assertEqual(self.case.calls, [])

    def test_changed_egress_requires_both_rejections_before_node_and_on_replay(self):
        self.changed_egress_fixture()
        for rejected in (['c' * 64, 'd' * 64], ['f' * 64, 'd' * 64]):
            self.case.save('http-rejected-egress.json', rejected)
            before = self.journal.read_bytes()
            with self.assertRaises(RuntimeError): self.execute()
            self.assertEqual(self.journal.read_bytes(), before)
        self.node.assert_not_called()
        self.case.save('http-rejected-egress.json', ['c' * 64, 'd' * 64, 'f' * 64])
        self.execute()
        self.case.save('http-rejected-egress.json', ['c' * 64, 'd' * 64])
        for applying in (False, True):
            with self.assertRaises(RuntimeError): batch.execute(self.root, [], 1, apply=applying)
        self.assertEqual(self.case.calls, [])

    def test_changed_egress_node_must_bind_exact_actual_after_hash(self):
        for after in ('missing', None, 'c' * 64, 'e' * 64, True):
            with self.subTest(after=after):
                self.changed_egress_fixture()
                if after == 'missing': self.evidence.pop('egressAfterHash')
                else: self.evidence['egressAfterHash'] = after
                before = self.journal.read_bytes()
                with self.assertRaisesRegex(RuntimeError, 'BATCH_FAILURE_QUARANTINE_DENIED'): self.execute()
                self.assertEqual(self.journal.read_bytes(), before)
        self.assertEqual(self.node.call_count, 5)

    def test_changed_egress_node_failure_or_evidence_tamper_still_blocks(self):
        self.changed_egress_fixture()
        before = self.journal.read_bytes()
        self.node.side_effect = ValueError('encrypted chain rejected')
        with self.assertRaisesRegex(RuntimeError, 'BATCH_FAILURE_QUARANTINE_DENIED'): self.execute()
        self.assertEqual(self.journal.read_bytes(), before)
        self.node.side_effect = None
        self.execute()
        rows = [json.loads(line) for line in self.journal.read_text().splitlines()]
        rows[-1]['verification']['egressAfterHash'] = 'e' * 64
        self.journal.write_text(''.join(json.dumps(row) + '\n' for row in rows), encoding='utf-8')
        with self.assertRaises(RuntimeError): batch.journal_state(self.journal, self.plan_sha, {1, 2})
        self.assertEqual(self.case.calls, [])

    def test_changed_egress_does_not_accept_success_artifact_or_unknown_intent(self):
        self.changed_egress_fixture()
        for name, value in (('http-receipt-1-run-959.json', {}),
                            ('browser-receipt-bind-intent-2.json', {'orderId': 2, 'state': 'UNKNOWN'}),
                            ('http-apply-intent-1.json', {'orderId': 1, 'state': 'APPLIED'})):
            path = self.case.save(name, value)
            before = self.journal.read_bytes()
            with self.assertRaises(RuntimeError): self.execute()
            self.assertEqual(self.journal.read_bytes(), before)
            path.unlink()
        self.node.assert_not_called()

    def test_old_unknown_exit_shape_cannot_borrow_new_terminal_or_request_count(self):
        original = dict(self.sample)
        for change in ({'originalOutcome': 'HTTP_TRANSPORT_FAILED'}, {'requests': 4}):
            self.sample = dict(original)
            self.replace_sample(change)
            # 更新 proof 排除仅因旧 SHA 不符而被拒的假阳性。
            self.audit_sha = hashlib.sha256(self.audit.read_bytes()).hexdigest()
            self.proof['sampleAuditSha256'] = self.audit_sha
            self.proof_path = self.case.save(self.proof_name, self.proof)
            self.proof_sha = hashlib.sha256(self.proof_path.read_bytes()).hexdigest()
            self.evidence.update(sampleAuditSha256=self.audit_sha, proofSha256=self.proof_sha)
            with self.assertRaisesRegex(RuntimeError, 'BATCH_FAILURE_QUARANTINE_DENIED'): self.execute()
        self.node.assert_not_called()

    def test_one_or_two_preceding_541_are_sealed_in_order_and_replayed(self):
        for count in (1, 2):
            with self.subTest(count=count):
                self.add_preceding_failures(count)
                before = self.journal.read_bytes()
                self.assertEqual(self.execute()['outcome'], 'BATCH_FAILURE_QUARANTINED')
                self.assertTrue(self.journal.read_bytes().startswith(before))
                event = json.loads(self.journal.read_text().splitlines()[-1])
                expected = []
                for sample in self.preceding:
                    name = 'http-sample-1-' + sample['attemptId'] + '.json'
                    expected.append({'auditFile': name, 'auditSha256': hashlib.sha256(
                        (self.root / 'private' / name).read_bytes()).hexdigest(),
                        'runId': sample['runId'], 'sampleAttemptId': sample['attemptId']})
                self.assertEqual(event['precedingFailures'], expected)
                quarantined = set()
                self.assertEqual(batch.journal_state(self.journal, self.plan_sha, {1, 2},
                                                    quarantined=quarantined), set())
                self.assertEqual(quarantined, {1})
                for applying in (False, True):
                    with self.assertRaisesRegex(RuntimeError, 'BATCH_TARGET_QUARANTINED'):
                        batch.execute(self.root, [1], 1, apply=applying)
        self.assertEqual(self.case.calls, [])

    def test_legacy_single_sample_event_without_preceding_list_still_replays(self):
        self.execute()
        rows = [json.loads(line) for line in self.journal.read_text().splitlines()]
        del rows[-1]['precedingFailures']
        self.journal.write_text(''.join(json.dumps(row) + '\n' for row in rows), encoding='utf-8')
        quarantined = set()
        self.assertEqual(batch.journal_state(self.journal, self.plan_sha, {1, 2}, quarantined=quarantined), set())
        self.assertEqual(quarantined, {1})

    def test_preceding_541_does_not_skip_final_encrypted_evidence_or_fresh_proof(self):
        self.add_preceding_failures()
        self.node.side_effect = RuntimeError('HTTP_FAILURE_QUARANTINE_DENIED')
        before = self.journal.read_bytes()
        with self.assertRaises(RuntimeError): self.execute()
        self.assertEqual(self.journal.read_bytes(), before)
        self.assertEqual(self.node.call_count, 1)
        self.assertEqual(self.case.calls, [])

    def test_preceding_sample_keys_types_identity_egress_and_cleanup_are_exact(self):
        changes = [{'outcome': 'SUCCEEDED'}, {'outcome': 'HTTP_TIMEOUT'}, {'outcome': 'ACCOUNT_COOLDOWN'},
                   {'businessWrites': False}, {'businessWrites': 0.0}, {'businessWrites': 1},
                   {'requests': True}, {'requests': 0}, {'requests': 41}, {'requests': 1.0},
                   {'runId': True}, {'targetOrderId': True}, {'targetOrderId': 2},
                   {'proxyIndex': False}, {'proxyIndex': -1}, {'proxyIndex': 0.0},
                   {'attemptId': 'unknown'}, {'egressHash': 'unknown'},
                   {'egressAfterHash': 'f' * 64}, {'egressVerifiedAfter': 1},
                   {'cleanup': {'attempted': 1, 'removed': True, 'outcome': 'REMOVED'}},
                   {'cleanup': {'attempted': True, 'removed': False, 'outcome': 'REMOVED'}},
                   {'containerName': 'other'}, {'elapsedSeconds': True}, {'elapsedSeconds': 6},
                   {'orderId': 1}, {'resultFile': '/research/private/results/order-1-run-958.json'},
                   {'originalOutcome': 'HTTP_541'}]
        for change in changes:
            with self.subTest(change=change):
                self.add_preceding_failures()
                self.replace_preceding(change)
                before = self.journal.read_bytes()
                with self.assertRaisesRegex(RuntimeError, 'BATCH_(FAILURE_QUARANTINE_DENIED|RECONCILIATION_REQUIRED)'):
                    self.execute()
                self.assertEqual(self.journal.read_bytes(), before)
        self.node.assert_not_called()

    def test_preceding_and_final_runs_and_attempts_must_be_unique(self):
        for target, change in ((0, {'runId': 959}), (0, {'attemptId': self.attempt}),
                               (1, {'runId': 957}), (1, {'attemptId': 'd' * 32})):
            with self.subTest(target=target, change=change):
                self.add_preceding_failures(2)
                self.replace_preceding(change, target)
                with self.assertRaises(RuntimeError): self.execute()
        self.node.assert_not_called()

    def test_preceding_times_must_fit_strict_sequential_journal_window(self):
        changes = [{'startedAt': True}, {'finishedAt': float('nan')},
                   {'startedAt': self.now - 32}, {'finishedAt': self.now - 8},
                   {'startedAt': self.now - 25, 'finishedAt': self.now - 30}]
        for change in changes:
            with self.subTest(change=change):
                self.add_preceding_failures()
                self.replace_preceding(change)
                with self.assertRaises(RuntimeError): self.execute()
        for at in (True, self.now - 26, self.now - 9):
            with self.subTest(journalAt=at):
                self.add_preceding_failures()
                rows = [json.loads(line) for line in self.journal.read_text().splitlines()]
                rows[1]['at'] = at
                self.journal.write_text(''.join(json.dumps(row) + '\n' for row in rows), encoding='utf-8')
                with self.assertRaises(RuntimeError): self.execute()
        self.node.assert_not_called()

    def test_more_than_three_total_runs_are_denied_without_verification_or_append(self):
        self.add_preceding_failures(3)
        before = self.journal.read_bytes()
        with self.assertRaisesRegex(RuntimeError, 'BATCH_FAILURE_QUARANTINE_DENIED'): self.execute()
        self.assertEqual(self.journal.read_bytes(), before)
        self.node.assert_not_called()

    def test_preceding_audit_must_be_private_regular_strict_and_equal_to_journal(self):
        for kind in ('missing', 'public', 'symlink', 'duplicate', 'different'):
            with self.subTest(kind=kind):
                self.add_preceding_failures()
                path = self.root / ('private/http-sample-1-' + 'd' * 32 + '.json')
                if kind == 'missing': path.unlink()
                elif kind == 'public': path.chmod(0o644)
                elif kind == 'symlink':
                    path.unlink(); path.symlink_to(self.audit)
                elif kind == 'duplicate': path.write_bytes(path.read_bytes()[:-1] + b',"requests":1}')
                else:
                    value = dict(self.preceding[0], requests=2)
                    path.write_text(json.dumps(value), encoding='utf-8')
                with self.assertRaises(RuntimeError): self.execute()
                if path.exists() or path.is_symlink(): path.unlink()
        self.node.assert_not_called()

    def test_preceding_live_container_rejected_exit_or_success_artifact_stops(self):
        self.add_preceding_failures()
        before = self.journal.read_bytes()
        self.docker.return_value = subprocess.CompletedProcess(
            [], 0, (self.preceding[0]['containerName'] + '\n').encode(), b'')
        with self.assertRaises(RuntimeError): self.execute()
        self.docker.return_value = subprocess.CompletedProcess([], 0, b'', b'')
        self.case.save('http-rejected-egress.json', ['c' * 64])
        with self.assertRaises(RuntimeError): self.execute()
        self.case.save('http-rejected-egress.json', ['c' * 64, 'd' * 64])
        (self.root / 'private/results').mkdir(exist_ok=True)
        self.case.save('results/order-1-run-958.json', {})
        with self.assertRaises(RuntimeError): self.execute()
        self.assertEqual(self.journal.read_bytes(), before)
        self.node.assert_not_called()

    def test_preceding_raw_audit_change_after_isolation_blocks_both_modes(self):
        self.add_preceding_failures()
        self.execute()
        path = self.root / ('private/http-sample-1-' + 'd' * 32 + '.json')
        path.write_text(json.dumps(self.preceding[0], indent=2), encoding='utf-8')
        for applying in (False, True):
            with self.subTest(applying=applying), self.assertRaises(RuntimeError):
                batch.execute(self.root, [], 1, apply=applying)
        self.assertEqual(self.case.calls, [])

    def test_preceding_manifest_cannot_be_missing_reordered_or_changed(self):
        self.add_preceding_failures(2)
        self.execute()
        raw = self.journal.read_text()
        for change in ('missing', 'empty', 'reverse', 'hash', 'run', 'attempt'):
            with self.subTest(change=change):
                rows = [json.loads(line) for line in raw.splitlines()]
                event = rows[-1]
                if change == 'missing': del event['precedingFailures']
                elif change == 'empty': event['precedingFailures'] = []
                elif change == 'reverse': event['precedingFailures'].reverse()
                else:
                    field = {'hash': 'auditSha256', 'run': 'runId', 'attempt': 'sampleAttemptId'}[change]
                    event['precedingFailures'][0][field] = 'f' * 64
                self.journal.write_text(''.join(json.dumps(row) + '\n' for row in rows), encoding='utf-8')
                with self.assertRaises(RuntimeError): batch.journal_state(self.journal, self.plan_sha, {1, 2})
        self.assertEqual(self.case.calls, [])

    def test_multi_sample_dry_run_quarantine_blocks_apply_too(self):
        self.add_preceding_failures()
        dry_journal = self.root / 'private/http-batch-dry-run.jsonl'
        self.journal.rename(dry_journal)
        self.journal = dry_journal
        self.assertEqual(self.execute()['outcome'], 'BATCH_FAILURE_QUARANTINED')
        for applying in (False, True):
            with self.subTest(applying=applying), self.assertRaisesRegex(RuntimeError, 'BATCH_TARGET_QUARANTINED'):
                batch.execute(self.root, [1], 1, apply=applying)

    def test_browser_batch_replays_multi_sample_isolation_and_never_starts_target(self):
        import runBrowserBatch as browser_batch
        self.add_preceding_failures(2)
        self.execute()
        with patch.object(browser_batch, 'child') as child:
            for applying in (False, True):
                with self.subTest(applying=applying), self.assertRaisesRegex(RuntimeError, 'BATCH_TARGET_QUARANTINED'):
                    browser_batch.execute(self.root, [1], apply=applying)
            child.assert_not_called()

    def test_multi_sample_replay_still_requires_exit_rejection_and_no_unknown_write(self):
        self.add_preceding_failures()
        self.execute()
        self.case.save('http-rejected-egress.json', ['c' * 64])
        with self.assertRaises(RuntimeError): batch.execute(self.root, [], 1, apply=True)
        self.case.save('http-rejected-egress.json', ['c' * 64, 'd' * 64])
        self.case.save('http-apply-intent-2.json', {'orderId': 2, 'state': 'UNKNOWN'})
        with self.assertRaises(RuntimeError): batch.execute(self.root, [], 1, apply=True)
        self.assertEqual(self.case.calls, [])

    def test_isolation_appends_preserves_unknown_egress_and_does_not_mark_finished(self):
        before = self.journal.read_bytes()
        result = self.execute()
        self.assertEqual(result['outcome'], 'BATCH_FAILURE_QUARANTINED')
        self.assertIs(result['targetCompleted'], False)
        self.assertIs(result['egressVerifiedAfter'], False)
        self.assertTrue(self.journal.read_bytes().startswith(before))
        quarantined = set()
        self.assertEqual(batch.journal_state(self.journal, self.plan_sha, {1, 2}, quarantined=quarantined), set())
        self.assertEqual(quarantined, {1})
        self.assertEqual(self.audit_sha, hashlib.sha256(self.audit.read_bytes()).hexdigest())
        self.assertEqual(self.case.calls, [])

    def test_default_batch_continues_other_orders_but_explicit_retry_is_denied_in_both_modes(self):
        self.execute()
        for applying in (False, True):
            with self.subTest(applying=applying), self.assertRaisesRegex(RuntimeError, 'BATCH_TARGET_QUARANTINED'):
                batch.execute(self.root, [1], 1, apply=applying)
        with patch.object(batch, 'child', side_effect=self.case.child), contextlib.redirect_stdout(io.StringIO()):
            value = batch.execute(self.root, [], 1, apply=True)
        self.assertEqual(value['processedThisRun'], 1)
        self.assertEqual(value['quarantinedOrderIds'], [1])
        self.assertEqual(self.case.calls[0][self.case.calls[0].index('--id') + 1], '2')

    def test_confirmed_timeout_is_quarantined_without_promoting_unknown_egress(self):
        self.replace_sample({'originalOutcome': 'HTTP_TIMEOUT'})
        self.audit_sha = hashlib.sha256(self.audit.read_bytes()).hexdigest()
        self.proof['sampleAuditSha256'] = self.audit_sha
        self.proof_path.write_text(json.dumps(self.proof), encoding='utf-8')
        self.proof_sha = hashlib.sha256(self.proof_path.read_bytes()).hexdigest()
        self.evidence.update(sampleAuditSha256=self.audit_sha, proofSha256=self.proof_sha)
        self.add_preceding_failures()
        result = self.execute()
        self.assertEqual(result['outcome'], 'BATCH_FAILURE_QUARANTINED')
        self.assertIs(result['targetCompleted'], False)
        self.assertIs(result['egressVerifiedAfter'], False)
        self.assertEqual(self.sample['originalOutcome'], 'HTTP_TIMEOUT')
        for applying in (False, True):
            with self.subTest(applying=applying), self.assertRaisesRegex(RuntimeError, 'BATCH_TARGET_QUARANTINED'):
                batch.execute(self.root, [1], 1, apply=applying)

    def test_success_unknown_fields_or_types_are_never_quarantinable(self):
        changes = [{'originalOutcome': 'SUCCEEDED'}, {'outcome': 'HTTP_541'}, {'runId': None},
                   {'businessWrites': False}, {'businessWrites': 0.0}, {'requests': True},
                   {'cleanup': {'attempted': True, 'removed': False, 'outcome': 'REMOVED'}},
                   {'egressVerifiedAfter': True}, {'egressAfterHash': 'd' * 64},
                   {'detailResultFile': '/research/private/results/order-1-run-959.json'}]
        original = dict(self.sample)
        for change in changes:
            with self.subTest(change=change):
                self.sample = dict(original)
                self.replace_sample(change)
                before = self.journal.read_bytes()
                with self.assertRaisesRegex(RuntimeError, 'BATCH_FAILURE_QUARANTINE_DENIED'):
                    self.execute()
                self.assertEqual(self.journal.read_bytes(), before)
        self.node.assert_not_called()

    def test_unknown_writes_other_pending_and_apply_failed_remain_global_blockers(self):
        for name, value in [('http-apply-intent-2.json', {'orderId': 2, 'state': 'APPLY_STARTED'}),
                            ('browser-receipt-bind-intent-2.json', {'orderId': 2, 'state': 'UNKNOWN'}),
                            ('http-apply-intent-1.json', {'orderId': 1, 'state': 'APPLIED'})]:
            target = self.case.save(name, value)
            with self.subTest(name=name), self.assertRaises(RuntimeError): self.execute()
            target.unlink()
        other = self.root / 'private/http-batch-dry-run.jsonl'
        batch.append(other, dict(self.record, event='order_started', orderId=2, batchAttemptId='d' * 32))
        with self.assertRaises(RuntimeError): self.execute()
        other.unlink()
        batch.append(self.journal, dict(self.record, event='apply_failed', at=time.time()))
        with self.assertRaises(RuntimeError): self.execute()
        self.node.assert_not_called()

    def test_original_proof_and_audit_bytes_are_immutable_on_replay(self):
        self.execute()
        self.proof_path.write_text(json.dumps(self.proof, indent=2), encoding='utf-8')
        with self.assertRaises(RuntimeError): batch.journal_state(self.journal, self.plan_sha, {1, 2})
        self.assertEqual(self.case.calls, [])

    def test_replayed_event_cannot_change_verified_manifest(self):
        self.execute()
        rows = [json.loads(line) for line in self.journal.read_text().splitlines()]
        rows[-1]['verification']['files']['private/plan.json'] = 'f' * 64
        self.journal.write_text(''.join(json.dumps(row) + '\n' for row in rows), encoding='utf-8')
        with self.assertRaises(RuntimeError): batch.journal_state(self.journal, self.plan_sha, {1, 2})

    def test_live_container_or_docker_failure_is_not_proof_of_absence(self):
        for code, output in ((0, (self.sample['containerName'] + '\n').encode()), (1, b'')):
            self.docker.return_value = subprocess.CompletedProcess([], code, output, b'private error')
            with self.subTest(code=code), self.assertRaises(RuntimeError): self.execute()
        self.node.assert_not_called()

    def test_result_artifacts_or_removed_egress_rejection_block_isolation(self):
        target = self.case.save('http-receipt-1-run-959.json', {})
        with self.assertRaises(RuntimeError): self.execute()
        target.unlink()
        self.case.save('http-rejected-egress.json', [])
        with self.assertRaises(RuntimeError): self.execute()
        self.node.assert_not_called()

    def test_all_three_locks_stop_and_cleanup_are_checked(self):
        for name in ('http-batch.lock', 'http-sample.lock', 'http-apply.lock'):
            with open(str(self.root / 'private' / name), 'a') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                with self.assertRaisesRegex(RuntimeError, 'BATCH_RECONCILIATION_BUSY'): self.execute()
        for name in ('STOP', 'http-cleanup-blocked.json'):
            target = self.case.save(name, {})
            with self.assertRaises(RuntimeError): self.execute()
            target.unlink()
        self.node.assert_not_called()

    def test_cancelled_target_new_uuid_and_repeated_quarantine_are_denied(self):
        self.execute()
        with self.assertRaises(RuntimeError): self.execute()
        batch.append(self.journal, dict(self.record, event='order_started', batchAttemptId='f' * 32, at=time.time()))
        with self.assertRaises(RuntimeError): batch.journal_state(self.journal, self.plan_sha, {1, 2})

    def test_private_proof_duplicate_keys_symlink_and_public_mode_are_rejected(self):
        raw = self.proof_path.read_bytes()
        for kind in ('duplicate', 'public', 'symlink'):
            with self.subTest(kind=kind):
                if self.proof_path.is_symlink(): self.proof_path.unlink()
                self.proof_path.write_bytes(raw); self.proof_path.chmod(0o600)
                if kind == 'duplicate':
                    self.proof_path.write_bytes(raw[:-1] + b',"runId":959}')
                    self.proof_sha = hashlib.sha256(self.proof_path.read_bytes()).hexdigest()
                elif kind == 'public': self.proof_path.chmod(0o644)
                else:
                    self.proof_path.unlink(); self.proof_path.symlink_to(self.audit)
                with self.assertRaises(RuntimeError): self.execute()
        self.node.assert_not_called()

    def test_cli_requires_explicit_fixed_proof_and_does_not_start_batch(self):
        args = ['batch', '--root', str(self.root), '--quarantine-failed-read', '--journal', 'apply',
                '--order-id', '1', '--batch-attempt-id', self.batch_id, '--sample-attempt-id', self.attempt,
                '--proof', self.proof_name, '--proof-sha256', self.proof_sha]
        with patch.object(sys, 'argv', args), patch.object(batch, 'execute') as execute, contextlib.redirect_stdout(io.StringIO()) as output:
            batch.main()
        execute.assert_not_called()
        self.assertEqual(json.loads(output.getvalue())['outcome'], 'BATCH_FAILURE_QUARANTINED')


if __name__ == '__main__': unittest.main()
