#!/usr/bin/env python3
"""在宿主验证队列静止并持 maintenance latch，再运行无网络 Node 迁移容器。"""
import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import hmac
import json
import os
import platform
from pathlib import Path
import re
import secrets
import stat
import subprocess
import sys
import time
import uuid


IMAGE = ('mcr.microsoft.com/playwright@sha256:'
         'eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27')
SCRIPT = 'scripts/officialPickupBackfill/migrateHttpEvidenceV2.js'
SCRIPT_SHA256 = '0a8f961bdf521a55b10599e73d515e591122c18ab7f8c11de1963fdb98710005'
TOOL_RELEASE = Path(__file__).resolve().parents[2]
TOOL_FILES = {
    SCRIPT: SCRIPT_SHA256,
    'src/services/officialOrderSupport.js':
        '47a6c71d1ac7934071087f171045c2d54d5f17e6cf6e880688ec970917d88608',
    'src/services/officialHttpEvidence.js':
        '63d4ba31a0fb7b789ead368b4720d50874fdb7ec6b4c4b0724ef3985f8f33233',
}
LOCK = 'private/http-evidence-v2-maintenance.lock'
PROOF_KIND = 'OFFICIAL_HTTP_EVIDENCE_V2_QUIESCENCE'
SOURCE_KIND = 'OFFICIAL_HTTP_EVIDENCE_V2_SOURCE_ATTESTATION'
OFFHOST_KIND = 'OFFICIAL_HTTP_EVIDENCE_OFFHOST_ATTESTATION'
SHA256 = re.compile(r'^[a-f0-9]{64}$')
SERVICE = re.compile(r'^[A-Za-z0-9@_.-]+\.service$')
NAME = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$')
ACTIVE_PROCESS = re.compile(
    r'(?:runOfficialOrderHttpQueue|runHttpSample|collectOfficialRefreshHttp|'
    r'collectOfficialOrderHttp)\.(?:py|js)')
ACTIVE_CONTAINER = re.compile(r'^apple-official-(?:http-sample|refresh)-')
PRODUCTION_RELEASE_LOCK = Path('/var/lock/apple-order-mgr-production-release.lock')
PRODUCTION_CURRENT = Path('/var/www/apple-order-mgr/current')
EXPECTED_CURRENT = Path(
    '/var/www/apple-order-mgr/releases/20261030-http-evidence-v2-compat-r2')
PRODUCTION_ROOT = Path(
    '/var/www/apple-order-mgr/shared/official-http-refresh')
EXPECTED_QUEUE_RELEASE = PRODUCTION_ROOT / 'release-evidence-v2-20261030'
EXPECTED_API_TAG = 'apple-order-mgr-api:20261030-http-evidence-v2-compat-r2-amd64'
EXPECTED_API_IMAGE_ID = (
    'sha256:9f7c7a2321818f4ecfb24e6ea3e47ce182025083234e21f971217d7c8de951a6')
EXPECTED_READER_SHA256 = TOOL_FILES['src/services/officialHttpEvidence.js']


def fail(code):
    """仅抛出固定错误码。"""
    raise RuntimeError(code)


def sha_bytes(value):
    """返回字节 SHA-256。"""
    return hashlib.sha256(value).hexdigest()


def private_bytes(file_path, maximum=16 * 1024 * 1024):
    """拒绝符号链接、宽权限、非普通文件和超限私密输入。"""
    descriptor = os.open(str(file_path), os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, 'rb') as handle:
        info = os.fstat(handle.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or
                info.st_size > maximum):
            fail('HTTP_EVIDENCE_MIGRATION_FILE_INVALID')
        return handle.read()


def validate_tool_release():
    """验证独立维护release目录及三项最小Node工具链摘要。"""
    try:
        release_info = TOOL_RELEASE.lstat()
    except OSError:
        fail('HTTP_EVIDENCE_MIGRATION_RELEASE_INVALID')
    expected_uid = os.geteuid() if platform.system() == 'Darwin' else 0
    if (not stat.S_ISDIR(release_info.st_mode) or TOOL_RELEASE.is_symlink() or
            release_info.st_uid != expected_uid or release_info.st_mode & 0o022):
        fail('HTTP_EVIDENCE_MIGRATION_RELEASE_INVALID')
    for relative, expected in TOOL_FILES.items():
        path = TOOL_RELEASE / relative
        try:
            info = path.lstat()
            value = path.read_bytes()
        except OSError:
            fail('HTTP_EVIDENCE_MIGRATION_RELEASE_INVALID')
        if (not stat.S_ISREG(info.st_mode) or path.is_symlink() or
                info.st_uid != expected_uid or info.st_mode & 0o022 or
                sha_bytes(value) != expected):
            fail('HTTP_EVIDENCE_MIGRATION_RELEASE_INVALID')
    return TOOL_RELEASE


@contextmanager
def production_release_lock():
    """持有与统一发布执行器相同的非阻塞全局排他锁。"""
    descriptor = None
    stream = None
    try:
        descriptor = os.open(
            str(PRODUCTION_RELEASE_LOCK),
            os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW,
            0o600)
        info = os.fstat(descriptor)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or
                stat.S_IMODE(info.st_mode) != 0o600):
            fail('HTTP_EVIDENCE_MIGRATION_RELEASE_LOCK_INVALID')
        stream = os.fdopen(descriptor, 'w')
        descriptor = None
        fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        stream.write(json.dumps({
            'releaseId': '20261030-http-evidence-v2-history-r1',
            'pid': os.getpid(),
            'acquiredAt': iso_time(time.time()),
        }, sort_keys=True))
        stream.flush()
        os.fsync(stream.fileno())
        yield
    except BlockingIOError:
        fail('HTTP_EVIDENCE_MIGRATION_RELEASE_LOCKED')
    except OSError:
        fail('HTTP_EVIDENCE_MIGRATION_RELEASE_LOCK_INVALID')
    finally:
        if stream is not None:
            try:
                fcntl.flock(stream, fcntl.LOCK_UN)
            finally:
                stream.close()
        elif descriptor is not None:
            os.close(descriptor)


def verify_compatibility_baseline(root, service):
    """锁内重验compat reader、API身份、queue静止与STOP。"""
    if root != PRODUCTION_ROOT or service != 'apple-official-order-queue.service':
        fail('HTTP_EVIDENCE_MIGRATION_BASELINE_INVALID')
    try:
        current = PRODUCTION_CURRENT.resolve(strict=True)
        queue_release = (root / 'release').resolve(strict=True)
        stop_info = (root / 'private/STOP').lstat()
        reader = queue_release / 'src/services/officialHttpEvidence.js'
        reader_info = reader.lstat()
        reader_sha = sha_bytes(reader.read_bytes())
    except OSError:
        fail('HTTP_EVIDENCE_MIGRATION_BASELINE_INVALID')
    if (current != EXPECTED_CURRENT or queue_release != EXPECTED_QUEUE_RELEASE or
            not stat.S_ISREG(stop_info.st_mode) or
            stat.S_IMODE(stop_info.st_mode) & 0o077 or
            not stat.S_ISREG(reader_info.st_mode) or reader.is_symlink() or
            reader_sha != EXPECTED_READER_SHA256):
        fail('HTTP_EVIDENCE_MIGRATION_BASELINE_INVALID')
    verify_quiescence(root, service)
    template = (
        '{{.Config.Image}}|{{.Image}}|{{.State.Status}}|'
        '{{if .State.Health}}{{.State.Health.Status}}{{end}}')
    result = command([
        'docker', 'inspect', '--format', template,
        'apple-order-mgr-prod-api-1'], 30)
    if result.returncode or result.stderr:
        fail('HTTP_EVIDENCE_MIGRATION_BASELINE_INVALID')
    try:
        values = result.stdout.decode('ascii').strip().split('|')
    except UnicodeDecodeError:
        fail('HTTP_EVIDENCE_MIGRATION_BASELINE_INVALID')
    if len(values) != 4:
        fail('HTTP_EVIDENCE_MIGRATION_BASELINE_INVALID')
    api = dict(zip(('image', 'imageId', 'status', 'health'), values))
    if (api != {
            'image': EXPECTED_API_TAG,
            'imageId': EXPECTED_API_IMAGE_ID,
            'status': 'running',
            'health': 'healthy'}):
        fail('HTTP_EVIDENCE_MIGRATION_BASELINE_INVALID')


def write_private(file_path, value, uid):
    """以 0600 原子写入并 fsync 文件与父目录。"""
    file_path = Path(file_path)
    file_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = file_path.with_name('.' + file_path.name + '-' + uuid.uuid4().hex)
    try:
        descriptor = os.open(str(temporary), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, 'wb') as handle:
            handle.write(value)
            handle.flush()
            os.fsync(handle.fileno())
        if os.geteuid() == 0:
            os.chown(str(temporary), uid, uid)
        os.replace(str(temporary), str(file_path))
        directory = os.open(str(file_path.parent), os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if temporary.exists():
            temporary.unlink()


def json_bytes(value):
    """生成与 Node JSON.stringify 一致的 ASCII 紧凑 JSON。"""
    return json.dumps(value, ensure_ascii=True, separators=(',', ':')).encode('ascii')


def command(args, timeout):
    """运行宿主只读检查或隔离容器，不透传 stderr 明文。"""
    try:
        return subprocess.run(
            args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout,
            universal_newlines=False)
    except (OSError, subprocess.TimeoutExpired):
        fail('HTTP_EVIDENCE_MIGRATION_RUNTIME_FAILED')


def host_hash():
    """返回宿主稳定身份哈希，不落盘或输出 machine-id／Mac UUID 原值。"""
    if platform.system() == 'Darwin':
        try:
            result = command(['ioreg', '-rd1', '-c', 'IOPlatformExpertDevice'], 15)
        except RuntimeError:
            fail('HTTP_EVIDENCE_MIGRATION_QUIESCENCE_UNAVAILABLE')
        if result.returncode:
            fail('HTTP_EVIDENCE_MIGRATION_QUIESCENCE_UNAVAILABLE')
        matched = re.search(rb'"IOPlatformUUID"\s*=\s*"([A-Fa-f0-9-]{36})"', result.stdout)
        if not matched:
            fail('HTTP_EVIDENCE_MIGRATION_QUIESCENCE_UNAVAILABLE')
        return sha_bytes(matched.group(1).lower())
    machine_id = Path('/etc/machine-id')
    info = machine_id.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_size > 4096:
        fail('HTTP_EVIDENCE_MIGRATION_QUIESCENCE_UNAVAILABLE')
    return sha_bytes(machine_id.read_bytes())


def validate_root(value):
    """解析绝对迁移根且拒绝符号链接入口。"""
    root = Path(value)
    if not root.is_absolute() or root.is_symlink():
        fail('HTTP_EVIDENCE_MIGRATION_INPUT_INVALID')
    resolved = root.resolve(strict=True)
    if not (resolved / 'private').is_dir() or not (resolved / 'evidence').is_dir():
        fail('HTTP_EVIDENCE_MIGRATION_INPUT_INVALID')
    return resolved


def plan_sha(root, name, expected):
    """核对计划文件与操作者重新输入的摘要。"""
    if not NAME.fullmatch(name or '') or not SHA256.fullmatch(expected or ''):
        fail('HTTP_EVIDENCE_MIGRATION_INPUT_INVALID')
    actual = sha_bytes(private_bytes(root / 'private' / name, 32 * 1024 * 1024))
    if not hmac.compare_digest(actual, expected):
        fail('HTTP_EVIDENCE_MIGRATION_PLAN_MISMATCH')
    return actual


def verify_quiescence(root, service):
    """宿主核对 STOP、systemd inactive、相关容器和相关进程均为空。"""
    stop = root / 'private/STOP'
    if not stop.exists() or stop.is_symlink() or not stop.is_file():
        fail('HTTP_EVIDENCE_MIGRATION_NOT_STOPPED')
    if (root / 'private/http-cleanup-blocked.json').exists():
        fail('HTTP_EVIDENCE_MIGRATION_ACTIVE')
    status = command(['systemctl', 'is-active', service], 15)
    if status.stdout.strip() != b'inactive':
        fail('HTTP_EVIDENCE_MIGRATION_ACTIVE')
    containers = command(['docker', 'ps', '--format', '{{.Names}}'], 30)
    if containers.returncode or any(
            ACTIVE_CONTAINER.search(line.decode('utf-8', 'replace').strip())
            for line in containers.stdout.splitlines()):
        fail('HTTP_EVIDENCE_MIGRATION_ACTIVE')
    processes = command(['ps', '-eo', 'pid=,args='], 15)
    if processes.returncode:
        fail('HTTP_EVIDENCE_MIGRATION_QUIESCENCE_UNAVAILABLE')
    for line in processes.stdout.decode('utf-8', 'replace').splitlines():
        match = re.match(r'\s*(\d+)\s+(.*)', line)
        if match and int(match.group(1)) != os.getpid() and ACTIVE_PROCESS.search(match.group(2)):
            fail('HTTP_EVIDENCE_MIGRATION_ACTIVE')


def proof_payload(value):
    """字段顺序必须与 Node quiescencePayload 完全一致。"""
    return {
        'version': value['version'],
        'kind': value['kind'],
        'planSha256': value['planSha256'],
        'rootPathHash': value['rootPathHash'],
        'sourceHostHash': value['sourceHostHash'],
        'toolSha256': value['toolSha256'],
        'nonce': value['nonce'],
        'issuedAt': value['issuedAt'],
        'expiresAt': value['expiresAt'],
        'service': value['service'],
        'serviceInactive': value['serviceInactive'],
        'activeContainers': value['activeContainers'],
        'activeProcesses': value['activeProcesses'],
        'stopPresent': value['stopPresent'],
    }


def source_payload(value):
    """生成源宿主认证的稳定字段。"""
    return {
        'version': value['version'],
        'kind': value['kind'],
        'planSha256': value['planSha256'],
        'sourceHostHash': value['sourceHostHash'],
        'createdAt': value['createdAt'],
    }


def offhost_payload(value):
    """字段顺序必须与 Node offhostAttestationPayload 完全一致。"""
    return {
        'version': value['version'],
        'kind': value['kind'],
        'planSha256': value['planSha256'],
        'sourceHostHash': value['sourceHostHash'],
        'storageHostHash': value['storageHostHash'],
        'contentManifestSha256': value['contentManifestSha256'],
        'verifiedAt': value['verifiedAt'],
    }


def iso_time(epoch):
    """生成毫秒精度 UTC ISO 时间。"""
    whole = int(epoch)
    milliseconds = int((epoch - whole) * 1000)
    return time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime(whole)) + '.%03dZ' % milliseconds


def docker_node(root, arguments, writable, offline_root=None, timeout=3600, container_uid=1000):
    """运行无网络、无 Docker socket、最小权限的固定 Node 容器。"""
    nonce = secrets.token_hex(16)
    name = 'official-evidence-v2-' + nonce
    release = validate_tool_release()
    deps = root / 'deps'
    if not deps.is_dir():
        fail('HTTP_EVIDENCE_MIGRATION_RELEASE_INVALID')
    root_mount = str(root) + ':/research:' + ('rw' if writable else 'ro')
    cmd = [
        'docker', 'run', '--rm', '--name', name, '--network', 'none',
        '--user', str(container_uid) + ':' + str(container_uid),
        '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
        '--memory', '512m', '--cpus', '1', '--pids-limit', '64',
        '--tmpfs', '/tmp:rw,nosuid,size=16777216', '-e', 'NODE_PATH=/research/node_modules',
        '-e', 'OFFICIAL_EVIDENCE_COORDINATOR_CAPTURE=1',
        '-v', root_mount, '-v', str(release) + ':/maintenance-release:ro',
        '-v', str(deps) + ':/research/node_modules:ro',
    ]
    if offline_root is not None:
        cmd.extend(['-v', str(offline_root) + ':/offline:ro'])
    cmd.extend(
        ['--entrypoint', 'node', IMAGE, '/maintenance-release/' + SCRIPT] + arguments)
    try:
        result = command(cmd, timeout)
    finally:
        command(['docker', 'rm', '-f', name], 30)
    if result.returncode:
        try:
            value = json.loads(result.stderr.decode('utf-8').splitlines()[-1])
            fail(value.get('outcome', 'HTTP_EVIDENCE_MIGRATION_RUNTIME_FAILED'))
        except (ValueError, IndexError, AttributeError):
            fail('HTTP_EVIDENCE_MIGRATION_RUNTIME_FAILED')
    try:
        return json.loads(result.stdout.decode('utf-8').splitlines()[-1])
    except (ValueError, IndexError):
        fail('HTTP_EVIDENCE_MIGRATION_RUNTIME_FAILED')


def run_plan(args, root):
    """默认只读检查；仅显式 --write-plan 才保存计划。"""
    if not NAME.fullmatch(args.selection or ''):
        fail('HTTP_EVIDENCE_MIGRATION_INPUT_INVALID')
    result = docker_node(
        root, ['--root', '/research', '--selection', args.selection], writable=False,
        timeout=900, container_uid=args.container_uid)
    plan = result.get('plan')
    if not isinstance(plan, dict):
        fail('HTTP_EVIDENCE_MIGRATION_RUNTIME_FAILED')
    encoded = json_bytes(plan)
    digest = sha_bytes(encoded)
    if args.write_plan:
        if not NAME.fullmatch(args.write_plan):
            fail('HTTP_EVIDENCE_MIGRATION_INPUT_INVALID')
        write_private(root / 'private' / args.write_plan, encoded, args.container_uid)
    return {
        'outcome': 'HTTP_EVIDENCE_V2_PLAN_VALIDATED',
        'planSha256': digest,
        'runs': len(plan.get('runs', [])),
        'written': bool(args.write_plan),
        'planFile': args.write_plan if args.write_plan else None,
    }


def restricted_output_directory(value, root):
    """审核输出必须位于生产 root 外部既有 0700 目录。"""
    directory = Path(value)
    if not directory.is_absolute() or directory.is_symlink():
        fail('HTTP_EVIDENCE_MIGRATION_INPUT_INVALID')
    directory = directory.resolve(strict=True)
    info = directory.stat()
    if (not stat.S_ISDIR(info.st_mode) or info.st_mode & 0o077 or
            directory == root or root in directory.parents):
        fail('HTTP_EVIDENCE_MIGRATION_OUTPUT_INVALID')
    return directory


def run_inventory(args, root):
    """只读生成候选 inventory，并把完整内容写到 root 外受限目录。"""
    if not NAME.fullmatch(args.inventory_output or '') or not NAME.fullmatch(
            args.selection_output or '') or args.inventory_output == args.selection_output:
        fail('HTTP_EVIDENCE_MIGRATION_INPUT_INVALID')
    output = restricted_output_directory(args.output_dir, root)
    result = docker_node(
        root, ['--root', '/research', '--inventory'], writable=False, timeout=3600,
        container_uid=args.container_uid)
    if (result.get('kind') != 'OFFICIAL_HTTP_EVIDENCE_V2_INVENTORY' or
            not isinstance(result.get('selection'), dict) or
            not isinstance(result.get('summary'), dict)):
        fail('HTTP_EVIDENCE_MIGRATION_RUNTIME_FAILED')
    inventory_bytes = json_bytes(result)
    selection_bytes = json_bytes(result['selection'])
    write_private(output / args.inventory_output, inventory_bytes, os.geteuid())
    write_private(output / args.selection_output, selection_bytes, os.geteuid())
    summary = result['summary']
    return {
        'outcome': 'HTTP_EVIDENCE_V2_INVENTORY_WRITTEN',
        'audits': summary.get('audits'),
        'eligible': summary.get('eligible'),
        'skipped': summary.get('skipped'),
        'reasonCounts': summary.get('reasonCounts'),
        'inventoryFile': str(output / args.inventory_output),
        'inventorySha256': sha_bytes(inventory_bytes),
        'selectionFile': str(output / args.selection_output),
        'selectionSha256': sha_bytes(selection_bytes),
    }


def run_apply(args, root):
    """持锁生成短效 HMAC proof，并在锁存续期间执行 stage/finalize。"""
    digest = plan_sha(root, args.plan, args.expected_plan_sha256)
    if not SERVICE.fullmatch(args.service or ''):
        fail('HTTP_EVIDENCE_MIGRATION_INPUT_INVALID')
    lock = root / LOCK
    try:
        lock.mkdir(mode=0o700)
        if os.geteuid() == 0:
            os.chown(str(lock), args.container_uid, args.container_uid)
    except OSError:
        fail('HTTP_EVIDENCE_MIGRATION_LOCKED')
    nonce = secrets.token_hex(32)
    proof_file = 'http-evidence-v2-quiescence-' + nonce + '.json'
    proof_path = root / 'private' / proof_file
    owner_path = lock / 'owner.json'
    result = None
    try:
        verify_quiescence(root, args.service)
        source_host_hash = host_hash()
        tool_bytes = (validate_tool_release() / SCRIPT).read_bytes()
        common = {
            'nonce': nonce,
            'planSha256': digest,
            'rootPathHash': sha_bytes(str(root).encode('utf-8')),
            'sourceHostHash': source_host_hash,
            'toolSha256': sha_bytes(tool_bytes),
        }
        write_private(owner_path, json_bytes(dict(common, pid=os.getpid(), startedAt=iso_time(time.time()))),
                      args.container_uid)
        issued = time.time()
        proof = dict(common, version=1, kind=PROOF_KIND, issuedAt=iso_time(issued),
                     expiresAt=iso_time(issued + 300), service=args.service,
                     serviceInactive=True, activeContainers=0, activeProcesses=0,
                     stopPresent=True)
        key = private_bytes(root / 'private/evidence.key', 32)
        if len(key) != 32:
            fail('HTTP_EVIDENCE_MIGRATION_KEY_INVALID')
        proof['signature'] = hmac.new(key, json_bytes(proof_payload(proof)), hashlib.sha256).hexdigest()
        write_private(proof_path, json_bytes(proof), args.container_uid)
        node_args = [
            '--root', '/research', '--plan', args.plan,
            '--expected-plan-sha256', digest, '--apply',
            '--quiescence-proof', proof_file, '--maintenance-nonce', nonce,
        ]
        offline = None
        if args.mode == 'finalize':
            offline = validate_root(args.verification_mirror)
            node_args.extend(['--finalize', '--offline-root', '/offline'])
        result = docker_node(
            root, node_args, writable=True, offline_root=offline,
            container_uid=args.container_uid)
        if args.mode == 'stage':
            source = {
                'version': 1,
                'kind': SOURCE_KIND,
                'planSha256': digest,
                'sourceHostHash': source_host_hash,
                'createdAt': iso_time(time.time()),
            }
            source['signature'] = hmac.new(
                key, json_bytes(source_payload(source)), hashlib.sha256).hexdigest()
            write_private(
                root / 'private' / ('http-evidence-v2-source-' + digest + '.json'),
                json_bytes(source), args.container_uid)
    finally:
        cleanup_failed = False
        for candidate in (proof_path, owner_path):
            try:
                candidate.unlink()
            except FileNotFoundError:
                pass
            except OSError:
                cleanup_failed = True
        try:
            lock.rmdir()
        except OSError:
            # 未知残留保持 latch，队列失败关闭；人工核对后再处理。
            cleanup_failed = True
        if cleanup_failed and sys.exc_info()[0] is None:
            fail('HTTP_EVIDENCE_MIGRATION_LOCK_RELEASE_FAILED')
    return result


def run_offhost_attestation(args, root):
    """在真正的离机设备上验证源认证并签发短效 offhost 认证。"""
    digest = plan_sha(root, args.plan, args.expected_plan_sha256)
    key = private_bytes(root / 'private/evidence.key', 32)
    if len(key) != 32:
        fail('HTTP_EVIDENCE_MIGRATION_KEY_INVALID')
    source_file = root / 'private' / ('http-evidence-v2-source-' + digest + '.json')
    try:
        source = json.loads(private_bytes(source_file).decode('utf-8'))
    except (ValueError, UnicodeDecodeError):
        fail('HTTP_EVIDENCE_MIGRATION_OFFHOST_UNVERIFIED')
    expected = hmac.new(
        key, json_bytes(source_payload(source)), hashlib.sha256).hexdigest()
    if (source.get('version') != 1 or source.get('kind') != SOURCE_KIND or
            source.get('planSha256') != digest or
            not SHA256.fullmatch(source.get('sourceHostHash', '')) or
            not hmac.compare_digest(expected, source.get('signature', ''))):
        fail('HTTP_EVIDENCE_MIGRATION_OFFHOST_UNVERIFIED')
    storage_hash = host_hash()
    if storage_hash == source['sourceHostHash']:
        fail('HTTP_EVIDENCE_MIGRATION_OFFHOST_UNVERIFIED')
    verification = docker_node(
        root,
        [
            '--root', '/research', '--verify-offhost-backup', '--plan', args.plan,
            '--expected-plan-sha256', digest,
        ],
        writable=False,
        timeout=3600,
        container_uid=args.container_uid,
    )
    content_manifest = verification.get('contentManifestSha256')
    if (verification.get('outcome') != 'HTTP_EVIDENCE_V1_BACKUP_VERIFIED' or
            not SHA256.fullmatch(content_manifest or '')):
        fail('HTTP_EVIDENCE_MIGRATION_OFFHOST_UNVERIFIED')
    attestation = {
        'version': 1,
        'kind': OFFHOST_KIND,
        'planSha256': digest,
        'sourceHostHash': source['sourceHostHash'],
        'storageHostHash': storage_hash,
        'contentManifestSha256': content_manifest,
        'verifiedAt': iso_time(time.time()),
    }
    attestation['signature'] = hmac.new(
        key, json_bytes(offhost_payload(attestation)), hashlib.sha256).hexdigest()
    write_private(
        root / 'private/http-evidence-offhost-attestation.json',
        json_bytes(attestation), args.container_uid)
    return {
        'outcome': 'HTTP_EVIDENCE_OFFHOST_ATTESTED',
        'planSha256': digest,
        'attestationFile': 'private/http-evidence-offhost-attestation.json',
    }


def parse_args():
    """解析显式操作模式和摘要确认。"""
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True)
    parser.add_argument(
        '--mode', choices=('inventory', 'plan', 'stage', 'attest-offhost', 'finalize'),
        default='plan')
    parser.add_argument('--selection')
    parser.add_argument('--output-dir')
    parser.add_argument('--inventory-output')
    parser.add_argument('--selection-output')
    parser.add_argument('--write-plan')
    parser.add_argument('--plan')
    parser.add_argument('--expected-plan-sha256')
    parser.add_argument('--verification-mirror')
    parser.add_argument('--service', default='apple-official-order-queue.service')
    parser.add_argument(
        '--container-uid', type=int,
        default=os.geteuid() if platform.system() == 'Darwin' else 1000)
    return parser.parse_args()


def main():
    """只输出固定摘要字段，不输出正文、URL、请求或敏感元信息。"""
    args = parse_args()
    root = validate_root(args.root)
    if (
            args.container_uid < 1 or
            (platform.system() == 'Linux' and args.container_uid != 1000) or
            (platform.system() == 'Darwin' and args.container_uid != os.geteuid())):
        fail('HTTP_EVIDENCE_MIGRATION_INPUT_INVALID')
    if args.mode == 'inventory':
        return run_inventory(args, root)
    if args.mode == 'plan':
        return run_plan(args, root)
    if not args.plan or not args.expected_plan_sha256:
        fail('HTTP_EVIDENCE_MIGRATION_INPUT_INVALID')
    if args.mode == 'attest-offhost':
        return run_offhost_attestation(args, root)
    if args.mode == 'finalize' and not args.verification_mirror:
        fail('HTTP_EVIDENCE_MIGRATION_INPUT_INVALID')
    with production_release_lock():
        verify_compatibility_baseline(root, args.service)
        return run_apply(args, root)


if __name__ == '__main__':
    try:
        print(json.dumps(main(), ensure_ascii=True, separators=(',', ':')))
    except RuntimeError as error:
        code = str(error)
        if not re.fullmatch(r'[A-Z0-9_]{1,100}', code):
            code = 'HTTP_EVIDENCE_MIGRATION_FAILED'
        print(json.dumps({'outcome': code}, separators=(',', ':')), file=sys.stderr)
        sys.exit(1)
