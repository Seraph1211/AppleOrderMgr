#!/usr/bin/env python3
"""官网证据临时元数据租约维护入口的离线安全测试。"""
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock


MODULE_PATH = (
    Path(__file__).parents[1] /
    'scripts/officialPickupBackfill/runHttpEvidenceV2WithMetadataLease.py')
SPEC = importlib.util.spec_from_file_location(
    'http_evidence_v2_metadata_lease', str(MODULE_PATH))
LEASE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(LEASE)


DIRECTORY_ACL = 'user::rwx\ngroup::---\nother::---\n'
FILE_ACL_600 = 'user::rw-\ngroup::---\nother::---\n'
FILE_ACL_644 = 'user::rw-\ngroup::r--\nother::r--\n'


class MetadataLeaseHostTest(unittest.TestCase):
    """覆盖精确15项、租约mode、恢复、漂移和异常finally。"""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name) / 'root'
        self.target = self.root / 'private/batches'
        for relative in sorted(LEASE.EXPECTED_RELATIVES):
            path = self.target if relative == '.' else self.target / relative
            if relative == '.' or relative == '20261009-pickup0921-0925':
                path.mkdir(parents=True, exist_ok=True)
                path.chmod(0o700)
            else:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(('content:' + relative).encode('utf-8'))
                path.chmod(
                    0o644 if path.name in (
                        'concurrent-change-observed.json',
                        'progress-history.jsonl') else 0o600)
        self.acls = {}
        for relative in LEASE.EXPECTED_RELATIVES:
            path = self.target if relative == '.' else self.target / relative
            if path.is_dir():
                acl = DIRECTORY_ACL
            elif path.stat().st_mode & 0o777 == 0o644:
                acl = FILE_ACL_644
            else:
                acl = FILE_ACL_600
            self.acls[str(path)] = acl

    def tearDown(self):
        self.temporary.cleanup()

    def getAcl(self, path):
        """返回合成原ACL。"""
        return self.acls[str(path)]

    def makePlan(self):
        """将本机合成树标准化为生产已确认的root身份。"""
        with mock.patch.object(LEASE, 'get_acl', side_effect=self.getAcl):
            entries = LEASE.scan_target(self.target)
        for entry in entries:
            entry['uid'] = 0
            entry['gid'] = 0
            entry['mode'] = (
                0o700 if entry['kind'] == 'directory' else
                (0o644 if entry['relative'] in LEASE.LEGACY_0644 else 0o600))
        with mock.patch.object(LEASE, 'scan_target', return_value=entries):
            return LEASE.plan_for(self.root, self.target)

    def test_plan_is_exact_15_items_and_binds_inode_owner_mode_acl_content(self):
        """计划必须精确绑定已知目录及14项，含两个legacy 0644文件。"""
        plan = self.makePlan()
        self.assertEqual(len(plan['entries']), 15)
        self.assertEqual(
            {entry['relative'] for entry in plan['entries']},
            LEASE.EXPECTED_RELATIVES)
        legacy = {
            entry['relative']: entry for entry in plan['entries']
            if entry['relative'].endswith('concurrent-change-observed.json') or
            entry['relative'].endswith('progress-history.jsonl')}
        self.assertEqual({entry['mode'] for entry in legacy.values()}, {0o644})
        self.assertTrue(all(entry['device'] > 0 and entry['inode'] > 0
                            for entry in plan['entries']))
        self.assertTrue(all(entry['links'] == 1 for entry in plan['entries']
                            if entry['kind'] == 'file'))

    def test_lease_uses_uid1000_original_gid_and_strict_read_only_modes(self):
        """目录仅0500、文件仅0400，任何group/world位都不得保留。"""
        state = Path(self.temporary.name) / 'state.json'
        plan = self.makePlan()
        calls = []

        def recordIdentity(path, uid, gid, mode, entry):
            calls.append((str(path), uid, gid, mode, entry['relative']))

        with mock.patch.object(LEASE, 'scan_target', return_value=plan['entries']), \
                mock.patch.object(LEASE, 'set_identity', side_effect=recordIdentity), \
                mock.patch.object(LEASE, 'lease_matches', return_value=True):
            LEASE.lease_plan(
                plan, self.root, self.target, state,
                LEASE.sha_bytes(LEASE.canonical_bytes(plan)),
                'metadata-lease-plan-' + 'a' * 32 + '.json')
        self.assertEqual(len(calls), 15)
        for _path, uid, _gid, mode, _relative in calls:
            self.assertEqual(uid, 1000)
            self.assertIn(mode, (0o500, 0o400))
            self.assertEqual(mode & 0o077, 0)
        self.assertEqual(
            json.loads(state.read_text(encoding='ascii'))['status'], 'LEASED')

    def test_restore_replays_original_identity_acl_and_verifies_full_snapshot(self):
        """恢复必须逐项使用原uid/gid/mode/ACL并通过全快照复核。"""
        state = Path(self.temporary.name) / 'state.json'
        plan = self.makePlan()
        identities = []
        acls = []
        with mock.patch.object(
                LEASE, 'set_identity', side_effect=lambda path, uid, gid, mode, entry:
                identities.append((path, uid, gid, mode, entry['relative']))), \
                mock.patch.object(
                    LEASE, 'set_acl', side_effect=lambda *v: acls.append(v)), \
                mock.patch.object(LEASE, 'scan_target', return_value=plan['entries']):
            LEASE.restore_plan(
                plan, self.root, self.target, state,
                LEASE.sha_bytes(LEASE.canonical_bytes(plan)),
                'metadata-lease-plan-' + 'b' * 32 + '.json')
        self.assertEqual(len(identities), 15)
        self.assertEqual(len(acls), 15)
        expected = {
            (str(LEASE.path_for_entry(self.target, entry)),
             entry['uid'], entry['gid'], entry['mode'], entry['relative'])
            for entry in plan['entries']}
        self.assertEqual(
            {(str(value[0]),) + tuple(value[1:]) for value in identities},
            expected)
        self.assertEqual(
            json.loads(state.read_text(encoding='ascii'))['status'], 'RESTORED')

    def test_source_drift_fails_before_any_metadata_write(self):
        """正文或集合漂移必须在首个chown/chmod前失败。"""
        state = Path(self.temporary.name) / 'state.json'
        plan = self.makePlan()
        drifted = [dict(entry) for entry in plan['entries']]
        next(entry for entry in drifted
             if entry['relative'].endswith('progress.json'))['sha256'] = 'f' * 64
        with mock.patch.object(LEASE, 'scan_target', return_value=drifted), \
                mock.patch.object(LEASE, 'set_identity') as setter:
            with self.assertRaisesRegex(
                    RuntimeError, 'HTTP_EVIDENCE_LEASE_SOURCE_DRIFT'):
                LEASE.lease_plan(
                    plan, self.root, self.target, state,
                    LEASE.sha_bytes(LEASE.canonical_bytes(plan)),
                    'metadata-lease-plan-' + 'c' * 32 + '.json')
        setter.assert_not_called()

    def test_fd_identity_check_rejects_regular_file_swap_before_chown(self):
        """路径在扫描后换成新inode时不得先修改替代文件元数据。"""
        plan = self.makePlan()
        entry = next(
            value for value in plan['entries']
            if value['relative'].endswith('/progress.json'))
        path = LEASE.path_for_entry(self.target, entry)
        replacement = path.with_name('replacement.tmp')
        replacement.write_bytes(path.read_bytes())
        replacement.replace(path)
        with mock.patch.object(LEASE.os, 'fchown') as chown, \
                mock.patch.object(LEASE.os, 'fchmod') as chmod:
            with self.assertRaisesRegex(
                    RuntimeError, '^HTTP_EVIDENCE_LEASE_SOURCE_DRIFT$'):
                LEASE.set_identity(path, 1000, entry['gid'], 0o400, entry)
        chown.assert_not_called()
        chmod.assert_not_called()

    def test_coordinator_failure_still_restores_in_finally(self):
        """冻结协调器失败时finally仍须恢复后再返回原错误。"""
        stateDirectory = Path(self.temporary.name) / 'audit'
        stateDirectory.mkdir()
        arguments = [
            '--root', str(self.root), '--mode', 'inventory',
            '--service', LEASE.SERVICE,
        ]
        coordinator = SimpleNamespace(
            validate_root=lambda value: Path(value),
            verify_quiescence=lambda _root, _service: None,
            main=mock.Mock(side_effect=RuntimeError('COORDINATOR_FAILED')),
        )
        plan = {'entries': []}
        with mock.patch.object(LEASE.os, 'geteuid', return_value=0), \
                mock.patch.object(LEASE, 'load_coordinator', return_value=coordinator), \
                mock.patch.object(
                    LEASE, 'validate_state_directory', return_value=stateDirectory), \
                mock.patch.object(LEASE, 'metadata_lock'), \
                mock.patch.object(LEASE, 'target_path', return_value=self.target), \
                mock.patch.object(LEASE, 'load_plan', return_value=plan), \
                mock.patch.object(LEASE, 'lease_plan') as lease, \
                mock.patch.object(LEASE, 'restore_plan') as restore:
            with self.assertRaisesRegex(RuntimeError, 'COORDINATOR_FAILED'):
                LEASE.run_wrapped(
                    stateDirectory,
                    'metadata-lease-plan-' + 'd' * 32 + '.json',
                    'e' * 64, arguments)
        lease.assert_called_once()
        restore.assert_called_once()

    def test_symlink_root_and_missing_plan_fail_before_lease(self):
        """root符号链接及缺失计划不得触发任何元数据写入或泄露路径。"""
        linked = Path(self.temporary.name) / 'linked-root'
        linked.symlink_to(self.root)
        stateDirectory = Path(self.temporary.name) / 'audit'
        stateDirectory.mkdir()
        arguments = [
            '--root', str(linked), '--mode', 'inventory',
            '--service', LEASE.SERVICE,
        ]
        with mock.patch.object(LEASE.os, 'geteuid', return_value=0), \
                mock.patch.object(LEASE, 'lease_plan') as lease:
            with self.assertRaisesRegex(
                    RuntimeError, 'HTTP_EVIDENCE_MIGRATION_INPUT_INVALID'):
                LEASE.run_wrapped(
                    stateDirectory,
                    'metadata-lease-plan-' + 'f' * 32 + '.json',
                    'e' * 64, arguments)
        lease.assert_not_called()
        with self.assertRaisesRegex(
                RuntimeError, '^HTTP_EVIDENCE_LEASE_PLAN_INVALID$'):
            LEASE.load_plan(
                stateDirectory,
                'metadata-lease-plan-' + 'f' * 32 + '.json',
                'e' * 64, self.root, self.target)

    def test_only_explicit_server_modes_are_accepted(self):
        """离机认证、缺省mode和重复mode均不得进入租约。"""
        for values in (
                [], ['--mode', 'attest-offhost'],
                ['--mode', 'inventory', '--mode', 'plan']):
            with self.subTest(values=values):
                with self.assertRaisesRegex(
                        RuntimeError, 'HTTP_EVIDENCE_LEASE_MODE_INVALID'):
                    LEASE.coordinator_mode(values)
        self.assertEqual(
            LEASE.coordinator_mode(['--mode', 'finalize']), 'finalize')

    def test_extra_symlink_and_hardlink_are_rejected_without_expansion(self):
        """固定15项不得因新权限错误、额外路径或链接自动扩展。"""
        extra = self.target / 'unexpected.json'
        extra.write_bytes(b'extra')
        with mock.patch.object(LEASE, 'get_acl', side_effect=self.getAcl):
            with self.assertRaisesRegex(
                    RuntimeError, 'HTTP_EVIDENCE_LEASE_TARGET_SET_INVALID'):
                LEASE.scan_target(self.target)
        extra.unlink()
        linked = self.target / '20261009-pickup0921-0925/progress.json'
        linked.unlink()
        linked.symlink_to('plan.json')
        with mock.patch.object(LEASE, 'get_acl', side_effect=self.getAcl):
            with self.assertRaisesRegex(
                    RuntimeError, 'HTTP_EVIDENCE_LEASE_TARGET_INVALID'):
                LEASE.scan_target(self.target)

    def test_plan_schema_and_original_root_identity_fail_closed(self):
        """畸形恢复字段及非已确认root身份在任何写前拒绝。"""
        plan = self.makePlan()
        malformed = json.loads(json.dumps(plan))
        malformed['entries'][0]['acl'] = '用户::rwx\n'
        with self.assertRaisesRegex(
                RuntimeError, '^HTTP_EVIDENCE_LEASE_PLAN_INVALID$'):
            LEASE.validate_plan(malformed, self.root, self.target)
        wrong = [dict(entry) for entry in plan['entries']]
        wrong[0]['uid'] = 1000
        with mock.patch.object(LEASE, 'scan_target', return_value=wrong):
            with self.assertRaisesRegex(
                    RuntimeError,
                    '^HTTP_EVIDENCE_LEASE_SOURCE_IDENTITY_INVALID$'):
                LEASE.plan_for(self.root, self.target)

    def test_unfinished_state_requires_explicit_recovery(self):
        """未恢复journal必须阻断新计划和新租约。"""
        state = Path(self.temporary.name) / 'active-metadata-lease.json'
        LEASE.write_state(
            state, 'a' * 64,
            'metadata-lease-plan-' + 'b' * 32 + '.json',
            'LEASE_STARTED', [])
        with self.assertRaisesRegex(
                RuntimeError, '^HTTP_EVIDENCE_LEASE_RECOVERY_REQUIRED$'):
            LEASE.ensure_no_active_lease(state)


if __name__ == '__main__':
    unittest.main()
