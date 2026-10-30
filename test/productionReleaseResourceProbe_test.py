import json
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import productionRelease as release
import productionReleaseResourceProbe as probe


class FakeResponse(object):
    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self, _limit):
        return json.dumps({
            'success': True,
            'data': {'status': 'healthy', 'db': 'ok'},
        }).encode('utf-8')

    def getcode(self):
        return 200


class ProductionReleaseResourceProbeTest(unittest.TestCase):
    def test_probe_collects_only_local_health_disk_and_lock_metrics(self):
        with tempfile.TemporaryDirectory() as temporary:
            completed = mock.Mock(returncode=0, stdout=b'{"lockWaitMs":17}')
            with mock.patch.object(probe.urllib.request, 'urlopen',
                                   return_value=FakeResponse()), \
                    mock.patch.object(probe.subprocess, 'run',
                                      return_value=completed):
                result = probe.collect(
                    temporary, 'http://127.0.0.1/api/health/ready',
                    ['lock-probe'], 3)
        self.assertTrue(result['passed'])
        self.assertGreater(result['diskFreeBytes'], 0)
        self.assertGreaterEqual(result['apiLatencyMs'], 0)
        self.assertEqual(result['lockWaitMs'], 17)
        invalidUrls = (
            'https://example.com/api/health/ready',
            'http://127.0.0.1/api/orders/delete',
            'http://127.0.0.1/api/health/ready?mutate=1',
            'http://localhost/api/health/ready',
            'http://[::1]/api/health/ready#fragment',
        )
        with mock.patch.object(probe.urllib.request, 'urlopen') as urlopen:
            for url in invalidUrls:
                with self.subTest(url=url), self.assertRaises(
                        probe.ProbeError) as raised:
                    probe.probeApi(url, 3)
                self.assertEqual(raised.exception.code, 'API_PROBE_URL_INVALID')
        urlopen.assert_not_called()

    def test_parallel_group_stops_starting_new_work_and_degrades_to_serial(self):
        executor = release.ReleaseExecutor.__new__(release.ReleaseExecutor)
        executor.forceSerial = False
        active = {'count': 0, 'maximum': 0}
        lock = threading.Lock()
        starts = {}
        finishes = {}
        completed = []
        probes = []

        def execute(step):
            with lock:
                starts[step['id']] = time.monotonic()
                active['count'] += 1
                active['maximum'] = max(active['maximum'], active['count'])
            time.sleep(0.02 if step['id'] == 'one' else 0.05)
            with lock:
                active['count'] -= 1
                finishes[step['id']] = time.monotonic()

        def resource(reason):
            probes.append(reason)
            pressure = reason == 'parallel-group-progress'
            executor.forceSerial = pressure
            return {'pressure': pressure}

        executor.executeStep = execute
        executor.markCompleted = lambda step: completed.append(step['id'])
        executor.runResourceProbe = resource
        steps = [{'id': name} for name in ('one', 'two', 'three')]
        executor.runParallelGroup(steps)
        self.assertEqual(active['maximum'], 2)
        self.assertEqual(set(completed), {'one', 'two', 'three'})
        self.assertGreaterEqual(starts['three'], max(finishes['one'], finishes['two']))
        self.assertIn('parallel-group-progress', probes)
        self.assertIn('serial-fallback-before-step', probes)

    def test_resource_probe_error_is_fail_closed(self):
        executor = release.ReleaseExecutor.__new__(release.ReleaseExecutor)
        executor.plan = {
            'resourceGuard': {
                'argv': ['probe'], 'timeoutSeconds': 3,
                'minimumDiskFreeBytes': 1,
                'maximumApiLatencyMs': 100,
                'maximumLockWaitMs': 0,
            },
        }
        executor.resourceProbeCount = 0
        executor.forceSerial = False
        executor.evidenceDir = Path(tempfile.mkdtemp())
        executor.recorder = mock.Mock()
        failed = mock.Mock(returncode=9, stdout=b'sensitive output')
        with mock.patch.object(release.subprocess, 'run', return_value=failed):
            with self.assertRaises(release.ReleaseError) as raised:
                executor.runResourceProbe('preflight')
        self.assertEqual(raised.exception.code, 'RESOURCE_PROBE_FAILED')
        self.assertFalse(list(executor.evidenceDir.iterdir()))


if __name__ == '__main__':
    unittest.main()
