"""新执行器的离线并发、保护和断点行为。"""
import concurrent.futures
import datetime
import json
import pathlib
import sys
import tempfile
import threading
import time
import unittest
import runpy
import io
import os
from contextlib import redirect_stdout
from unittest.mock import patch, Mock
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'scripts/officialPickupBackfill'))
import runtime
import runBackfill
import receiptWorkflow


def plan():
    return {'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z'),
            'cutoff': '2026-09-23', 'entries': [
                {'id': i, 'orderNumber': 'W' + str(i).zfill(10), 'rowHash': 'f' * 32,
                 'accountKey': str(i // 2)} for i in range(1, 8)]}


class BackfillTests(unittest.TestCase):
    def missingPlan(self):
        value = dict(plan(), cutoff=None, schemaVersion=3, scope='missing-fields',
                     policy={'loginCooldown': True, 'apiHealthCheck': True, 'proxy541Limit': 3})
        value['entries'] = [dict(e, dateMissing=True, serialsMissing=False, previousDevices=[])
                            for e in value['entries']]
        return value

    def test_missing_scope_keeps_protections_and_frozen_backup(self):
        original = self.missingPlan()
        runtime.validatePlan(original)
        self.assertTrue(runtime.threeFieldScope(original))
        self.assertFalse(runtime.fullScope(original))
        derived = dict(original, entries=[dict(e, stableRowHash='a' * 32) for e in original['entries']])
        runtime.validatePlan(derived, original)
        derived['entries'][0]['previousDevices'] = [{'id': 7}]
        with self.assertRaisesRegex(RuntimeError, 'SCOPE'):
            runtime.validatePlan(derived, original)
        with self.assertRaisesRegex(RuntimeError, 'SCOPE'):
            runtime.validatePlan(dict(original, policy=dict(original['policy'], loginCooldown=False)))
        original['entries'][0]['dateMissing'] = False
        with self.assertRaisesRegex(RuntimeError, 'SCOPE'):
            runtime.validatePlan(original)

    def test_missing_scope_does_not_skip_login_cooldown(self):
        worker = object.__new__(runBackfill.Worker)
        worker.plan = self.missingPlan()
        worker.dockerRead = Mock(return_value=Mock(returncode=0, stdout=json.dumps([
            {'id': 1, 'attempts': 1, 'login_until': 'future'}]).encode()))
        with tempfile.TemporaryDirectory() as directory:
            worker.root = pathlib.Path(directory)
            (worker.root / 'private').mkdir()
            (worker.root / 'evidence').mkdir()
            self.assertEqual(worker.eligible(worker.plan['entries'][:1]), [])
            self.assertEqual(runtime.records(worker.root / 'private/deferred.jsonl')[0]['outcome'], 'LOGIN_COOLDOWN')

    def test_missing_scope_completion_requires_all_three_current_evidences(self):
        original = self.missingPlan()
        groups = runtime.chooseGroups(original, [], [{'orderId': 1, 'outcome': 'ALREADY_HAS_DATE'}],
                                      [{'orderId': 1, 'outcome': 'SERIALS_VERIFIED'}])
        self.assertIn(1, [e['id'] for group in groups for e in group])
        groups = runtime.chooseGroups(original, [], [{'orderId': 1, 'dateVerified': True, 'statusSaved': True}],
                                      [{'orderId': 1, 'outcome': 'SERIALS_VERIFIED'}])
        self.assertNotIn(1, [e['id'] for group in groups for e in group])

    def fullPlan(self):
        return dict(plan(), cutoff=None, schemaVersion=2, scope='all-picked-up',
                    policy={'loginCooldown': False, 'apiHealthCheck': False, 'proxy541Limit': 3})

    def test_full_scope_requires_explicit_policy_and_preserves_members(self):
        original = self.fullPlan()
        runtime.validatePlan(original)
        with self.assertRaisesRegex(RuntimeError, 'SCOPE'):
            runtime.validatePlan(dict(original, policy={}))
        with self.assertRaisesRegex(RuntimeError, 'SCOPE'):
            runtime.validatePlan(dict(original, entries=original['entries'][:-1]), original)
        groups = runtime.chooseGroups(original, [], [], [])
        self.assertEqual(sum(map(len, groups)), len(original['entries']))
        groups = runtime.chooseGroups(original, [], [{'orderId': 1, 'outcome': 'ALREADY_HAS_DATE'}],
                                      [{'orderId': 1, 'outcome': 'SERIALS_VERIFIED'}])
        self.assertIn(1, [e['id'] for group in groups for e in group])

    def test_authorized_login_cooldown_skip_does_not_skip_order_limit(self):
        worker = object.__new__(runBackfill.Worker)
        worker.plan = self.fullPlan()
        worker.dockerRead = Mock(return_value=Mock(returncode=0, stdout=json.dumps([
            {'id': 1, 'attempts': 1, 'login_until': 'future'}, {'id': 2, 'attempts': 3}]).encode()))
        with tempfile.TemporaryDirectory() as directory:
            worker.root = pathlib.Path(directory)
            (worker.root / 'private').mkdir()
            (worker.root / 'evidence').mkdir()
            self.assertEqual(len(worker.eligible(worker.plan['entries'][:1])), 1)
            self.assertEqual(worker.eligible(worker.plan['entries'][1:2]), [])

    def test_watch_skips_health_api_but_records_resources(self):
        import builtins
        originalOpen = builtins.open
        with tempfile.TemporaryDirectory() as directory:
            (pathlib.Path(directory) / 'evidence').mkdir()
            def fakeOpen(path, *args, **kwargs):
                if path == '/proc/meminfo':
                    return io.StringIO('MemAvailable: 4194304 kB\n')
                if path == '/proc/stat':
                    return io.StringIO('cpu 10 0 2 100 0 0 0 0\n')
                return originalOpen(path, *args, **kwargs)
            with patch.dict(os.environ, {'OFFICIAL_ORDER_ROOT': directory, 'OFFICIAL_BACKFILL_SKIP_API_HEALTH': '1'}), \
                    patch.object(sys, 'argv', ['watch', 'apple-pickup-collector-v6-1']), \
                    patch('builtins.open', side_effect=fakeOpen), \
                    patch('subprocess.check_output', return_value=b'{"Running":false,"Status":"exited"}'), \
                    patch('urllib.request.urlopen', side_effect=AssertionError('Health API called')) as api, \
                    redirect_stdout(io.StringIO()) as output:
                runpy.run_path(str(pathlib.Path(runBackfill.__file__).parents[1] / 'watchOfficialOrderServer.py'))
            api.assert_not_called()
            self.assertFalse(json.loads(output.getvalue())['apiHealthCheckEnabled'])

    def test_scope_and_expiry(self):
        original = plan()
        runtime.validatePlan(original)
        changed = dict(original, entries=original['entries'][:-1])
        with self.assertRaisesRegex(RuntimeError, 'SCOPE'):
            runtime.validatePlan(changed, original)
        original['startedAt'] = '2020-01-01T00:00:00.000Z'
        with self.assertRaisesRegex(RuntimeError, 'SCOPE'):
            runtime.validatePlan(original)

    def test_account_group_and_protected_history(self):
        p = plan()
        groups = runtime.chooseGroups(p, [{'orderId': 1, 'outcome': 'AUTH_REJECTED'}],
                                      [{'orderId': 2, 'outcome': 'FILLED'}],
                                      [{'orderId': 2, 'outcome': 'SERIALS_VERIFIED'}])
        ids = [e['id'] for group in groups for e in group]
        self.assertNotIn(1, ids)
        self.assertNotIn(2, ids)
        for group in groups:
            self.assertEqual(len({e['accountKey'] for e in group}), 1)

    def test_receipt_failure_can_be_reconsidered_but_not_success(self):
        groups = runtime.chooseGroups(plan(), [], [{'orderId': 1, 'outcome': 'FILLED'}],
                                      [{'orderId': 1, 'outcome': 'RECEIPT_SESSION_REDIRECT'}])
        self.assertTrue(groups[0][0]['receiptOnly'])

    def test_parallel_append_preserves_all_records(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / 'events.jsonl'
            with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
                list(pool.map(lambda i: runtime.append(path, {'n': i}), range(80)))
            self.assertEqual({r['n'] for r in runtime.records(path)}, set(range(80)))

    def test_rejected_exits_merge_without_lost_update(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            (root / 'private').mkdir()
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                list(pool.map(lambda i: runtime.rejectionSet(root, [str(i)]), range(10)))
            self.assertEqual(runtime.rejectionSet(root), {str(i) for i in range(10)})

    def test_receipt_failure_never_binds(self):
        call = Mock()
        out = receiptWorkflow.bindCaptured(None, None, 1, {'outcome': 'RECEIPT_SESSION_REDIRECT'}, 'hash', call)
        self.assertEqual(out['newBindings'], 0)
        call.assert_not_called()

    def test_receipt_requires_matching_browser_egress(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            runtime.writeJson(root / 'private/receipt-probe-1.json', {'systemOrderId': 1, 'egressHash': 'old'})
            with self.assertRaisesRegex(RuntimeError, 'METADATA'):
                receiptWorkflow.bindCaptured(root, root, 1, {'outcome': 'RECEIPT_CAPTURED'}, 'new', Mock())

    def test_three_workers_overlap_and_never_exceed_three(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            (root / 'private').mkdir()
            (root / 'evidence').mkdir()
            lock = threading.Lock()
            state = {'active': 0, 'peak': 0, 'count': 0}
            barrier = threading.Barrier(3)
            class FakeWorker:
                def __init__(self, *args):
                    pass
                def process(self, group):
                    with lock:
                        state['active'] += 1
                        state['peak'] = max(state['peak'], state['active'])
                        state['count'] += 1
                    if state['count'] <= 3:
                        barrier.wait(timeout=2)
                    time.sleep(0.01)
                    with lock:
                        state['active'] -= 1
            with patch.object(runBackfill, 'preparePlan', return_value=plan()), patch.object(runBackfill, 'Worker', FakeWorker):
                runBackfill.run(root)
            self.assertEqual(state['peak'], 3)
            self.assertEqual(state['count'], 4)

    def test_gate_does_not_clear_cooldowns_or_attempt_limits(self):
        worker = object.__new__(runBackfill.Worker)
        worker.plan = plan()
        result = Mock(returncode=0, stdout=json.dumps([{'id': 2, 'attempts': 3},
                      {'id': 3, 'attempts': 1, 'account_until': 'future'}]).encode())
        worker.dockerRead = Mock(return_value=result)
        with tempfile.TemporaryDirectory() as directory:
            worker.root = pathlib.Path(directory)
            (worker.root / 'private').mkdir()
            (worker.root / 'evidence').mkdir()
            self.assertEqual(worker.eligible([worker.plan['entries'][1]]), [])
            self.assertEqual(worker.eligible([worker.plan['entries'][2]]), [])

    def test_offline_status_catchup_reuses_verified_run_without_collection(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            (root / 'private').mkdir()
            (root / 'evidence').mkdir()
            runtime.append(root / 'private/applied.jsonl', {'orderId': 1, 'outcome': 'FILLED', 'runId': 9})
            worker = Mock()
            worker.applyResult.return_value = {'statusSaved': True}
            with patch.object(runBackfill, 'Worker', return_value=worker):
                runBackfill.syncSavedStatuses(root, plan())
            worker.applyResult.assert_called_once_with('/research/private/results/order-1-run-9.json')
            worker.collect.assert_not_called()

    def test_cumulative_bindings_survive_idempotent_retry(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            (root / 'private').mkdir()
            p = plan()
            p['entries'] = p['entries'][:1]
            runtime.writeJson(root / 'private/plan.json', p)
            for runId, count in [(1, 2), (2, 0)]:
                runtime.append(root / 'private/receipt-applied.jsonl', {
                    'orderId': 1, 'outcome': 'SERIALS_VERIFIED', 'receiptRunId': runId,
                    'newBindings': count, 'serialCount': 2, 'serialsHash': 'hash'})
            responses = [Mock(stdout=json.dumps([{'id': 1, 'date': None, 'hash': 'f' * 32}]).encode()),
                         Mock(stdout=json.dumps([{'id': 1, 'count': 2, 'linkedUnits': 2, 'serialsHash': 'hash'}]).encode())]
            with patch.dict(os.environ, {'OFFICIAL_BACKFILL_ROOT': str(root)}), patch('subprocess.run', side_effect=responses), redirect_stdout(io.StringIO()) as output:
                runpy.run_path(str(pathlib.Path(runBackfill.__file__).with_name('checkBackfill.py')))
            report = json.loads(output.getvalue())
            self.assertEqual(report['receiptNewBindings'], 2)
            self.assertEqual(report['receiptIssues'], [])

    def test_full_scope_interrupted_research_run_is_not_reported_as_unprocessed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            p = self.fullPlan()
            p['entries'] = p['entries'][:1]
            runtime.writeJson(root / 'private/plan.json', p)
            responses = [Mock(stdout=json.dumps([{'id': 1, 'date': None, 'hash': 'f' * 32}]).encode()),
                         Mock(stdout=b'[]'), Mock(stdout=b'[{"id":1,"outcome":"RUN_INTERRUPTED"}]')]
            with patch.dict(os.environ, {'OFFICIAL_BACKFILL_ROOT': str(root)}), \
                    patch('subprocess.run', side_effect=responses), redirect_stdout(io.StringIO()) as output:
                runpy.run_path(str(pathlib.Path(runBackfill.__file__).with_name('checkBackfill.py')))
            report = json.loads(output.getvalue())
            self.assertEqual(report['syncClassification'], {'verified': 0, 'running': 0, 'failedOrDeferred': 1, 'unprocessed': 0})
            self.assertEqual(report['actualAttemptedThisBatch'], 1)

    def test_fatal_proxy_unavailability_stops_scheduling_without_erasing_history(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            (root / 'private').mkdir()
            (root / 'evidence').mkdir()
            runtime.append(root / 'private/processed.jsonl', {'orderId': 99, 'outcome': 'PROXY_CONNECTION_FAILED'})
            before = (root / 'private/processed.jsonl').read_bytes()
            worker = Mock()
            worker.process.side_effect = RuntimeError('NO_FRESH_EGRESS')
            with patch.object(runBackfill, 'preparePlan', return_value=plan()), patch.object(runBackfill, 'Worker', return_value=worker):
                with self.assertRaisesRegex(RuntimeError, 'NO_FRESH_EGRESS'):
                    runBackfill.run(root)
            self.assertLessEqual(worker.process.call_count, 3)
            self.assertEqual((root / 'private/processed.jsonl').read_bytes(), before)

    def fakeWorker(self, directory):
        worker = object.__new__(runBackfill.Worker)
        worker.root = pathlib.Path(directory)
        (worker.root / 'private').mkdir()
        (worker.root / 'evidence').mkdir()
        worker.work = worker.root
        worker.slot = 1
        worker.plan = plan()
        worker.stop = threading.Event()
        worker.configure = Mock()
        worker.eligible = Mock(side_effect=lambda entries: entries)
        worker.freshProxy = Mock(return_value=({}, 'new-egress', time.time()))
        worker.probe = Mock(return_value='new-egress')
        worker.applyResult = Mock(return_value={'orderId': 1, 'outcome': 'FILLED'})
        return worker

    def test_network_failure_rotates_then_saves_success_once(self):
        with tempfile.TemporaryDirectory() as directory:
            worker = self.fakeWorker(directory)
            worker.freshProxy.side_effect = [({}, 'first', time.time()), ({}, 'second', time.time())]
            worker.probe.side_effect = ['first', 'second']
            worker.collect = Mock(side_effect=[
                {'results': [{'orderId': 1, 'attempted': True, 'runId': 1, 'outcome': 'PROXY_CONNECTION_FAILED'}]},
                {'results': [{'orderId': 1, 'attempted': True, 'runId': 2, 'outcome': 'SUCCEEDED', 'resultFile': 'saved'}]}])
            with patch.object(receiptWorkflow, 'bindCaptured', return_value={'orderId': 1, 'outcome': 'RECEIPT_NOT_ATTEMPTED'}):
                worker.process(worker.plan['entries'][:1])
            self.assertEqual(worker.freshProxy.call_count, 2)
            worker.applyResult.assert_called_once_with('saved')
            self.assertIn('first', runtime.rejectionSet(worker.root))

    def test_changed_egress_never_writes_business_and_records_failed_attempt(self):
        with tempfile.TemporaryDirectory() as directory:
            worker = self.fakeWorker(directory)
            worker.probe.return_value = 'changed'
            worker.collect = Mock(return_value={'results': [{'orderId': 1, 'attempted': True, 'runId': 1, 'outcome': 'SUCCEEDED'}]})
            worker.process(worker.plan['entries'][:1])
            worker.applyResult.assert_not_called()
            self.assertEqual(runtime.records(worker.root / 'private/processed.jsonl')[0]['outcome'], 'EGRESS_CHANGED_DURING_GROUP')

    def test_write_failure_stops_all_workers_before_unlocking(self):
        with tempfile.TemporaryDirectory() as directory:
            worker = self.fakeWorker(directory)
            worker.collect = Mock(return_value={'results': [{'orderId': 1, 'attempted': True, 'outcome': 'SUCCEEDED', 'resultFile': 'saved'}]})
            worker.applyResult.side_effect = RuntimeError('BACKFILL_INVARIANCE_FAILED')
            with self.assertRaisesRegex(RuntimeError, 'INVARIANCE'):
                worker.process(worker.plan['entries'][:1])
            self.assertTrue(worker.stop.is_set())

    def test_proxy_retry_remains_bounded_when_gate_allows(self):
        with tempfile.TemporaryDirectory() as directory:
            worker = self.fakeWorker(directory)
            worker.collect = Mock(return_value={'results': [{'orderId': 1, 'attempted': True, 'outcome': 'HTTP_541'}]})
            worker.process(worker.plan['entries'][:1])
            self.assertEqual(worker.collect.call_count, 3)
            worker.applyResult.assert_not_called()

    def test_connection_capacity_not_ten_browsers(self):
        self.assertEqual(runtime.MAX_WORKERS, 3)
        self.assertLessEqual(runtime.MAX_BATCH_CHANNELS + runtime.OTHER_PROXY_CHANNELS, runtime.PROXY_CHANNEL_CAPACITY)
        self.assertEqual(runtime.CONNECTIONS_PER_WORKER, 16)
        for workers in (0, 4, 5, 10):
            with self.assertRaisesRegex(RuntimeError, 'CONCURRENCY'):
                runBackfill.run(pathlib.Path('/unused'), workers)

    def test_sticky_channel_reservations_are_atomic_and_do_not_reset_on_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            (root / 'private').mkdir()
            started = time.time()
            with concurrent.futures.ThreadPoolExecutor(max_workers=10) as pool:
                results = list(pool.map(lambda n: runtime.reserveChannel(root, str(n), started), range(10)))
            self.assertEqual(sum(r['waitUntil'] is None for r in results), 6)
            history = runtime.readJson(root / 'private/tunnel-leases.json')
            key = next(iter(history))
            self.assertEqual(runtime.reserveChannel(root, key, started + 30)['startedAt'], started)
            with patch.object(runtime.time, 'time', return_value=started + 601):
                self.assertIsNone(runtime.reserveChannel(root, 'new', started + 601)['waitUntil'])
            self.assertEqual(len(runtime.readJson(root / 'private/tunnel-leases.json')), 7)

    def test_valid_worker_lease_reused_without_new_sid_or_renewal(self):
        with tempfile.TemporaryDirectory() as directory:
            worker = self.fakeWorker(directory)
            original = ({'host': 'test'}, 'new-egress', time.time() - 100)
            worker.cachedProxy = original
            with patch.object(runBackfill, 'readJson', side_effect=AssertionError('must not allocate new proxy')):
                self.assertEqual(runBackfill.Worker.freshProxy(worker), original)
            worker.probe.assert_called_once_with(original[0])

    def test_three_workers_share_one_probe_slot_even_after_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            (root / 'private').mkdir()
            state = {'active': 0, 'peak': 0}
            barrier = threading.Barrier(3)
            def exercise(slot):
                worker = object.__new__(runBackfill.Worker)
                worker.root = root
                def probe(proxy):
                    state['active'] += 1
                    state['peak'] = max(state['peak'], state['active'])
                    try:
                        time.sleep(0.02)
                        if slot == 1:
                            raise RuntimeError('EGRESS_PROBE_FAILED')
                        return 'verified'
                    finally:
                        state['active'] -= 1
                worker.probeExclusive = probe
                barrier.wait(timeout=2)
                try:
                    return worker.probe({})
                except RuntimeError:
                    return 'failed'
            with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
                results = list(pool.map(exercise, (1, 2, 3)))
            self.assertEqual(results.count('verified'), 2)
            self.assertEqual(state['peak'], 1)
            self.assertEqual(state['active'], 0)


if __name__ == '__main__':
    unittest.main()
