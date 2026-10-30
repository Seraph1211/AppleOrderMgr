import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import productionReleaseFiles as files


class ProductionReleaseFilesTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        self.source = self.root / 'source'
        self.store = self.root / 'store'
        self.source.mkdir()
        self.store.mkdir()
        self.key = b'k' * 32

    def tearDown(self):
        for path in sorted(self.root.rglob('*'), reverse=True):
            if path.exists() and not path.is_symlink():
                try:
                    path.chmod(0o700 if path.is_dir() else 0o600)
                except OSError:
                    pass
        self.temporary.cleanup()

    def test_mutable_files_are_always_hashed(self):
        (self.source / 'state.json').write_text('one', encoding='utf-8')
        first = self.root / 'first.json'
        second = self.root / 'second.json'
        files.createManifest(self.source, self.store, first, self.key, 'r1')
        result = files.createManifest(
            self.source, self.store, second, self.key, 'r2', first)
        self.assertEqual(result['metrics']['filesHashed'], 1)
        self.assertEqual(result['metrics']['filesReused'], 0)

    def test_immutable_reuse_requires_owner_read_only_chain(self):
        sealed = self.source / 'sealed'
        sealed.mkdir()
        payload = sealed / 'artifact.bin'
        payload.write_bytes(b'fixed')
        payload.chmod(0o444)
        sealed.chmod(0o555)
        self.source.chmod(0o555)
        first = self.root / 'first.json'
        second = self.root / 'second.json'
        files.createManifest(
            self.source, self.store, first, self.key, 'r1', immutableRules=['sealed'])
        result = files.createManifest(
            self.source, self.store, second, self.key, 'r2', first,
            immutableRules=['sealed'])
        self.assertEqual(result['metrics']['filesReused'], 1)
        self.assertEqual(result['metrics']['filesHashed'], 0)

    def test_writable_owner_disables_immutable_reuse(self):
        (self.source / 'artifact.bin').write_bytes(b'fixed')
        first = self.root / 'first.json'
        second = self.root / 'second.json'
        files.createManifest(
            self.source, self.store, first, self.key, 'r1',
            immutableRules=['artifact.bin'])
        result = files.createManifest(
            self.source, self.store, second, self.key, 'r2', first,
            immutableRules=['artifact.bin'])
        self.assertEqual(result['metrics']['filesReused'], 0)
        self.assertEqual(result['metrics']['filesHashed'], 1)

    def test_consistent_snapshot_restores_and_detects_object_tamper(self):
        (self.source / 'data.txt').write_text('business', encoding='utf-8')
        state = self.root / 'state.json'
        state.write_text(json.dumps({
            'passed': True, 'queuePaused': True, 'inFlight': 0,
            'activeWriters': 0, 'externalRequestsTriggered': False,
            'writerChecks': {
                'queueDatabaseRunning': 0,
                'collectorProcessCount': 0,
                'queueServiceInactive': True,
            },
            'observedAtUtc': files.utcNow(),
        }), encoding='utf-8')
        proof = self.root / 'consistency.json'
        files.createConsistencyProof(self.source, state, proof, self.key)
        manifest = self.root / 'manifest.json'
        document = files.createManifest(
            self.source, self.store, manifest, self.key, 'r1',
            consistencyProof=proof)
        result = files.restoreManifest(manifest, self.root / 'restored', self.key)
        self.assertTrue(result['consistentSnapshot'])
        entry = next(item for item in document['entries'] if item['type'] == 'file')
        objectPath = files.objectPath(self.store, entry['sha256'])
        objectPath.chmod(0o600)
        objectPath.write_bytes(b'tampered')
        with self.assertRaises(files.FileBackupError) as raised:
            files.restoreManifest(manifest, self.root / 'restored-2', self.key)
        self.assertEqual(raised.exception.code, 'OBJECT_CORRUPT')

    def test_authenticated_traversal_still_fails_closed(self):
        (self.source / 'data.txt').write_text('business', encoding='utf-8')
        manifest = self.root / 'manifest.json'
        document = files.createManifest(
            self.source, self.store, manifest, self.key, 'r1')
        document['entries'][0]['path'] = '../outside'
        files.authenticate(document, self.key)
        files.writeJsonAtomic(self.root / 'bad.json', document)
        with self.assertRaises(files.FileBackupError) as raised:
            files.restoreManifest(
                self.root / 'bad.json', self.root / 'restored', self.key)
        self.assertEqual(raised.exception.code, 'PATH_INVALID')

    def test_include_allowlist_does_not_scan_siblings_and_preserves_link(self):
        included = self.source / 'app' / 'shared'
        included.mkdir(parents=True)
        (included / 'config').write_text('kept', encoding='utf-8')
        release = self.source / 'app' / 'releases' / 'r1'
        release.mkdir(parents=True)
        (release / 'index').write_text('release', encoding='utf-8')
        (self.source / 'app' / 'current').symlink_to('releases/r1')
        (self.source / 'secret').write_text('not scanned', encoding='utf-8')
        manifest = self.root / 'include.json'
        result = files.createManifest(
            self.source, self.store, manifest, self.key, 'r1',
            includeRules=['app/shared', 'app/releases/r1', 'app/current'])
        paths = {item['path'] for item in result['entries']}
        self.assertIn('app/shared/config', paths)
        self.assertIn('app/current', paths)
        self.assertNotIn('secret', paths)
        restored = self.root / 'included-restored'
        files.restoreManifest(manifest, restored, self.key)
        self.assertTrue((restored / 'app/current').is_symlink())

    def test_selected_subtree_preserves_internal_directory_link(self):
        release = self.source / 'selected' / 'releases' / 'r1'
        release.mkdir(parents=True)
        (release / 'index.html').write_text('release', encoding='utf-8')
        (self.source / 'selected' / 'current').symlink_to('releases/r1',
                                                          target_is_directory=True)
        manifest = self.root / 'selected-subtree.json'
        document = files.createManifest(
            self.source, self.store, manifest, self.key, 'r1',
            includeRules=['selected'])
        link = next(item for item in document['entries']
                    if item['path'] == 'selected/current')
        self.assertEqual(link['type'], 'symlink')
        self.assertEqual(link['target'], 'releases/r1')
        restored = self.root / 'selected-restored'
        files.restoreManifest(manifest, restored, self.key)
        self.assertEqual((restored / 'selected/current/index.html').read_text(),
                         'release')

    def test_include_cannot_traverse_symlink_parent(self):
        real = self.source / 'real'
        real.mkdir()
        (real / 'child').write_text('must require explicit real path', encoding='utf-8')
        (self.source / 'alias').symlink_to('real', target_is_directory=True)
        with self.assertRaises(files.FileBackupError) as raised:
            files.createManifest(
                self.source, self.store, self.root / 'alias-child.json', self.key,
                'r1', includeRules=['alias/child'])
        self.assertEqual(raised.exception.code, 'SOURCE_ANCESTOR_SYMLINK')

    def test_absolute_link_target_is_audited_and_remapped_inside_restore(self):
        runtime = self.source / 'app' / 'runtime' / 'venv' / 'bin'
        runtime.mkdir(parents=True)
        interpreter = self.source / 'usr' / 'bin' / 'python3.6'
        interpreter.parent.mkdir(parents=True)
        interpreter.write_text('synthetic interpreter', encoding='utf-8')
        originalTarget = str(interpreter)
        (runtime / 'python').symlink_to(originalTarget)
        manifest = self.root / 'absolute-link.json'
        document = files.createManifest(
            self.source, self.store, manifest, self.key, 'r1',
            includeRules=['app/runtime', 'usr/bin/python3.6'])
        link = next(item for item in document['entries']
                    if item['path'] == 'app/runtime/venv/bin/python')
        self.assertEqual(link['target'], originalTarget)
        self.assertEqual(link['targetPath'], 'usr/bin/python3.6')
        restored = self.root / 'absolute-restored'
        result = files.restoreManifest(manifest, restored, self.key)
        restoredLink = restored / 'app/runtime/venv/bin/python'
        self.assertFalse(Path(restoredLink.readlink()).is_absolute())
        self.assertEqual(restoredLink.read_text(), 'synthetic interpreter')
        self.assertEqual(result['absoluteLinksRemapped'], 1)

    def test_absolute_link_requires_explicit_target_in_manifest(self):
        runtime = self.source / 'app' / 'runtime'
        runtime.mkdir(parents=True)
        interpreter = self.source / 'usr' / 'bin' / 'python3.6'
        interpreter.parent.mkdir(parents=True)
        interpreter.write_text('synthetic interpreter', encoding='utf-8')
        (runtime / 'python').symlink_to(str(interpreter))
        with self.assertRaises(files.FileBackupError) as raised:
            files.createManifest(
                self.source, self.store, self.root / 'missing-target.json', self.key,
                'r1', includeRules=['app/runtime'])
        self.assertEqual(raised.exception.code, 'SOURCE_LINK_TARGET_NOT_INCLUDED')

    def test_store_below_source_is_allowed_only_outside_include_closure(self):
        included = self.source / 'var' / 'www' / 'app'
        included.mkdir(parents=True)
        (included / 'config').write_text('business', encoding='utf-8')
        nestedStore = self.source / 'var' / 'backups' / 'objects-root'
        nestedStore.mkdir(parents=True)
        document = files.createManifest(
            self.source, nestedStore, self.root / 'nested-store.json', self.key,
            'r1', includeRules=['var/www/app'])
        self.assertEqual([item['path'] for item in document['entries']
                          if item['type'] == 'file'], ['var/www/app/config'])
        overlappingStore = self.source / 'var' / 'www' / 'app' / 'backup'
        overlappingStore.mkdir()
        with self.assertRaises(files.FileBackupError) as raised:
            files.createManifest(
                self.source, overlappingStore,
                self.root / 'overlapping-store.json', self.key, 'r2',
                includeRules=['var/www/app'])
        self.assertEqual(raised.exception.code, 'STORE_OVERLAPS_SOURCE')

    def test_second_inventory_detects_file_added_during_scan(self):
        included = self.source / 'shared'
        included.mkdir()
        (included / 'existing').write_text('stable', encoding='utf-8')
        originalStoreObject = files.storeObject
        injected = {'done': False}

        def addFileAfterObject(source, store, digest, expectedSize):
            created = originalStoreObject(source, store, digest, expectedSize)
            if not injected['done']:
                injected['done'] = True
                (included / 'concurrent-new').write_text('late', encoding='utf-8')
            return created

        with mock.patch.object(files, 'storeObject', side_effect=addFileAfterObject):
            with self.assertRaises(files.FileBackupError) as raised:
                files.createManifest(
                    self.source, self.store, self.root / 'concurrent.json', self.key,
                    'r1', includeRules=['shared'])
        self.assertEqual(raised.exception.code, 'SOURCE_TREE_CHANGED')
        self.assertFalse((self.root / 'concurrent.json').exists())

    def test_manifest_records_owner_and_second_inventory_detects_owner_drift(self):
        payload = self.source / 'private.env'
        payload.write_text('secret', encoding='utf-8')
        payload.chmod(0o600)
        originalStatSource = files.statSource

        def ownerDrift(source, includeRules, excludeRules):
            inventory = originalStatSource(source, includeRules, excludeRules)
            inventory['private.env']['uid'] += 1
            inventory['private.env']['fingerprint']['uid'] += 1
            return inventory

        with mock.patch.object(files, 'statSource', side_effect=ownerDrift):
            with self.assertRaises(files.FileBackupError) as raised:
                files.createManifest(
                    self.source, self.store, self.root / 'owner-drift.json',
                    self.key, 'r1')
        self.assertEqual(raised.exception.code, 'SOURCE_TREE_CHANGED')

    def test_authenticated_owner_mapping_restores_0600_and_link_owner(self):
        private = self.source / 'private'
        private.mkdir()
        secret = private / 'evidence'
        secret.write_text('secret', encoding='utf-8')
        secret.chmod(0o600)
        (self.source / 'evidence-link').symlink_to('private/evidence')
        manifestPath = self.root / 'owners.json'
        manifest = files.createManifest(
            self.source, self.store, manifestPath, self.key, 'r1')
        for item in manifest['entries']:
            item['uid'] = 1000
            item['gid'] = 1000
            item['fingerprint']['uid'] = 1000
            item['fingerprint']['gid'] = 1000
        files.authenticate(manifest, self.key)
        files.writeJsonAtomic(manifestPath, manifest)
        ownershipPath = self.root / 'ownership-map.json'
        ownership = files.createOwnershipMap(
            manifestPath, ownershipPath, self.key,
            {'1000:1000': {'uid': self.source.stat().st_uid,
                           'gid': self.source.stat().st_gid}})
        restored = self.root / 'owner-restored'
        result = files.restoreManifest(
            manifestPath, restored, self.key, ownershipMapPath=ownershipPath)
        self.assertEqual(result['ownership']['policy'], 'authenticated-map')
        self.assertEqual(result['ownership']['mapDigest'],
                         ownership['authentication']['digest'])
        self.assertEqual((restored / 'private/evidence').stat().st_mode & 0o777,
                         0o600)
        self.assertEqual((restored / 'evidence-link').lstat().st_uid,
                         self.source.stat().st_uid)

    def test_invalid_owner_and_chown_failure_never_complete_restore(self):
        (self.source / 'data').write_text('value', encoding='utf-8')
        manifestPath = self.root / 'invalid-owner.json'
        manifest = files.createManifest(
            self.source, self.store, manifestPath, self.key, 'r1')
        manifest['entries'][0]['uid'] = -1
        files.authenticate(manifest, self.key)
        files.writeJsonAtomic(manifestPath, manifest)
        with self.assertRaises(files.FileBackupError) as raised:
            files.restoreManifest(
                manifestPath, self.root / 'invalid-owner-restore', self.key)
        self.assertEqual(raised.exception.code, 'MANIFEST_OWNER_INVALID')

        manifest = files.createManifest(
            self.source, self.store, self.root / 'chown-fail.json', self.key, 'r2')
        with mock.patch.object(files.os, 'chown', side_effect=PermissionError()):
            with self.assertRaises(files.FileBackupError) as raised:
                files.restoreManifest(
                    self.root / 'chown-fail.json',
                    self.root / 'chown-fail-restore', self.key)
        self.assertEqual(raised.exception.code, 'RESTORE_OWNERSHIP_FAILED')

    def test_consistency_proof_requires_scoped_writer_checks(self):
        state = self.root / 'writer-state.json'
        state.write_text(json.dumps({
            'passed': True, 'queuePaused': True, 'inFlight': 0,
            'activeWriters': 0, 'externalRequestsTriggered': False,
            'observedAtUtc': files.utcNow(),
        }), encoding='utf-8')
        with self.assertRaises(files.FileBackupError) as raised:
            files.createConsistencyProof(
                self.source, state, self.root / 'writer-proof.json', self.key)
        self.assertEqual(raised.exception.code, 'CONSISTENCY_STATE_INVALID')

    def test_recovery_bundle_requires_verified_second_inventory(self):
        database = self.root / 'database-restore.json'
        database.write_text(json.dumps({
            'kind': 'apple-order-mgr-database-restore', 'passed': True,
            'completeRestore': True, 'completeVerification': True,
        }), encoding='utf-8')
        restoredFiles = self.root / 'files-restore.json'
        payload = {
            'kind': 'apple-order-mgr-files-restore', 'passed': True,
            'completeVerification': True, 'consistentSnapshot': True,
        }
        restoredFiles.write_text(json.dumps(payload), encoding='utf-8')
        with self.assertRaises(files.FileBackupError) as raised:
            files.createRecoveryBundleEvidence(
                database, restoredFiles, self.root / 'incomplete-bundle.json',
                self.key, 'source', 'baseline')
        self.assertEqual(raised.exception.code, 'RECOVERY_EVIDENCE_INVALID')
        payload['sourceInventoryVerified'] = True
        payload['ownershipVerification'] = True
        payload['ownership'] = {'policy': 'preserve'}
        restoredFiles.write_text(json.dumps(payload), encoding='utf-8')
        bundle = files.createRecoveryBundleEvidence(
            database, restoredFiles, self.root / 'complete-bundle.json',
            self.key, 'source', 'baseline')
        self.assertTrue(bundle['passed'])


if __name__ == '__main__':
    unittest.main()
