"""REL-01～04 独立验收；只使用临时目录、回环进程和合成证据。"""
import datetime
import hashlib
import importlib.util
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]


def loadModule(name, relative):
    """从工作树导入待验收脚本。"""
    spec = importlib.util.spec_from_file_location(name, str(ROOT / relative))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


FILES = loadModule('productionReleaseFiles', 'scripts/productionReleaseFiles.py')
BACKUP = loadModule('productionReleaseBackup', 'scripts/productionReleaseBackup.py')
RELEASE = loadModule('productionRelease', 'scripts/productionRelease.py')
RESOURCE_PROBE = loadModule(
    'productionReleaseResourceProbe', 'scripts/productionReleaseResourceProbe.py')


def writeJson(path, payload, mode=0o600):
    """写入合成 JSON 证据。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload), encoding='utf-8')
    path.chmod(mode)


class ProductionFilesAcceptanceTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='release-files-qa-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.source = self.root / 'source'
        self.store = self.root / 'store'
        self.source.mkdir(mode=0o700)
        self.store.mkdir(mode=0o700)
        self.key = b'k' * 32

    def assertFileCode(self, code, callback):
        with self.assertRaises(FILES.FileBackupError) as result:
            callback()
        self.assertEqual(result.exception.code, code)

    def snapshot(self, name='manifest.json', base=None):
        return FILES.createManifest(
            self.source, self.store, self.root / name, self.key, 'release-qa',
            basePath=base, immutableRules=['sealed'], excludeRules=['aos-raw'],
            keyVersion='qa-v1')

    def test_full_manifest_increment_and_restore_round_trip(self):
        (self.source / 'mutable').mkdir()
        (self.source / 'mutable/current.json').write_text('one', encoding='utf-8')
        (self.source / 'sealed').mkdir()
        (self.source / 'sealed/archive.bin').write_bytes(b'archive')
        (self.source / 'aos-raw').mkdir()
        (self.source / 'aos-raw/excluded.log').write_text('excluded', encoding='utf-8')
        (self.source / 'current-link').symlink_to('mutable/current.json')
        firstPath = self.root / 'first.json'
        first = self.snapshot(firstPath.name)

        self.assertEqual(first['metrics']['filesScanned'], 2)
        self.assertEqual(first['metrics']['filesHashed'], 2)
        self.assertNotIn('aos-raw/excluded.log', [item['path'] for item in first['entries']])
        self.assertEqual(first['changes']['deleted'], [])

        (self.source / 'mutable/current.json').write_text('two', encoding='utf-8')
        (self.source / 'mutable/new.txt').write_text('new', encoding='utf-8')
        secondPath = self.root / 'second.json'
        second = self.snapshot(secondPath.name, firstPath)
        self.assertEqual(
            second['changes']['changed'],
            ['mutable/current.json', 'mutable/new.txt'],
        )

        destination = self.root / 'restored'
        restored = FILES.restoreManifest(secondPath, destination, self.key)
        self.assertTrue(restored['completeVerification'])
        self.assertEqual(restored['bytesRestored'], len(b'two') + len(b'new') + len(b'archive'))
        self.assertEqual((destination / 'mutable/current.json').read_text(), 'two')
        self.assertEqual((destination / 'mutable/new.txt').read_text(), 'new')
        self.assertEqual((destination / 'sealed/archive.bin').read_bytes(), b'archive')
        self.assertEqual(os.readlink(str(destination / 'current-link')), 'mutable/current.json')
        self.assertFalse((destination / 'aos-raw').exists())

    def test_manifest_tamper_missing_object_and_corrupt_object_fail_closed(self):
        (self.source / 'data.txt').write_text('protected', encoding='utf-8')
        manifestPath = self.root / 'manifest.json'
        manifest = self.snapshot(manifestPath.name)

        tampered = json.loads(manifestPath.read_text(encoding='utf-8'))
        tampered['entries'][0]['mode'] = 0o777
        writeJson(self.root / 'tampered.json', tampered)
        self.assertFileCode(
            'MANIFEST_AUTHENTICATION',
            lambda: FILES.restoreManifest(
                self.root / 'tampered.json', self.root / 'tampered-restore', self.key),
        )

        entry = next(item for item in manifest['entries'] if item['type'] == 'file')
        objectPath = FILES.objectPath(self.store, entry['sha256'])
        original = objectPath.read_bytes()
        objectPath.unlink()
        self.assertFileCode(
            'OBJECT_MISSING',
            lambda: FILES.restoreManifest(
                manifestPath, self.root / 'missing-restore', self.key),
        )
        objectPath.parent.mkdir(parents=True, exist_ok=True)
        objectPath.write_bytes(original + b'x')
        self.assertFileCode(
            'OBJECT_CORRUPT',
            lambda: FILES.restoreManifest(
                manifestPath, self.root / 'corrupt-restore', self.key),
        )

    def test_source_link_outside_and_symlink_source_root_are_rejected(self):
        outside = self.root / 'outside.txt'
        outside.write_text('outside', encoding='utf-8')
        (self.source / 'outside-link').symlink_to(outside)
        self.assertFileCode('SOURCE_LINK_OUTSIDE', self.snapshot)
        (self.source / 'outside-link').unlink()

        alias = self.root / 'source-alias'
        alias.symlink_to(self.source, target_is_directory=True)
        self.assertFileCode(
            'SOURCE_INVALID',
            lambda: FILES.createManifest(
                alias, self.store, self.root / 'alias.json', self.key, 'release-qa'),
        )

    def test_manifest_rejects_legacy_consistency_proof_without_writer_checks(self):
        (self.source / 'data.txt').write_text('business', encoding='utf-8')
        proof = {
            'schemaVersion': FILES.SCHEMA_VERSION,
            'kind': 'apple-order-mgr-file-consistency',
            'createdAtUtc': FILES.utcNow(),
            'observedAtUtc': FILES.utcNow(),
            'sourceRoot': str(self.source),
            'queuePaused': True,
            'inFlight': 0,
            'activeWriters': 0,
            'externalRequestsTriggered': False,
            'stateEvidenceDigest': 'legacy-proof-without-specific-writer-checks',
        }
        FILES.authenticate(proof, self.key)
        proofPath = self.root / 'legacy-consistency-proof.json'
        writeJson(proofPath, proof)

        self.assertFileCode(
            'CONSISTENCY_PROOF_INVALID',
            lambda: FILES.createManifest(
                self.source, self.store, self.root / 'manifest.json', self.key,
                'release-qa', consistencyProof=proofPath),
        )

    def test_source_file_swapped_to_external_link_during_hash_fails_closed(self):
        sourceFile = self.source / 'mutable' / 'current.json'
        sourceFile.parent.mkdir()
        sourceFile.write_text('original source bytes', encoding='utf-8')
        originalFile = self.root / 'original-current.json'
        outside = self.root / 'outside-secret.txt'
        outside.write_text('outside secret must not enter object store', encoding='utf-8')
        originalStoreObject = FILES.storeObject
        swapped = {'done': False}

        def swapBeforeObjectCopy(path, store, digest, expectedSize):
            if str(path) == str(sourceFile) and not swapped['done']:
                swapped['done'] = True
                sourceFile.rename(originalFile)
                sourceFile.symlink_to(outside)
            return originalStoreObject(path, store, digest, expectedSize)

        with mock.patch.object(FILES, 'storeObject', side_effect=swapBeforeObjectCopy):
            self.assertFileCode('SOURCE_CHANGED', self.snapshot)
        objects = self.store / 'objects'
        self.assertFalse(objects.exists() and any(
            child.is_file() for child in objects.rglob('*')
        ))

    def test_mixed_link_inventory_restores_inside_isolation_root(self):
        app = self.source / 'var' / 'www' / 'apple-order-mgr'
        absoluteTargets = app / 'absolute-targets'
        relativeTargets = app / 'relative-targets'
        links = app / 'links'
        absoluteTargets.mkdir(parents=True)
        relativeTargets.mkdir()
        links.mkdir()

        targetPaths = []
        for index in range(28):
            target = absoluteTargets / ('target-%02d' % index)
            target.write_text('absolute-%02d' % index, encoding='utf-8')
            targetPaths.append(target)
        python3 = self.source / 'usr' / 'bin' / 'python3'
        python36 = self.source / 'usr' / 'bin' / 'python3.6'
        libpython = self.source / 'usr' / 'lib' / 'libpython3.6.so'
        python3.parent.mkdir(parents=True)
        libpython.parent.mkdir(parents=True)
        python36.write_text('python3.6', encoding='utf-8')
        python3.symlink_to('python3.6')
        libpython.write_text('libpython3.6', encoding='utf-8')
        targetPaths.extend([python3, python36, libpython])

        release = app / 'releases' / 'release-1'
        release.mkdir(parents=True)
        (release / 'index.html').write_text('release', encoding='utf-8')
        (app / 'current').symlink_to('releases/release-1', target_is_directory=True)
        expectedLinks = {
            'usr/bin/python3',
            'var/www/apple-order-mgr/current',
        }
        for index, target in enumerate(targetPaths):
            link = links / ('absolute-%02d' % index)
            link.symlink_to(target)
            expectedLinks.add(str(link.relative_to(self.source)))
        for index in range(24):
            target = relativeTargets / ('target-%02d' % index)
            target.write_text('relative-%02d' % index, encoding='utf-8')
            link = links / ('relative-%02d' % index)
            link.symlink_to('../relative-targets/' + target.name)
            expectedLinks.add(str(link.relative_to(self.source)))

        manifestPath = self.root / 'production-links.json'
        document = FILES.createManifest(
            self.source, self.store, manifestPath, self.key, 'release-links-qa',
            includeRules=[
                'var/www/apple-order-mgr',
                'usr/bin/python3',
                'usr/bin/python3.6',
                'usr/lib/libpython3.6.so',
            ],
        )
        linkEntries = [entry for entry in document['entries']
                       if entry['type'] == 'symlink']
        absoluteEntries = [entry for entry in linkEntries
                           if os.path.isabs(entry['target'])]
        relativeEntries = [entry for entry in linkEntries
                           if not os.path.isabs(entry['target'])]
        self.assertEqual({entry['path'] for entry in linkEntries}, expectedLinks)
        self.assertEqual(len(absoluteEntries), 31)
        self.assertEqual(len(relativeEntries), 26)
        self.assertTrue(all(entry.get('targetPath') for entry in absoluteEntries))

        destination = self.root / 'production-links-restored'
        restored = FILES.restoreManifest(manifestPath, destination, self.key)
        self.assertTrue(restored['completeVerification'])
        self.assertEqual(restored['absoluteLinksRemapped'], 31)
        for entry in linkEntries:
            restoredLink = destination / entry['path']
            self.assertTrue(restoredLink.is_symlink())
            self.assertFalse(os.path.isabs(os.readlink(str(restoredLink))))
            self.assertTrue(str(restoredLink.resolve()).startswith(
                str(destination) + os.sep))

    def test_manifest_and_default_restore_preserve_object_ownership(self):
        directory = self.source / 'business'
        directory.mkdir(mode=0o750)
        target = directory / 'data.json'
        target.write_text('{"passed":true}', encoding='utf-8')
        target.chmod(0o640)
        link = self.source / 'current'
        link.symlink_to('business/data.json')
        manifestPath = self.root / 'ownership-manifest.json'
        document = self.snapshot(manifestPath.name)

        for entry in document['entries']:
            metadata = (self.source / entry['path']).lstat()
            self.assertEqual(entry['uid'], metadata.st_uid)
            self.assertEqual(entry['gid'], metadata.st_gid)
            self.assertEqual(entry['fingerprint']['uid'], metadata.st_uid)
            self.assertEqual(entry['fingerprint']['gid'], metadata.st_gid)

        originalChown = os.chown
        originalLchown = os.lchown
        chownTargets = []
        lchownTargets = []

        def recordChown(path, uid, gid):
            chownTargets.append(Path(path).relative_to(self.root / 'restored'))
            return originalChown(path, uid, gid)

        def recordLchown(path, uid, gid):
            lchownTargets.append(Path(path).relative_to(self.root / 'restored'))
            return originalLchown(path, uid, gid)

        with mock.patch.object(FILES.os, 'chown', side_effect=recordChown), \
                mock.patch.object(FILES.os, 'lchown', side_effect=recordLchown):
            restored = FILES.restoreManifest(
                manifestPath, self.root / 'restored', self.key)

        self.assertTrue(restored['completeVerification'])
        self.assertTrue(restored['ownershipVerification'])
        self.assertEqual(restored['ownership']['policy'], 'preserve')
        self.assertEqual(restored['ownership']['entriesVerified'],
                         len(document['entries']))
        self.assertEqual(set(lchownTargets), {Path('current')})
        self.assertNotIn(Path('current'), set(chownTargets))
        self.assertEqual(set(chownTargets), {
            Path('business'), Path('business/data.json'),
        })
        for entry in document['entries']:
            metadata = (self.root / 'restored' / entry['path']).lstat()
            self.assertEqual((metadata.st_uid, metadata.st_gid),
                             (entry['uid'], entry['gid']))
            if entry['type'] != 'symlink':
                self.assertEqual(stat.S_IMODE(metadata.st_mode), entry['mode'])

    def test_authenticated_ownership_map_is_complete_and_manifest_scoped(self):
        (self.source / 'data.txt').write_text('business', encoding='utf-8')
        manifestPath = self.root / 'ownership-manifest.json'
        document = self.snapshot(manifestPath.name)
        owners = {
            '%d:%d' % (entry['uid'], entry['gid'])
            for entry in document['entries']
        }
        mappings = {
            owner: {'uid': os.getuid(), 'gid': os.getgid()}
            for owner in owners
        }
        mapPath = self.root / 'ownership-map.json'
        ownershipMap = FILES.createOwnershipMap(
            manifestPath, mapPath, self.key, mappings)
        restored = FILES.restoreManifest(
            manifestPath, self.root / 'mapped-restore', self.key,
            ownershipMapPath=mapPath)
        self.assertTrue(restored['completeVerification'])
        self.assertEqual(restored['ownership']['policy'], 'authenticated-map')
        self.assertEqual(restored['ownership']['mapDigest'],
                         ownershipMap['authentication']['digest'])

        incompleteMap = {
            'schemaVersion': FILES.SCHEMA_VERSION,
            'kind': 'apple-order-mgr-ownership-map',
            'createdAtUtc': FILES.utcNow(),
            'manifestDigest': document['authentication']['digest'],
            'mappings': {
                '2147483647:2147483647': {
                    'uid': os.getuid(), 'gid': os.getgid(),
                },
            },
        }
        FILES.authenticate(incompleteMap, self.key)
        incompletePath = self.root / 'ownership-map-incomplete.json'
        writeJson(incompletePath, incompleteMap)
        self.assertFileCode(
            'OWNERSHIP_MAP_INCOMPLETE',
            lambda: FILES.restoreManifest(
                manifestPath, self.root / 'incomplete-restore', self.key,
                ownershipMapPath=incompletePath),
        )

        (self.source / 'added.txt').write_text('second manifest', encoding='utf-8')
        secondPath = self.root / 'ownership-manifest-second.json'
        self.snapshot(secondPath.name)
        self.assertFileCode(
            'OWNERSHIP_MAP_SCOPE',
            lambda: FILES.restoreManifest(
                secondPath, self.root / 'wrong-scope-restore', self.key,
                ownershipMapPath=mapPath),
        )

    def test_owner_drift_in_second_inventory_fails_closed(self):
        (self.source / 'data.txt').write_text('business', encoding='utf-8')
        originalStatSource = FILES.statSource

        def driftOwner(*args, **kwargs):
            inventory = originalStatSource(*args, **kwargs)
            inventory['data.txt']['uid'] += 1
            return inventory

        with mock.patch.object(FILES, 'statSource', side_effect=driftOwner):
            self.assertFileCode('SOURCE_TREE_CHANGED', self.snapshot)

    def test_chown_and_lchown_failures_never_report_complete_restore(self):
        (self.source / 'target.txt').write_text('business', encoding='utf-8')
        (self.source / 'current').symlink_to('target.txt')
        manifestPath = self.root / 'ownership-manifest.json'
        self.snapshot(manifestPath.name)

        with mock.patch.object(FILES.os, 'chown', side_effect=OSError('denied')):
            self.assertFileCode(
                'RESTORE_OWNERSHIP_FAILED',
                lambda: FILES.restoreManifest(
                    manifestPath, self.root / 'chown-failed', self.key),
            )
        with mock.patch.object(FILES.os, 'lchown', side_effect=OSError('denied')):
            self.assertFileCode(
                'RESTORE_OWNERSHIP_FAILED',
                lambda: FILES.restoreManifest(
                    manifestPath, self.root / 'lchown-failed', self.key),
            )

    def makeBackupSet(self, backupId, createdAt, dependencies=None):
        directory = self.root / 'backups' / backupId
        directory.mkdir(parents=True)
        evidence = directory / 'restore-evidence.json'
        recovery = {
            'schemaVersion': FILES.SCHEMA_VERSION,
            'kind': 'apple-order-mgr-complete-recovery',
            'passed': True,
            'databaseCompleteRestore': True,
            'filesCompleteRestore': True,
            'sideEffectsDisabled': True,
        }
        FILES.authenticate(recovery, self.key)
        writeJson(evidence, recovery)
        FILES.createBackupSetManifest(
            directory, self.key, backupId, createdAt, evidence,
            dependencies=dependencies or [])
        return directory

    def test_cleanup_keeps_two_complete_sets_seven_days_and_dependencies(self):
        backupRoot = self.root / 'backups'
        self.makeBackupSet('backup-01', '2026-10-01T00:00:00Z')
        self.makeBackupSet('backup-10', '2026-10-10T00:00:00Z')
        self.makeBackupSet(
            'backup-24', '2026-10-24T00:00:00Z', dependencies=['backup-01'])
        self.makeBackupSet('backup-29', '2026-10-29T00:00:00Z')
        references = self.root / 'references.json'
        writeJson(references, {'current': 'backup-29', 'rollback': [],
                               'base': [], 'dependencies': []})
        planPath = self.root / 'cleanup-plan.json'

        plan = FILES.buildCleanupPlan(
            backupRoot, references, planPath, self.key, backupRoot,
            now=datetime.datetime(2026, 10, 30), retentionDays=7,
            minimumComplete=2)
        self.assertEqual([item['backupId'] for item in plan['candidates']], ['backup-10'])
        self.assertEqual(
            set(plan['protected']), {'backup-01', 'backup-24', 'backup-29'})

        applied = FILES.applyCleanupPlan(
            planPath, self.key, backupRoot, plan['authentication']['digest'])
        self.assertEqual(applied['removed'], ['backup-10'])
        self.assertFalse((backupRoot / 'backup-10').exists())
        for backupId in ('backup-01', 'backup-24', 'backup-29'):
            self.assertTrue((backupRoot / backupId).is_dir())

    def test_cleanup_state_drift_blocks_before_deletion(self):
        backupRoot = self.root / 'backups'
        old = self.makeBackupSet('backup-old', '2026-09-01T00:00:00Z')
        self.makeBackupSet('backup-24', '2026-10-24T00:00:00Z')
        self.makeBackupSet('backup-29', '2026-10-29T00:00:00Z')
        references = self.root / 'references.json'
        writeJson(references, {'current': 'backup-29'})
        planPath = self.root / 'cleanup-plan.json'
        plan = FILES.buildCleanupPlan(
            backupRoot, references, planPath, self.key, backupRoot,
            now=datetime.datetime(2026, 10, 30))
        (old / 'late-change').write_text('changed after review', encoding='utf-8')

        self.assertFileCode(
            'CLEANUP_ROOT_CHANGED',
            lambda: FILES.applyCleanupPlan(
                planPath, self.key, backupRoot, plan['authentication']['digest']),
        )
        self.assertTrue(old.is_dir())

    def test_cleanup_policy_cannot_drop_below_safety_floor(self):
        backupRoot = self.root / 'backups'
        backupRoot.mkdir()
        references = self.root / 'references.json'
        writeJson(references, {})
        for retention, minimum in ((6, 2), (7, 1)):
            with self.subTest(retention=retention, minimum=minimum):
                self.assertFileCode(
                    'CLEANUP_POLICY_WEAK',
                    lambda: FILES.buildCleanupPlan(
                        backupRoot, references, self.root / 'plan.json', self.key,
                        backupRoot, retentionDays=retention,
                        minimumComplete=minimum),
                )


class ProductionDatabaseAcceptanceTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='release-db-qa-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()

    def test_aos_exclusions_are_exact_and_do_not_match_all_monitor_data(self):
        self.assertEqual(BACKUP.AOS_LOG_EXCLUSIONS, (
            'public.monitor_log_entries',
            'public.monitor_log_entries_*',
            'public.monitor_log_files',
            'public.monitor_log_blocks',
            'public.monitor_log_blocks_*',
            'public.monitor_log_block_accounts',
            'public.monitor_log_block_accounts_*',
            'public.monitor_log_receipts',
        ))
        self.assertNotIn('public.monitor_*', BACKUP.AOS_LOG_EXCLUSIONS)
        self.assertNotIn('public.monitor_log_states', BACKUP.AOS_LOG_EXCLUSIONS)
        self.assertNotIn('public.monitor_log_storage_scopes', BACKUP.AOS_LOG_EXCLUSIONS)
        self.assertNotIn('public.monitor_log_storage_metrics', BACKUP.AOS_LOG_EXCLUSIONS)

    def test_stream_pipeline_success_and_any_segment_failure_preserve_old_output(self):
        output = self.root / 'stream.dump'
        commands = [
            [sys.executable, '-c', 'import sys;sys.stdout.buffer.write(b"complete")'],
            [sys.executable, '-c', 'import sys;sys.stdout.buffer.write(sys.stdin.buffer.read())'],
        ]
        result = BACKUP.runCheckedPipeline(commands, output)
        self.assertTrue(result['passed'])
        self.assertEqual(output.read_bytes(), b'complete')
        self.assertEqual(result['sha256'], hashlib.sha256(b'complete').hexdigest())

        failingOutput = self.root / 'failed.dump'
        failing = [
            [sys.executable, '-c', 'import sys;sys.stdout.buffer.write(b"partial")'],
            [sys.executable, '-c', 'import sys;sys.stdin.buffer.read();sys.exit(9)'],
        ]
        with self.assertRaises(BACKUP.BackupError) as error:
            BACKUP.runCheckedPipeline(failing, failingOutput)
        self.assertEqual(error.exception.code, 'PIPELINE_FAILED')
        self.assertFalse(failingOutput.exists())

        with self.assertRaises(BACKUP.BackupError) as error:
            BACKUP.runCheckedPipeline(commands, output)
        self.assertEqual(error.exception.code, 'PIPELINE_OUTPUT_ALREADY_EXISTS')
        self.assertEqual(output.read_bytes(), b'complete')

    def test_restore_rejects_production_target_before_pg_restore(self):
        dump = self.root / 'business.dump'
        dump.write_bytes(b'synthetic custom dump')
        digest = hashlib.sha256(dump.read_bytes()).hexdigest()
        proof = self.root / 'isolation.json'
        writeJson(proof, {
            'sourceDatabase': 'some-other-name',
            'targetDatabase': 'apple_order_mgr',
            'networkMode': 'none',
            'publishedPorts': [],
            'sideEffectsDisabled': {
                'mail': True,
                'wecom': True,
                'officialQueue': True,
                'schedulers': True,
                'externalWrites': True,
            },
        })
        validation = self.root / 'validation.sql'
        validation.write_text("SELECT '{\"passed\":true}'::json;", encoding='utf-8')

        calls = []

        def rejectRun(argv, **_kwargs):
            calls.append(argv)
            return mock.Mock(returncode=1, stdout=b'', stderr=b'')

        with mock.patch.object(BACKUP.subprocess, 'run', side_effect=rejectRun):
            with self.assertRaises(BACKUP.BackupError):
                BACKUP.restoreDatabaseBackup(
                    dump, digest, 'apple_order_mgr', proof, validation,
                    self.root / 'restore.json')
        self.assertEqual(calls, [])

    def test_restore_cannot_escape_proved_container_through_connection_args(self):
        dump = self.root / 'business.dump'
        dump.write_bytes(b'synthetic custom dump')
        digest = hashlib.sha256(dump.read_bytes()).hexdigest()
        key = b'qa-proof-key-' + (b'x' * 32)
        targetDatabase = 'apple_order_mgr_restore_qa'
        containerId = 'sha256:isolated-container-a'
        labels = {
            'com.apple-order-mgr.isolated-restore': 'true',
            'com.apple-order-mgr.side-effects-disabled': 'true',
            'com.apple-order-mgr.postgres-major': '15',
            'com.apple-order-mgr.restore-database': targetDatabase,
        }
        inspect = {
            'Id': containerId,
            'HostConfig': {'NetworkMode': 'none'},
            'NetworkSettings': {'Ports': {}},
            'Config': {'Labels': labels},
            'State': {'Running': True},
            'Mounts': [],
        }
        selected = {
            'containerId': containerId,
            'networkMode': 'none',
            'publishedPorts': {},
            'running': True,
            'labels': {
                'isolatedRestore': 'true',
                'sideEffectsDisabled': 'true',
                'postgresMajor': '15',
                'restoreDatabase': targetDatabase,
            },
        }
        proof = {
            'schemaVersion': 1,
            'kind': 'apple-order-mgr-restore-isolation',
            'generatedAtUtc': BACKUP.utcNow(),
            'container': 'restore-a',
            'containerId': containerId,
            'inspectDigest': hashlib.sha256(
                BACKUP.canonicalBytes(selected)).hexdigest(),
            'targetDatabase': targetDatabase,
            'sourceDatabase': 'apple_order_mgr',
            'networkMode': 'none',
            'publishedPorts': [],
            'postgresMajor': 15,
            'testDatabaseMarker': targetDatabase,
            'sideEffectsDisabled': {
                name: True for name in BACKUP.SIDE_EFFECT_GUARDS
            },
        }
        BACKUP.authenticate(proof, key)
        proofPath = self.root / 'isolation.json'
        writeJson(proofPath, proof)
        validation = self.root / 'validation.sql'
        validation.write_text("SELECT '{\"passed\":true}'::json;", encoding='utf-8')
        calls = []

        def fakeRun(argv, **_kwargs):
            calls.append(list(argv))
            if argv[:2] == ['docker', 'inspect']:
                return mock.Mock(
                    returncode=0,
                    stdout=json.dumps([inspect]).encode('utf-8'),
                    stderr=b'')
            if argv[0] == 'psql':
                if any(b'current_database' in value
                       for value in [_kwargs.get('input', b'')]):
                    payload = {
                        'passed': True,
                        'userTables': 0,
                        'serverVersionNum': 150000,
                    }
                else:
                    payload = {'passed': True}
                return mock.Mock(
                    returncode=0,
                    stdout=(json.dumps(payload) + '\n').encode('utf-8'),
                    stderr=b'')
            return mock.Mock(returncode=0, stdout=b'', stderr=b'')

        with mock.patch.object(BACKUP.subprocess, 'run', side_effect=fakeRun):
            with self.assertRaises(BACKUP.BackupError):
                BACKUP.restoreDatabaseBackup(
                    dump, digest, targetDatabase, proofPath, validation,
                    self.root / 'restore.json', connectionArgs=[
                        '--host', 'unproved-database-b',
                    ], proofKey=key)
        self.assertFalse(any(call and call[0] == 'pg_restore' for call in calls))

    def schemaDiagnostic(self):
        return {
            'passed': True,
            'columnsRawDigest': '1' * 32,
            'columnsDenseDigest': '2' * 32,
            'constraintsDigest': '3' * 32,
            'indexesDigest': '4' * 32,
            'typesDigest': '5' * 32,
            'sequencesDigest': '6' * 32,
            'ordinalGaps': [],
        }

    def nativeSchemaInventory(self):
        return {
            'passed': True,
            'inventoryVersion': 1,
            'serverVersionNum': 150018,
            'components': {
                'schemas': [{'schema': 'public'}],
                'columns': [{'relation': 'orders', 'name': 'id',
                             'type': 'bigint'}],
                'types': [{'name': 'orders', 'kind': 'c'}],
                'sequences': [{'name': 'orders_id_seq', 'increment': '1'}],
                'constraints': [{
                    'relation': 'orders_2026', 'name': None, 'type': 'f',
                    'rootRelation': 'orders', 'rootName': 'orders_fk',
                    'keyColumns': ['recipient_id'],
                    'referencedRelation': 'recipients',
                    'referencedColumns': ['id'],
                    'updateAction': 'a', 'deleteAction': 'c',
                    'definition': 'FOREIGN KEY (recipient_id) REFERENCES recipients(id)',
                }],
                'indexes': [{
                    'relation': 'orders', 'name': 'orders_reference_idx',
                    'attributes': [{
                        'position': 1, 'definition': 'reference',
                        'included': False, 'opclass': 'pg_catalog.text_ops',
                        'collation': 'pg_catalog.default', 'option': 0,
                    }],
                    'predicate': '(reference IS NOT NULL)',
                    'definition': 'CREATE INDEX orders_reference_idx ON orders (reference)',
                }],
                'partitions': [{'parent': 'orders', 'child': 'orders_2026'}],
                'functions': [{
                    'schema': 'public', 'name': 'audit_business_product_names',
                    'identityArguments': '', 'result': 'trigger',
                    'language': 'plpgsql', 'volatility': 'v',
                    'body': 'CREATE FUNCTION audit_business_product_names() RETURNS trigger',
                }],
                'triggers': [{
                    'schema': 'public', 'relation': 'orders',
                    'name': 'orders_product_name_audit', 'enabled': 'O',
                    'typeBits': 23, 'functionSchema': 'public',
                    'functionName': 'audit_business_product_names',
                    'functionIdentityArguments': '', 'argumentsHex': '',
                    'condition': None,
                    'definition': 'CREATE TRIGGER orders_product_name_audit',
                }],
                'relations': [{
                    'schema': 'public', 'name': 'orders', 'kind': 'p',
                    'partitionStrategy': 'r',
                    'partitionKeyDefinition': 'RANGE (created_at)',
                }],
                'comments': [{
                    'schema': 'public', 'relation': 'orders',
                    'objectType': 'column', 'column': 'id',
                    'comment': 'synthetic identifier',
                }],
            },
        }

    def makeNativeSchemaFixture(self):
        key = b'native-schema-qa-' + (b'k' * 32)
        archive = self.root / 'source-schema.archive'
        archive.write_bytes(b'synthetic native schema archive')
        listBytes = b'; synthetic schema-only list\n'
        diagnostic = self.schemaDiagnostic()
        rawDigest = BACKUP.schemaDigestFromDiagnostic(diagnostic)
        businessDumpSha = 'a' * 64
        source = {
            'schemaVersion': 1,
            'kind': 'apple-order-mgr-source-schema-archive',
            'passed': True,
            'archive': {
                'sha256': hashlib.sha256(archive.read_bytes()).hexdigest(),
                'size': archive.stat().st_size,
                'listSha256': hashlib.sha256(listBytes).hexdigest(),
            },
            'businessDumpSha256': businessDumpSha,
            'expectedSourceSchemaDigest': rawDigest,
            'beforeDiagnostic': diagnostic,
            'afterDiagnostic': dict(diagnostic),
        }
        BACKUP.authenticate(source, key)
        sourcePath = self.root / 'source-schema-evidence.json'
        writeJson(sourcePath, source)
        roundtrip = {
            'schemaVersion': 1,
            'kind': 'apple-order-mgr-schema-roundtrip',
            'passed': True,
            'dump': {'sha256': businessDumpSha},
            'schemaOnlyRestore': {
                'containerId': 'schema-only-container',
                'targetDatabase': 'apple_order_mgr_restore_schema_only',
            },
        }
        BACKUP.authenticate(roundtrip, key)
        roundtripPath = self.root / 'schema-roundtrip.json'
        writeJson(roundtripPath, roundtrip)
        fullRestorePath = self.root / 'full-restore.json'
        writeJson(fullRestorePath, {
            'kind': 'apple-order-mgr-database-restore',
            'completeRestore': True,
            'dump': {'sha256': businessDumpSha},
            'containerId': 'full-restore-container',
            'targetDatabase': 'apple_order_mgr_restore_full',
        })
        originalPath = self.root / 'original-comparison.json'
        writeJson(originalPath, {'passed': False, 'mismatches': ['schemaDigest']})
        invalidatedPath = self.root / 'unsafe-regex-comparison.json'
        writeJson(invalidatedPath, {'passed': True, 'method': 'unsafe-regex'})
        invalidationPath = self.root / 'unsafe-regex-comparison.invalidated.json'
        writeJson(invalidationPath, {
            'passed': False,
            'reasonCode': 'UNSAFE_REGEX_SCHEMA_EQUIVALENCE',
            'invalidatedEvidence': invalidatedPath.name,
            'invalidatedEvidenceSha256': hashlib.sha256(
                invalidatedPath.read_bytes()).hexdigest(),
        })
        referenceProofPath = self.root / 'reference-isolation.json'
        referenceProofPath.write_text('{}', encoding='utf-8')
        schemaSql = self.root / 'schema-diagnostic.sql'
        schemaSql.write_text('SELECT 1;', encoding='utf-8')
        inventorySql = self.root / 'schema-inventory.sql'
        inventorySql.write_text('SELECT 1;', encoding='utf-8')
        return {
            'key': key,
            'archive': archive,
            'source': sourcePath,
            'roundtrip': roundtripPath,
            'fullRestore': fullRestorePath,
            'original': originalPath,
            'invalidation': invalidationPath,
            'referenceProof': referenceProofPath,
            'schemaSql': schemaSql,
            'inventorySql': inventorySql,
            'diagnostic': diagnostic,
            'listBytes': listBytes,
        }

    def runNativeSchemaFixture(self, fixture, inventories, output,
                               referenceContainer='reference-container'):
        referenceProof = {
            'containerId': referenceContainer,
            'databaseUser': 'postgres',
        }
        empty = {'passed': True, 'userTables': 0, 'serverVersionNum': 150018}
        with mock.patch.object(BACKUP, 'loadIsolationProof',
                               return_value=referenceProof), \
                mock.patch.object(BACKUP, 'verifyLiveIsolation',
                                  return_value={'Mounts': []}), \
                mock.patch.object(BACKUP, 'verifySchemaArchiveList'), \
                mock.patch.object(BACKUP, 'verifyContainerDumpMount'), \
                mock.patch.object(BACKUP, 'verifyReadOnlyRestoreContainer'), \
                mock.patch.object(BACKUP.subprocess, 'run', return_value=mock.Mock(
                    returncode=0, stdout=b'', stderr=b'')), \
                mock.patch.object(BACKUP, 'runContainerPsql',
                                  side_effect=[empty] + inventories), \
                mock.patch.object(BACKUP, 'runContainerSchemaDiagnostic',
                                  side_effect=[fixture['diagnostic']] * 3), \
                mock.patch.object(BACKUP, 'runCanonicalSchemaDump',
                                  side_effect=[(b'complete schema SQL\n', 'sha256:' + 'f' * 64)] * 3):
            return BACKUP.createNativeSchemaEvidence(
                fixture['archive'], fixture['source'],
                'apple_order_mgr_restore_reference', fixture['referenceProof'],
                '/restore-input/source-schema.archive', fixture['roundtrip'],
                fixture['fullRestore'], fixture['schemaSql'],
                fixture['inventorySql'], fixture['original'],
                fixture['invalidation'], Path(str(output) + '.sql'), output,
                fixture['key'])

    def test_source_schema_archive_is_schema_only_authenticated_and_atomic(self):
        output = self.root / 'source-schema.dump'
        evidence = self.root / 'source-schema-evidence.json'
        schemaSql = self.root / 'schema.sql'
        schemaSql.write_text("SELECT '{\"passed\":true}'::json;", encoding='utf-8')
        diagnostic = self.schemaDiagnostic()
        expected = BACKUP.schemaDigestFromDiagnostic(diagnostic)
        key = b'schema-source-qa-' + (b'k' * 32)
        listBytes = (
            b'; synthetic PG15 archive\n'
            b'1; 2615 2200 SCHEMA - public owner\n'
            b'2; 1259 123 TABLE public orders owner\n'
        )
        calls = []

        def fakeRun(argv, **_kwargs):
            calls.append(list(argv))
            if argv[0] == 'pg_dump':
                archive = Path(argv[argv.index('--file') + 1])
                archive.write_bytes(b'synthetic schema archive')
                return mock.Mock(returncode=0, stdout=b'', stderr=b'')
            if argv[:2] == ['pg_restore', '--list']:
                return mock.Mock(returncode=0, stdout=listBytes, stderr=b'')
            raise AssertionError(argv)

        with mock.patch.object(BACKUP, 'runValidation',
                               side_effect=[diagnostic, dict(diagnostic)]), \
                mock.patch.object(BACKUP.subprocess, 'run', side_effect=fakeRun):
            document = BACKUP.createSourceSchemaArchive(
                'apple_order_mgr', output, schemaSql, evidence, expected,
                'a' * 64, key)

        self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o600)
        self.assertEqual(document['archive']['tableDataEntryCount'], 0)
        self.assertEqual(document['archive']['largeObjectDataEntryCount'], 0)
        self.assertEqual(document['archive']['listSha256'],
                         hashlib.sha256(listBytes).hexdigest())
        self.assertEqual(document['businessDumpSha256'], 'a' * 64)
        BACKUP.verifyAuthentication(document, key, 'QA_AUTHENTICATION')
        dumpCommand = next(call for call in calls if call[0] == 'pg_dump')
        self.assertIn('--schema-only', dumpCommand)
        self.assertIn('--no-owner', dumpCommand)
        self.assertIn('--no-privileges', dumpCommand)

    def test_source_schema_archive_rejects_data_and_removes_failed_output(self):
        schemaSql = self.root / 'schema.sql'
        schemaSql.write_text("SELECT '{\"passed\":true}'::json;", encoding='utf-8')
        diagnostic = self.schemaDiagnostic()
        expected = BACKUP.schemaDigestFromDiagnostic(diagnostic)
        key = b'schema-source-qa-' + (b'k' * 32)
        forbidden = (
            b'1; 0 0 TABLE DATA public orders owner\n',
            b'1; 0 0 BLOB - 123 owner\n',
            b'1; 0 0 BLOBS - BLOBS owner\n',
        )
        for index, listBytes in enumerate(forbidden):
            output = self.root / ('forbidden-%d.dump' % index)
            evidence = self.root / ('forbidden-%d.json' % index)

            def fakeRun(argv, **_kwargs):
                if argv[0] == 'pg_dump':
                    Path(argv[argv.index('--file') + 1]).write_bytes(b'archive')
                    return mock.Mock(returncode=0, stdout=b'', stderr=b'')
                return mock.Mock(returncode=0, stdout=listBytes, stderr=b'')

            with self.subTest(listBytes=listBytes), \
                    mock.patch.object(BACKUP, 'runValidation',
                                      return_value=diagnostic), \
                    mock.patch.object(BACKUP.subprocess, 'run',
                                      side_effect=fakeRun):
                with self.assertRaises(BACKUP.BackupError) as raised:
                    BACKUP.createSourceSchemaArchive(
                        'apple_order_mgr', output, schemaSql, evidence, expected,
                        'a' * 64, key)
                self.assertEqual(raised.exception.code,
                                 'PG_SCHEMA_ARCHIVE_CONTAINS_DATA')
                self.assertFalse(output.exists())
                self.assertFalse(evidence.exists())

        emptyOutput = self.root / 'empty.dump'
        emptyEvidence = self.root / 'empty.json'

        def emptyArchive(argv, **_kwargs):
            if argv[0] == 'pg_dump':
                return mock.Mock(returncode=0, stdout=b'', stderr=b'')
            return mock.Mock(
                returncode=0,
                stdout=b'1; 2615 2200 SCHEMA - public owner\n', stderr=b'')

        with mock.patch.object(BACKUP, 'runValidation',
                               side_effect=[diagnostic, dict(diagnostic)]), \
                mock.patch.object(BACKUP.subprocess, 'run',
                                  side_effect=emptyArchive):
            with self.assertRaises(BACKUP.BackupError) as raised:
                BACKUP.createSourceSchemaArchive(
                    'apple_order_mgr', emptyOutput, schemaSql, emptyEvidence,
                    expected, 'a' * 64, key)
        self.assertEqual(raised.exception.code, 'PG_DUMP_EMPTY')
        self.assertFalse(emptyOutput.exists())
        self.assertFalse(emptyEvidence.exists())

    def test_source_schema_archive_rejects_archive_evidence_path_alias(self):
        samePath = self.root / 'schema-output'
        schemaSql = self.root / 'schema.sql'
        schemaSql.write_text("SELECT '{\"passed\":true}'::json;", encoding='utf-8')
        calls = []

        def shouldNotRun(*args, **kwargs):
            calls.append((args, kwargs))
            raise AssertionError('path conflict must fail before commands')

        with mock.patch.object(BACKUP, 'runValidation', side_effect=shouldNotRun), \
                mock.patch.object(BACKUP.subprocess, 'run',
                                  side_effect=shouldNotRun):
            with self.assertRaises(BACKUP.BackupError) as raised:
                BACKUP.createSourceSchemaArchive(
                    'apple_order_mgr', samePath, schemaSql, samePath,
                    '0' * 32, 'a' * 64, b'k' * 32)
        self.assertEqual(raised.exception.code, 'BACKUP_PATH_CONFLICT')
        self.assertEqual(calls, [])
        self.assertFalse(samePath.exists())

        realParent = self.root / 'real-parent'
        realParent.mkdir()
        aliasParent = self.root / 'alias-parent'
        aliasParent.symlink_to(realParent, target_is_directory=True)
        calls[:] = []
        with mock.patch.object(BACKUP, 'runValidation', side_effect=shouldNotRun), \
                mock.patch.object(BACKUP.subprocess, 'run',
                                  side_effect=shouldNotRun):
            with self.assertRaises(BACKUP.BackupError) as raised:
                BACKUP.createSourceSchemaArchive(
                    'apple_order_mgr', aliasParent / 'schema-output', schemaSql,
                    realParent / 'schema-output', '0' * 32, 'a' * 64,
                    b'k' * 32)
        self.assertEqual(raised.exception.code, 'BACKUP_PATH_CONFLICT')
        self.assertEqual(calls, [])
        self.assertFalse((realParent / 'schema-output').exists())

    def test_native_schema_inventory_rejects_function_trigger_fk_and_index_drift(self):
        fixture = self.makeNativeSchemaFixture()
        mutations = (
            ('function-body', 'functions', 'body', 'changed function body'),
            ('trigger-enabled', 'triggers', 'enabled', 'D'),
            ('child-fk-root', 'constraints', 'rootName', 'wrong_root'),
            ('child-fk-columns', 'constraints', 'keyColumns', ['wrong_id']),
            ('child-fk-action', 'constraints', 'deleteAction', 'r'),
            ('index-opclass', 'indexes', 'attributes', [{
                'position': 1, 'definition': 'reference', 'included': False,
                'opclass': 'pg_catalog.text_pattern_ops',
                'collation': 'pg_catalog.default', 'option': 0,
            }]),
            ('index-predicate', 'indexes', 'predicate', None),
            ('partition-key', 'relations', 'partitionKeyDefinition',
             'RANGE (id)'),
            ('comment-byte', 'comments', 'comment', 'synthetic identifier.'),
        )
        for index, (case, component, field, value) in enumerate(mutations):
            inventories = [json.loads(json.dumps(self.nativeSchemaInventory()))
                           for _item in range(3)]
            inventories[-1]['components'][component][0][field] = value
            output = self.root / ('native-mismatch-%d.json' % index)
            with self.subTest(case=case), self.assertRaises(
                    BACKUP.BackupError) as raised:
                self.runNativeSchemaFixture(fixture, inventories, output)
            self.assertEqual(raised.exception.code,
                             'SCHEMA_NATIVE_INVENTORY_MISMATCH')
            self.assertFalse(output.exists())

    def test_native_schema_evidence_rejects_container_reuse_and_input_tamper(self):
        fixture = self.makeNativeSchemaFixture()
        inventories = [json.loads(json.dumps(self.nativeSchemaInventory()))
                       for _item in range(3)]
        roundtrip = json.loads(fixture['roundtrip'].read_text(encoding='utf-8'))
        roundtrip['schemaOnlyRestore']['containerId'] = 'reference-container'
        BACKUP.authenticate(roundtrip, fixture['key'])
        writeJson(fixture['roundtrip'], roundtrip)
        with self.assertRaises(BACKUP.BackupError) as reused:
            self.runNativeSchemaFixture(
                fixture, inventories, self.root / 'container-reuse.json')
        self.assertEqual(reused.exception.code, 'SCHEMA_NATIVE_CONTAINER_REUSE')

        fixture = self.makeNativeSchemaFixture()
        source = json.loads(fixture['source'].read_text(encoding='utf-8'))
        source['expectedSourceSchemaDigest'] = 'tampered-without-resigning'
        writeJson(fixture['source'], source)
        with self.assertRaises(BACKUP.BackupError) as proofTamper:
            self.runNativeSchemaFixture(
                fixture, inventories, self.root / 'proof-tamper.json')
        self.assertEqual(proofTamper.exception.code,
                         'SOURCE_SCHEMA_EVIDENCE_INVALID')

        fixture = self.makeNativeSchemaFixture()
        fixture['archive'].write_bytes(b'tampered archive bytes')
        with self.assertRaises(BACKUP.BackupError) as dumpTamper:
            self.runNativeSchemaFixture(
                fixture, inventories, self.root / 'archive-tamper.json')
        self.assertEqual(dumpTamper.exception.code,
                         'SOURCE_SCHEMA_ARCHIVE_CHANGED')

        fixture = self.makeNativeSchemaFixture()
        invalidation = json.loads(
            fixture['invalidation'].read_text(encoding='utf-8'))
        invalidation['invalidatedEvidenceSha256'] = '0' * 64
        writeJson(fixture['invalidation'], invalidation)
        with self.assertRaises(BACKUP.BackupError) as invalidationTamper:
            self.runNativeSchemaFixture(
                fixture, inventories, self.root / 'invalidation-tamper.json')
        self.assertEqual(invalidationTamper.exception.code,
                         'INVALIDATION_EVIDENCE_INVALID')

    def test_native_schema_archive_list_digest_tamper_fails_closed(self):
        archive = self.root / 'source-schema.archive'
        archive.write_bytes(b'archive')
        with mock.patch.object(BACKUP.subprocess, 'run', return_value=mock.Mock(
                returncode=0, stdout=b'changed list', stderr=b'')):
            with self.assertRaises(BACKUP.BackupError) as raised:
                BACKUP.verifySchemaArchiveList(
                    'pg_restore', archive,
                    hashlib.sha256(b'expected list').hexdigest())
        self.assertEqual(raised.exception.code, 'PG_SCHEMA_LIST_CHANGED')

    def test_native_schema_complete_sql_rejects_single_byte_drift(self):
        exact = {
            'reference': b'complete schema SQL\n',
            'businessSchemaOnly': b'complete schema SQL\n',
            'fullRestore': b'complete schema SQL\n',
        }
        self.assertTrue(BACKUP.verifyCanonicalSchemaSql(exact))
        for name in exact:
            changed = dict(exact)
            changed[name] = changed[name][:-1] + b'.'
            with self.subTest(name=name), self.assertRaises(
                    BACKUP.BackupError) as raised:
                BACKUP.verifyCanonicalSchemaSql(changed)
            self.assertEqual(raised.exception.code,
                             'SCHEMA_CANONICAL_SQL_MISMATCH')

    def test_native_schema_dump_runs_the_inspected_immutable_client_image(self):
        containerId = 'container-' + ('c' * 64)
        imageTag = 'postgres:15.18-alpine'
        imageId = 'sha256:' + ('f' * 64)
        calls = []
        responses = iter((
            mock.Mock(returncode=0, stdout=json.dumps([{
                'Id': containerId,
                'HostConfig': {'NetworkMode': 'none'},
                'State': {'Running': True},
                'Config': {'Env': ['POSTGRES_PASSWORD=synthetic-test-only']},
            }]).encode('utf-8'), stderr=b''),
            mock.Mock(returncode=0, stdout=json.dumps([{
                'Id': imageId,
            }]).encode('utf-8'), stderr=b''),
            mock.Mock(returncode=0, stdout=b'complete schema SQL\n', stderr=b''),
        ))

        def runCommand(argv, **_kwargs):
            calls.append(list(argv))
            return next(responses)

        with mock.patch.object(BACKUP.subprocess, 'run', side_effect=runCommand):
            sql, actualImageId = BACKUP.runCanonicalSchemaDump(
                'docker', containerId, 'apple_order_mgr_restore_qa', 'postgres',
                imageTag, 'A' * 64)
        self.assertEqual(sql, b'complete schema SQL\n')
        self.assertEqual(actualImageId, imageId)
        self.assertIn(imageId, calls[2])
        self.assertNotIn(imageTag, calls[2])
        self.assertIn('container:' + containerId, calls[2])


class ProductionExecutorPlanAcceptanceTest(unittest.TestCase):
    def validPlan(self):
        return {
            'schemaVersion': 1,
            'releaseId': 'release-qa',
            'attemptId': 'attempt-1',
            'evidenceDir': '/tmp/release-qa-evidence',
            'lockPath': '/tmp/release-qa.lock',
            'sourceDigest': 'a' * 64,
            'baselineDigest': 'b' * 64,
            'baselineEvidence': '/tmp/release-qa-baseline.json',
            'frontend': {
                'gateScript': '/tmp/productionFrontendGate.py',
                'candidate': '/tmp/releases/new',
                'current': '/tmp/current',
                'expectedCurrent': '/tmp/releases/old',
                'nginxUser': '33:33',
                'nginxUsers': ['33:33'],
                'baseUrl': 'https://example.test',
            },
            'components': {
                'api': {'expectedVersion': 'old', 'targetVersion': 'new'},
                'frontend': {'expectedVersion': 'old', 'targetVersion': 'new'},
            },
            'steps': [
                {
                    'id': 'frontend-prepare',
                    'stage': 'preflight',
                    'type': 'frontendPrepare',
                    'requiresReleaseLock': True,
                },
                {
                    'id': 'frontend-check',
                    'stage': 'preflight',
                    'type': 'frontendCheck',
                    'requiresReleaseLock': True,
                },
                {
                    'id': 'frontend-switch',
                    'stage': 'switch',
                    'type': 'frontendSwitch',
                    'requiresReleaseLock': True,
                    'mutatesComponents': ['frontend'],
                    'reconcileCompleted': [sys.executable, '-c', 'pass'],
                    'reconcileRolledBack': [sys.executable, '-c', 'pass'],
                },
                {
                    'id': 'frontend-verify',
                    'stage': 'verify',
                    'type': 'frontendVerify',
                    'requiresReleaseLock': True,
                },
            ],
        }

    def assertPlanRejected(self, plan):
        with self.assertRaises(RELEASE.ReleaseError):
            RELEASE.validatePlan(plan)

    def test_baseline_digest_is_required_and_frontend_check_must_be_locked(self):
        valid = self.validPlan()
        self.assertIs(RELEASE.validatePlan(valid), valid)

        noPrepare = self.validPlan()
        noPrepare['steps'] = [step for step in noPrepare['steps']
                              if step['id'] != 'frontend-prepare']
        with self.subTest(case='frontend prepare required'):
            self.assertPlanRejected(noPrepare)

        unlockedPrepare = self.validPlan()
        next(step for step in unlockedPrepare['steps']
             if step['id'] == 'frontend-prepare').pop('requiresReleaseLock')
        with self.subTest(case='locked frontend prepare'):
            self.assertPlanRejected(unlockedPrepare)

        wrongOrder = self.validPlan()
        prepare = wrongOrder['steps'].pop(0)
        wrongOrder['steps'].insert(1, prepare)
        with self.subTest(case='prepare before check'):
            self.assertPlanRejected(wrongOrder)

        noBaseline = self.validPlan()
        noBaseline.pop('baselineDigest')
        with self.subTest(case='baseline digest'):
            self.assertPlanRejected(noBaseline)

        unlockedCheck = self.validPlan()
        next(step for step in unlockedCheck['steps']
             if step['id'] == 'frontend-check').pop('requiresReleaseLock')
        with self.subTest(case='locked frontend check'):
            self.assertPlanRejected(unlockedCheck)

        unlockedVerify = self.validPlan()
        unlockedVerify['steps'][-1].pop('requiresReleaseLock')
        with self.subTest(case='locked frontend verify'):
            self.assertPlanRejected(unlockedVerify)

    def test_resource_guard_schema_is_strict_and_parallel_never_enters_lock(self):
        guarded = self.validPlan()
        guarded['resourceGuard'] = {
            'argv': ['resource-probe'],
            'onPressure': 'serial',
            'minimumDiskFreeBytes': 1,
            'maximumApiLatencyMs': 100,
            'maximumLockWaitMs': 20,
            'timeoutSeconds': 10,
        }
        guarded['steps'].insert(0, {
            'id': 'read-only-one',
            'stage': 'preflight',
            'type': 'command',
            'argv': [sys.executable, '-c', 'pass'],
            'parallelGroup': 'read-only-checks',
            'readOnly': True,
            'serialFallbackSafe': True,
        })
        self.assertIs(RELEASE.validatePlan(guarded), guarded)

        booleanThreshold = json.loads(json.dumps(guarded))
        booleanThreshold['resourceGuard']['minimumDiskFreeBytes'] = True
        self.assertPlanRejected(booleanThreshold)
        nonStringGroup = json.loads(json.dumps(guarded))
        nonStringGroup['steps'][0]['parallelGroup'] = True
        self.assertPlanRejected(nonStringGroup)
        insideLock = json.loads(json.dumps(guarded))
        parallel = insideLock['steps'].pop(0)
        insideLock['steps'].insert(2, parallel)
        with self.assertRaises(RELEASE.ReleaseError) as raised:
            RELEASE.validatePlan(insideLock)
        self.assertEqual(raised.exception.code, 'PLAN_PARALLEL_INSIDE_LOCK')

    def test_parallel_failure_does_not_start_pending_work(self):
        executor = RELEASE.ReleaseExecutor.__new__(RELEASE.ReleaseExecutor)
        executor.forceSerial = False
        started = []
        completed = []

        def execute(step):
            started.append(step['id'])
            if step['id'] == 'one':
                raise RELEASE.ReleaseError('STEP_FAILED', 'one')

        executor.executeStep = execute
        executor.markCompleted = lambda step: completed.append(step['id'])
        executor.runResourceProbe = lambda _reason: {'pressure': False}
        with self.assertRaises(RELEASE.ReleaseError) as raised:
            executor.runParallelGroup([
                {'id': 'one'}, {'id': 'two'}, {'id': 'pending-three'},
            ])
        self.assertEqual(raised.exception.code, 'STEP_FAILED')
        self.assertEqual(set(started), {'one', 'two'})
        self.assertNotIn('pending-three', started)
        self.assertEqual(completed, ['two'])

    def test_api_resource_probe_allows_only_exact_loopback_readiness_path(self):
        class HealthyResponse(object):
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

        opened = []

        def openUrl(url, **_kwargs):
            opened.append(url)
            return HealthyResponse()

        with mock.patch.object(RESOURCE_PROBE.urllib.request, 'urlopen',
                               side_effect=openUrl):
            latency = RESOURCE_PROBE.probeApi(
                'http://127.0.0.1/api/health/ready', 3)
            self.assertGreaterEqual(latency, 0)
            for url in (
                    'http://127.0.0.1/api/orders/delete',
                    'http://127.0.0.1/api/health/ready?mutate=1',
                    'http://127.0.0.1/api/health/ready#fragment',
                    'http://localhost/admin'):
                with self.subTest(url=url), self.assertRaises(
                        RESOURCE_PROBE.ProbeError) as raised:
                    RESOURCE_PROBE.probeApi(url, 3)
                self.assertEqual(raised.exception.code, 'API_PROBE_URL_INVALID')
        self.assertEqual(opened, ['http://127.0.0.1/api/health/ready'])

    def test_resource_probe_thresholds_timeout_and_evidence_are_fail_closed(self):
        with tempfile.TemporaryDirectory(prefix='resource-guard-qa-') as temporary:
            executor = RELEASE.ReleaseExecutor.__new__(RELEASE.ReleaseExecutor)
            executor.plan = {'resourceGuard': {
                'argv': ['resource-probe'],
                'onPressure': 'serial',
                'minimumDiskFreeBytes': 100,
                'maximumApiLatencyMs': 50,
                'maximumLockWaitMs': 20,
                'timeoutSeconds': 3,
            }}
            executor.resourceProbeCount = 0
            executor.forceSerial = False
            executor.evidenceDir = Path(temporary)
            executor.recorder = mock.Mock()

            diskLow = mock.Mock(returncode=0, stderr=b'secret', stdout=json.dumps({
                'passed': True, 'diskFreeBytes': 99,
                'apiLatencyMs': 1, 'lockWaitMs': 1,
                'raw': 'must not be persisted',
            }).encode('utf-8'))
            with mock.patch.object(RELEASE.subprocess, 'run', return_value=diskLow):
                with self.assertRaises(RELEASE.ReleaseError) as raised:
                    executor.runResourceProbe('release-preflight')
            self.assertEqual(raised.exception.code, 'RESOURCE_DISK_LOW')
            self.assertFalse(list(Path(temporary).iterdir()))

            pressure = mock.Mock(returncode=0, stderr=b'secret', stdout=json.dumps({
                'passed': True, 'diskFreeBytes': 100,
                'apiLatencyMs': 51, 'lockWaitMs': 20,
                'raw': 'must not be persisted',
            }).encode('utf-8'))
            with mock.patch.object(RELEASE.subprocess, 'run', return_value=pressure):
                result = executor.runResourceProbe('parallel-group-progress')
            self.assertTrue(result['pressure'])
            self.assertTrue(executor.forceSerial)
            evidence = json.loads(Path(result['evidence']).read_text(encoding='utf-8'))
            self.assertEqual(set(evidence), {
                'passed', 'reason', 'diskFreeBytes', 'apiLatencyMs',
                'lockWaitMs', 'parallelDegraded',
            })
            self.assertNotIn('raw', evidence)

            with mock.patch.object(
                    RELEASE.subprocess, 'run',
                    side_effect=subprocess.TimeoutExpired(['probe'], 3)):
                with self.assertRaises(RELEASE.ReleaseError) as timeout:
                    executor.runResourceProbe('parallel-group-progress')
            self.assertEqual(timeout.exception.code, 'RESOURCE_PROBE_TIMEOUT')

    def test_resume_cannot_turn_a_rolled_back_release_into_passed(self):
        with tempfile.TemporaryDirectory(prefix='release-executor-qa-') as temporary:
            root = Path(temporary)
            plan = self.validPlan()
            plan['evidenceDir'] = str(root / 'evidence')
            plan['lockPath'] = str(root / 'release.lock')
            plan['baselineEvidence'] = str(root / 'baseline.json')
            plan['resumeChecks'] = [[sys.executable, '-c', 'pass']]
            switchIndex = next(index for index, step in enumerate(plan['steps'])
                               if step['id'] == 'frontend-switch')
            plan['steps'].insert(switchIndex, {
                'id': 'api-switch',
                'stage': 'switch',
                'type': 'command',
                'argv': [sys.executable, '-c', 'pass'],
                'rollback': [[sys.executable, '-c', 'pass']],
                'requiresReleaseLock': True,
                'mutatesComponents': ['api'],
                'reconcileCompleted': [sys.executable, '-c', 'pass'],
                'reconcileRolledBack': [sys.executable, '-c', 'pass'],
            })
            for step in plan['steps']:
                step['resumeSafe'] = True

            baseline = {
                'passed': True,
                'releaseId': plan['releaseId'],
                'components': plan['components'],
            }
            writeJson(Path(plan['baselineEvidence']), baseline)
            plan['baselineDigest'] = hashlib.sha256(
                Path(plan['baselineEvidence']).read_bytes()).hexdigest()

            executed = []
            failVerify = {'enabled': True}

            class FakeExecutor(RELEASE.ReleaseExecutor):
                def executeStep(self, step, rollback=False):
                    executed.append((step['id'], rollback))
                    started = RELEASE.utcNow()
                    if step['id'] == 'frontend-verify' and failVerify['enabled']:
                        self.recorder.record(
                            step['stage'], step['id'], started, RELEASE.utcNow(),
                            0, 'failed', errorCode='STEP_FAILED')
                        raise RELEASE.ReleaseError('STEP_FAILED', step['id'])
                    self.recorder.record(
                        step['stage'], step['id'], started, RELEASE.utcNow(),
                        0, 'passed')
                    return {}

            with self.assertRaises(RELEASE.ReleaseError) as firstError:
                FakeExecutor(plan).run()
            self.assertEqual(firstError.exception.code, 'STEP_FAILED')
            self.assertIn(('frontend-switch-1', True), executed)
            self.assertIn(('api-switch-1', True), executed)

            failVerify['enabled'] = False
            with self.assertRaises(RELEASE.ReleaseError) as resumeError:
                FakeExecutor(plan, resume=True).run()
            self.assertEqual(resumeError.exception.code, 'RESUME_AFTER_ROLLBACK')

    def test_resume_rechecks_under_lock_when_all_steps_were_completed(self):
        with tempfile.TemporaryDirectory(prefix='release-resume-qa-') as temporary:
            root = Path(temporary)
            plan = self.validPlan()
            plan['evidenceDir'] = str(root / 'evidence')
            plan['lockPath'] = str(root / 'release.lock')
            plan['baselineEvidence'] = str(root / 'baseline.json')
            plan['resumeChecks'] = [[sys.executable, '-c', 'pass']]
            for step in plan['steps']:
                step['resumeSafe'] = True
            baseline = {
                'passed': True,
                'releaseId': plan['releaseId'],
                'components': plan['components'],
            }
            writeJson(Path(plan['baselineEvidence']), baseline)
            plan['baselineDigest'] = hashlib.sha256(
                Path(plan['baselineEvidence']).read_bytes()).hexdigest()
            state = {
                'schemaVersion': 1,
                'releaseId': plan['releaseId'],
                'attemptId': plan['attemptId'],
                'planDigest': RELEASE.sha256Bytes(RELEASE.canonicalBytes(plan)),
                'sourceDigest': plan['sourceDigest'],
                'baselineDigest': plan['baselineDigest'],
                'completedSteps': [step['id'] for step in plan['steps']],
                'status': 'running',
            }
            writeJson(Path(plan['evidenceDir']) / 'release-state.json', state)
            executed = []

            class FakeExecutor(RELEASE.ReleaseExecutor):
                def executeStep(self, step, rollback=False):
                    executed.append((step['id'], rollback))
                    started = RELEASE.utcNow()
                    self.recorder.record(
                        step['stage'], step['id'], started, RELEASE.utcNow(),
                        0, 'passed')
                    return {}

            executor = FakeExecutor(plan, resume=True)
            acquired = []
            executor.releaseLock.acquire = lambda: acquired.append(True)
            started = RELEASE.utcNow()
            executor.recorder.record(
                'verify', 'previous-final-verification', started,
                RELEASE.utcNow(), 0, 'passed')
            summary = executor.run()
            self.assertTrue(summary['passed'])
            self.assertEqual(acquired, [True])
            self.assertIn(('resume-check-1', False), executed)

    def test_unknown_api_queue_and_frontend_reconcile_before_resume_checks(self):
        for pendingStep, outcome in (
                ('api-switch', 'completed'),
                ('queue-switch', 'completed'),
                ('frontend-switch', 'completed'),
                ('api-switch', 'rolled-back'),
                ('queue-switch', 'rolled-back'),
                ('frontend-switch', 'rolled-back')):
            with self.subTest(step=pendingStep, outcome=outcome), \
                    tempfile.TemporaryDirectory(prefix='release-resolve-qa-') as temporary:
                root = Path(temporary)
                plan = self.validPlan()
                plan['components']['queue'] = {
                    'expectedVersion': 'old', 'targetVersion': 'new'}
                plan['evidenceDir'] = str(root / 'evidence')
                plan['lockPath'] = str(root / 'release.lock')
                plan['baselineEvidence'] = str(root / 'baseline.json')
                plan['resumeChecks'] = [['resume-check']]
                frontendIndex = next(
                    index for index, step in enumerate(plan['steps'])
                    if step['id'] == 'frontend-switch')
                for identifier, component in (
                        ('api-switch', 'api'), ('queue-switch', 'queue')):
                    plan['steps'].insert(frontendIndex, {
                        'id': identifier,
                        'stage': 'switch',
                        'type': 'command',
                        'argv': ['apply', identifier],
                        'rollback': [['rollback', identifier]],
                        'requiresReleaseLock': True,
                        'mutatesComponents': [component],
                        'reconcileCompleted': ['reconcile', identifier, 'completed'],
                        'reconcileRolledBack': ['reconcile', identifier, 'rolled-back'],
                    })
                    frontendIndex += 1
                plan['steps'][-2]['reconcileCompleted'] = [
                    'reconcile', 'frontend-switch', 'completed']
                plan['steps'][-2]['reconcileRolledBack'] = [
                    'reconcile', 'frontend-switch', 'rolled-back']
                self.assertIs(RELEASE.validatePlan(plan), plan)
                baseline = {
                    'passed': True, 'releaseId': plan['releaseId'],
                    'components': plan['components'],
                }
                writeJson(Path(plan['baselineEvidence']), baseline)
                plan['baselineDigest'] = hashlib.sha256(
                    Path(plan['baselineEvidence']).read_bytes()).hexdigest()
                state = {
                    'schemaVersion': 1,
                    'releaseId': plan['releaseId'],
                    'attemptId': plan['attemptId'],
                    'planDigest': RELEASE.sha256Bytes(RELEASE.canonicalBytes(plan)),
                    'sourceDigest': plan['sourceDigest'],
                    'baselineDigest': plan['baselineDigest'],
                    'completedSteps': ['frontend-prepare', 'frontend-check'],
                    'pendingMutation': pendingStep,
                    'status': 'failed',
                }
                statePath = Path(plan['evidenceDir']) / 'release-state.json'
                writeJson(statePath, state)
                evidence = {
                    'passed': True,
                    'step': pendingStep,
                    'outcome': outcome,
                    'releaseId': plan['releaseId'],
                    'attemptId': plan['attemptId'],
                    'baselineDigest': plan['baselineDigest'],
                    'planDigest': state['planDigest'],
                    'sourceDigest': plan['sourceDigest'],
                    'components': plan['components'],
                }
                evidencePath = root / 'resolution.json'
                writeJson(evidencePath, evidence)
                calls = []

                def runCommand(command, **_kwargs):
                    calls.append(list(command))
                    return mock.Mock(returncode=0)

                with mock.patch.object(RELEASE.subprocess, 'run',
                                       side_effect=runCommand):
                    resolved = RELEASE.resolveUnknownMutation(
                        plan, outcome, evidencePath)
                self.assertTrue(resolved['passed'])
                self.assertEqual(calls[0], [
                    'reconcile', pendingStep,
                    'completed' if outcome == 'completed' else 'rolled-back'])
                self.assertEqual(calls[1], ['resume-check'])
                finalState = json.loads(statePath.read_text(encoding='utf-8'))
                self.assertIsNone(finalState['pendingMutation'])
                self.assertEqual(finalState['status'], 'running')
                self.assertTrue(
                    finalState['mutationResolution']['resumeChecksPassed'])
                self.assertEqual(pendingStep in finalState['completedSteps'],
                                 outcome == 'completed')

    def test_unknown_resolution_postcheck_failure_preserves_resolution(self):
        with tempfile.TemporaryDirectory(prefix='release-resolve-qa-') as temporary:
            root = Path(temporary)
            plan = self.validPlan()
            plan['evidenceDir'] = str(root / 'evidence')
            plan['lockPath'] = str(root / 'release.lock')
            plan['baselineEvidence'] = str(root / 'baseline.json')
            plan['resumeChecks'] = [['post-check']]
            baseline = {
                'passed': True, 'releaseId': plan['releaseId'],
                'components': plan['components'],
            }
            writeJson(Path(plan['baselineEvidence']), baseline)
            plan['baselineDigest'] = hashlib.sha256(
                Path(plan['baselineEvidence']).read_bytes()).hexdigest()
            statePath = Path(plan['evidenceDir']) / 'release-state.json'
            planDigest = RELEASE.sha256Bytes(RELEASE.canonicalBytes(plan))
            writeJson(statePath, {
                'releaseId': plan['releaseId'],
                'attemptId': plan['attemptId'],
                'planDigest': planDigest,
                'sourceDigest': plan['sourceDigest'],
                'baselineDigest': plan['baselineDigest'],
                'completedSteps': ['frontend-prepare', 'frontend-check'],
                'pendingMutation': 'frontend-switch', 'status': 'failed',
            })
            evidencePath = root / 'resolution.json'
            writeJson(evidencePath, {
                'passed': True, 'step': 'frontend-switch',
                'outcome': 'completed', 'releaseId': plan['releaseId'],
                'attemptId': plan['attemptId'],
                'baselineDigest': plan['baselineDigest'],
                'planDigest': planDigest,
                'sourceDigest': plan['sourceDigest'],
                'components': plan['components'],
            })
            results = iter((mock.Mock(returncode=0), mock.Mock(returncode=1)))
            with mock.patch.object(RELEASE.subprocess, 'run',
                                   side_effect=lambda *_args, **_kwargs: next(results)):
                with self.assertRaises(RELEASE.ReleaseError) as raised:
                    RELEASE.resolveUnknownMutation(plan, 'completed', evidencePath)
            self.assertEqual(raised.exception.code, 'RESOLUTION_POSTCHECK_FAILED')
            state = json.loads(statePath.read_text(encoding='utf-8'))
            self.assertIsNone(state['pendingMutation'])
            self.assertIn('frontend-switch', state['completedSteps'])
            self.assertEqual(state['status'], 'resolution_check_failed')
            self.assertFalse(state['mutationResolution']['resumeChecksPassed'])
            self.assertEqual(state['errorCode'], 'RESOLUTION_POSTCHECK_FAILED')

    def test_unknown_resolution_rejects_state_or_plan_identity_mismatch_before_command(self):
        with tempfile.TemporaryDirectory(prefix='release-resolve-qa-') as temporary:
            root = Path(temporary)
            plan = self.validPlan()
            plan['evidenceDir'] = str(root / 'evidence')
            plan['lockPath'] = str(root / 'release.lock')
            plan['baselineEvidence'] = str(root / 'baseline.json')
            plan['resumeChecks'] = [['resume-check']]
            baseline = {
                'passed': True, 'releaseId': plan['releaseId'],
                'components': plan['components'],
            }
            writeJson(Path(plan['baselineEvidence']), baseline)
            plan['baselineDigest'] = hashlib.sha256(
                Path(plan['baselineEvidence']).read_bytes()).hexdigest()
            planDigest = RELEASE.sha256Bytes(RELEASE.canonicalBytes(plan))
            baseState = {
                'releaseId': plan['releaseId'],
                'attemptId': plan['attemptId'],
                'planDigest': planDigest,
                'sourceDigest': plan['sourceDigest'],
                'baselineDigest': plan['baselineDigest'],
                'completedSteps': ['frontend-prepare', 'frontend-check'],
                'pendingMutation': 'frontend-switch',
                'status': 'failed',
            }
            evidencePath = root / 'resolution.json'
            writeJson(evidencePath, {
                'passed': True, 'step': 'frontend-switch',
                'outcome': 'completed', 'releaseId': plan['releaseId'],
                'attemptId': plan['attemptId'],
                'planDigest': planDigest,
                'sourceDigest': plan['sourceDigest'],
                'baselineDigest': plan['baselineDigest'],
                'components': plan['components'],
            })
            statePath = Path(plan['evidenceDir']) / 'release-state.json'
            mismatches = {
                'releaseId': 'wrong-release',
                'attemptId': 'wrong-attempt',
                'planDigest': '0' * 64,
                'sourceDigest': '1' * 64,
                'baselineDigest': '2' * 64,
            }
            for field, value in mismatches.items():
                with self.subTest(field=field):
                    state = dict(baseState)
                    state[field] = value
                    writeJson(statePath, state)
                    with mock.patch.object(RELEASE.subprocess, 'run') as run:
                        with self.assertRaises(RELEASE.ReleaseError) as raised:
                            RELEASE.resolveUnknownMutation(
                                plan, 'completed', evidencePath)
                    self.assertEqual(raised.exception.code,
                                     'RESOLUTION_STATE_MISMATCH')
                    run.assert_not_called()
                    statePath.unlink()

            alteredPlan = json.loads(json.dumps(plan))
            next(step for step in alteredPlan['steps']
                 if step['id'] == 'frontend-switch')['reconcileCompleted'] = [
                     'different', 'reconcile', 'command']
            writeJson(statePath, baseState)
            with mock.patch.object(RELEASE.subprocess, 'run') as run:
                with self.assertRaises(RELEASE.ReleaseError) as raised:
                    RELEASE.resolveUnknownMutation(
                        alteredPlan, 'completed', evidencePath)
            self.assertEqual(raised.exception.code, 'RESOLUTION_STATE_MISMATCH')
            run.assert_not_called()


if __name__ == '__main__':
    unittest.main()
