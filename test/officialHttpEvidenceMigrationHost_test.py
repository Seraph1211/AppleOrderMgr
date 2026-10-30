#!/usr/bin/env python3
"""宿主官网证据迁移协调器的离线安全单测。"""
import hashlib
import hmac
import importlib.util
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock


MODULE_PATH = Path(__file__).parents[1] / 'scripts/officialPickupBackfill/runHttpEvidenceV2Migration.py'
SPEC = importlib.util.spec_from_file_location('http_evidence_migration_host', str(MODULE_PATH))
MIGRATION = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MIGRATION)


class HostMigrationTest(unittest.TestCase):
    """验证离机认证签名和宿主静止检查。"""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        (self.root / 'private').mkdir(mode=0o700)
        (self.root / 'evidence').mkdir()
        self.key = b'k' * 32
        self.write_private('private/evidence.key', self.key)
        self.plan = b'{"version":1}'
        self.plan_sha = hashlib.sha256(self.plan).hexdigest()
        self.write_private('private/plan.json', self.plan)

    def tearDown(self):
        self.temporary.cleanup()

    def write_private(self, relative, value):
        """写入 0600 测试文件。"""
        file_path = self.root / relative
        file_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        file_path.write_bytes(value)
        file_path.chmod(0o600)

    def test_offhost_attestation_is_bound_to_source_and_backup_key(self):
        """离机设备认证必须验证源认证 HMAC，再用备份密钥签名。"""
        source = {
            'version': 1,
            'kind': MIGRATION.SOURCE_KIND,
            'planSha256': self.plan_sha,
            'sourceHostHash': 'e' * 64,
            'createdAt': '2026-10-30T00:00:00.000Z',
        }
        source['signature'] = hmac.new(
            self.key,
            MIGRATION.json_bytes(MIGRATION.source_payload(source)),
            hashlib.sha256,
        ).hexdigest()
        self.write_private(
            'private/http-evidence-v2-source-' + self.plan_sha + '.json',
            MIGRATION.json_bytes(source),
        )
        args = SimpleNamespace(
            plan='plan.json',
            expected_plan_sha256=self.plan_sha,
            container_uid=1000,
        )
        storage_host_hash = MIGRATION.host_hash()
        with mock.patch.object(MIGRATION, 'docker_node', return_value={
                    'outcome': 'HTTP_EVIDENCE_V1_BACKUP_VERIFIED',
                    'contentManifestSha256': 'c' * 64,
                }):
            result = MIGRATION.run_offhost_attestation(args, self.root)
        self.assertEqual(result['outcome'], 'HTTP_EVIDENCE_OFFHOST_ATTESTED')
        attestation = json.loads(
            (self.root / 'private/http-evidence-offhost-attestation.json').read_text()
        )
        expected = hmac.new(
            self.key,
            MIGRATION.json_bytes(MIGRATION.offhost_payload(attestation)),
            hashlib.sha256,
        ).hexdigest()
        self.assertTrue(hmac.compare_digest(expected, attestation['signature']))
        self.assertEqual(attestation['sourceHostHash'], 'e' * 64)
        self.assertEqual(attestation['storageHostHash'], storage_host_hash)
        self.assertEqual(attestation['contentManifestSha256'], 'c' * 64)

    def test_host_hash_uses_stable_host_identity_without_exposing_source(self):
        """真机身份只返回固定长度摘要。"""
        first = MIGRATION.host_hash()
        second = MIGRATION.host_hash()
        self.assertRegex(first, r'^[a-f0-9]{64}$')
        self.assertEqual(first, second)

    def test_quiescence_rejects_related_process_even_when_service_is_inactive(self):
        """STOP 和 inactive 不能掩盖尚未排空的相关进程。"""
        self.write_private('private/STOP', b'stopped')

        def fake_command(arguments, _timeout):
            if arguments[0] == 'systemctl':
                return SimpleNamespace(stdout=b'inactive\n', returncode=3)
            if arguments[0] == 'docker':
                return SimpleNamespace(stdout=b'', returncode=0)
            return SimpleNamespace(
                stdout=b'999 python3 scripts/officialOrder/runHttpSample.py\n', returncode=0)

        with mock.patch.object(MIGRATION, 'command', side_effect=fake_command):
            with self.assertRaisesRegex(RuntimeError, 'HTTP_EVIDENCE_MIGRATION_ACTIVE'):
                MIGRATION.verify_quiescence(
                    self.root, 'apple-official-order-queue.service'
                )

    def test_inventory_writes_full_selection_only_to_restricted_external_directory(self):
        """inventory stdout 摘要与 root 外 0600 审核文件分离。"""
        with tempfile.TemporaryDirectory() as output_name:
            output = Path(output_name)
            output.chmod(0o700)
            args = SimpleNamespace(
                output_dir=str(output),
                inventory_output='inventory.json',
                selection_output='selection.json',
                container_uid=os.geteuid(),
            )
            inventory = {
                'version': 1,
                'kind': 'OFFICIAL_HTTP_EVIDENCE_V2_INVENTORY',
                'selection': {
                    'version': 1,
                    'kind': 'OFFICIAL_HTTP_EVIDENCE_V2_SELECTION',
                    'runs': [{'runId': 12, 'auditFile': 'http-sample-1-' + 'a' * 32 + '.json'}],
                },
                'skipped': [{'runId': 13, 'reasonCode': 'EVIDENCE_MISSING_OR_INVALID'}],
                'summary': {
                    'audits': 2,
                    'eligible': 1,
                    'skipped': 1,
                    'reasonCounts': {'EVIDENCE_MISSING_OR_INVALID': 1},
                },
            }
            with mock.patch.object(MIGRATION, 'docker_node', return_value=inventory):
                summary = MIGRATION.run_inventory(args, self.root)
            self.assertEqual(summary['eligible'], 1)
            self.assertEqual((output / 'inventory.json').stat().st_mode & 0o777, 0o600)
            self.assertEqual((output / 'selection.json').stat().st_mode & 0o777, 0o600)
            self.assertNotIn('runs', summary)

    def test_docker_node_binds_reviewed_independent_tool_release(self):
        """摘要漂移的独立Node维护release必须在docker调用前拒绝。"""
        (self.root / 'deps').mkdir()
        completed = SimpleNamespace(
            returncode=0,
            stdout=b'{"outcome":"SYNTHETIC_OK"}\n',
            stderr=b'',
        )
        with mock.patch.object(MIGRATION, 'command', return_value=completed):
            self.assertEqual(
                MIGRATION.docker_node(self.root, ['--inventory'], writable=False),
                {'outcome': 'SYNTHETIC_OK'},
            )
        with mock.patch.dict(MIGRATION.TOOL_FILES, {MIGRATION.SCRIPT: '0' * 64}), \
                mock.patch.object(MIGRATION, 'command') as command:
            with self.assertRaisesRegex(
                    RuntimeError, '^HTTP_EVIDENCE_MIGRATION_RELEASE_INVALID$'):
                MIGRATION.docker_node(self.root, ['--inventory'], writable=False)
        command.assert_not_called()

    def test_compatibility_baseline_binds_current_api_reader_stop_and_queue(self):
        """stage/finalize写前基线必须在锁内逐项匹配compat-r2。"""
        currentTarget = self.root / 'compat-r2'
        queueTarget = self.root / 'queue-r2'
        currentTarget.mkdir()
        reader = queueTarget / 'src/services/officialHttpEvidence.js'
        reader.parent.mkdir(parents=True)
        reader.write_bytes(
            (MODULE_PATH.parents[2] / 'src/services/officialHttpEvidence.js').read_bytes())
        (self.root / 'release').symlink_to(queueTarget)
        self.write_private('private/STOP', b'stopped')
        current = self.root / 'current'
        current.symlink_to(currentTarget)
        api = {
            'image': MIGRATION.EXPECTED_API_TAG,
            'imageId': MIGRATION.EXPECTED_API_IMAGE_ID,
            'status': 'running',
            'health': 'healthy',
        }
        completed = SimpleNamespace(
            returncode=0,
            stdout=('|'.join((
                api['image'], api['imageId'], api['status'], api['health'],
            )) + '\n').encode('ascii'),
            stderr=b'',
        )
        with mock.patch.object(MIGRATION, 'PRODUCTION_ROOT', self.root), \
                mock.patch.object(MIGRATION, 'PRODUCTION_CURRENT', current), \
                mock.patch.object(MIGRATION, 'EXPECTED_CURRENT', currentTarget.resolve()), \
                mock.patch.object(MIGRATION, 'EXPECTED_QUEUE_RELEASE', queueTarget.resolve()), \
                mock.patch.object(MIGRATION, 'verify_quiescence') as quiescence, \
                mock.patch.object(MIGRATION, 'command', return_value=completed):
            MIGRATION.verify_compatibility_baseline(
                self.root, 'apple-official-order-queue.service')
            quiescence.assert_called_once()
            current.unlink()
            current.symlink_to(self.root / 'wrong-release')
            with self.assertRaisesRegex(
                    RuntimeError, '^HTTP_EVIDENCE_MIGRATION_BASELINE_INVALID$'):
                MIGRATION.verify_compatibility_baseline(
                    self.root, 'apple-official-order-queue.service')


if __name__ == '__main__':
    unittest.main()
