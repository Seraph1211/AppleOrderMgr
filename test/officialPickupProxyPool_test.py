"""固定代理池不扩范围、不清保护、不共用实际出口。"""
import concurrent.futures
import pathlib
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'scripts/officialPickupBackfill'))
import proxyPool
import runtime
import runBackfill
from officialPickupBackfill_test import plan


class ProxyPoolTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.directory.name)
        (self.root / 'evidence').mkdir()
        self.entries = [{'host': 'geo.iproyal.com', 'port': 12321, 'username': 'test',
                         'password': 'synthetic_session-%08d_lifetime-24h' % n} for n in range(6)]
        runtime.writeJson(self.root / 'private/iproyal-proxies.json',
                          {'provider': 'IPRoyal', 'entries': self.entries + self.entries[:1]})
        runtime.writeJson(self.root / 'private/proxy-provider.json', {'provider': 'iproyal'})
        self.pool = proxyPool.ProvidedProxyPool(self.root)

    def tearDown(self):
        self.directory.cleanup()

    def worker(self):
        worker = object.__new__(runBackfill.Worker)
        worker.root, worker.slot, worker.plan = self.root, 1, plan()
        worker.stop = threading.Event()
        worker.provider, worker.proxyPool = 'iproyal', self.pool
        worker.probe = Mock(return_value='egress-new')
        return worker

    def test_password_session_dedup_and_unique_slot_claims(self):
        self.assertEqual(len(self.pool.entries), 6)
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
            claims = list(executor.map(self.pool.claim, (1, 2, 3)))
        self.assertEqual(len({proxyPool.proxyHash(p) for p, _ in claims}), 3)
        first, state = claims[0]
        again, restored = self.pool.claim(1)
        self.assertEqual(again, first)
        self.assertEqual(restored['startedAt'], state['startedAt'])
        self.assertEqual(proxyPool.providerFor(self.root), 'iproyal')

    def test_actual_egress_duplicate_retired_without_rejecting_other_worker(self):
        first, _ = self.pool.claim(1)
        second, _ = self.pool.claim(2)
        self.assertTrue(self.pool.accept(first, 1, 'same'))
        self.assertFalse(self.pool.accept(second, 2, 'same'))
        self.assertNotEqual(self.pool.claim(2)[0], second)
        self.assertEqual(runtime.rejectionSet(self.root), set())
        self.assertEqual(self.pool.state()[proxyPool.proxyHash(second)]['reason'], 'DUPLICATE_ACTIVE_EGRESS')

    def test_finite_pool_never_recycles_failure_or_generates_session(self):
        for _ in range(6):
            proxy, _ = self.pool.claim(1)
            self.assertIn(proxy['password'], [entry['password'] for entry in self.entries])
            self.pool.retire(proxy, 'EGRESS_PROBE_FAILED')
        with self.assertRaisesRegex(RuntimeError, 'NO_FRESH_EGRESS'):
            self.pool.claim(1)
        self.assertEqual(len(self.pool.state()), 6)

    def test_new_provider_never_calls_fan_reservation_or_reads_fan_credentials(self):
        worker = self.worker()
        with patch.object(runBackfill, 'reserveChannel', side_effect=AssertionError('fan reservation')), \
                patch.object(runBackfill, 'readJson', side_effect=AssertionError('fan credentials')):
            first = worker.freshProxy()
            second = worker.freshProxy()
        self.assertEqual(first, second)
        self.assertEqual(worker.probe.call_count, 2)

    def test_failed_and_changed_exits_persist_and_rotate(self):
        worker = self.worker()
        worker.probe.side_effect = [RuntimeError('EGRESS_PROBE_FAILED'), 'old', 'changed', 'fresh']
        first = worker.freshProxy()
        second = worker.freshProxy()
        self.assertNotEqual(first[0], second[0])
        self.assertEqual(runtime.rejectionSet(self.root), {'old', 'changed'})
        self.assertEqual(sum(s['status'] == 'retired' for s in self.pool.state().values()), 2)

    def test_stop_prevents_any_probe_and_pool_allocation(self):
        worker = self.worker()
        runtime.writeJson(self.root / 'private/STOP', {'reason': 'test'})
        with self.assertRaisesRegex(RuntimeError, 'COORDINATED_STOP'):
            worker.freshProxy()
        worker.probe.assert_not_called()
        self.assertEqual(self.pool.state(), {})

    def test_lease_expiry_keeps_original_history_and_moves_to_next_configuration(self):
        proxy, row = self.pool.claim(1)
        with patch.object(proxyPool.time, 'time', return_value=row['startedAt'] + 86400):
            replacement, _ = self.pool.claim(1)
        self.assertNotEqual(proxy, replacement)
        old = self.pool.state()[proxyPool.proxyHash(proxy)]
        self.assertEqual(old['startedAt'], row['startedAt'])
        self.assertEqual(old['status'], 'retired')

    def test_world_readable_or_nonsticky_configuration_rejected(self):
        path = self.root / 'private/iproyal-proxies.json'
        path.chmod(0o644)
        with self.assertRaisesRegex(RuntimeError, 'PERMISSIONS'):
            proxyPool.ProvidedProxyPool(self.root)
        runtime.writeJson(path, {'provider': 'IPRoyal', 'entries': [dict(self.entries[0], password='no-session')]})
        with self.assertRaisesRegex(RuntimeError, 'INVALID'):
            proxyPool.ProvidedProxyPool(self.root)

    def test_541_rotates_and_third_unique_event_retires_across_restart(self):
        proxy, original = self.pool.claim(1)
        self.pool.accept(proxy, 1, 'egress-a')
        self.assertEqual(self.pool.record541(proxy, 'run-1'), {'count': 1, 'retired': False})
        self.assertNotEqual(self.pool.claim(1, avoidEgress='egress-a')[0], proxy)
        reopened = proxyPool.ProvidedProxyPool(self.root)
        self.assertEqual(reopened.record541(proxy, 'run-1')['count'], 1)
        self.assertFalse(reopened.record541(proxy, 'run-2')['retired'])
        self.assertTrue(reopened.record541(proxy, 'run-3')['retired'])
        self.assertEqual(reopened.state()[proxyPool.proxyHash(proxy)]['startedAt'], original['startedAt'])

    def test_available_configs_rotate_without_resetting_lease_or_strikes(self):
        first, original = self.pool.claim(1)
        self.pool.accept(first, 1, 'first')
        self.pool.record541(first, 'run-1')
        for _ in range(5):
            candidate, _ = self.pool.claim(1)
            self.pool.retire(candidate, 'TEST_TRANSPORT_FAILURE')
        restored, row = self.pool.claim(1, avoidEgress='different')
        self.assertEqual(restored, first)
        self.assertEqual(row['http541Count'], 1)
        self.assertEqual(row['startedAt'], original['startedAt'])

    def test_paused_proxy_is_retired_before_probe_not_assigned_to_an_account(self):
        worker = self.worker()
        paused, _ = self.pool.claim(1)
        worker.proxyPauses = {proxyPool.proxyHash(paused): 'PROXY_CONNECTION_FAILED'}
        selected, _, _ = worker.freshProxy()
        self.assertNotEqual(selected, paused)
        worker.probe.assert_called_once_with(selected)
        self.assertEqual(self.pool.state()[proxyPool.proxyHash(paused)]['reason'], 'EXISTING_PROXY_PAUSE')


if __name__ == '__main__':
    unittest.main()
