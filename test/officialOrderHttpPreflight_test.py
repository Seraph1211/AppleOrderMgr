"""预检不发代理/官网请求；全部使用临时文件和子进程替身。"""
import contextlib
import hashlib
import importlib.util
import io
import json
import pathlib
import subprocess
import time
import unittest
import uuid
from unittest.mock import patch


def fixture(name, filename):
    spec = importlib.util.spec_from_file_location(name, pathlib.Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


http_fixture = fixture('preflight_http_fixture', 'officialOrderHttpSample_test.py')
batch_fixture = fixture('preflight_batch_fixture', 'officialOrderHttpBatch_test.py')
batch = batch_fixture.batch


class HttpPreflightTests(unittest.TestCase):
    def setUp(self):
        self.case = http_fixture.HttpSampleTests('test_success_preserves_private_configs_and_has_no_password_in_command')
        self.case.setUp()
        self.addCleanup(self.case.doCleanups)

    def test_both_deferred_codes_skip_probes_collector_and_configuration(self):
        for reason in ('ACCOUNT_COOLDOWN', 'ORDER_ATTEMPT_LIMIT'):
            self.case.preflightOutcome = reason
            value, error, probes = self.case.execute()
            self.assertIsNone(error)
            self.assertEqual(value['outcome'], reason)
            self.assertIs(value['preflightOnly'], True)
            self.assertEqual(value['requests'], 0)
            self.assertEqual(value['businessWrites'], 0)
            self.assertIsNone(value['egressHash'])
            self.assertIsNone(value['egressAfterHash'])
            self.assertIs(value['egressVerifiedAfter'], False)
            self.assertEqual(value['cleanup'], {'attempted': False, 'removed': False, 'outcome': 'NOT_NEEDED'})
            self.assertFalse({'runId', 'containerName', 'resultFile'} & set(value))
            self.assertEqual(probes.call_count, 0)
            self.assertFalse((self.case.root / 'private/httpConfig.json').exists())
            self.assertFalse((self.case.root / 'private/httpProxy.json').exists())
        self.assertFalse(any(args[:2] in (['docker', 'create'], ['docker', 'start'], ['docker', 'network'])
                             for args, _kwargs in self.case.calls))
        calls = [args for args, _kwargs in self.case.calls if args[:2] == ['docker', 'run']]
        self.assertTrue(all('--read-only' in args and args[args.index('--network') + 1] ==
                            'apple-account-research-internal' and '--http' in args for args in calls))
        self.assertTrue(all(str(self.case.root) + ':/research:ro' in args for args in calls))

    def test_allowed_preflight_does_not_replace_actual_gate_outcome(self):
        self.case.summary = {'outcome': 'ACCOUNT_COOLDOWN', 'requests': 0}
        value, error, probes = self.case.execute()
        self.assertIsNone(error)
        self.assertEqual(value['outcome'], 'ACCOUNT_COOLDOWN')
        self.assertNotIn('preflightOnly', value)
        self.assertEqual(probes.call_count, 2)
        self.assertTrue(any(args[:2] == ['docker', 'start'] for args, _kwargs in self.case.calls))

    def test_input_failure_and_stop_prevent_preflight_and_probe(self):
        self.case.inputFailure = True
        value, _error, probes = self.case.execute()
        self.assertEqual(value['failedStage'], 'input-read')
        self.assertEqual(probes.call_count, 0)
        self.assertFalse(any(args[:2] == ['docker', 'run'] for args, _kwargs in self.case.calls))
        self.case.inputFailure = False
        self.case.calls.clear()
        (self.case.root / 'private/STOP').touch()
        value, _error, probes = self.case.execute()
        self.assertEqual(value['outcome'], 'REQUEST_STOPPED')
        self.assertEqual(probes.call_count, 0)
        self.assertEqual(self.case.calls, [])

    def test_malformed_wrong_identity_or_database_failure_never_becomes_deferred(self):
        changes = [{'version': 1}, {'version': 3}, {'version': True}, {'version': 2.0},
                   {'orderId': 241}, {'attempts': True}, {'accountPaused': 1},
                   {'checkedAt': 1}, {'planSha256': 'f' * 64}, {'inputSha256': 'f' * 64},
                   {'outcome': 'SUCCEEDED'}, {'outcome': 'ACCOUNT_COOLDOWN'}, {'extra': 'not-allowed'}]
        original = self.case.subprocess
        for change in changes + [None]:
            def altered(args, **kwargs):
                result = original(args, **kwargs)
                if args[:2] == ['docker', 'run']:
                    if change is None:
                        return subprocess.CompletedProcess(args, 2, b'', b'private-server-details')
                    result_value = json.loads(result.stdout)
                    result_value.update(change)
                    return subprocess.CompletedProcess(args, 0, json.dumps(result_value).encode(), b'')
                return result
            with self.subTest(change=change), patch.object(self.case, 'subprocess', side_effect=altered):
                value, _error, probes = self.case.execute()
            self.assertEqual(value['outcome'], 'GATE_PREFLIGHT_FAILED')
            self.assertEqual(value['failedStage'], 'preflight')
            self.assertEqual(probes.call_count, 0)
            self.assertNotIn('private-server-details', json.dumps(value))

    def test_v2_allows_ninth_and_denies_tenth_existing_attempt(self):
        original = self.case.subprocess
        cases = [(3, 'HTTP_PREFLIGHT_ALLOWED', 'SUCCEEDED'),
                 (9, 'HTTP_PREFLIGHT_ALLOWED', 'SUCCEEDED'),
                 (10, 'ORDER_ATTEMPT_LIMIT', 'ORDER_ATTEMPT_LIMIT'),
                 (11, 'ORDER_ATTEMPT_LIMIT', 'ORDER_ATTEMPT_LIMIT'),
                 (9, 'ORDER_ATTEMPT_LIMIT', 'GATE_PREFLIGHT_FAILED'),
                 (10, 'HTTP_PREFLIGHT_ALLOWED', 'GATE_PREFLIGHT_FAILED')]
        for attempts, reason, expected in cases:
            def altered(args, **kwargs):
                result = original(args, **kwargs)
                if args[:2] == ['docker', 'run']:
                    value = json.loads(result.stdout)
                    value.update(attempts=attempts, outcome=reason)
                    return subprocess.CompletedProcess(args, 0, json.dumps(value).encode(), b'')
                return result
            with self.subTest(attempts=attempts, reason=reason), patch.object(self.case, 'subprocess', side_effect=altered):
                value, error, probes = self.case.execute()
            self.assertIsNone(error)
            self.assertEqual(value['outcome'], expected)
            self.assertEqual(probes.call_count, 2 if expected == 'SUCCEEDED' else 0)

    def test_preflight_timeout_attempts_bounded_cleanup_and_stops(self):
        original = self.case.subprocess
        def timed(args, **kwargs):
            if args[:2] == ['docker', 'run']:
                raise subprocess.TimeoutExpired(args, 30)
            return original(args, **kwargs)
        with patch.object(self.case, 'subprocess', side_effect=timed):
            value, _error, probes = self.case.execute()
        self.assertEqual(value['outcome'], 'GATE_PREFLIGHT_FAILED')
        self.assertEqual(probes.call_count, 0)
        cleanups = [(args, kwargs) for args, kwargs in self.case.calls if args[:2] == ['docker', 'rm']]
        self.assertTrue(cleanups)
        self.assertEqual(cleanups[-1][1]['timeout'], 10)


class BatchPreflightTests(unittest.TestCase):
    def setUp(self):
        self.case = batch_fixture.BatchTests('test_default_preview_never_passes_apply')
        self.case.setUp()
        self.addCleanup(self.case.doCleanups)
        self.calls = []
        self.change = {}
        self.preflight_change = {}

    def child(self, command, _timeout):
        self.calls.append(command)
        self.assertTrue(command[1].endswith('runHttpSample.py'))
        order = int(command[command.index('--id') + 1])
        now = time.time()
        input_path = self.case.save('request-' + str(order) + '.json', {'synthetic': True})
        result = {'outcome': 'ACCOUNT_COOLDOWN', 'requests': 0, 'preflightOnly': True,
                  'attemptId': uuid.uuid4().hex, 'targetOrderId': order, 'proxyIndex': int(command[-1]),
                  'startedAt': now - 2, 'finishedAt': now, 'elapsedSeconds': 2.0,
                  'egressHash': None, 'egressAfterHash': None, 'egressVerifiedAfter': False,
                  'businessWrites': 0, 'cleanup': {'attempted': False, 'removed': False, 'outcome': 'NOT_NEEDED'},
                  'preflight': {'version': 2, 'outcome': 'ACCOUNT_COOLDOWN', 'orderId': order,
                                'checkedAt': now - 1, 'accountPaused': True, 'attempts': 0,
                                'planSha256': hashlib.sha256((self.case.root / 'private/plan.json').read_bytes()).hexdigest(),
                                'inputSha256': hashlib.sha256(input_path.read_bytes()).hexdigest()}}
        result['preflight'].update(self.preflight_change)
        result.update(self.change)
        self.case.save('http-sample-' + str(order) + '-' + result['attemptId'] + '.json', result)
        return result

    def execute(self, apply=False):
        with patch.object(batch, 'child', side_effect=self.child), contextlib.redirect_stdout(io.StringIO()):
            return batch.execute(self.case.root, [1], 1, apply=apply)

    def test_deferred_preflight_finishes_pass_without_apply_in_both_modes_and_replays(self):
        for mode in (False, True):
            self.assertEqual(self.execute(mode)['outcome'], 'BATCH_PASS_FINISHED')
            self.assertEqual(self.execute(mode)['processedThisRun'], 0)
        self.assertEqual(len(self.calls), 2)

    def test_new_marker_rejects_legacy_or_forged_collection_fields(self):
        self.change = {'runId': 99}
        with self.assertRaisesRegex(RuntimeError, 'BATCH_SAMPLE_AUDIT_INVALID'):
            self.execute()
        with self.assertRaises(RuntimeError):
            self.execute(True)
        self.assertEqual(len(self.calls), 1)

    def test_boolean_zero_cannot_claim_no_requests_or_business_writes(self):
        self.change = {'requests': False, 'businessWrites': False}
        with self.assertRaisesRegex(RuntimeError, 'BATCH_SAMPLE_AUDIT_INVALID'):
            self.execute()

    def test_preflight_source_audit_tampering_blocks_replay(self):
        self.execute()
        audit = next((self.case.root / 'private').glob('http-sample-*.json'))
        value = json.loads(audit.read_text())
        value['preflight']['attempts'] = 2
        audit.write_text(json.dumps(value), encoding='utf-8')
        with self.assertRaisesRegex(RuntimeError, 'BATCH_SAMPLE_AUDIT_INVALID'):
            self.execute()
        self.assertEqual(len(self.calls), 1)

    def rewrite_deferred(self, version, attempts, reason):
        journal = self.case.root / 'private/http-batch-dry-run.jsonl'
        rows = [json.loads(line) for line in journal.read_text().splitlines()]
        value = rows[1]['sample']
        value['preflight'].update(version=version, attempts=attempts, accountPaused=False, outcome=reason)
        value['outcome'] = reason
        self.case.save('http-sample-1-' + value['attemptId'] + '.json', value)
        rows[-1]['sampleOutcome'] = reason
        journal.write_text(''.join(json.dumps(row) + '\n' for row in rows), encoding='utf-8')

    def test_historical_v1_attempt_limit_replays_under_original_three_attempt_rule(self):
        self.execute()
        self.rewrite_deferred(1, 3, 'ORDER_ATTEMPT_LIMIT')
        self.calls.clear()
        self.assertEqual(self.execute()['processedThisRun'], 0)
        self.assertFalse(self.calls)

    def test_historical_v1_cooldown_remains_valid(self):
        self.execute()
        journal = self.case.root / 'private/http-batch-dry-run.jsonl'
        rows = [json.loads(line) for line in journal.read_text().splitlines()]
        value = rows[1]['sample']
        value['preflight']['version'] = 1
        self.case.save('http-sample-1-' + value['attemptId'] + '.json', value)
        journal.write_text(''.join(json.dumps(row) + '\n' for row in rows), encoding='utf-8')
        self.calls.clear()
        self.assertEqual(self.execute()['processedThisRun'], 0)
        self.assertFalse(self.calls)

    def test_v2_tenth_attempt_limit_replays(self):
        self.execute()
        self.rewrite_deferred(2, 10, 'ORDER_ATTEMPT_LIMIT')
        self.calls.clear()
        self.assertEqual(self.execute()['processedThisRun'], 0)
        self.assertFalse(self.calls)

    def test_historical_version_does_not_permit_mismatched_threshold_or_unknown_version(self):
        self.execute()
        for version, attempts in ((1, 2), (2, 3), (2, 9), (3, 10), (True, 3), (2.0, 10)):
            self.rewrite_deferred(version, attempts, 'ORDER_ATTEMPT_LIMIT')
            with self.subTest(version=version, attempts=attempts), self.assertRaises(RuntimeError):
                self.execute()
        self.assertEqual(len(self.calls), 1)

    def test_new_child_cannot_return_v1_even_for_unchanged_cooldown_reason(self):
        self.preflight_change = {'version': 1}
        with self.assertRaisesRegex(RuntimeError, 'BATCH_SAMPLE_AUDIT_INVALID'):
            self.execute()
        self.assertEqual(len(self.calls), 1)


if __name__ == '__main__':
    unittest.main()
