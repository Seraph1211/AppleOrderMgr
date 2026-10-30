#!/usr/bin/env python3
"""以可恢复的精确临时元数据租约运行冻结官网证据迁移协调器。"""
import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import stat
import subprocess
import sys
import time


BASE_COORDINATOR = Path(__file__).with_name('runHttpEvidenceV2Migration.py')
BASE_COORDINATOR_SHA256 = (
    'dabaaeaef293c2ebbe599845c4ff238c4eff08f4b814521324473e1a9e63783c')
TARGET_RELATIVE = Path('private/batches')
SERVICE = 'apple-official-order-queue.service'
ALLOWED_MODES = frozenset(('inventory', 'plan', 'stage', 'finalize'))
PLAN_KIND = 'OFFICIAL_HTTP_EVIDENCE_METADATA_LEASE_PLAN'
STATE_KIND = 'OFFICIAL_HTTP_EVIDENCE_METADATA_LEASE_STATE'
SHA256 = re.compile(r'^[a-f0-9]{64}$')
MAXIMUM_ACL_BYTES = 65536
MAXIMUM_PLAN_BYTES = 2 * 1024 * 1024
LEASE_UID = 1000
EXPECTED_RELATIVES = frozenset((
    '.',
    '20261009-pickup0921-0925',
    '20261009-pickup0921-0925/concurrent-change-observed.json',
    '20261009-pickup0921-0925/plan.json',
    '20261009-pickup0921-0925/progress-history.jsonl',
    '20261009-pickup0921-0925/progress.json',
    '20261009-pickup0921-0925/protected-change-first.json',
    '20261009-pickup0921-0925/retry-plan.json',
    '20261009-pickup0921-0925/retry-proof.json',
    '20261009-pickup0921-0925/retry-submission-output.log',
    '20261009-pickup0921-0925/retry-submission-started.json',
    '20261009-pickup0921-0925/retry-submission.json',
    '20261009-pickup0921-0925/submission-output.log',
    '20261009-pickup0921-0925/submission-started.json',
    '20261009-pickup0921-0925/submission.json',
))
LEGACY_0644 = frozenset((
    '20261009-pickup0921-0925/concurrent-change-observed.json',
    '20261009-pickup0921-0925/progress-history.jsonl',
))


def fail(code):
    """仅抛出固定错误码。"""
    raise RuntimeError(code)


def canonical_bytes(value):
    """生成稳定紧凑JSON。"""
    return json.dumps(
        value, ensure_ascii=True, sort_keys=True,
        separators=(',', ':')).encode('ascii')


def sha_bytes(value):
    """返回字节SHA-256。"""
    return hashlib.sha256(value).hexdigest()


def sha_file(path):
    """流式计算普通文件摘要。"""
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        while True:
            block = handle.read(1024 * 1024)
            if not block:
                break
            digest.update(block)
    return digest.hexdigest()


def write_private(path, value):
    """以0600原子写入审计状态。"""
    path = Path(path)
    temporary = path.with_name('.' + path.name + '-' + secrets.token_hex(8))
    descriptor = os.open(str(temporary), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, 'wb') as handle:
            handle.write(value)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(str(temporary), str(path))
        directory = os.open(str(path.parent), os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if temporary.exists():
            temporary.unlink()


@contextmanager
def metadata_lock(state_dir):
    """以外部root状态目录锁串行化计划、租约和恢复。"""
    if not hasattr(os, 'O_NOFOLLOW'):
        fail('HTTP_EVIDENCE_LEASE_TOOL_FAILED')
    path = Path(state_dir) / 'metadata-lease.lock'
    flags = (os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW |
             getattr(os, 'O_CLOEXEC', 0))
    descriptor = None
    try:
        descriptor = os.open(str(path), flags, 0o600)
        info = os.fstat(descriptor)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or
                stat.S_IMODE(info.st_mode) != 0o600):
            fail('HTTP_EVIDENCE_LEASE_LOCK_INVALID')
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except RuntimeError:
        if descriptor is not None:
            os.close(descriptor)
        raise
    except (OSError, IOError):
        if descriptor is not None:
            os.close(descriptor)
        fail('HTTP_EVIDENCE_LEASE_LOCKED')
    try:
        yield
    finally:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_UN)
        finally:
            os.close(descriptor)


def command(arguments, timeout=30, input_bytes=None):
    """运行ACL工具且不向普通输出透传路径或正文。"""
    try:
        return subprocess.run(
            arguments, input=input_bytes, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired):
        fail('HTTP_EVIDENCE_LEASE_TOOL_FAILED')


def load_coordinator():
    """仅加载摘要固定的冻结基础协调器。"""
    try:
        info = BASE_COORDINATOR.lstat()
        source = BASE_COORDINATOR.read_bytes()
    except OSError:
        fail('HTTP_EVIDENCE_LEASE_TOOLCHAIN_INVALID')
    if (not stat.S_ISREG(info.st_mode) or BASE_COORDINATOR.is_symlink() or
            sha_bytes(source) != BASE_COORDINATOR_SHA256):
        fail('HTTP_EVIDENCE_LEASE_TOOLCHAIN_INVALID')
    spec = importlib.util.spec_from_file_location(
        'official_http_evidence_lease_base', str(BASE_COORDINATOR))
    if spec is None or spec.loader is None:
        fail('HTTP_EVIDENCE_LEASE_TOOLCHAIN_INVALID')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def get_acl(path):
    """读取不含owner/path头的数字ACL。"""
    result = command([
        'getfacl', '--omit-header', '--numeric', '--absolute-names', '--',
        str(path)])
    if (result.returncode or result.stderr or not result.stdout or
            len(result.stdout) > MAXIMUM_ACL_BYTES):
        fail('HTTP_EVIDENCE_LEASE_ACL_READ_FAILED')
    try:
        value = result.stdout.decode('ascii')
    except UnicodeDecodeError:
        fail('HTTP_EVIDENCE_LEASE_ACL_READ_FAILED')
    if not value.endswith('\n'):
        fail('HTTP_EVIDENCE_LEASE_ACL_READ_FAILED')
    return value


def file_entry(target, path):
    """记录单个目标的身份、ACL与文件内容摘要。"""
    info = path.lstat()
    if path.is_symlink():
        fail('HTTP_EVIDENCE_LEASE_TARGET_INVALID')
    if stat.S_ISDIR(info.st_mode):
        kind = 'directory'
    elif stat.S_ISREG(info.st_mode):
        kind = 'file'
    else:
        fail('HTTP_EVIDENCE_LEASE_TARGET_INVALID')
    relative = '.' if path == target else path.relative_to(target).as_posix()
    return {
        'relative': relative,
        'kind': kind,
        'device': info.st_dev,
        'inode': info.st_ino,
        'links': info.st_nlink,
        'uid': info.st_uid,
        'gid': info.st_gid,
        'mode': stat.S_IMODE(info.st_mode),
        'size': info.st_size if kind == 'file' else None,
        'sha256': sha_file(path) if kind == 'file' else None,
        'acl': get_acl(path),
    }


def scan_target(target):
    """逐项扫描固定目录，不跟随符号链接。"""
    target = Path(target)
    info = target.lstat()
    if not stat.S_ISDIR(info.st_mode) or target.is_symlink():
        fail('HTTP_EVIDENCE_LEASE_TARGET_INVALID')
    paths = [target]
    for current, directories, files in os.walk(str(target), followlinks=False):
        directories.sort()
        files.sort()
        current_path = Path(current)
        paths.extend(current_path / name for name in directories)
        paths.extend(current_path / name for name in files)
        if len(paths) > len(EXPECTED_RELATIVES):
            fail('HTTP_EVIDENCE_LEASE_TARGET_SET_INVALID')
    entries = [file_entry(target, path) for path in paths]
    if ({entry['relative'] for entry in entries} != EXPECTED_RELATIVES or
            any(entry['kind'] == 'file' and entry['links'] != 1
                for entry in entries)):
        fail('HTTP_EVIDENCE_LEASE_TARGET_SET_INVALID')
    return entries


def validate_state_directory(value, root):
    """状态目录必须位于证据root外且为root独占0700。"""
    directory = Path(value)
    if not directory.is_absolute() or directory.is_symlink():
        fail('HTTP_EVIDENCE_LEASE_STATE_INVALID')
    directory = directory.resolve(strict=True)
    info = directory.stat()
    if (not stat.S_ISDIR(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o700 or
            info.st_uid != 0 or directory == root or root in directory.parents):
        fail('HTTP_EVIDENCE_LEASE_STATE_INVALID')
    return directory


def target_path(root):
    """解析固定batches目录且拒绝入口符号链接。"""
    target = root / TARGET_RELATIVE
    if target.is_symlink():
        fail('HTTP_EVIDENCE_LEASE_TARGET_INVALID')
    resolved = target.resolve(strict=True)
    if resolved != target:
        fail('HTTP_EVIDENCE_LEASE_TARGET_INVALID')
    return target


def plan_for(root, target):
    """生成绑定原ACL、owner、mode和内容摘要的计划。"""
    entries = scan_target(target)
    for entry in entries:
        expected_mode = (
            0o700 if entry['kind'] == 'directory' else
            (0o644 if entry['relative'] in LEGACY_0644 else 0o600))
        if (entry['uid'] != 0 or entry['gid'] != 0 or
                entry['mode'] != expected_mode):
            fail('HTTP_EVIDENCE_LEASE_SOURCE_IDENTITY_INVALID')
    return {
        'version': 1,
        'kind': PLAN_KIND,
        'root': str(root),
        'target': str(target),
        'createdAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'entries': entries,
    }


def path_for_entry(target, entry):
    """解析计划相对路径并阻止越界。"""
    relative = entry.get('relative')
    if relative == '.':
        return target
    if (not isinstance(relative, str) or not relative or
            Path(relative).is_absolute() or '..' in Path(relative).parts):
        fail('HTTP_EVIDENCE_LEASE_PLAN_INVALID')
    path = target / relative
    if path.parent != target and target not in path.parents:
        fail('HTTP_EVIDENCE_LEASE_PLAN_INVALID')
    return path


def expected_source_mode(entry):
    """返回生产已确认的单项原始mode。"""
    if entry['kind'] == 'directory':
        return 0o700
    return 0o644 if entry['relative'] in LEGACY_0644 else 0o600


def valid_plan_entry(entry):
    """严格验证恢复会使用的单项计划字段。"""
    required = {
        'relative', 'kind', 'device', 'inode', 'links', 'uid', 'gid',
        'mode', 'size', 'sha256', 'acl'}
    if not isinstance(entry, dict) or set(entry) != required:
        return False
    integers = ('device', 'inode', 'links', 'uid', 'gid', 'mode')
    if any(isinstance(entry.get(name), bool) or
           not isinstance(entry.get(name), int) for name in integers):
        return False
    if (not isinstance(entry.get('relative'), str) or
            entry.get('kind') not in ('file', 'directory')):
        return False
    try:
        acl_bytes = entry['acl'].encode('ascii')
    except (AttributeError, UnicodeEncodeError):
        return False
    if (entry['device'] < 0 or entry['inode'] < 1 or
            entry['links'] < 1 or entry['uid'] != 0 or entry['gid'] != 0 or
            entry['mode'] != expected_source_mode(entry) or
            not isinstance(entry['acl'], str) or not entry['acl'].endswith('\n') or
            len(acl_bytes) > MAXIMUM_ACL_BYTES):
        return False
    if entry['kind'] == 'directory':
        return entry['size'] is None and entry['sha256'] is None
    return (entry['links'] == 1 and
            isinstance(entry['size'], int) and not isinstance(entry['size'], bool) and
            entry['size'] >= 0 and isinstance(entry['sha256'], str) and
            SHA256.fullmatch(entry['sha256']) is not None)


def validate_plan(plan, root, target):
    """验证计划固定字段和无重复路径。"""
    if not isinstance(plan, dict):
        fail('HTTP_EVIDENCE_LEASE_PLAN_INVALID')
    entries = plan.get('entries')
    if (set(plan) != {'version', 'kind', 'root', 'target', 'createdAt', 'entries'} or
            plan.get('version') != 1 or plan.get('kind') != PLAN_KIND or
            plan.get('root') != str(root) or plan.get('target') != str(target) or
            not isinstance(plan.get('createdAt'), str) or
            not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z',
                             plan.get('createdAt')) or
            not isinstance(entries, list) or
            len(entries) != len(EXPECTED_RELATIVES) or
            any(not valid_plan_entry(entry) for entry in entries)):
        fail('HTTP_EVIDENCE_LEASE_PLAN_INVALID')
    paths = [str(path_for_entry(target, entry)) for entry in entries]
    relatives = {entry.get('relative') for entry in entries}
    if len(set(paths)) != len(paths) or relatives != EXPECTED_RELATIVES:
        fail('HTTP_EVIDENCE_LEASE_PLAN_INVALID')
    return entries


def set_acl(path, acl):
    """精确恢复单个对象原ACL，不执行递归操作。"""
    result = command(
        ['setfacl', '--set-file=-', '--', str(path)],
        input_bytes=acl.encode('ascii'))
    if result.returncode or result.stdout or result.stderr:
        fail('HTTP_EVIDENCE_LEASE_METADATA_FAILED')


def set_identity(path, uid, gid, mode, entry):
    """通过O_NOFOLLOW文件描述符核对原inode后设置owner和mode。"""
    if not hasattr(os, 'O_NOFOLLOW'):
        fail('HTTP_EVIDENCE_LEASE_TOOL_FAILED')
    flags = os.O_RDONLY | getattr(os, 'O_CLOEXEC', 0)
    flags |= os.O_NOFOLLOW
    descriptor = None
    try:
        descriptor = os.open(str(path), flags)
        info = os.fstat(descriptor)
        expected_directory = entry['kind'] == 'directory'
        if (info.st_dev != entry['device'] or info.st_ino != entry['inode'] or
                info.st_nlink != entry['links'] or
                expected_directory != stat.S_ISDIR(info.st_mode) or
                (not expected_directory and not stat.S_ISREG(info.st_mode)) or
                (not expected_directory and info.st_size != entry['size'])):
            fail('HTTP_EVIDENCE_LEASE_SOURCE_DRIFT')
        os.fchown(descriptor, uid, gid)
        os.fchmod(descriptor, mode)
    except OSError:
        fail('HTTP_EVIDENCE_LEASE_METADATA_FAILED')
    finally:
        if descriptor is not None:
            os.close(descriptor)


def write_state(path, plan_sha, plan_file, status, completed):
    """持久化中断可恢复状态。"""
    value = {
        'version': 1,
        'kind': STATE_KIND,
        'planSha256': plan_sha,
        'planFile': plan_file,
        'status': status,
        'completed': list(completed),
        'updatedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
    }
    write_private(path, canonical_bytes(value))


def lease_matches(path, entry):
    """核对租约身份、只读mode、inode和正文均未漂移。"""
    info = path.lstat()
    mode = 0o500 if entry['kind'] == 'directory' else 0o400
    return (
        not path.is_symlink() and info.st_dev == entry['device'] and
        info.st_ino == entry['inode'] and info.st_nlink == entry['links'] and
        info.st_uid == LEASE_UID and info.st_gid == entry['gid'] and
        stat.S_IMODE(info.st_mode) == mode and
        not (stat.S_IMODE(info.st_mode) & 0o077) and
        (entry['kind'] == 'directory' or
         (info.st_size == entry['size'] and sha_file(path) == entry['sha256'])))


def lease_plan(plan, root, target, state_path, plan_sha, plan_file):
    """仅在原状态完整未漂移时逐项租给UID1000只读访问。"""
    entries = validate_plan(plan, root, target)
    if scan_target(target) != entries:
        fail('HTTP_EVIDENCE_LEASE_SOURCE_DRIFT')
    completed = []
    write_state(state_path, plan_sha, plan_file, 'LEASE_STARTED', completed)
    for entry in entries:
        path = path_for_entry(target, entry)
        mode = 0o500 if entry['kind'] == 'directory' else 0o400
        set_identity(path, LEASE_UID, entry['gid'], mode, entry)
        if not lease_matches(path, entry):
            fail('HTTP_EVIDENCE_LEASE_VERIFY_FAILED')
        completed.append(entry['relative'])
        write_state(state_path, plan_sha, plan_file, 'LEASE_STARTED', completed)
    write_state(state_path, plan_sha, plan_file, 'LEASED', completed)


def restore_plan(plan, root, target, state_path, plan_sha, plan_file):
    """逐项恢复原owner、mode和ACL，并复核inode及内容摘要。"""
    entries = validate_plan(plan, root, target)
    write_state(state_path, plan_sha, plan_file, 'RESTORE_STARTED', [])
    restored = []
    failed = []
    for entry in reversed(entries):
        path = path_for_entry(target, entry)
        try:
            info = path.lstat()
            expected_directory = entry['kind'] == 'directory'
            if (path.is_symlink() or info.st_dev != entry['device'] or
                    info.st_ino != entry['inode'] or
                    expected_directory != stat.S_ISDIR(info.st_mode) or
                    (not expected_directory and not stat.S_ISREG(info.st_mode))):
                failed.append(entry['relative'])
                continue
            set_identity(path, entry['uid'], entry['gid'], entry['mode'], entry)
            set_acl(path, entry['acl'])
        except (OSError, RuntimeError):
            failed.append(entry['relative'])
            continue
        restored.append(entry['relative'])
        write_state(state_path, plan_sha, plan_file, 'RESTORE_STARTED', restored)
    try:
        exact = scan_target(target) == entries
    except (OSError, RuntimeError):
        exact = False
    if failed or not exact:
        write_state(state_path, plan_sha, plan_file, 'RESTORED_WITH_DRIFT', restored)
        fail('HTTP_EVIDENCE_LEASE_RESTORE_DRIFT')
    write_state(state_path, plan_sha, plan_file, 'RESTORED', restored)


def load_plan(state_dir, plan_file, expected_sha, root, target):
    """读取并核对0600普通计划文件和显式摘要。"""
    if (not re.fullmatch(r'metadata-lease-plan-[a-f0-9]{32}\.json', plan_file or '') or
            not SHA256.fullmatch(expected_sha or '')):
        fail('HTTP_EVIDENCE_LEASE_PLAN_INVALID')
    path = state_dir / plan_file
    try:
        info = path.lstat()
        raw = path.read_bytes()
    except OSError:
        fail('HTTP_EVIDENCE_LEASE_PLAN_INVALID')
    if (not stat.S_ISREG(info.st_mode) or path.is_symlink() or
            stat.S_IMODE(info.st_mode) != 0o600 or info.st_uid != 0):
        fail('HTTP_EVIDENCE_LEASE_PLAN_INVALID')
    if len(raw) > MAXIMUM_PLAN_BYTES:
        fail('HTTP_EVIDENCE_LEASE_PLAN_INVALID')
    if sha_bytes(raw) != expected_sha:
        fail('HTTP_EVIDENCE_LEASE_PLAN_INVALID')
    try:
        plan = json.loads(raw.decode('ascii'))
    except (UnicodeDecodeError, ValueError):
        fail('HTTP_EVIDENCE_LEASE_PLAN_INVALID')
    validate_plan(plan, root, target)
    return plan


def load_state(path):
    """读取root独占的固定状态文件，拒绝符号链接和畸形内容。"""
    path = Path(path)
    try:
        info = path.lstat()
        raw = path.read_bytes()
    except OSError:
        fail('HTTP_EVIDENCE_LEASE_RECOVERY_REQUIRED')
    if (path.is_symlink() or not stat.S_ISREG(info.st_mode) or
            info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o600 or
            len(raw) > 65536):
        fail('HTTP_EVIDENCE_LEASE_RECOVERY_REQUIRED')
    try:
        value = json.loads(raw.decode('ascii'))
    except (UnicodeDecodeError, ValueError):
        fail('HTTP_EVIDENCE_LEASE_RECOVERY_REQUIRED')
    allowed_status = frozenset((
        'LEASE_STARTED', 'LEASED', 'RESTORE_STARTED', 'RESTORED_WITH_DRIFT',
        'RESTORED'))
    completed = value.get('completed') if isinstance(value, dict) else None
    plan_sha = value.get('planSha256') if isinstance(value, dict) else None
    plan_file = value.get('planFile') if isinstance(value, dict) else None
    if (not isinstance(value, dict) or value.get('version') != 1 or
            value.get('kind') != STATE_KIND or
            value.get('status') not in allowed_status or
            not isinstance(plan_sha, str) or SHA256.fullmatch(plan_sha) is None or
            not isinstance(plan_file, str) or
            re.fullmatch(r'metadata-lease-plan-[a-f0-9]{32}\.json', plan_file) is None or
            not isinstance(completed, list) or
            any(not isinstance(relative, str) or relative not in EXPECTED_RELATIVES
                for relative in completed) or
            len(completed) != len(set(completed))):
        fail('HTTP_EVIDENCE_LEASE_RECOVERY_REQUIRED')
    return value


def ensure_no_active_lease(state_path):
    """在新计划或执行前拒绝未完成的历史租约。"""
    if not os.path.lexists(str(state_path)):
        return
    if load_state(state_path).get('status') != 'RESTORED':
        fail('HTTP_EVIDENCE_LEASE_RECOVERY_REQUIRED')


def coordinator_mode(arguments):
    """仅允许基础协调器的服务器迁移模式。"""
    positions = [index for index, value in enumerate(arguments) if value == '--mode']
    if len(positions) != 1 or positions[0] + 1 >= len(arguments):
        fail('HTTP_EVIDENCE_LEASE_MODE_INVALID')
    mode = arguments[positions[0] + 1]
    if mode not in ALLOWED_MODES:
        fail('HTTP_EVIDENCE_LEASE_MODE_INVALID')
    return mode


def argument_value(arguments, name):
    """读取唯一基础协调器参数。"""
    positions = [index for index, value in enumerate(arguments) if value == name]
    if len(positions) != 1 or positions[0] + 1 >= len(arguments):
        fail('HTTP_EVIDENCE_LEASE_MODE_INVALID')
    return arguments[positions[0] + 1]


def prepare(state_dir_value, root_value):
    """只读生成待人工审核的精确元数据租约计划。"""
    if os.geteuid() != 0:
        fail('HTTP_EVIDENCE_LEASE_ROOT_REQUIRED')
    root_argument = Path(root_value)
    if not root_argument.is_absolute() or root_argument.is_symlink():
        fail('HTTP_EVIDENCE_MIGRATION_INPUT_INVALID')
    coordinator = load_coordinator()
    root = coordinator.validate_root(str(root_argument))
    state_dir = validate_state_directory(state_dir_value, root)
    with metadata_lock(state_dir):
        target = target_path(root)
        coordinator.verify_quiescence(root, SERVICE)
        ensure_no_active_lease(state_dir / 'active-metadata-lease.json')
        plan = plan_for(root, target)
        raw = canonical_bytes(plan)
        plan_sha = sha_bytes(raw)
        plan_file = 'metadata-lease-plan-' + secrets.token_hex(16) + '.json'
        write_private(state_dir / plan_file, raw)
        return {
            'outcome': 'HTTP_EVIDENCE_METADATA_LEASE_PLANNED',
            'planFile': plan_file,
            'planSha256': plan_sha,
            'entries': len(plan['entries']),
            'files': len([entry for entry in plan['entries']
                         if entry['kind'] == 'file']),
            'directories': len([entry for entry in plan['entries']
                                if entry['kind'] == 'directory']),
        }


def run_wrapped(state_dir_value, plan_file, expected_plan_sha,
                coordinator_arguments):
    """按已审核计划租用、运行冻结协调器并在finally恢复元数据。"""
    if os.geteuid() != 0:
        fail('HTTP_EVIDENCE_LEASE_ROOT_REQUIRED')
    coordinator_mode(coordinator_arguments)
    root_argument = Path(argument_value(coordinator_arguments, '--root'))
    if not root_argument.is_absolute() or root_argument.is_symlink():
        fail('HTTP_EVIDENCE_MIGRATION_INPUT_INVALID')
    coordinator = load_coordinator()
    root = coordinator.validate_root(str(root_argument))
    state_dir = validate_state_directory(state_dir_value, root)
    with metadata_lock(state_dir):
        return run_wrapped_locked(
            coordinator, state_dir, root, plan_file, expected_plan_sha,
            coordinator_arguments)


def run_wrapped_locked(coordinator, state_dir, root, plan_file,
                       expected_plan_sha, coordinator_arguments):
    """在外部串行锁内执行租约、协调器及恢复。"""
    target = target_path(root)
    service = argument_value(coordinator_arguments, '--service')
    if service != SERVICE:
        fail('HTTP_EVIDENCE_LEASE_MODE_INVALID')
    coordinator.verify_quiescence(root, service)
    active = state_dir / 'active-metadata-lease.json'
    ensure_no_active_lease(active)
    plan = load_plan(
        state_dir, plan_file, expected_plan_sha, root, target)
    plan_sha = expected_plan_sha
    try:
        lease_plan(plan, root, target, active, plan_sha, plan_file)
    except BaseException as lease_error:
        try:
            state = load_state(active)
        except RuntimeError:
            state = {}
        if (state.get('planSha256') == plan_sha and
                state.get('status') in ('LEASE_STARTED', 'LEASED')):
            restore_plan(plan, root, target, active, plan_sha, plan_file)
        raise lease_error
    result = None
    original_arguments = sys.argv
    operation_error = None
    try:
        sys.argv = [str(BASE_COORDINATOR)] + list(coordinator_arguments)
        result = coordinator.main()
    except BaseException as error:
        operation_error = error
    finally:
        sys.argv = original_arguments
        try:
            restore_plan(plan, root, target, active, plan_sha, plan_file)
        except BaseException:
            raise
    if operation_error is not None:
        raise operation_error
    return {
        'outcome': result.get('outcome'),
        'leasePlanSha256': plan_sha,
        'leaseEntries': len(plan['entries']),
        'metadataRestored': True,
        'coordinator': result,
    }


def recover(state_dir_value, root_value, expected_plan_sha):
    """进程中断后按显式计划摘要恢复原owner、mode和ACL。"""
    if os.geteuid() != 0:
        fail('HTTP_EVIDENCE_LEASE_ROOT_REQUIRED')
    root_argument = Path(root_value)
    if not root_argument.is_absolute() or root_argument.is_symlink():
        fail('HTTP_EVIDENCE_MIGRATION_INPUT_INVALID')
    coordinator = load_coordinator()
    root = coordinator.validate_root(str(root_argument))
    state_dir = validate_state_directory(state_dir_value, root)
    with metadata_lock(state_dir):
        coordinator.verify_quiescence(root, SERVICE)
        return recover_locked(state_dir, root, expected_plan_sha)


def recover_locked(state_dir, root, expected_plan_sha):
    """在外部串行锁内恢复中断租约。"""
    target = target_path(root)
    state_path = state_dir / 'active-metadata-lease.json'
    state = load_state(state_path)
    if (state.get('kind') != STATE_KIND or
            state.get('status') not in (
                'LEASE_STARTED', 'LEASED', 'RESTORE_STARTED',
                'RESTORED_WITH_DRIFT') or
            state.get('planSha256') != expected_plan_sha):
        fail('HTTP_EVIDENCE_LEASE_RECOVERY_REQUIRED')
    plan = load_plan(
        state_dir, state.get('planFile'), expected_plan_sha, root, target)
    restore_plan(
        plan, root, target, state_path, expected_plan_sha,
        state.get('planFile'))
    return {
        'outcome': 'HTTP_EVIDENCE_METADATA_LEASE_RECOVERED',
        'leasePlanSha256': expected_plan_sha,
        'leaseEntries': len(plan['entries']),
        'metadataRestored': True,
    }


def parse_args():
    """解析包装执行或中断恢复模式。"""
    parser = argparse.ArgumentParser()
    parser.add_argument('--state-dir', required=True)
    parser.add_argument('--prepare', action='store_true')
    parser.add_argument('--recover', action='store_true')
    parser.add_argument('--root')
    parser.add_argument('--plan')
    parser.add_argument('--expected-plan-sha256')
    parser.add_argument('coordinator_arguments', nargs=argparse.REMAINDER)
    return parser.parse_args()


def main():
    """仅输出不含ACL、路径清单或证据正文的摘要。"""
    args = parse_args()
    coordinator_arguments = list(args.coordinator_arguments)
    if coordinator_arguments and coordinator_arguments[0] == '--':
        coordinator_arguments.pop(0)
    if args.recover:
        if (args.prepare or coordinator_arguments or not args.root or args.plan or
                not args.expected_plan_sha256):
            fail('HTTP_EVIDENCE_LEASE_MODE_INVALID')
        return recover(args.state_dir, args.root, args.expected_plan_sha256)
    if args.prepare:
        if (coordinator_arguments or not args.root or args.plan or
                args.expected_plan_sha256):
            fail('HTTP_EVIDENCE_LEASE_MODE_INVALID')
        return prepare(args.state_dir, args.root)
    if (args.root or not args.plan or not args.expected_plan_sha256 or
            not coordinator_arguments):
        fail('HTTP_EVIDENCE_LEASE_MODE_INVALID')
    return run_wrapped(
        args.state_dir, args.plan, args.expected_plan_sha256,
        coordinator_arguments)


if __name__ == '__main__':
    try:
        print(json.dumps(main(), ensure_ascii=True, separators=(',', ':')))
    except RuntimeError as error:
        code = str(error)
        if not re.fullmatch(r'[A-Z0-9_]{1,100}', code):
            code = 'HTTP_EVIDENCE_METADATA_LEASE_FAILED'
        print(json.dumps({'outcome': code}, separators=(',', ':')), file=sys.stderr)
        sys.exit(1)
