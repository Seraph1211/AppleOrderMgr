"""预检真实能力回归与失败关闭；不连接生产、不执行真实备份。"""
import hashlib
import importlib.util
import json
import os
import shutil
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('preflight', str(ROOT / 'scripts/productionReleasePreflight.py'))
PREFLIGHT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PREFLIGHT)


class PreflightTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.old = self.release('old', ['原筛选', '范围导出'])
        self.new = self.release('new', ['原筛选', '范围导出', '新查询'])
        self.current = self.root / 'current'
        self.current.symlink_to(self.old)
        self.input = self.root / 'classification.json'
        self.input.write_text(json.dumps({'releaseId': 'test-release', 'releaseClass': 'C'}))
        self.plan = {
            'schemaVersion': 1, 'releaseId': 'test-release',
            'candidate': str(self.new), 'expectedCurrent': str(self.old),
            'current': str(self.current), 'nginxUsers': ['33:33', '997:995'],
            'output': str(self.root / 'proof.json'), 'classification': str(self.input),
            'inputs': [{'path': str(self.input),
                        'sha256': hashlib.sha256(self.input.read_bytes()).hexdigest()}],
            'checks': [{'id': name, 'argv': [sys.executable, '-c', 'pass'],
                        'cwd': str(self.root), 'timeoutSeconds': 5}
                       for name in ('test-environment', 'candidate-acceptance')],
        }
        for name in ('source-capabilities.json', 'runtime-source-proof.json'):
            (self.new / name).write_text(json.dumps({
                'schemaVersion': 1, 'capabilities': [{'id': 'logs'}], 'sourceInventory': {},
            }))
        (self.new / 'runtime-source-proof.json').write_text(json.dumps({
            'passed': True, 'sourceManifestSha256': hashlib.sha256(
                (self.new / 'source-capabilities.json').read_bytes()).hexdigest(),
        }))
        for name in ('source-capabilities.json', 'runtime-source-proof.json', 'capabilities.json'):
            path = self.new / name
            self.plan['inputs'].append({'path': str(path),
                                       'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
        self.path = self.root / 'plan.json'
        check = PREFLIGHT.GATE.check
        self.gateMock = mock.patch.object(PREFLIGHT.GATE, 'check', side_effect=lambda release, nginxUser, expectedCurrent: check(release, nginxUser, True, expectedCurrent))
        self.calls = self.gateMock.start()
        self.addCleanup(self.gateMock.stop)

    def release(self, name, tokens):
        release = self.root / name
        (release / 'frontend/assets').mkdir(parents=True)
        url = '/assets/' + name + '.js'
        (release / 'frontend/index.html').write_text('<script src="' + url + '"></script>')
        asset = release / 'frontend' / url.lstrip('/')
        asset.write_text(';'.join(tokens), encoding='utf-8')
        (release / 'capabilities.json').write_text(json.dumps({
            'schemaVersion': 1, 'assets': {url: hashlib.sha256(asset.read_bytes()).hexdigest()},
            'capabilities': [{'id': 'logs', 'tokens': {token: url for token in tokens}}],
        }))
        if name == 'new':
            (release / 'rollback-target.json').write_text(json.dumps({
                'releasePath': str(self.old),
                'assets': {'/assets/old.js': hashlib.sha256((self.old / 'frontend/assets/old.js').read_bytes()).hexdigest()},
                'indexSha256': hashlib.sha256((self.old / 'frontend/index.html').read_bytes()).hexdigest(),
            }))
        PREFLIGHT.GATE.prepare(release)
        return release

    def runPlan(self):
        self.path.write_text(json.dumps(self.plan))
        return PREFLIGHT.runPreflight(str(self.path))

    def test_both_identities_and_history_on_repeated_checks(self):
        self.assertTrue(self.runPlan()['passed'])
        self.assertTrue(self.runPlan()['passed'])
        self.assertEqual(len(list(self.root.glob('proof-*.json'))), 2)
        self.assertEqual([call.kwargs['nginxUser'] for call in self.calls.call_args_list],
                         ['33:33', '997:995'] * 2)

    def test_old_token_missing_fails_before_any_test_command(self):
        proof = self.new / 'capabilities.json'
        payload = json.loads(proof.read_text())
        del payload['capabilities'][0]['tokens']['范围导出']
        proof.write_text(json.dumps(payload))
        self.plan['inputs'][-1]['sha256'] = hashlib.sha256(proof.read_bytes()).hexdigest()
        with mock.patch.object(PREFLIGHT.subprocess, 'run') as command:
            with self.assertRaisesRegex(Exception, 'RELEASE_CAPABILITY_DROPPED'):
                self.runPlan()
            command.assert_not_called()
        self.assertFalse(json.loads((self.root / 'proof.json').read_text())['passed'])

    def test_environment_failure_blocks_acceptance(self):
        self.plan['checks'][0]['argv'] = [sys.executable, '-c', 'raise SystemExit(2)']
        with self.assertRaisesRegex(Exception, 'PREFLIGHT_CHECK_FAILED:test-environment'):
            self.runPlan()
        report = json.loads((self.root / 'proof.json').read_text())
        self.assertEqual(len(report['checks']), 1)

    def test_changed_input_rejected(self):
        self.input.write_text(json.dumps({'releaseId': 'test-release', 'releaseClass': 'D'}))
        with self.assertRaisesRegex(Exception, 'PREFLIGHT_INPUT_CHANGED'):
            self.runPlan()

    def test_current_changed_rejected(self):
        self.current.unlink()
        self.current.symlink_to(self.new)
        with self.assertRaisesRegex(Exception, 'PREFLIGHT_CURRENT_CHANGED'):
            self.runPlan()

    def test_timeout_fails_closed(self):
        self.plan['checks'][0]['argv'] = [sys.executable, '-c', 'import time; time.sleep(10)']
        self.plan['checks'][0]['timeoutSeconds'] = 1
        with self.assertRaisesRegex(Exception, 'PREFLIGHT_CHECK_TIMEOUT'):
            self.runPlan()

    def test_changes_during_acceptance_rejected(self):
        self.plan['checks'][1]['argv'] = [sys.executable, '-c',
            'from pathlib import Path; Path("classification.json").write_text("changed")']
        with self.assertRaisesRegex(Exception, 'PREFLIGHT_INPUT_CHANGED'):
            self.runPlan()

    def test_missing_check_cannot_be_skipped(self):
        self.runPlan()
        self.plan['checks'].pop()
        with self.assertRaisesRegex(Exception, 'PREFLIGHT_CHECKS_REQUIRED'):
            self.runPlan()
        self.assertFalse(json.loads((self.root / 'proof.json').read_text())['passed'])

    def test_output_cannot_overwrite_frozen_input(self):
        original = self.input.read_bytes()
        self.plan['output'] = str(self.input)
        with self.assertRaisesRegex(Exception, 'PREFLIGHT_OUTPUT_CONFLICT'):
            self.runPlan()
        self.assertEqual(self.input.read_bytes(), original)

    def test_relative_and_symlink_paths_rejected(self):
        with self.assertRaisesRegex(Exception, 'PREFLIGHT_PATH_INVALID'):
            PREFLIGHT.safePath('/tmp/../candidate')
        with self.assertRaisesRegex(Exception, 'PREFLIGHT_PATH_SYMLINK'):
            PREFLIGHT.safePath(str(self.current / 'frontend'))

    def test_cli_backup_requires_preflight_before_external_programs(self):
        for name, args in [
            ('productionReleaseBackup.py', ['database-backup', '--database', 'unused',
             '--output', '/tmp/unused', '--validation-sql', '/tmp/unused', '--evidence', '/tmp/unused']),
            ('productionReleaseFiles.py', ['snapshot']),
        ]:
            result = subprocess.run([sys.executable, str(ROOT / 'scripts' / name)] + args,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(b'--preflight-plan', result.stderr)

    @unittest.skipUnless(os.geteuid() == 0 and shutil.which('setpriv'), 'requires Linux setpriv/root')
    def test_real_non_root_identity(self):
        self.gateMock.stop()
        self.root.chmod(0o755)
        self.assertTrue(self.runPlan()['passed'])

    def test_executor_requires_binding(self):
        with self.assertRaisesRegex(Exception, 'PREFLIGHT_BINDING_REQUIRED'):
            PREFLIGHT.RELEASE.preflightBinding({})

class CloseoutTest(unittest.TestCase):
    def test_missing_wrong_release_and_changed_evidence_remain_pending(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            proof = root / 'browser.json'
            plan = {'releaseId': 'test', 'attemptId': 'one', 'evidenceDir': directory,
                    'closeoutEvidence': [{'id': 'browser', 'path': str(proof)}]}
            release = PREFLIGHT.RELEASE
            state = {'status': 'passed', 'planDigest': release.sha256Bytes(release.canonicalBytes(plan))}
            release.writeJsonAtomic(root / 'release-state.json', state)
            recorder = release.EventRecorder(root / 'release-timing.jsonl', 'test', 'one', 'a' * 64)
            recorder.record('verify', 'readback', '2026-11-01T00:00:00.000Z',
                            '2026-11-01T00:00:01.000Z', 1000, 'passed')
            self.assertFalse(release.writeCloseout(plan)['passed'])
            release.writeJsonAtomic(proof, {'passed': True, 'releaseId': 'another'})
            self.assertFalse(release.writeCloseout(plan)['passed'])
            release.writeJsonAtomic(proof, {'passed': True, 'releaseId': 'test'})
            self.assertTrue(release.writeCloseout(plan)['passed'])
            state['status'] = 'rolled_back'
            release.writeJsonAtomic(root / 'release-state.json', state)
            self.assertFalse(release.writeCloseout(plan)['passed'])
            self.assertTrue((root / 'release-summary.json').is_file())


if __name__ == '__main__':
    unittest.main()
