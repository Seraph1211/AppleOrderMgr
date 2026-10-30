"""生产能力回退门禁：覆盖旧源码、旧构建、伪造证明和能力清单丢失。"""
import importlib.util
import json
import io
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, str(ROOT / relative))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


GUARD = load('sourceGuardTest', 'scripts/productionSourceGuard.py')
GATE = load('sourceGuardGateTest', 'scripts/productionFrontendGate.py')


class ProductionSourceGuardTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        (self.root / 'config').mkdir()
        (self.root / 'src').mkdir()
        (self.root / 'src/feature.js').write_text('function restoredFeature() {}', encoding='utf-8')
        self.contract = {'schemaVersion': 1, 'capabilities': [
            {'id': 'log-tags', 'source': {'src/feature.js': ['restoredFeature']},
             'frontendTokens': ['新版日志选择器']}]}
        self.writeContract()
        self.patch = mock.patch.object(GUARD.subprocess, 'check_output', return_value=b'synthetic-commit')
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def writeContract(self):
        (self.root / 'config/productionCapabilities.json').write_text(
            json.dumps(self.contract, ensure_ascii=False), encoding='utf-8')

    def release(self, name, text='新版日志选择器'):
        release = self.root / name
        (release / 'frontend/assets').mkdir(parents=True)
        (release / 'frontend/index.html').write_text(
            '<script src="/assets/' + name + '.js"></script>', encoding='utf-8')
        (release / 'frontend/assets' / (name + '.js')).write_text(text, encoding='utf-8')
        return release

    def proof(self, release):
        data = GUARD.frontendProof(self.root, release)
        (release / 'capabilities.json').write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')
        return data

    def test_missing_source_is_rejected(self):
        (self.root / 'src/feature.js').unlink()
        with self.assertRaisesRegex(GUARD.SourceGuardError, 'CAPABILITY_SOURCE_MISSING'):
            GUARD.checkSource(self.root)

    def test_old_source_is_rejected_even_when_git_commit_exists(self):
        (self.root / 'src/feature.js').write_text('function nativeSelect() {}')
        with self.assertRaisesRegex(GUARD.SourceGuardError, 'CAPABILITY_SOURCE_REGRESSED'):
            GUARD.checkSource(self.root)

    def test_old_build_is_rejected_even_when_source_is_correct(self):
        with self.assertRaisesRegex(GUARD.SourceGuardError, 'CAPABILITY_BUILD_REGRESSED'):
            self.proof(self.release('old', '旧原生下拉'))

    def test_valid_source_and_build_are_bound(self):
        release = self.release('new')
        data = self.proof(release)
        self.assertEqual(data['sourceCommit'], 'synthetic-commit')
        self.assertEqual(GATE.capabilityProof(release, GATE.inventory(release)[3]),
                         {'log-tags': {'新版日志选择器'}})

    def test_same_claim_with_different_asset_bytes_is_rejected(self):
        release = self.release('new')
        self.proof(release)
        (release / 'frontend/assets/new.js').write_text('旧原生下拉')
        with self.assertRaisesRegex(GATE.GateError, 'CAPABILITY_ASSETS_CHANGED'):
            GATE.inventory(release)

    def test_missing_manifest_is_rejected_after_first_registration(self):
        previous = self.release('previous')
        self.proof(previous)
        candidate = self.release('candidate')
        with self.assertRaisesRegex(GATE.GateError, 'CAPABILITY_MANIFEST_MISSING'):
            GATE.rejectDroppedCapabilities(candidate, previous)

    def test_removing_capability_or_behavior_proof_is_rejected(self):
        previous = self.release('previous')
        self.proof(previous)
        for kind in ('id', 'tokens'):
            candidate = self.release(kind)
            data = self.proof(candidate)
            if kind == 'id':
                data['capabilities'][0]['id'] = 'unrelated-capability'
            else:
                data['capabilities'][0]['tokens'] = {}
            (candidate / 'capabilities.json').write_text(json.dumps(data, ensure_ascii=False))
            with self.assertRaisesRegex(GATE.GateError, 'RELEASE_CAPABILITY_DROPPED'):
                GATE.rejectDroppedCapabilities(candidate, previous)

    def test_behavior_token_must_exist_in_reachable_asset(self):
        release = self.release('new')
        data = self.proof(release)
        data['capabilities'][0]['tokens'] = {'伪造已实现': '/assets/new.js'}
        (release / 'capabilities.json').write_text(json.dumps(data, ensure_ascii=False))
        with self.assertRaisesRegex(GATE.GateError, 'CAPABILITY_BUILD_REGRESSED'):
            GATE.inventory(release)

    def test_capabilities_can_be_preserved_or_extended(self):
        previous = self.release('previous')
        self.proof(previous)
        candidate = self.release('candidate')
        self.proof(candidate)
        GATE.rejectDroppedCapabilities(candidate, previous)

    def test_rollback_requires_exact_pre_recorded_previous_tree(self):
        previous = self.release('previous', '旧版')
        current = self.release('current')
        self.proof(current)
        with self.assertRaisesRegex(GATE.GateError, 'CAPABILITY_ROLLBACK_UNPROVEN'):
            GATE.rejectDroppedCapabilities(previous, current, rollback=True)

        assets = GATE.inventory(previous)[3]
        proof = {'releasePath': str(previous),
                 'assets': {url: GATE.fileDigest(path).hex() for url, path in assets.items()},
                 'indexSha256': GATE.fileDigest(previous / 'frontend/index.html').hex()}
        (current / 'rollback-target.json').write_text(json.dumps(proof))
        GATE.rejectDroppedCapabilities(previous, current, rollback=True)
        (previous / 'frontend/index.html').write_text('<script src="/assets/previous.js"></script>changed')
        with self.assertRaisesRegex(GATE.GateError, 'CAPABILITY_ROLLBACK_UNPROVEN'):
            GATE.rejectDroppedCapabilities(previous, current, rollback=True)

    def test_api_only_release_cannot_drop_source_capability(self):
        previous = self.release('previous')
        candidate = self.release('candidate')
        for release in (previous, candidate):
            self.proof(release)
        source = GUARD.checkSource(self.root)
        (previous / 'source-capabilities.json').write_text(json.dumps(source))
        with self.assertRaisesRegex(GATE.GateError, 'SOURCE_CAPABILITY_MANIFEST_MISSING'):
            GATE.rejectDroppedCapabilities(candidate, previous)
        source['capabilities'][0]['id'] = 'unrelated'
        (candidate / 'source-capabilities.json').write_text(json.dumps(source))
        with self.assertRaisesRegex(GATE.GateError, 'SOURCE_CAPABILITY_DROPPED'):
            GATE.rejectDroppedCapabilities(candidate, previous)

    def test_runtime_must_contain_checked_source_bytes(self):
        (self.root / 'scripts').mkdir()
        (self.root / 'scripts/helper.py').write_text('restored_helper = True')
        source = GUARD.checkSource(self.root)
        manifest = self.root / 'source-capabilities.json'
        manifest.write_text(json.dumps(source))
        for text, helper, passes in (
            (b'function restoredFeature() {}', b'restored_helper = True', True),
            (b'old image', b'restored_helper = True', False),
            (b'function restoredFeature() {}', b'old_helper = True', False),
        ):
            data = io.BytesIO()
            with tarfile.open(fileobj=data, mode='w') as archive:
                entry = tarfile.TarInfo('src/feature.js')
                entry.size = len(text)
                archive.addfile(entry, io.BytesIO(text))
                entry = tarfile.TarInfo('scripts/helper.py')
                entry.size = len(helper)
                archive.addfile(entry, io.BytesIO(helper))
            with mock.patch.object(GUARD.subprocess, 'check_output',
                                   side_effect=[data.getvalue(), b'sha256:synthetic']):
                if passes:
                    self.assertTrue(GUARD.runtimeProof('synthetic', manifest)['passed'])
                else:
                    with self.assertRaisesRegex(GUARD.SourceGuardError, 'RUNTIME_SOURCE_MISMATCH'):
                        GUARD.runtimeProof('synthetic', manifest)

    def test_registered_migration_cannot_disappear_or_change(self):
        previous = self.release('previous')
        candidate = self.release('candidate')
        for release in (previous, candidate):
            self.proof(release)
        source = GUARD.checkSource(self.root)
        source['sourceInventory']['migrations/already-deployed.js'] = 'a' * 64
        (previous / 'source-capabilities.json').write_text(json.dumps(source))
        for value in (None, 'b' * 64):
            candidateSource = json.loads(json.dumps(source))
            if value is None:
                del candidateSource['sourceInventory']['migrations/already-deployed.js']
            else:
                candidateSource['sourceInventory']['migrations/already-deployed.js'] = value
            (candidate / 'source-capabilities.json').write_text(json.dumps(candidateSource))
            with self.assertRaisesRegex(GATE.GateError, 'MIGRATION_HISTORY_CHANGED'):
                GATE.rejectDroppedCapabilities(candidate, previous)



if __name__ == '__main__':
    unittest.main()
