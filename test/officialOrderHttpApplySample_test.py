"""回写协调器离线验证：持久备份、明确写入、未知提交停止。"""
import contextlib
import copy
import fcntl
import hashlib
import importlib.util
import io
import json
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).parents[1] / 'scripts/officialOrder'))

SPEC = importlib.util.spec_from_file_location(
    'http_apply_sample', pathlib.Path(__file__).parents[1] / 'scripts/officialOrder/applyHttpSample.py')
sample = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(sample)


class HttpApplySampleTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = pathlib.Path(self.directory.name)
        self.private = self.root / 'private'
        self.private.mkdir()
        plan = self.private / 'plan.json'
        plan.write_text('{"fixture":true}', encoding='utf-8')
        plan.chmod(0o600)
        self.audit = 'http-sample-240-' + 'a' * 32 + '.json'
        self.payload = {'version': 1, 'entry': {'id': 240},
                        'audit': {'runId': 12, 'attemptId': 'a' * 32}, 'private': 'private-password'}
        self.basis = {'version': 1, 'planSha256': '1' * 64, 'orderId': 240,
                      'originalRowHash': '2' * 32, 'stableRowHash': '3' * 32,
                      'runId': 12, 'auditSha256': '4' * 64}
        self.preview = {'version': 1, 'mode': 'dry-run', 'orderId': 240, 'runId': 12,
                        'basis': self.basis, 'snapshot': {'order': {'notes': 'private-password'}, 'devices': []},
                        'payloadSha256': '5' * 64, 'beforeHash': '6' * 32, 'afterHash': '6' * 32,
                        'devicesHash': '7' * 64, 'stableRowHash': '3' * 32,
                        'statusSaved': False, 'dateFilled': False, 'businessWrites': 0,
                        'statusAction': 'UPDATE_STATUS', 'dateAction': 'FILL_DATE'}
        self.result = dict(self.preview, mode='apply', statusSaved=True, dateFilled=True,
                           afterHash='8' * 32, businessWrites=1)
        self.databaseCalls = []
        self.applyFailure = None
        self.backupObservedBeforeApply = False
        self.verifyHook = None
        self.databaseHook = None

    def database(self, root, payload, mode, basis=None, preview=None, beforeStart=None):
        if beforeStart is not None:
            beforeStart()
        self.databaseCalls.append((mode, payload, basis, preview))
        if self.databaseHook:
            self.databaseHook(mode)
        if mode == 'dry-run':
            return copy.deepcopy(self.preview)
        paths = list(self.private.glob('http-apply-240-*-preview.json'))
        self.assertEqual(len(paths), 1)
        self.assertEqual(sample.readPrivate(paths[0]), preview)
        self.assertEqual(basis, preview['basis'])
        self.assertEqual(sample.readPrivate(self.private / 'http-apply-intent-240.json')['state'], 'APPLY_STARTED')
        self.backupObservedBeforeApply = True
        if self.applyFailure:
            raise self.applyFailure
        return copy.deepcopy(self.result)

    def execute(self, apply=False):
        args = ['apply', '--root', str(self.root), '--audit', self.audit]
        if apply:
            args.append('--apply')
        output = io.StringIO()
        def verified(*args):
            if self.verifyHook:
                self.verifyHook()
            return self.payload
        with patch.object(sys, 'argv', args), patch.object(sample, 'verify', side_effect=verified) as verify, \
                patch.object(sample, 'database', side_effect=self.database), patch.object(sample.os, 'chown'), \
                contextlib.redirect_stdout(output):
            value = sample.main()
        lines = output.getvalue().splitlines()
        self.assertEqual(len(lines), 1)
        self.assertEqual(value, json.loads(lines[0]))
        return value, verify

    def test_default_is_read_only_and_persists_full_private_preview(self):
        value, _ = self.execute()
        self.assertEqual(value['outcome'], 'DRY_RUN')
        self.assertEqual([x[0] for x in self.databaseCalls], ['dry-run'])
        self.assertEqual(sample.readPrivate(self.private / value['previewFile']), self.preview)
        self.assertNotIn('private-password', json.dumps(value))
        self.assertEqual((self.private / value['previewFile']).stat().st_mode & 0o777, 0o600)
        self.assertFalse((self.private / 'http-apply-intent-240.json').exists())

    def test_apply_requires_backup_before_write_and_preserves_all_results(self):
        value, _ = self.execute(True)
        self.assertEqual(value['outcome'], 'SUCCEEDED')
        self.assertEqual([x[0] for x in self.databaseCalls], ['dry-run', 'apply'])
        self.assertTrue(self.backupObservedBeforeApply)
        self.assertEqual(sample.readPrivate(self.private / value['resultFile']), self.result)
        self.assertEqual(sample.readPrivate(self.private / value['basisFile']), self.basis)
        self.assertNotIn('private-password', json.dumps(value))
        self.assertEqual(sample.readPrivate(self.private / 'http-apply-intent-240.json')['state'], 'APPLIED')

    def test_unknown_commit_stops_without_retry_and_blocks_next_invocation(self):
        self.applyFailure = RuntimeError('MANUAL_RECONCILIATION_REQUIRED')
        first, _ = self.execute(True)
        self.assertEqual(first['outcome'], 'MANUAL_RECONCILIATION_REQUIRED')
        self.assertIsNone(first['businessWrites'])
        self.assertEqual(len(self.databaseCalls), 2)
        second, verify = self.execute(True)
        self.assertEqual(second['outcome'], 'MANUAL_RECONCILIATION_REQUIRED')
        self.assertEqual(len(self.databaseCalls), 2)
        verify.assert_not_called()
        self.assertTrue((self.private / first['previewFile']).is_file())

    def test_successful_same_audit_replay_never_touches_database(self):
        first, _ = self.execute(True)
        self.assertEqual(first['outcome'], 'SUCCEEDED')
        second, verify = self.execute(True)
        self.assertEqual(second['outcome'], 'SUCCEEDED')
        self.assertTrue(second['replayed'])
        self.assertEqual(second['businessWrites'], 0)
        self.assertEqual(len(self.databaseCalls), 2)
        verify.assert_not_called()

    def test_confirmed_rollback_is_not_marked_as_unknown_commit(self):
        self.applyFailure = RuntimeError('HTTP_APPLY_ORDER_CHANGED')
        value, _ = self.execute(True)
        self.assertEqual(value['outcome'], 'HTTP_APPLY_ORDER_CHANGED')
        self.assertEqual(sample.readPrivate(self.private / 'http-apply-intent-240.json')['state'], 'ROLLED_BACK')
        self.assertTrue((self.private / value['auditFile']).is_file())

    def test_preview_storage_failure_prevents_any_apply(self):
        original = sample.writePrivate
        def write(path, value):
            if path.name.endswith('-preview.json'):
                raise OSError('private-password')
            return original(path, value)
        with patch.object(sample, 'writePrivate', side_effect=write):
            value, _ = self.execute(True)
        self.assertEqual(value['outcome'], 'HTTP_APPLY_FAILED')
        self.assertEqual([x[0] for x in self.databaseCalls], ['dry-run'])
        self.assertNotIn('private-password', json.dumps(value))

    def test_post_commit_persistence_failure_is_manual_reconciliation(self):
        original = sample.writePrivate
        def write(path, value):
            if path.name.endswith('-result.json'):
                raise OSError('private-password')
            return original(path, value)
        with patch.object(sample, 'writePrivate', side_effect=write):
            value, _ = self.execute(True)
        self.assertEqual(value['outcome'], 'MANUAL_RECONCILIATION_REQUIRED')
        self.assertEqual(sample.readPrivate(self.private / 'http-apply-intent-240.json')['state'], 'APPLY_STARTED')

    def test_wrong_apply_result_identity_is_never_success(self):
        self.result['orderId'] = 999
        value, _ = self.execute(True)
        self.assertEqual(value['outcome'], 'MANUAL_RECONCILIATION_REQUIRED')

    def test_wrong_preview_identity_prevents_write(self):
        self.preview['runId'] = 99
        value, _ = self.execute(True)
        self.assertEqual(value['outcome'], 'HTTP_APPLY_OUTPUT_INVALID')
        self.assertEqual([x[0] for x in self.databaseCalls], ['dry-run'])

    def test_wrong_verified_identity_prevents_database_access(self):
        self.payload['entry']['id'] = 999
        value, _ = self.execute(True)
        self.assertEqual(value['outcome'], 'HTTP_APPLY_OUTPUT_INVALID')
        self.assertFalse(self.databaseCalls)

    def test_interprocess_lock_prevents_verification_and_releases(self):
        with open(str(self.private / 'http-apply.lock'), 'a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            value, verify = self.execute(True)
            self.assertEqual(value['outcome'], 'HTTP_APPLY_BUSY')
            verify.assert_not_called()
        self.assertEqual(self.execute()[0]['outcome'], 'DRY_RUN')

    def test_private_large_snapshot_over_one_mib_is_preserved(self):
        self.preview['snapshot']['order']['large'] = 'x' * (2 * 1024 * 1024)
        value, _ = self.execute()
        path = self.private / value['previewFile']
        self.assertGreater(path.stat().st_size, 1024 * 1024)
        self.assertEqual(sample.readPrivate(path), self.preview)

    def test_private_file_and_parent_directory_are_fsynced(self):
        with patch.object(sample.os, 'fsync') as fsync, patch.object(sample.os, 'chown'):
            sample.writePrivate(self.private / 'test.json', {'中文': '数据'})
        self.assertEqual(fsync.call_count, 2)
        self.assertEqual(sample.readPrivate(self.private / 'test.json'), {'中文': '数据'})

    def test_private_reads_reject_world_readable_and_symlink(self):
        path = self.private / 'public.json'
        path.write_text('{}', encoding='utf-8')
        path.chmod(0o644)
        with self.assertRaisesRegex(RuntimeError, 'HTTP_APPLY_PRIVATE_FILE_INVALID'):
            sample.readPrivate(path)
        path.chmod(0o600)
        link = self.private / 'link.json'
        link.symlink_to(path)
        with self.assertRaisesRegex(RuntimeError, 'HTTP_APPLY_PRIVATE_FILE_INVALID'):
            sample.readPrivate(link)

    def save_intent(self, state='APPLY_STARTED', order=999, browser=True):
        attempt = 'f' * 32
        prefix = ('browser-receipt-bind-' if browser else 'http-apply-') + str(order) + '-' + attempt
        value = {'state': state, 'orderId': order, 'attemptId': attempt,
                 'sourceAudit': ('browser-sample-' if browser else 'http-sample-') + str(order) + '-' + 'e' * 32 + '.json',
                 'payloadFile': prefix + '-payload.json', 'resultFile': prefix + '-result.json',
                 'auditFile': prefix + '-audit.json'}
        if browser:
            value.update(receiptRunId=42, receiptSha256='c' * 64, payloadSha256='d' * 64)
        else:
            value.update(runId=41, previewFile=prefix + '-preview.json')
            if state == 'ROLLED_BACK': value['outcome'] = 'HTTP_APPLY_ORDER_CHANGED'
        path = self.private / (('browser-receipt-bind-intent-' if browser else 'http-apply-intent-') + str(order) + '.json')
        sample.writePrivate(path, value)
        return path

    def test_global_browser_or_other_http_unknown_blocks_before_verify(self):
        for browser in (True, False):
            path = self.save_intent(browser=browser)
            value, verify = self.execute(True)
            self.assertEqual(value['outcome'], 'MANUAL_RECONCILIATION_REQUIRED')
            verify.assert_not_called()
            self.assertEqual(self.databaseCalls, [])
            path.unlink()

    def test_known_existing_terminal_intents_need_no_new_schema_fields(self):
        self.save_intent('APPLIED', browser=True)
        self.save_intent('ROLLED_BACK', browser=False)
        self.assertEqual(self.execute()[0]['outcome'], 'DRY_RUN')

    def test_strict_intent_keys_identity_types_and_private_file_shape(self):
        path = self.private / 'browser-receipt-bind-intent-999.json'
        for raw in (b'{"state":"UNKNOWN","state":"APPLIED"}',
                    b'{"state":"APPLIED","orderId":999}',
                    b'{"state":"APPLIED","orderId":true}',
                    b'{"state":"APPLIED","orderId":999,"extra":NaN}',
                    b'{"state":"APPLIED","orderId":999,"extra":1e999}', b'{'):
            path.write_bytes(raw); path.chmod(0o600)
            value, verify = self.execute(True)
            self.assertEqual(value['outcome'], 'MANUAL_RECONCILIATION_REQUIRED')
            verify.assert_not_called()
            self.assertEqual(self.databaseCalls, [])
        path.unlink()
        for kind in ('wrong-filename', 'public', 'symlink', 'wrong-id', 'bool-run', 'wrong-reference'):
            path = self.save_intent('APPLIED')
            if kind == 'wrong-filename':
                target = self.private / 'browser-receipt-bind-intent-bad.json'
                path.rename(target)
                path = target
            elif kind == 'public': path.chmod(0o644)
            elif kind == 'symlink': path.unlink(); path.symlink_to('plan.json')
            else:
                value = sample.readPrivate(path)
                value.update({'wrong-id': {'orderId': 998}, 'bool-run': {'receiptRunId': True},
                              'wrong-reference': {'resultFile': '../result.json'}}[kind])
                sample.writePrivate(path, value)
            value, verify = self.execute(True)
            self.assertEqual(value['outcome'], 'MANUAL_RECONCILIATION_REQUIRED')
            verify.assert_not_called()
            path.unlink()
        self.assertEqual(self.databaseCalls, [])

    def test_unknown_created_during_verify_prevents_even_preview(self):
        self.verifyHook = lambda: self.save_intent()
        value, verify = self.execute(True)
        self.assertEqual(value['outcome'], 'MANUAL_RECONCILIATION_REQUIRED')
        verify.assert_called_once()
        self.assertEqual(self.databaseCalls, [])

    def test_unknown_created_during_preview_prevents_intent_and_commit(self):
        self.databaseHook = lambda mode: self.save_intent() if mode == 'dry-run' else None
        value, _ = self.execute(True)
        self.assertEqual(value['outcome'], 'MANUAL_RECONCILIATION_REQUIRED')
        self.assertEqual([call[0] for call in self.databaseCalls], ['dry-run'])
        self.assertFalse((self.private / 'http-apply-intent-240.json').exists())

    def test_async_verify_stop_cleanup_and_plan_changes_block_database(self):
        for kind in ('STOP', 'http-cleanup-blocked.json', 'plan.json'):
            original = (self.private / 'plan.json').read_bytes()
            target = self.private / kind
            self.verifyHook = lambda: sample.writePrivate(target, {'changed': True})
            value, _ = self.execute(True)
            self.assertIn(value['outcome'], ('HTTP_APPLY_STOP_REQUESTED', 'HTTP_APPLY_CLEANUP_PENDING', 'HTTP_APPLY_PLAN_CHANGED'))
            self.assertEqual(self.databaseCalls, [])
            if kind == 'plan.json': target.write_bytes(original)
            else: target.unlink()

    def test_unknown_or_stop_after_own_intent_keeps_started_without_commit(self):
        original = sample.writePrivate
        for kind in ('unknown', 'STOP'):
            def write(path, value):
                original(path, value)
                if path.name == 'http-apply-intent-240.json' and value['state'] == 'APPLY_STARTED':
                    if kind == 'unknown': self.save_intent()
                    else: original(self.private / 'STOP', {})
            with patch.object(sample, 'writePrivate', side_effect=write):
                value, _ = self.execute(True)
            self.assertEqual(value['outcome'], 'MANUAL_RECONCILIATION_REQUIRED')
            self.assertEqual(sample.readPrivate(self.private / 'http-apply-intent-240.json')['state'], 'APPLY_STARTED')
            self.assertTrue(all(call[0] == 'dry-run' for call in self.databaseCalls))
            (self.private / 'http-apply-intent-240.json').unlink()
            (self.private / ('browser-receipt-bind-intent-999.json' if kind == 'unknown' else 'STOP')).unlink()

    def test_own_intent_raw_bytes_change_or_removal_cannot_be_exempted(self):
        original = sample.writePrivate
        for kind in ('format', 'remove'):
            def write(path, value):
                original(path, value)
                if path.name == 'http-apply-intent-240.json' and value['state'] == 'APPLY_STARTED':
                    if kind == 'format': path.write_bytes(path.read_bytes() + b' ')
                    else: path.unlink()
            with patch.object(sample, 'writePrivate', side_effect=write):
                value, _ = self.execute(True)
            self.assertEqual(value['outcome'], 'MANUAL_RECONCILIATION_REQUIRED')
            self.assertTrue(all(call[0] == 'dry-run' for call in self.databaseCalls))
            path = self.private / 'http-apply-intent-240.json'
            if path.exists(): path.unlink()

    def test_prepared_intent_storage_unknown_never_marks_rollback(self):
        original = sample.writePrivate
        def write(path, value):
            original(path, value)
            if path.name == 'http-apply-intent-240.json': raise OSError('directory fsync unknown')
        with patch.object(sample, 'writePrivate', side_effect=write):
            value, _ = self.execute(True)
        self.assertEqual(value['outcome'], 'MANUAL_RECONCILIATION_REQUIRED')
        self.assertEqual(sample.readPrivate(self.private / 'http-apply-intent-240.json')['state'], 'APPLY_STARTED')
        self.assertEqual([call[0] for call in self.databaseCalls], ['dry-run'])

    def test_applied_replay_with_unrelated_unknown_returns_only_old_result(self):
        self.assertEqual(self.execute(True)[0]['outcome'], 'SUCCEEDED')
        count = len(self.databaseCalls)
        self.save_intent()
        value, verify = self.execute(True)
        self.assertTrue(value['replayed'])
        self.assertEqual(value['businessWrites'], 0)
        self.assertEqual(len(self.databaseCalls), count)
        verify.assert_not_called()



class BridgeTests(unittest.TestCase):
    def output(self, value, code=0):
        return subprocess.CompletedProcess([], code, json.dumps(value).encode(), b'private-password')

    def test_missing_or_malformed_apply_stdout_is_unknown_commit(self):
        for output in (b'', b'bad', b'[]'):
            result = subprocess.CompletedProcess([], 0, output, b'private-password')
            with self.assertRaisesRegex(RuntimeError, 'MANUAL_RECONCILIATION_REQUIRED'):
                sample.parseOutput(result, applying=True)

    def test_nonzero_exit_cannot_promote_ok_payload(self):
        with self.assertRaisesRegex(RuntimeError, 'MANUAL_RECONCILIATION_REQUIRED'):
            sample.parseOutput(self.output({'ok': True, 'result': {}}, code=2), applying=True)

    def test_error_with_confirmed_rollback_is_safe_to_report(self):
        with self.assertRaisesRegex(RuntimeError, 'HTTP_APPLY_ORDER_CHANGED'):
            sample.parseOutput(self.output({'ok': False, 'code': 'HTTP_APPLY_ORDER_CHANGED',
                                            'rollbackConfirmed': True}, code=2), applying=True)

    def test_error_without_rollback_proof_is_manual_reconciliation(self):
        with self.assertRaisesRegex(RuntimeError, 'MANUAL_RECONCILIATION_REQUIRED'):
            sample.parseOutput(self.output({'ok': False, 'code': 'HTTP_APPLY_ORDER_CHANGED'}, code=2), applying=True)

    def test_unknown_commit_cannot_be_hidden_by_later_rollback(self):
        with self.assertRaisesRegex(RuntimeError, 'MANUAL_RECONCILIATION_REQUIRED'):
            sample.parseOutput(self.output({'ok': False, 'code': 'MANUAL_RECONCILIATION_REQUIRED',
                                            'rollbackConfirmed': True}, code=2), applying=True)

    def test_db_timeout_is_not_retried_and_credentials_only_use_stdin(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            for name in sample.SOURCES:
                file = root / 'release' / name
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text('module.exports={};', encoding='utf-8')
            with patch.object(sample, 'call', side_effect=subprocess.TimeoutExpired([], 45)) as call:
                with self.assertRaisesRegex(RuntimeError, 'MANUAL_RECONCILIATION_REQUIRED'):
                    sample.database(root, {'password': 'private-password'}, 'apply')
            call.assert_called_once()
            self.assertNotIn('private-password', json.dumps(call.call_args[0]))
            self.assertIn(b'private-password', call.call_args[1]['input'])

    def test_database_rechecks_boundary_after_loading_bundle_before_subprocess(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            for name in sample.SOURCES:
                path = root / 'release' / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('module.exports={};', encoding='utf-8')
            before = lambda: (_ for _ in ()).throw(RuntimeError('MANUAL_RECONCILIATION_REQUIRED'))
            with patch.object(sample, 'call') as call:
                with self.assertRaisesRegex(RuntimeError, 'MANUAL_RECONCILIATION_REQUIRED'):
                    sample.database(root, {}, 'apply', beforeStart=before)
                call.assert_not_called()

    def test_verifier_has_no_network_and_no_writable_research_mount(self):
        with patch.object(sample, 'call', return_value=self.output({'version': 1})) as call:
            sample.verify(pathlib.Path('/research-root'), 'audit.json', 'a' * 32)
        args = call.call_args_list[0][0][0]
        self.assertEqual(args[args.index('--network') + 1], 'none')
        self.assertIn('/research-root:/research:ro', args)
        self.assertNotIn('/research-root:/research:rw', args)
        self.assertEqual(call.call_args_list[-1][1]['timeout'], 15)


@unittest.skipUnless(shutil.which('node'), '需要本地 Node 执行完全离线模块桥接')
class NodeBridgeTests(unittest.TestCase):
    def execute(self, failure):
        helper = """
module.exports.applyHttpPayload = async (client, payload, options) => {
  await client.query('BEGIN');
  try {
    await client.query('UPDATE synthetic');
    await client.query('COMMIT');
    return { mode: options.mode, orderId: 240, private: 'private-password' };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
};
"""
        bundle = {'scripts/officialPickupBackfill/applyHttpResult.js': helper}
        script = ('const bundle=' + json.dumps(bundle) + ';const input={mode:"apply",payload:{}};' + sample.BRIDGE)
        harness = r"""
const realRequire = require;
class TestModule extends realRequire('module') {}
const failure = FAILURE;
class FakeClient {
  async connect() {}
  async end() {}
  async query(sql) {
    if (sql.startsWith('SELECT current_database')) return {rows:[{name:'business',orders:'orders'}]};
    if ((failure === 'commit' && sql === 'COMMIT') ||
        (failure === 'update' && sql.startsWith('UPDATE'))) {
      throw Object.assign(Error('private-password'), {code:'HTTP_APPLY_ORDER_CHANGED'});
    }
    return {rows:[]};
  }
}
TestModule.createRequire = () => name => name === 'pg' ? {Client:FakeClient} : realRequire(name);
const isolatedProcess = {env:{NODE_ENV:'production',DB_HOST:'fake-business',DB_NAME:'business'},
                         stdout:process.stdout,exitCode:0};
new Function('require','process',SCRIPT)(
  name => name === 'module' ? TestModule : realRequire(name), isolatedProcess);
""".replace('FAILURE', json.dumps(failure)).replace('SCRIPT', json.dumps(script))
        result = subprocess.run([shutil.which('node'), '-'], input=harness.encode('utf-8'),
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
        self.assertEqual(result.returncode, 0)
        return json.loads(result.stdout.decode('utf-8'))

    def test_compiled_helper_uses_private_pipe_without_api_files(self):
        result = self.execute(None)
        self.assertTrue(result['ok'])
        self.assertEqual(result['result']['orderId'], 240)

    def test_commit_rejection_stays_unknown_after_successful_rollback(self):
        result = self.execute('commit')
        self.assertFalse(result['ok'])
        self.assertEqual(result['code'], 'MANUAL_RECONCILIATION_REQUIRED')
        self.assertFalse(result['rollbackConfirmed'])
        self.assertNotIn('private-password', json.dumps(result))

    def test_known_precommit_error_reports_confirmed_rollback(self):
        result = self.execute('update')
        self.assertFalse(result['ok'])
        self.assertEqual(result['code'], 'HTTP_APPLY_ORDER_CHANGED')
        self.assertTrue(result['rollbackConfirmed'])


if __name__ == '__main__':
    unittest.main()
