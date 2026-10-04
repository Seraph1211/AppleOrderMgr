"""宿主队列回归：不得调用 Docker、官网或真实账号。"""
import json
import runpy
import subprocess
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

QUEUE = runpy.run_path('scripts/runOfficialOrderQueue.py', run_name='test_queue')


class QueueProtocolTest(unittest.TestCase):
    def collect(self, stdout='', stderr='', code=1):
        result = subprocess.CompletedProcess(args=[], returncode=code, stdout=stdout, stderr=stderr)
        with patch.object(QUEUE['subprocess'], 'run', return_value=result):
            return QUEUE['collect']({'id': 'synthetic-job', 'orderId': 249})

    def test_input_error_is_preserved(self):
        for error in ['ORDER_CREDENTIALS_MISSING', 'ACCOUNT_REFERENCE_CONFLICT',
                      'CREDENTIAL_DECRYPT_FAILED', 'CREDENTIAL_SNAPSHOT_MISMATCH',
                      'ORDER_ACCOUNT_AMBIGUOUS', 'ACCOUNT_MARKED_INVALID']:
            result = self.collect(stderr=json.dumps({'outcome': error, 'stage': 'input'}))
            self.assertEqual(result['outcome'], error)
            self.assertNotIn('result', result)

    def test_unknown_stderr_cannot_leak_as_code(self):
        result = self.collect(stderr='private data\n' + json.dumps({'outcome': 'PRIVATE_SECRET_123'}))
        self.assertEqual(result['outcome'], 'COLLECTOR_FAILED')
        self.assertNotIn('private', json.dumps(result))

    def test_stderr_cannot_create_success(self):
        self.assertEqual(self.collect(stderr='{"outcome":"SUCCEEDED"}')['outcome'], 'COLLECTOR_FAILED')

    def test_legacy_input_failure_and_busy_are_classified(self):
        self.assertEqual(self.collect(stderr='READ_ONLY_ORDER_INPUT_FAILED\n')['outcome'], 'ORDER_INPUT_READ_FAILED')
        self.assertEqual(self.collect(stderr='COLLECTOR_BUSY\n')['outcome'], 'COLLECTOR_BUSY')

    def test_stdout_failure_is_not_overridden_by_stderr(self):
        self.assertEqual(self.collect(stdout='{"outcome":"HTTP_541"}', stderr='{"outcome":"INPUT_INVALID"}')['outcome'], 'HTTP_541')

    def test_failed_process_cannot_commit_success(self):
        self.assertEqual(self.collect(stdout='{"outcome":"SUCCEEDED"}', code=2)['outcome'], 'COLLECTOR_EXIT_FAILED')

    def test_stdout_noise_and_invalid_json_are_ignored(self):
        self.assertEqual(self.collect(stdout='loading\n[]\n{"outcome":123}\n', stderr='{"outcome":"INPUT_INVALID"}')['outcome'], 'INPUT_INVALID')

    def test_shell_removes_partial_private_input_and_never_starts_browser(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'private').mkdir()
            (root / 'release/scripts').mkdir(parents=True)
            (root / 'release/scripts/readOfficialOrderInput.js').write_text('// synthetic', encoding='utf-8')
            (root / 'bin').mkdir()
            commands = {
                'flock': '#!/bin/sh\nexit 0\n',
                'docker': '#!/bin/sh\nif [ "$1" = "inspect" ]; then exit 1; fi\n'
                          'if [ "$1" = "exec" ]; then echo partial-private-input; '
                          'echo \'{"outcome":"ORDER_CREDENTIALS_MISSING","stage":"input"}\' >&2; exit 1; fi\n'
                          'echo "unexpected-docker-call" >&2\nexit 99\n'
            }
            for name, script in commands.items():
                target = root / 'bin' / name
                target.write_text(script, encoding='utf-8')
                target.chmod(0o700)
            result = subprocess.run(['bash', 'scripts/runOfficialOrderServer.sh', '249'],
                env=dict(os.environ, OFFICIAL_ORDER_ROOT=str(root), PATH=str(root / 'bin') + os.pathsep + os.environ['PATH']),
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(list((root / 'private').glob('request-*')), [])
            self.assertNotIn('partial-private-input', result.stdout + result.stderr)
            self.assertNotIn('unexpected-docker-call', result.stderr)
            self.assertEqual(QUEUE['read_summary'](result)['outcome'], 'ORDER_CREDENTIALS_MISSING')

    def test_account_group_partial_success_and_single_launch(self):
        job = {'id': 'a', 'orderId': 249, 'leaseToken': 'lease', 'accountGroupId': 'group',
               'jobs': [{'id': 'a', 'orderId': 249, 'leaseToken': 'lease'},
                        {'id': 'b', 'orderId': 250, 'leaseToken': 'lease'}]}
        summary = {'outcome': 'REQUEST_BUDGET', 'results': [
            {'orderId': 249, 'outcome': 'SUCCEEDED', 'resultFile': '/private/order-249-run-21.json'},
            {'orderId': 250, 'outcome': 'REQUEST_BUDGET'}]}
        result = subprocess.CompletedProcess(args=[], returncode=2,
            stdout=json.dumps(summary), stderr='')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'private/results').mkdir(parents=True)
            (root / 'private/results/order-249-run-21.json').write_text('{"systemOrderId":249}')
            # runpy functions retain their own module globals.
            with patch.dict(QUEUE['collect'].__globals__, ROOT=str(root)):
                with patch.object(QUEUE['subprocess'], 'run', return_value=result) as run:
                    payload = QUEUE['collect'](job)
                    self.assertEqual(run.call_count, 1)
                    self.assertEqual(run.call_args[1]['env']['OFFICIAL_ACCOUNT_GROUP'], 'group')
                    self.assertEqual(payload['results'][0]['result']['systemOrderId'], 249)
                    self.assertEqual(payload['results'][1]['outcome'], 'REQUEST_BUDGET')
                    self.assertNotIn('result', payload['results'][1])

    def test_account_group_rejects_duplicate_unclaimed_and_untrusted_success(self):
        job = {'id': 'a', 'orderId': 249, 'leaseToken': 'lease', 'accountGroupId': 'group',
               'jobs': [{'id': 'a', 'orderId': 249, 'leaseToken': 'lease'}]}
        for rows in [[{'orderId': 250}], [{'orderId': 249}, {'orderId': 249}]]:
            result = subprocess.CompletedProcess(args=[], returncode=2,
                stdout=json.dumps({'outcome': 'PARTIAL', 'results': rows}), stderr='')
            with patch.object(QUEUE['subprocess'], 'run', return_value=result):
                with self.assertRaises(RuntimeError):
                    QUEUE['collect'](job)
        result = subprocess.CompletedProcess(args=[], returncode=1,
            stdout=json.dumps({'outcome': 'SUCCEEDED', 'results': [{'orderId': 249, 'outcome': 'SUCCEEDED'}]}), stderr='')
        with patch.object(QUEUE['subprocess'], 'run', return_value=result):
            self.assertEqual(QUEUE['collect'](job)['results'][0]['outcome'], 'COLLECTOR_FAILED')


if __name__ == '__main__':
    unittest.main()
