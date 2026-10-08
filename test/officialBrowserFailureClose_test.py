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
import browserFailureClose as closure


class BrowserFailureCloseTests(unittest.TestCase):
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
        node_patch = patch.object(closure, 'verify_node', return_value=self.evidence)
        self.node = node_patch.start()
        self.addCleanup(node_patch.stop)
        docker_patch = patch.object(closure.subprocess, 'run',
            return_value=subprocess.CompletedProcess([], 0, b'other-container\n', b''))
        self.docker = docker_patch.start()
        self.addCleanup(docker_patch.stop)

        self.sample.pop('originalOutcome')
        self.sample.update(outcome='RECEIPT_SESSION_REDIRECT', receiptOutcome='RECEIPT_SESSION_REDIRECT',
            egressAfterHash=self.sample['egressHash'], egressVerifiedAfter=True, passwordSubmitted=True,
            receiptRunId=12, resultFile='/research/private/results/order-1-run-11.json',
            receipt={'orderId': 1, 'detailRun': 11, 'runId': 12, 'outcome': 'RECEIPT_SESSION_REDIRECT'})
        self.case.save(self.audit.name, self.sample)
        self.proof_name = 'browser-failure-close-proof-1-' + self.sample_attempt + '.json'
        self.proof.pop('runId')
        self.proof.update(kind='BROWSER_FAILURE_CLOSE', phase='DETAIL_READY_RECEIPT_FAILED',
            detailRunId=11, receiptRunId=12, sampleAuditSha256=hashlib.sha256(self.audit.read_bytes()).hexdigest(),
            observedAt=self.now, business={'queriedAt': self.now}, research={'queriedAt': self.now})
        self.proof_path=self.case.save(self.proof_name,self.proof)
        self.proof_sha=hashlib.sha256(self.proof_path.read_bytes()).hexdigest()
        self.evidence.clear()
        self.evidence.update({key: value for key, value in self.proof.items()
            if key not in ('version', 'kind', 'observedAt', 'business', 'research')})
        self.evidence.update(outcome='BROWSER_FAILURE_CLOSE_VERIFIED', processExitVerified=False,
            proofSha256=self.proof_sha, egressHash=self.sample['egressHash'],
            egressAfterHash=self.sample['egressHash'], proxyHash=self.sample['proxyHash'],
            files={'private/plan.json':self.plan_sha})

    def execute(self):
        return batch.close_failed_read(self.root,self.journal.name,1,self.batch_attempt,
            self.sample_attempt,self.proof_name,self.proof_sha)

    def assert_closed_failure(self):
        before=self.journal.read_bytes()
        with self.assertRaises(RuntimeError):self.execute()
        self.assertEqual(self.journal.read_bytes(),before)
        self.assertFalse(self.case.calls)

    def test_append_original_start_without_fake_sample_or_success(self):
        before=self.journal.read_bytes()
        result=self.execute()
        self.assertEqual(result['outcome'],'BROWSER_BATCH_FAILURE_CLOSED')
        self.assertIs(result['processExitVerified'],False)
        self.assertIs(result['targetCompleted'],False)
        self.assertTrue(self.journal.read_bytes().startswith(before))
        rows=[json.loads(line) for line in self.journal.read_text().splitlines()]
        self.assertEqual([r['event'] for r in rows],['target_started','failed_read_only_closed'])
        self.assertEqual(rows[-1]['outcome'],'FAILED')
        self.assertIsNone(rows[-1]['apply'])
        self.assertEqual(rows[-1]['verification'],self.evidence)
        state=batch.journal_state(self.root,self.journal.name,self.plan_sha,{1,2},set())
        self.assertEqual(state[1]['outcome'],'FAILED')
        self.assertFalse(self.case.calls)

    def test_both_modes_skip_and_explicit_retry_is_rejected(self):
        self.execute()
        with patch.object(batch,'child') as child,patch.object(batch,'verify_snapshot') as snapshot:
            for applying in (True,False):
                with self.assertRaisesRegex(RuntimeError,'BATCH_TARGET_FAILED_NO_RETRY'):
                    batch.execute(self.root,[1],apply=applying)
                result=batch.execute(self.root,apply=applying)
                self.assertEqual(result['processedThisRun'],0)
                self.assertEqual(result['failedReadOnlyOrderIds'],[1])
                self.assertIs(result['allFieldsComplete'],False)
            child.assert_not_called();snapshot.assert_not_called()

    def test_dry_run_close_also_permanently_skips_apply(self):
        self.journal.rename(self.private/batch.JOURNALS[1]);self.journal=self.private/batch.JOURNALS[1]
        self.execute()
        with self.assertRaisesRegex(RuntimeError,'BATCH_TARGET_FAILED_NO_RETRY'):batch.execute(self.root,[1],apply=True)

    def test_repeated_close_never_retries_or_duplicates_event(self):
        self.execute();self.assert_closed_failure()

    def test_original_audit_shape_is_not_widened(self):
        original=dict(self.sample)
        for update in ({'passwordSubmitted':False},{'serverSessionRestored':True},{'outcome':'STATE_WRITE_FAILED'},
            {'egressAfterHash':'f'*64},{'receiptEgressVerifiedAfter':True},{'receiptOutcome':'RECEIPT_CAPTURED'},
            {'processExitVerified':True},{'receiptRunId':11}):
            with self.subTest(update=tuple(update)):
                self.case.save(self.audit.name,dict(original,**update));self.assert_closed_failure()
        self.case.save(self.audit.name,original)

    def test_unknown_write_intents_always_block(self):
        for name,state in (('browser-receipt-bind-intent-2.json','APPLY_STARTED'),('http-apply-intent-2.json','APPLY_STARTED')):
            with self.subTest(name=name):
                path=self.case.save(name,{'state':state});self.assert_closed_failure();path.unlink()

    def test_existing_receipt_or_bind_artifacts_block(self):
        for name in ('receipt-probe-1.json','browser-receipt-bind-intent-1.json','browser-receipt-bind-1-other.json'):
            with self.subTest(name=name):
                path=self.case.save(name,{});self.assert_closed_failure();path.unlink()

    def test_ambiguous_second_sample_blocks(self):
        second=dict(self.sample,attemptId='f'*32,auditFile='browser-sample-1-'+('f'*32)+'.json')
        self.case.save(second['auditFile'],second);self.assert_closed_failure()

    def test_live_container_blocks(self):
        self.docker.return_value=subprocess.CompletedProcess([],0,(self.sample['containerName']+'\n').encode(),b'')
        self.assert_closed_failure()

    def test_node_must_bind_every_identity_and_admit_exit_unknown(self):
        original=dict(self.evidence)
        for update in ({'processExitVerified':True},{'receiptRunId':13},{'egressAfterHash':'f'*64},
            {'sampleAuditSha256':'0'*64},{'phase':'OTHER'},{'outcome':'SUCCEEDED'}):
            with self.subTest(keys=tuple(update)):
                self.node.return_value=dict(original,**update);self.assert_closed_failure()
        self.node.return_value=self.evidence

    def test_stop_cleanup_unknown_or_plan_change_during_node_blocks_append(self):
        for kind in ('stop','cleanup','intent','plan'):
            before_plan=(self.private/'plan.json').read_bytes()
            def during(*args,**kwargs):
                if kind=='stop':(self.private/'STOP').touch()
                if kind=='cleanup':self.case.save('http-cleanup-blocked.json',{})
                if kind=='intent':self.case.save('browser-receipt-bind-intent-2.json',{'state':'APPLY_STARTED'})
                if kind=='plan':(self.private/'plan.json').write_bytes(before_plan+b' ')
                return self.evidence
            with self.subTest(kind=kind):
                self.node.side_effect=during;self.assert_closed_failure();self.node.side_effect=None
                for name in ('STOP','http-cleanup-blocked.json','browser-receipt-bind-intent-2.json'):
                    if (self.private/name).exists():(self.private/name).unlink()
                (self.private/'plan.json').write_bytes(before_plan)

    def test_locks_refuse_concurrent_close(self):
        for name in ('http-batch.lock','http-sample.lock','http-apply.lock'):
            with (self.private/name).open('a') as lock:
                fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
                self.assert_closed_failure()

    def test_proof_must_remain_fresh_and_unchanged_until_append(self):
        def changed(*args, **kwargs):
            self.proof_path.write_bytes(self.proof_path.read_bytes()+b' ')
            return self.evidence
        self.node.side_effect=changed
        self.assert_closed_failure()
        self.node.side_effect=None
        self.case.save(self.proof_name,self.proof)
        with patch.object(batch.time,'time',return_value=self.now+301):
            self.assert_closed_failure()

    def test_cli_rejects_conflicting_or_missing_arguments(self):
        for flags in (['--close-failed-read'],['--close-failed-read','--quarantine-failed-read'],
                      ['--close-failed-read','--ids','1']):
            output=io.StringIO()
            with patch.object(sys,'argv',['runBrowserBatch.py','--root',str(self.root)]+flags),contextlib.redirect_stdout(output):
                batch.main()
            self.assertEqual(json.loads(output.getvalue())['outcome'],'BROWSER_BATCH_FAILURE_CLOSE_ARGUMENT_INVALID')

if __name__=='__main__':unittest.main()
