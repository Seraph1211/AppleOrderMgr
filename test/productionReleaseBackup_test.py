import hashlib
import json
import sys
import tempfile
import unittest
from unittest import mock
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import productionReleaseBackup as backup


class ProductionReleaseBackupTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def test_pipeline_fails_when_upstream_fails(self):
        output = self.root / 'output.bin'
        commands = [
            [sys.executable, '-c', 'import sys; sys.stdout.write("x"); sys.exit(7)'],
            [sys.executable, '-c', 'import sys; sys.stdout.write(sys.stdin.read())'],
        ]
        with self.assertRaises(backup.BackupError) as raised:
            backup.runCheckedPipeline(commands, output)
        self.assertEqual(raised.exception.code, 'PIPELINE_FAILED')
        self.assertFalse(output.exists())

    def test_pipeline_rehashes_final_file(self):
        output = self.root / 'output.bin'
        result = backup.runCheckedPipeline(
            [[sys.executable, '-c', 'print("payload", end="")']], output)
        self.assertEqual(output.read_bytes(), b'payload')
        self.assertEqual(result['sha256'], hashlib.sha256(b'payload').hexdigest())

    def test_restore_rejects_external_connection_arguments_first(self):
        with self.assertRaises(backup.BackupError) as raised:
            backup.restoreDatabaseBackup(
                self.root / 'missing.dump', '0' * 64,
                'apple_order_mgr_restore_test', self.root / 'proof.json',
                self.root / 'validation.sql', self.root / 'evidence.json',
                connectionArgs=['--host', 'production'], proofKey=b'k' * 32,
                containerDumpPath='/restore-input/business.dump')
        self.assertEqual(raised.exception.code,
                         'RESTORE_EXTERNAL_CONNECTION_FORBIDDEN')

    def test_restore_target_name_cannot_be_production(self):
        proof = self.root / 'proof.json'
        document = {
            'schemaVersion': 1, 'kind': 'apple-order-mgr-restore-isolation',
            'generatedAtUtc': backup.utcNow(), 'targetDatabase': 'apple_order_mgr',
            'sourceDatabase': 'other', 'networkMode': 'none', 'publishedPorts': [],
            'postgresMajor': 15, 'testDatabaseMarker': 'apple_order_mgr',
            'databaseUser': 'postgres',
            'sideEffectsDisabled': {name: True for name in backup.SIDE_EFFECT_GUARDS},
        }
        backup.authenticate(document, b'k' * 32)
        backup.writeJsonAtomic(proof, document)
        with self.assertRaises(backup.BackupError) as raised:
            backup.loadIsolationProof(proof, 'apple_order_mgr', b'k' * 32)
        self.assertEqual(raised.exception.code, 'RESTORE_TARGET_NAME')

    def validation(self, schemaDigest):
        return {
            'passed': True,
            'validationVersion': 1,
            'businessTableCount': 1,
            'businessTables': {
                'public.orders': {'rowCount': 2, 'rowDigest': '1' * 32},
            },
            'schemaDigest': schemaDigest,
            'migrationDigest': '2' * 32,
            'migrationCount': 3,
            'sequenceStates': {},
            'sequenceStatesSnapshotAligned': False,
            'sequenceSafetyPassed': True,
            'excludedTableData': list(backup.AOS_LOG_EXCLUSIONS),
        }

    def schemaDiagnostic(self, raw='a', dense='b', constraints='c', indexes='d'):
        return {
            'passed': True,
            'columnsRawDigest': raw * 32,
            'columnsDenseDigest': dense * 32,
            'constraintsDigest': constraints * 32,
            'indexesDigest': indexes * 32,
            'typesDigest': 'e' * 32,
            'sequencesDigest': 'f' * 32,
            'ordinalGaps': [],
        }

    def test_regex_schema_roundtrip_comparison_is_retired(self):
        key = b'roundtrip-key-' + b'k' * 32
        dumpDigest = '9' * 64
        restoredSchema = self.schemaDiagnostic()
        restoredDigest = backup.schemaDigestFromDiagnostic(restoredSchema)
        source = {
            'completeBusinessBackup': True,
            'snapshotId': 'snapshot-test',
            'dump': {'sha256': dumpDigest},
            'sameSnapshotValidation': self.validation('0' * 32),
        }
        restored = {
            'kind': 'apple-order-mgr-database-restore',
            'completeRestore': True,
            'dump': {'sha256': dumpDigest},
            'validation': self.validation(restoredDigest),
        }
        sourcePath = self.root / 'source.json'
        restorePath = self.root / 'restore.json'
        backup.writeJsonAtomic(sourcePath, source)
        backup.writeJsonAtomic(restorePath, restored)
        roundtrip = {
            'schemaVersion': 1,
            'kind': 'apple-order-mgr-schema-roundtrip',
            'passed': True,
            'componentsExactlyMatch': True,
            'dump': {'sha256': dumpDigest},
            'schemaOnlyRestore': {'validation': restoredSchema},
            'fullRestore': {'validation': restoredSchema},
        }
        backup.authenticate(roundtrip, key)
        roundtripPath = self.root / 'roundtrip.json'
        backup.writeJsonAtomic(roundtripPath, roundtrip)
        sourceSchema = self.schemaDiagnostic(raw='0')
        sourceSchema['ordinalGaps'] = [{
            'table': 'public.apple_ids', 'column': 'status',
            'ordinalPosition': 8, 'densePosition': 7,
        }]
        sourceSchemaPath = self.root / 'source-schema.json'
        backup.writeJsonAtomic(sourceSchemaPath, sourceSchema)
        sourceDefinitions = [
            {
                'kind': 'constraint', 'name': 'public.orders.kind_check',
                'definition': "CHECK (((kind)::text = ANY ((ARRAY['a'::character varying, 'b'::character varying])::text[])))",
            },
            {
                'kind': 'constraint',
                'name': 'public.monitor_log_receipts.monitor_log_receipts_fkey1',
                'definition': 'FOREIGN KEY (id) REFERENCES p_20261001(id)',
            },
            {
                'kind': 'constraint',
                'name': 'public.monitor_log_receipts.monitor_log_receipts_fkey2',
                'definition': 'FOREIGN KEY (id) REFERENCES p_20261002(id)',
            },
        ]
        restoreDefinitions = [dict(item) for item in sourceDefinitions]
        restoreDefinitions[0]['definition'] = (
            "CHECK (((kind)::text = ANY (ARRAY[(('a'::character varying))::text, "
            "(('b'::character varying))::text])))")
        restoreDefinitions[1]['definition'], restoreDefinitions[2]['definition'] = (
            restoreDefinitions[2]['definition'], restoreDefinitions[1]['definition'])
        sourceDefinitionsPath = self.root / 'source-definitions.json'
        restoreDefinitionsPath = self.root / 'restore-definitions.json'
        backup.writeJsonAtomic(sourceDefinitionsPath, sourceDefinitions)
        backup.writeJsonAtomic(restoreDefinitionsPath, restoreDefinitions)
        with self.assertRaises(backup.BackupError) as raised:
            backup.compareValidationEvidence(
                sourcePath, restorePath, self.root / 'comparison.json',
                roundtripPath, sourceSchemaPath,
                sourceDefinitionsPath, restoreDefinitionsPath, key)
        self.assertEqual(raised.exception.code,
                         'SCHEMA_REGEX_COMPARISON_RETIRED')

    def test_native_inventory_requires_every_schema_component(self):
        names = ('schemas', 'columns', 'types', 'sequences', 'constraints',
                 'indexes', 'partitions', 'functions', 'triggers', 'relations',
                 'comments')
        inventory = {
            'passed': True,
            'inventoryVersion': 1,
            'serverVersionNum': 150018,
            'components': {name: [] for name in names},
        }
        self.assertIs(backup.validateNativeInventory(inventory), inventory)
        for missing in ('functions', 'triggers', 'relations', 'comments'):
            incomplete = json.loads(json.dumps(inventory))
            incomplete['components'].pop(missing)
            with self.assertRaises(backup.BackupError) as raised:
                backup.validateNativeInventory(incomplete)
            self.assertEqual(raised.exception.code,
                             'SCHEMA_NATIVE_INVENTORY_INVALID')

    def test_canonical_schema_sql_rejects_single_byte_drift(self):
        exact = {
            'reference': b'complete schema\n',
            'businessSchemaOnly': b'complete schema\n',
            'fullRestore': b'complete schema\n',
        }
        self.assertTrue(backup.verifyCanonicalSchemaSql(exact))
        exact['fullRestore'] = b'complete schema!\n'
        with self.assertRaises(backup.BackupError) as raised:
            backup.verifyCanonicalSchemaSql(exact)
        self.assertEqual(raised.exception.code, 'SCHEMA_CANONICAL_SQL_MISMATCH')

    def test_canonical_schema_dump_runs_inspected_immutable_image_id(self):
        containerId = 'c' * 64
        imageId = 'sha256:' + ('d' * 64)
        inspected = mock.Mock(
            returncode=0,
            stdout=json.dumps([{
                'Id': containerId,
                'HostConfig': {'NetworkMode': 'none'},
                'State': {'Running': True},
                'Config': {'Env': ['POSTGRES_PASSWORD=private']},
            }]).encode('utf-8'), stderr=b'')
        imageInspected = mock.Mock(
            returncode=0,
            stdout=json.dumps([{'Id': imageId}]).encode('utf-8'), stderr=b'')
        dumped = mock.Mock(returncode=0, stdout=b'complete schema\n', stderr=b'')
        with mock.patch.object(
                backup.subprocess, 'run',
                side_effect=[inspected, imageInspected, dumped]) as run:
            payload, resolvedImage = backup.runCanonicalSchemaDump(
                'docker', containerId, 'restore_test', 'postgres',
                'postgres:15.18-bookworm', 'fixedrestrictkey')
        self.assertEqual(payload, b'complete schema\n')
        self.assertEqual(resolvedImage, imageId)
        command = run.call_args_list[2].args[0]
        self.assertIn(imageId, command)
        self.assertNotIn('postgres:15.18-bookworm', command)


if __name__ == '__main__':
    unittest.main()
