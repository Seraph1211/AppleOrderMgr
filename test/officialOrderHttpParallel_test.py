"""并发调度回归：真实线程重叠、账号互斥、原日志重放和全局失败边界。"""
import contextlib
import fcntl
import io
import json
import os
import pathlib
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).parents[1] / 'scripts/officialOrder'))
import parallelHttpBatch as parallel
import runHttpBatch as batch


class ParallelTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name).resolve()
        (self.root / 'private').mkdir()
        self.journal = self.root / 'private/http-batch-apply.jsonl'
        self.plan = {'entries': [{'id': i, 'accountKey': ('%032x' % i)} for i in range(1, 5)]}
        self.calls = []
        self.running = 0
        self.maxRunning = 0
        self.mutex = threading.Lock()
        self.barrier = threading.Barrier(3)
        self.outcomes = {}
        self.applied = []
        self.runId = 10

    def fakeChild(self, command, timeout, pass_fds=()):
        if '--id' in command:
            order_id = int(command[command.index('--id') + 1])
            proxy = int(command[command.index('--proxy-index') + 1])
            self.assertEqual(len(pass_fds), 1)
            self.assertEqual(os.fstat(pass_fds[0]).st_ino, (self.root / 'private/http-sample.lock').stat().st_ino)
            with open(str(self.root / 'private/http-sample.lock'), 'a') as other:
                with self.assertRaises(BlockingIOError):
                    fcntl.flock(other, fcntl.LOCK_SH | fcntl.LOCK_NB)
            with self.mutex:
                self.running += 1
                self.maxRunning = max(self.maxRunning, self.running)
                self.runId += 1
                run_id = self.runId
            started = time.time()
            if self.barrier:
                self.barrier.wait(timeout=3)
            time.sleep(.01)
            with self.mutex:
                self.running -= 1
                self.calls.append((order_id, proxy))
            return {'outcome': self.outcomes.get(order_id, 'SUCCEEDED'), 'orderId': order_id,
                    'targetOrderId': order_id, 'proxyIndex': proxy, 'runId': run_id,
                    'attemptId': '%032x' % run_id, 'businessWrites': 0,
                    'egressHash': '%064x' % proxy, 'egressAfterHash': '%064x' % proxy,
                    'startedAt': started, 'finishedAt': time.time()}
        self.assertEqual(self.running, 0)
        audit = command[command.index('--audit') + 1]
        order_id = int(audit.split('-')[2])
        run_id = int(audit.split('-')[3].split('.')[0], 16)
        self.applied.append(order_id)
        return {'outcome': 'SUCCEEDED', 'mode': 'apply', 'orderId': order_id, 'runId': run_id, 'businessWrites': 1}

    def execute(self, ids=(1, 2, 3), width=3):
        def write(path, value):
            path.write_text(json.dumps(value))
        with patch.object(batch, 'child', side_effect=self.fakeChild), patch.object(batch, 'check_boundary'), \
                patch.object(batch, 'validate_sample'), patch.object(parallel, 'writePrivate', side_effect=write), \
                contextlib.redirect_stdout(io.StringIO()):
            return parallel.execute_waves(self.root, self.plan, 'a' * 64, list(ids), self.journal,
                                          {}, [None] * 30, 1, set(), True, width)

    def knownFailureChild(self, count, original=None):
        child = self.fakeChild
        seen = {}
        self.barrier = None
        def execute(command, timeout, pass_fds=()):
            result = child(command, timeout, pass_fds)
            if '--id' not in command or result['orderId'] != 1:
                return result
            seen[1] = seen.get(1, 0) + 1
            if seen[1] > count:
                return result
            result.pop('orderId')
            result.update(outcome='HTTP_TIMEOUT', requests=3, egressVerifiedAfter=True,
                          cleanup={'attempted': True, 'removed': True, 'outcome': 'REMOVED'},
                          containerName='apple-official-http-sample-' + result['attemptId'],
                          elapsedSeconds=round(result['finishedAt']-result['startedAt'], 3))
            if original:
                result.update(outcome='EGRESS_CHANGED_OR_UNVERIFIED', originalOutcome=original,
                              egressAfterHash=None, egressAfterError='RUNTIME_COMMAND_FAILED', egressVerifiedAfter=False)
                if original == 'SUCCEEDED':
                    del result['requests']
                    result.update(orderId=1, receiptOutcome='RECEIPT_NOT_REQUESTED',
                                  resultFile='/research/private/results/order-1-run-' + str(result['runId']) + '.json')
            name=self.root / ('private/http-sample-1-' + result['attemptId'] + '.json')
            name.write_text(json.dumps(result)); name.chmod(0o600)
            return result
        return execute

    def test_known_read_failure_rotates_and_only_applies_verified_success(self):
        self.fakeChild = self.knownFailureChild(2)
        result = self.execute()
        self.assertEqual(result['processedThisRun'], 3)
        self.assertEqual(len([i for i, _p in self.calls if i == 1]), 3)
        self.assertEqual(self.applied.count(1), 1)
        self.assertEqual(len(set(p for _i, p in self.calls)), 5)
        self.assertEqual(batch.journal_state(self.journal, 'a' * 64, {1, 2, 3}), {1, 2, 3})

    def test_three_known_failures_end_without_apply_or_hidden_replay(self):
        self.fakeChild = self.knownFailureChild(20)
        result = self.execute()
        self.assertEqual(result['processedThisRun'], 3)
        self.assertEqual(len([i for i, _p in self.calls if i == 1]), 3)
        self.assertNotIn(1, self.applied)
        records=[json.loads(line) for line in self.journal.read_text().splitlines()]
        last=[row for row in records if row['orderId']==1][-1]
        self.assertTrue(last['readFailureVerified']); self.assertIsNone(last['apply'])
        self.assertEqual(batch.journal_state(self.journal, 'a' * 64, {1, 2, 3}), {1, 2, 3})
        last.pop('readFailureVerified')
        self.journal.write_text(''.join(json.dumps(row)+'\n' for row in records))
        with self.assertRaises(RuntimeError): batch.journal_state(self.journal, 'a' * 64, {1, 2, 3})

    def test_unverified_success_result_is_never_applied_before_new_verified_read(self):
        self.fakeChild = self.knownFailureChild(1, original='SUCCEEDED')
        self.execute()
        self.assertEqual(self.applied.count(1), 1)
        self.assertEqual(len([i for i, _p in self.calls if i == 1]), 2)
        rejected=json.loads((self.root/'private/http-rejected-egress.json').read_text())
        self.assertEqual(len(rejected), 1)

    def test_retryable_failure_rejects_unclean_unknown_or_malformed_samples(self):
        now=time.time()
        sample={'outcome':'HTTP_TIMEOUT','runId':1,'requests':3,'attemptId':'a'*32,
                'targetOrderId':1,'proxyIndex':1,'businessWrites':0,'startedAt':now-2,'finishedAt':now-1,
                'elapsedSeconds':1.0,'egressHash':'b'*64,'egressAfterHash':'b'*64,'egressVerifiedAfter':True,
                'cleanup':{'attempted':True,'removed':True,'outcome':'REMOVED'},
                'containerName':'apple-official-http-sample-'+'a'*32}
        self.assertTrue(batch.retryable_read_failure(sample))
        for change in ({'runId':True},{'businessWrites':1},{'businessWrites':False},{'requests':0},
                       {'requests':True},{'requests':41},{'outcome':'STATE_WRITE_FAILED'},
                       {'egressVerifiedAfter':False},{'egressAfterHash':'c'*64},
                       {'cleanup':{'attempted':True,'removed':False,'outcome':'UNKNOWN'}},
                       {'finishedAt':now+100},{'elapsedSeconds':float('nan')},{'containerName':'other'},
                       {'targetOrderId':True},{'proxyIndex':-1},{'unexpected':True}):
            with self.subTest(change=change):
                self.assertFalse(batch.retryable_read_failure(dict(sample,**change)))
        unknown=dict(sample,outcome='EGRESS_CHANGED_OR_UNVERIFIED',originalOutcome='HTTP_TIMEOUT',
                     egressAfterHash=None,egressAfterError='RUNTIME_COMMAND_FAILED',egressVerifiedAfter=False)
        self.assertTrue(batch.retryable_read_failure(unknown))
        self.assertFalse(batch.retryable_read_failure(dict(unknown,originalOutcome='STATE_WRITE_FAILED')))

    def test_real_three_threads_overlap_and_sequential_apply(self):
        result = self.execute()
        self.assertEqual(self.maxRunning, 3)
        self.assertEqual(result['maximumObservedSampleOverlap'], 3)
        self.assertEqual(len(set(proxy for _i, proxy in self.calls)), 3)
        self.assertEqual(set(self.applied), {1, 2, 3})
        self.assertEqual(batch.journal_state(self.journal, 'a' * 64, {1, 2, 3}), {1, 2, 3})

    def test_five_collectors_overlap_with_one_apply_at_a_time(self):
        self.plan['entries'] = [{'id': i, 'accountKey': '%032x' % i} for i in range(1, 6)]
        self.barrier = threading.Barrier(5)
        result = self.execute(tuple(range(1, 6)), 5)
        self.assertEqual(self.maxRunning, 5)
        self.assertEqual(result['maximumObservedSampleOverlap'], 5)
        self.assertEqual(set(self.applied), set(range(1, 6)))
        self.assertEqual(batch.journal_state(self.journal, 'a' * 64, set(range(1, 6))), set(range(1, 6)))

    def test_ten_collectors_overlap_with_one_apply_at_a_time(self):
        self.plan['entries'] = [{'id': i, 'accountKey': '%032x' % i} for i in range(1, 11)]
        self.barrier = threading.Barrier(10)
        result = self.execute(tuple(range(1, 11)), 10)
        self.assertEqual(self.maxRunning, 10)
        self.assertEqual(result['maximumObservedSampleOverlap'], 10)
        self.assertEqual(set(self.applied), set(range(1, 11)))
        self.assertEqual(batch.journal_state(self.journal, 'a' * 64, set(range(1, 11))), set(range(1, 11)))

    def test_same_account_wave_selection(self):
        self.assertEqual(parallel.select_wave([1, 2, 3, 4], {1: 'a', 2: 'a', 3: 'b', 4: 'c'}, 3), [1, 3, 4])
        self.assertEqual(parallel.select_wave([1, 2], {1: 'a', 2: 'a'}, 3), [1])

    def test_unknown_read_finishes_peers_but_never_starts_next_wave(self):
        self.outcomes[2] = 'HTTP_TIMEOUT'
        with self.assertRaisesRegex(RuntimeError, 'BATCH_COLLECTOR_STOPPED'):
            self.execute((1, 2, 3, 4))
        self.assertEqual(set(self.applied), {1, 3})
        self.assertEqual({i for i, _p in self.calls}, {1, 2, 3})
        pending = {}
        self.assertEqual(batch.journal_state(self.journal, 'a' * 64, {1, 2, 3, 4}, pending), {1, 3})
        self.assertEqual(pending['orderId'], 2)
        with self.assertRaisesRegex(RuntimeError, 'BATCH_RECONCILIATION_REQUIRED'):
            batch.journal_state(self.journal, 'a' * 64, {1, 2, 3, 4})

    def test_unknown_apply_stops_remaining_writes(self):
        original = self.fakeChild
        def child(command, timeout, pass_fds=()):
            if '--audit' in command:
                return {'outcome': 'MANUAL_RECONCILIATION_REQUIRED'}
            return original(command, timeout, pass_fds)
        self.fakeChild = child
        with self.assertRaisesRegex(RuntimeError, 'BATCH_APPLY_STOPPED'):
            self.execute()
        self.assertFalse(self.applied)

    def test_541_keeps_max_three_attempts_and_all_rejected_exits(self):
        self.barrier = None
        self.outcomes[1] = 'HTTP_541'
        result = self.execute((1,))
        self.assertEqual(len(self.calls), 3)
        self.assertEqual(result['processedThisRun'], 1)
        self.assertFalse(self.applied)
        self.assertEqual(len(json.loads((self.root / 'private/http-rejected-egress.json').read_text())), 3)
        self.assertEqual(batch.journal_state(self.journal, 'a' * 64, {1}), {1})

    def test_multiple_pending_remain_fail_closed(self):
        self.outcomes = {1: 'HTTP_TIMEOUT', 2: 'HTTP_TIMEOUT'}
        with self.assertRaises(RuntimeError):
            self.execute()
        with self.assertRaisesRegex(RuntimeError, 'BATCH_RECONCILIATION_REQUIRED'):
            batch.journal_state(self.journal, 'a' * 64, {1, 2, 3}, {})

    def test_pool_exhaustion_does_not_append_new_start(self):
        with patch.object(batch, 'check_boundary'):
            with self.assertRaisesRegex(RuntimeError, 'NO_FRESH_EGRESS'):
                parallel.execute_waves(self.root, self.plan, 'a' * 64, [1, 2, 3], self.journal,
                                       {}, [None], 0, set(), True, 3)
        self.assertFalse(self.journal.exists())

    def test_duplicate_attempt_across_orders_rejected(self):
        self.execute()
        rows = [json.loads(line) for line in self.journal.read_text().splitlines()]
        starts = [r for r in rows if r['event'] == 'order_started']
        starts[1]['batchAttemptId'] = starts[0]['batchAttemptId']
        self.journal.write_text(''.join(json.dumps(r) + '\n' for r in rows))
        with self.assertRaises(RuntimeError):
            batch.journal_state(self.journal, 'a' * 64, {1, 2, 3})


if __name__ == '__main__':
    unittest.main()
