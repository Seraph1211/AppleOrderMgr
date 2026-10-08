"""浏览器登录前代理失败隔离：临时私密文件及进程替身，无生产/官网操作。"""
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

SPEC = importlib.util.spec_from_file_location('http_fixture', pathlib.Path(__file__).with_name('officialOrderHttpBatch_test.py'))
fixture = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(fixture)
import runBrowserBatch as batch
import browserFailureQuarantine as quarantine


class BrowserQuarantineTests(unittest.TestCase):
    def setUp(self):
        self.case = fixture.BatchTests('test_default_preview_never_passes_apply')
        self.case.setUp()
        self.addCleanup(self.case.doCleanups)
        self.root = self.case.root
        self.private = self.root / 'private'
        self.intent = self.case.seed_confirmed()
        self.plan_sha = hashlib.sha256((self.private / 'plan.json').read_bytes()).hexdigest()
        self.now = time.time()
        self.batch_attempt = 'd' * 32
        self.sample_attempt = 'e' * 32
        self.source = {'basis': 'http-apply-basis-1-run-10.json', 'httpSourceAudit': self.intent['sourceAudit'],
                       'afterHash': 'e' * 32}
        self.started = {'event': 'target_started', 'at': self.now - 3, 'orderId': 1, 'planSha256': self.plan_sha,
                        'batchAttemptId': self.batch_attempt, 'proxyIndex': 0, 'source': self.source}
        self.journal = self.private / batch.JOURNALS[0]
        batch.http.append(self.journal, self.started)
        self.sample = {'outcome': 'EGRESS_CHANGED_OR_UNVERIFIED', 'originalOutcome': 'PROXY_CONNECTION_FAILED',
            'attemptId': self.sample_attempt, 'auditFile': 'browser-sample-1-' + self.sample_attempt + '.json',
            'bootstrapMode': 'native-browser', 'businessWrites': 0,
            'cleanup': {'attempted': True, 'removed': True, 'outcome': 'REMOVED'},
            'containerName': 'apple-official-browser-sample-' + self.sample_attempt, 'detailRunId': 11,
            'egressAfterHash': 'f' * 64, 'egressHash': 'a' * 64, 'egressVerifiedAfter': False,
            'startedAt': self.now - 2, 'finishedAt': self.now - 1, 'orderId': 1, 'targetOrderId': 1,
            'leaseContext': {'provider': 'iproyal', 'startedAt': '2026-10-07T01:00:00.000Z',
                             'proxyHash': 'b' * 64, 'egressHash': 'a' * 64},
            'passwordSubmitted': False, 'persistSessions': False, 'proxyHash': 'b' * 64, 'proxyIndex': 0,
            'receiptEgressVerifiedAfter': False, 'runId': 11, 'serverSessionRestored': False}
        self.audit = self.case.save(self.sample['auditFile'], self.sample)
        self.proof_name = 'browser-failure-proof-1-' + self.sample_attempt + '.json'
        self.proof = {'version': 1, 'kind': 'BROWSER_FAILURE_QUARANTINE', 'planSha256': self.plan_sha,
            'orderId': 1, 'runId': 11, 'batchAttemptId': self.batch_attempt, 'sampleAttemptId': self.sample_attempt,
            'sampleAuditSha256': hashlib.sha256(self.audit.read_bytes()).hexdigest(),
            'httpSourceAuditSha256': hashlib.sha256((self.private / self.intent['sourceAudit']).read_bytes()).hexdigest(),
            'httpResultSha256': hashlib.sha256((self.private / self.intent['resultFile']).read_bytes()).hexdigest()}
        self.proof_path = self.case.save(self.proof_name, self.proof)
        self.proof_sha = hashlib.sha256(self.proof_path.read_bytes()).hexdigest()
        self.evidence = dict(self.proof, outcome='BROWSER_FAILURE_QUARANTINE_VERIFIED', proofSha256=self.proof_sha,
            egressHash='a' * 64, egressAfterHash='f' * 64, proxyHash='b' * 64,
            files={'private/plan.json': self.plan_sha})
        self.case.save('http-rejected-egress.json', ['a' * 64, 'f' * 64])
        node_patch = patch.object(quarantine, 'verify_node', return_value=self.evidence)
        self.node = node_patch.start()
        self.addCleanup(node_patch.stop)
        docker_patch = patch.object(quarantine.subprocess, 'run',
            return_value=subprocess.CompletedProcess([], 0, b'other-container\n', b''))
        self.docker = docker_patch.start()
        self.addCleanup(docker_patch.stop)

    def execute(self):
        return batch.quarantine_failed_read(self.root, self.journal.name, 1, self.batch_attempt,
                                            self.sample_attempt, self.proof_name, self.proof_sha)

    def replace_audit(self, change):
        self.sample.update(change)
        self.case.save(self.audit.name, self.sample)

    def assert_unchanged_failure(self):
        before = self.journal.read_bytes()
        with self.assertRaises(RuntimeError): self.execute()
        self.assertEqual(self.journal.read_bytes(), before)
        self.assertFalse(self.case.calls)

    def test_append_seals_evidence_preserves_start_and_never_completes_target(self):
        before = self.journal.read_bytes()
        result = self.execute()
        self.assertEqual(result['outcome'], 'BROWSER_BATCH_FAILURE_QUARANTINED')
        self.assertIs(result['targetCompleted'], False)
        self.assertIs(result['egressVerifiedAfter'], False)
        self.assertEqual(result['businessWrites'], 0)
        self.assertTrue(self.journal.read_bytes().startswith(before))
        rows = [json.loads(line) for line in self.journal.read_text().splitlines()]
        self.assertEqual([row['event'] for row in rows], ['target_started', 'failed_read_only_quarantined'])
        self.assertEqual(rows[-1]['verification'], self.evidence)
        quarantined = set()
        self.assertEqual(batch.journal_state(self.root, self.journal.name, self.plan_sha, {1, 2}, set(),
                                            quarantined=quarantined), {})
        self.assertEqual(quarantined, {1})
        self.assertFalse(self.case.calls)

    def test_both_modes_skip_isolated_target_and_explicit_selection_fails(self):
        self.execute()
        with patch.object(batch, 'child') as child, patch.object(batch, 'verify_snapshot') as snapshot:
            for applying in (False, True):
                with self.subTest(apply=applying):
                    with self.assertRaisesRegex(RuntimeError, 'BATCH_TARGET_QUARANTINED'):
                        batch.execute(self.root, [1], apply=applying)
                    result = batch.execute(self.root, apply=applying)
                    self.assertEqual(result['processedThisRun'], 0)
                    self.assertEqual(result['quarantinedOrderIds'], [1])
                    self.assertIs(result['allFieldsComplete'], False)
            child.assert_not_called()
            snapshot.assert_not_called()

    def test_dry_run_source_isolation_also_blocks_apply(self):
        destination = self.private / batch.JOURNALS[1]
        self.journal.rename(destination)
        self.journal = destination
        self.execute()
        with self.assertRaisesRegex(RuntimeError, 'BATCH_TARGET_QUARANTINED'):
            batch.execute(self.root, [1], apply=True)

    def test_exact_failure_shape_types_and_identity_are_required(self):
        original = dict(self.sample)
        changes = [{'outcome': 'SUCCEEDED'}, {'originalOutcome': 'HTTP_TIMEOUT'}, {'passwordSubmitted': True},
            {'serverSessionRestored': True}, {'passwordSubmitted': 0}, {'persistSessions': 0},
            {'receiptEgressVerifiedAfter': True}, {'egressVerifiedAfter': True}, {'bootstrapMode': 'http-bootstrap'},
            {'businessWrites': False}, {'businessWrites': 0.0}, {'runId': True}, {'detailRunId': True},
            {'detailRunId': 12}, {'orderId': True}, {'targetOrderId': 2}, {'proxyIndex': False}, {'proxyIndex': 1},
            {'receipt': {}}, {'receiptRunId': 12}, {'resultFile': 'private.json'}, {'requests': 23},
            {'egressAfterHash': 'a' * 64}, {'egressAfterHash': None}, {'proxyHash': 'unknown'},
            {'containerName': 'other'}, {'cleanup': {'attempted': True, 'removed': 1, 'outcome': 'REMOVED'}},
            {'startedAt': self.now - 4}, {'finishedAt': self.now + 100}, {'startedAt': False}]
        for change in changes:
            with self.subTest(change=change):
                self.sample = dict(original)
                self.replace_audit(change)
                self.assert_unchanged_failure()
        self.node.assert_not_called()

    def test_unique_candidate_does_not_ignore_second_invalid_or_later_audit(self):
        other_name = 'browser-sample-1-' + 'f' * 32 + '.json'
        for kind in ('same-window', 'after-event', 'invalid-time', 'bad-identity'):
            with self.subTest(kind=kind):
                other = dict(self.sample, attemptId='f' * 32, auditFile=other_name)
                if kind == 'after-event': other['startedAt'] = self.now + 60
                elif kind == 'invalid-time': del other['startedAt']
                elif kind == 'bad-identity': other['targetOrderId'] = 2
                path = self.case.save(other_name, other)
                self.assert_unchanged_failure()
                path.unlink()
        self.node.assert_not_called()

    def test_valid_older_audit_does_not_claim_this_start(self):
        name = 'browser-sample-1-' + 'f' * 32 + '.json'
        self.case.save(name, dict(self.sample, attemptId='f' * 32, auditFile=name,
                                 startedAt=self.now - 10, finishedAt=self.now - 9))
        self.assertEqual(self.execute()['outcome'], 'BROWSER_BATCH_FAILURE_QUARANTINED')

    def test_started_source_proxy_identity_and_time_must_match(self):
        original = dict(self.started)
        for change in ({'source': dict(self.source, afterHash='f' * 32)}, {'proxyIndex': 1},
                       {'source': None}, {'batchAttemptId': 'f' * 32}, {'orderId': 2},
                       {'at': self.now - 1}, {'proxyIndex': False}, {'extra': 'unknown'}):
            with self.subTest(change=change):
                self.journal.write_text(json.dumps(dict(original, **change)) + '\n', encoding='utf-8')
                self.assert_unchanged_failure()
        self.node.assert_not_called()

    def test_all_locks_stop_cleanup_and_unknown_global_intents_block(self):
        for name in ('http-batch.lock', 'http-sample.lock', 'http-apply.lock'):
            with open(str(self.private / name), 'a') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                self.assert_unchanged_failure()
        for name, value in (('STOP', {}), ('http-cleanup-blocked.json', {}),
                ('http-apply-intent-2.json', {'orderId': 2, 'state': 'UNKNOWN'}),
                ('browser-receipt-bind-intent-2.json', {'orderId': 2, 'state': 'APPLY_STARTED'}),
                ('browser-receipt-bind-intent-1.json', {'orderId': 1, 'state': 'ROLLED_BACK'})):
            path = self.case.save(name, value)
            self.assert_unchanged_failure()
            path.unlink()
        self.node.assert_not_called()

    def test_other_mode_pending_or_existing_sample_finished_cannot_be_isolated(self):
        other = self.private / batch.JOURNALS[1]
        batch.http.append(other, dict(self.started, orderId=2, batchAttemptId='f' * 32))
        self.assert_unchanged_failure()
        other.unlink()
        batch.http.append(self.journal, dict(self.started, event='sample_finished', sample=self.sample))
        self.assert_unchanged_failure()
        self.node.assert_not_called()

    def test_required_http_applied_chain_cannot_be_absent_rolled_back_or_corrupt(self):
        target = self.private / 'http-apply-intent-1.json'
        original = target.read_bytes()
        for kind in ('missing', 'rolled-back', 'unknown', 'bad-result'):
            with self.subTest(kind=kind):
                target.write_bytes(original)
                if kind == 'missing': target.unlink()
                elif kind == 'bad-result': (self.private / self.intent['resultFile']).unlink()
                else: self.case.save(target.name, dict(self.intent, state='ROLLED_BACK' if kind == 'rolled-back' else 'UNKNOWN'))
                self.assert_unchanged_failure()
        self.node.assert_not_called()

    def test_changed_exit_rejections_container_or_new_browser_artifacts_block(self):
        for values in ([], ['a' * 64], ['f' * 64]):
            self.case.save('http-rejected-egress.json', values)
            self.assert_unchanged_failure()
        self.case.save('http-rejected-egress.json', ['a' * 64, 'f' * 64])
        self.docker.return_value = subprocess.CompletedProcess([], 0, (self.sample['containerName'] + '\n').encode(), b'')
        self.assert_unchanged_failure()
        self.docker.return_value = subprocess.CompletedProcess([], 0, b'', b'')
        for name in ('receipt-probe-1.json', 'http-receipt-1-run-11.json', 'browser-receipt-bind-1-extra-payload.json'):
            target = self.case.save(name, {})
            self.assert_unchanged_failure()
            target.unlink()
        (self.private / 'results').mkdir()
        self.case.save('results/order-1-run-11.json', {})
        self.assert_unchanged_failure()
        self.node.assert_not_called()

    def test_verifier_failure_or_changed_protocol_never_appends(self):
        self.node.side_effect = RuntimeError('EVIDENCE_INVALID')
        self.assert_unchanged_failure()
        self.node.side_effect = None
        for field, value in (('runId', 12), ('egressAfterHash', 'a' * 64), ('sampleAuditSha256', 'f' * 64), ('files', {})):
            self.node.return_value = dict(self.evidence, **{field: value})
            self.assert_unchanged_failure()

    def test_stop_cleanup_plan_journal_and_unknown_write_during_verification_block_append(self):
        mutations = [('STOP', {}), ('http-cleanup-blocked.json', {}),
                     ('http-apply-intent-2.json', {'orderId': 2, 'state': 'UNKNOWN'}),
                     ('browser-receipt-bind-intent-2.json', {'orderId': 2, 'state': 'UNKNOWN'})]
        for name, value in mutations:
            with self.subTest(name=name):
                self.node.side_effect = lambda *_args, n=name, v=value: (self.case.save(n, v), self.evidence)[1]
                self.assert_unchanged_failure()
                (self.private / name).unlink()
        raw = (self.private / 'plan.json').read_bytes()
        self.node.side_effect = lambda *_args: ((self.private / 'plan.json').write_bytes(raw + b' '), self.evidence)[1]
        self.assert_unchanged_failure()
        (self.private / 'plan.json').write_bytes(raw)
        before = self.journal.read_bytes()
        self.node.side_effect = lambda *_args: (self.journal.write_bytes(before + b' '), self.evidence)[1]
        with self.assertRaises(RuntimeError): self.execute()
        self.assertEqual(self.journal.read_bytes(), before + b' ')

    def test_original_proof_or_browser_audit_bytes_cannot_change_on_replay(self):
        self.execute()
        proof = self.proof_path.read_bytes()
        self.proof_path.write_text(json.dumps(self.proof, indent=2), encoding='utf-8')
        with self.assertRaises(RuntimeError): batch.execute(self.root)
        self.proof_path.write_bytes(proof)
        self.audit.write_text(json.dumps(self.sample, indent=2), encoding='utf-8')
        with self.assertRaises(RuntimeError): batch.execute(self.root)

    def test_manifest_changes_second_audit_and_new_target_start_fail_replay(self):
        self.execute()
        original = self.journal.read_bytes()
        rows = [json.loads(line) for line in original.decode().splitlines()]
        rows[-1]['verification']['files']['private/plan.json'] = 'f' * 64
        self.journal.write_text(''.join(json.dumps(row) + '\n' for row in rows), encoding='utf-8')
        with self.assertRaises(RuntimeError): batch.execute(self.root)
        self.journal.write_bytes(original)
        batch.http.append(self.journal, dict(self.started, batchAttemptId='f' * 32, at=time.time()))
        with self.assertRaises(RuntimeError): batch.execute(self.root)

    def test_cli_is_explicit_and_never_invokes_normal_batch(self):
        args = ['batch', '--root', str(self.root), '--quarantine-failed-read', '--journal', 'apply',
                '--order-id', '1', '--batch-attempt-id', self.batch_attempt, '--sample-attempt-id', self.sample_attempt,
                '--proof', self.proof_name, '--proof-sha256', self.proof_sha]
        with patch.object(sys, 'argv', args), patch.object(batch, 'execute') as execute, contextlib.redirect_stdout(io.StringIO()) as output:
            batch.main()
        execute.assert_not_called()
        self.assertEqual(json.loads(output.getvalue())['outcome'], 'BROWSER_BATCH_FAILURE_QUARANTINED')

    def test_private_files_reject_duplicate_keys_symlinks_and_public_mode(self):
        original = self.audit.read_bytes()
        for kind in ('duplicate', 'symlink', 'public'):
            with self.subTest(kind=kind):
                if self.audit.is_symlink(): self.audit.unlink()
                self.audit.write_bytes(original); self.audit.chmod(0o600)
                if kind == 'duplicate': self.audit.write_bytes(original[:-1] + b',"runId":11}')
                elif kind == 'public': self.audit.chmod(0o644)
                else:
                    self.audit.unlink(); self.audit.symlink_to(self.proof_path)
                self.assert_unchanged_failure()
        self.node.assert_not_called()


if __name__ == '__main__':
    unittest.main()
