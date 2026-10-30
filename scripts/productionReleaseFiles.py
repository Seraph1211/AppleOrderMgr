#!/usr/bin/env python3
"""生产发布业务文件备份工具；兼容 Python 3.6，仅使用标准库。"""
import argparse
import datetime
import hashlib
import hmac
import json
import os
import shutil
import stat
import sys
import tempfile
from pathlib import Path, PurePosixPath


SCHEMA_VERSION = 1
CHUNK_SIZE = 1024 * 1024
DEFAULT_BACKUP_ROOT = '/var/backups/apple-order-mgr'


class FileBackupError(Exception):
    """文件备份固定错误码。"""

    def __init__(self, code):
        super().__init__(code)
        self.code = code


def require(condition, code):
    """条件不满足时失败关闭。"""
    if not condition:
        raise FileBackupError(code)


def utcNow():
    """返回带 Z 的 UTC 时间。"""
    return datetime.datetime.utcnow().replace(microsecond=0).isoformat() + 'Z'


def canonicalBytes(payload):
    """生成签名使用的稳定 JSON。"""
    return json.dumps(payload, ensure_ascii=False, sort_keys=True,
                      separators=(',', ':')).encode('utf-8')


def sha256File(path):
    """完整读取文件并返回 SHA-256 与字节数。"""
    digest = hashlib.sha256()
    size = 0
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(CHUNK_SIZE), b''):
            digest.update(chunk)
            size += len(chunk)
    return digest.hexdigest(), size


def readKey(path):
    """读取受保护的清单认证密钥。"""
    keyPath = Path(path)
    require(keyPath.is_file() and not keyPath.is_symlink(), 'KEY_FILE_INVALID')
    require(stat.S_IMODE(keyPath.stat().st_mode) & 0o077 == 0,
            'KEY_FILE_PERMISSIONS')
    key = keyPath.read_bytes()
    require(len(key) >= 32, 'KEY_FILE_TOO_SHORT')
    return key


def manifestPayload(document):
    """移除认证字段以得到被认证正文。"""
    payload = dict(document)
    payload.pop('authentication', None)
    return payload


def authenticate(document, key):
    """为完整清单生成 HMAC-SHA256。"""
    digest = hmac.new(key, canonicalBytes(manifestPayload(document)),
                      hashlib.sha256).hexdigest()
    document['authentication'] = {
        'algorithm': 'hmac-sha256',
        'digest': digest,
    }
    return document


def verifyManifest(document, key):
    """验证清单结构与 HMAC。"""
    require(document.get('schemaVersion') == SCHEMA_VERSION, 'MANIFEST_SCHEMA')
    authentication = document.get('authentication', {})
    require(authentication.get('algorithm') == 'hmac-sha256',
            'MANIFEST_AUTHENTICATION')
    expected = hmac.new(key, canonicalBytes(manifestPayload(document)),
                        hashlib.sha256).hexdigest()
    require(hmac.compare_digest(authentication.get('digest', ''), expected),
            'MANIFEST_AUTHENTICATION')
    return document


def loadManifest(path, key):
    """读取并验证一个清单。"""
    manifestPath = Path(path)
    require(manifestPath.is_file() and not manifestPath.is_symlink(),
            'MANIFEST_INVALID')
    try:
        document = json.loads(manifestPath.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        raise FileBackupError('MANIFEST_INVALID')
    return verifyManifest(document, key)


def normalizedRelative(value):
    """验证清单中的 POSIX 相对路径，拒绝穿越。"""
    require(isinstance(value, str) and value not in ('', '.'), 'PATH_INVALID')
    path = PurePosixPath(value)
    require(not path.is_absolute() and '..' not in path.parts
            and '\\' not in value and '\x00' not in value, 'PATH_INVALID')
    normalized = str(path)
    require(normalized == value and not normalized.startswith('/'), 'PATH_INVALID')
    return normalized


def normalizeRules(values):
    """标准化重复传入的相对路径规则。"""
    rules = []
    for value in values or []:
        value = value.strip('/')
        normalizedRelative(value)
        rules.append(value)
    return sorted(set(rules))


def matchesRule(relative, rules):
    """判断路径是否位于规则路径本身或其后代。"""
    return any(relative == rule or relative.startswith(rule + '/') for rule in rules)


def fingerprint(path):
    """记录可用于可信封存复用的文件系统身份。"""
    metadata = path.lstat()
    return {
        'device': metadata.st_dev,
        'inode': metadata.st_ino,
        'size': metadata.st_size,
        'mtimeNs': getattr(metadata, 'st_mtime_ns', int(metadata.st_mtime * 1000000000)),
        'ctimeNs': getattr(metadata, 'st_ctime_ns', int(metadata.st_ctime * 1000000000)),
        'mode': stat.S_IMODE(metadata.st_mode),
        'uid': metadata.st_uid,
        'gid': metadata.st_gid,
    }


def entryOwnership(path):
    """以 lstat 记录对象本身 owner，符号链接不跟随目标。"""
    metadata = path.lstat()
    return {'uid': metadata.st_uid, 'gid': metadata.st_gid}


def parentsNotWritable(path, source):
    """确认封存文件及其源内父目录对任何身份均不可写且不含链接。"""
    current = path
    while True:
        metadata = current.lstat()
        if stat.S_ISLNK(metadata.st_mode) or stat.S_IMODE(metadata.st_mode) & 0o222:
            return False
        if current == source:
            return True
        current = current.parent


def canReuseImmutable(path, source, previous):
    """仅在认证清单与只读文件系统身份都未变化时跳过重新散列。"""
    return bool(previous
                and previous.get('classification') == 'immutable'
                and previous.get('immutableAuthenticated') is True
                and previous.get('fingerprint') == fingerprint(path)
                and parentsNotWritable(path, source))


def objectPath(store, digest):
    """返回内容寻址对象路径。"""
    require(len(digest) == 64 and all(char in '0123456789abcdef' for char in digest),
            'OBJECT_DIGEST_INVALID')
    return store / 'objects' / 'sha256' / digest[:2] / digest


def secureDirectory(path):
    """要求目录本身及从既有根开始的每层都不是符号链接。"""
    path = Path(path).absolute()
    require(path.is_dir() and not path.is_symlink() and path == path.resolve(),
            'OBJECT_STORE_UNSAFE')
    return path


def secureObjectParent(store, digest, create=True):
    """创建并重核对象目录各层，防止链接把对象写到根外。"""
    store = secureDirectory(store)
    objects = store / 'objects'
    algorithm = objects / 'sha256'
    prefix = algorithm / digest[:2]
    for directory in (objects, algorithm, prefix):
        if create:
            directory.mkdir(exist_ok=True)
        require(directory.is_dir() and not directory.is_symlink(),
                'OBJECT_STORE_UNSAFE')
        try:
            directory.resolve().relative_to(store)
        except ValueError:
            raise FileBackupError('OBJECT_STORE_UNSAFE')
    return prefix


def storeObject(source, store, digest, expectedSize):
    """原子写入内容寻址对象；既有对象必须完整验证。"""
    target = secureObjectParent(store, digest) / digest
    if target.exists():
        require(target.is_file() and not target.is_symlink(), 'OBJECT_INVALID')
        actualDigest, actualSize = sha256File(target)
        require(actualDigest == digest and actualSize == expectedSize, 'OBJECT_CORRUPT')
        return False
    descriptor, temporaryName = tempfile.mkstemp(prefix='.object-', dir=str(target.parent))
    os.close(descriptor)
    temporary = Path(temporaryName)
    try:
        shutil.copyfile(str(source), str(temporary))
        actualDigest, actualSize = sha256File(temporary)
        require(actualDigest == digest and actualSize == expectedSize, 'SOURCE_CHANGED')
        temporary.chmod(0o400)
        os.replace(str(temporary), str(target))
    finally:
        if temporary.exists():
            temporary.unlink()
    return True


def relevantToIncludes(relative, includeRules):
    """只遍历明确include本身、其祖先或后代。"""
    if not includeRules:
        return True
    if not relative:
        return True
    return any(relative == rule or relative.startswith(rule + '/')
               or rule.startswith(relative + '/') for rule in includeRules)


def scanSource(source, store, previous, immutableRules, excludeRules, includeRules):
    """全量枚举源树；可变文件始终完整散列。"""
    entries = []
    counters = {
        'filesScanned': 0,
        'filesHashed': 0,
        'filesReused': 0,
        'bytesRead': 0,
        'bytesWritten': 0,
    }
    previousByPath = {item['path']: item for item in previous.get('entries', [])}
    for root, dirNames, fileNames in os.walk(str(source), topdown=True,
                                             followlinks=False):
        rootPath = Path(root)
        relativeRoot = '' if rootPath == source else rootPath.relative_to(source).as_posix()
        retainedDirs = []
        for name in sorted(dirNames):
            path = rootPath / name
            relative = name if not relativeRoot else relativeRoot + '/' + name
            if matchesRule(relative, excludeRules) or not relevantToIncludes(
                    relative, includeRules):
                continue
            mode = path.lstat().st_mode
            if stat.S_ISLNK(mode):
                require(not includeRules or matchesRule(relative, includeRules),
                        'SOURCE_ANCESTOR_SYMLINK')
                target = os.readlink(str(path))
                targetPath = linkTargetPath(source, relative, target)
                entries.append({'path': relative, 'type': 'symlink',
                                'target': target, 'targetPath': targetPath,
                                'mode': stat.S_IMODE(mode),
                                'uid': path.lstat().st_uid,
                                'gid': path.lstat().st_gid,
                                'fingerprint': fingerprint(path)})
                continue
            require(stat.S_ISDIR(mode), 'SOURCE_SPECIAL_FILE')
            retainedDirs.append(name)
            entries.append({
                'path': relative,
                'type': 'directory',
                'mode': stat.S_IMODE(mode),
                'uid': path.lstat().st_uid,
                'gid': path.lstat().st_gid,
                'fingerprint': fingerprint(path),
            })
        dirNames[:] = retainedDirs
        for name in sorted(fileNames):
            path = rootPath / name
            relative = name if not relativeRoot else relativeRoot + '/' + name
            if (matchesRule(relative, excludeRules)
                    or (includeRules and not matchesRule(relative, includeRules))):
                continue
            mode = path.lstat().st_mode
            if stat.S_ISLNK(mode):
                target = os.readlink(str(path))
                targetPath = linkTargetPath(source, relative, target)
                entries.append({
                    'path': relative,
                    'type': 'symlink',
                    'target': target,
                    'targetPath': targetPath,
                    'mode': stat.S_IMODE(mode),
                    'uid': path.lstat().st_uid,
                    'gid': path.lstat().st_gid,
                    'fingerprint': fingerprint(path),
                })
                continue
            require(stat.S_ISREG(mode), 'SOURCE_SPECIAL_FILE')
            counters['filesScanned'] += 1
            classification = 'immutable' if matchesRule(relative, immutableRules) else 'mutable'
            prior = previousByPath.get(relative)
            if classification == 'immutable' and canReuseImmutable(path, source, prior):
                digest = prior['sha256']
                size = prior['size']
                counters['filesReused'] += 1
            else:
                before = fingerprint(path)
                digest, size = sha256File(path)
                after = fingerprint(path)
                require(before == after, 'SOURCE_CHANGED')
                counters['filesHashed'] += 1
                counters['bytesRead'] += size
            created = storeObject(path, store, digest, size)
            if created:
                counters['bytesWritten'] += size
            entries.append({
                'path': relative,
                'type': 'file',
                'mode': stat.S_IMODE(mode),
                'uid': path.lstat().st_uid,
                'gid': path.lstat().st_gid,
                'size': size,
                'sha256': digest,
                'classification': classification,
                'immutableAuthenticated': classification == 'immutable'
                    and parentsNotWritable(path, source),
                'fingerprint': fingerprint(path),
            })
    manifestPaths = {item['path'] for item in entries}
    for item in entries:
        if item['type'] == 'symlink':
            require(item['targetPath'] in manifestPaths,
                    'SOURCE_LINK_TARGET_NOT_INCLUDED')
    entries.sort(key=lambda item: (item['path'].count('/'), item['path'], item['type']))
    return entries, counters


def statSource(source, includeRules, excludeRules):
    """第二次只读枚举源树元数据，用于发现扫描期间新增、删除或替换。"""
    inventory = {}
    for root, dirNames, fileNames in os.walk(str(source), topdown=True,
                                             followlinks=False):
        rootPath = Path(root)
        relativeRoot = '' if rootPath == source else rootPath.relative_to(source).as_posix()
        retainedDirs = []
        for name in sorted(dirNames):
            path = rootPath / name
            relative = name if not relativeRoot else relativeRoot + '/' + name
            if matchesRule(relative, excludeRules) or not relevantToIncludes(
                    relative, includeRules):
                continue
            mode = path.lstat().st_mode
            if stat.S_ISLNK(mode):
                require(not includeRules or matchesRule(relative, includeRules),
                        'SOURCE_ANCESTOR_SYMLINK')
                target = os.readlink(str(path))
                inventory[relative] = {
                    'type': 'symlink', 'mode': stat.S_IMODE(mode),
                    'uid': path.lstat().st_uid, 'gid': path.lstat().st_gid,
                    'target': target,
                    'targetPath': linkTargetPath(source, relative, target),
                    'fingerprint': fingerprint(path),
                }
                continue
            require(stat.S_ISDIR(mode), 'SOURCE_SPECIAL_FILE')
            retainedDirs.append(name)
            inventory[relative] = {
                'type': 'directory', 'mode': stat.S_IMODE(mode),
                'uid': path.lstat().st_uid, 'gid': path.lstat().st_gid,
                'fingerprint': fingerprint(path),
            }
        dirNames[:] = retainedDirs
        for name in sorted(fileNames):
            path = rootPath / name
            relative = name if not relativeRoot else relativeRoot + '/' + name
            if (matchesRule(relative, excludeRules)
                    or (includeRules and not matchesRule(relative, includeRules))):
                continue
            mode = path.lstat().st_mode
            if stat.S_ISLNK(mode):
                target = os.readlink(str(path))
                inventory[relative] = {
                    'type': 'symlink', 'mode': stat.S_IMODE(mode),
                    'uid': path.lstat().st_uid, 'gid': path.lstat().st_gid,
                    'target': target,
                    'targetPath': linkTargetPath(source, relative, target),
                    'fingerprint': fingerprint(path),
                }
                continue
            require(stat.S_ISREG(mode), 'SOURCE_SPECIAL_FILE')
            inventory[relative] = {
                'type': 'file', 'mode': stat.S_IMODE(mode),
                'uid': path.lstat().st_uid, 'gid': path.lstat().st_gid,
                'fingerprint': fingerprint(path),
            }
    return inventory


def writeJsonAtomic(path, payload, mode=0o600):
    """在同目录写临时文件后原子定稿。"""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporaryName = tempfile.mkstemp(prefix='.' + path.name + '-',
                                                  dir=str(path.parent))
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
            json.dump(payload, stream, ensure_ascii=False, sort_keys=True, indent=2)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporaryName, mode)
        os.replace(temporaryName, str(path))
    finally:
        if os.path.exists(temporaryName):
            os.unlink(temporaryName)


def createManifest(source, store, output, key, releaseId, basePath=None,
                   immutableRules=None, excludeRules=None, keyVersion=None,
                   consistencyProof=None, includeRules=None):
    """创建一份完整逻辑视图清单和本次变化集。"""
    source = Path(source).absolute()
    store = Path(store).absolute()
    require(source.is_dir() and not source.is_symlink() and source == source.resolve(),
            'SOURCE_INVALID')
    if store.exists():
        secureDirectory(store)
    else:
        store.mkdir(parents=True, mode=0o700)
        secureDirectory(store)
    require(not Path(output).exists(), 'MANIFEST_ALREADY_EXISTS')
    previous = {'entries': []}
    baseDigest = None
    if basePath:
        previous = loadManifest(basePath, key)
        baseDigest = previous['authentication']['digest']
    immutableRules = normalizeRules(immutableRules)
    excludeRules = normalizeRules(excludeRules)
    includeRules = normalizeRules(includeRules)
    if source == Path('/'):
        require(bool(includeRules), 'ROOT_SOURCE_REQUIRES_INCLUDES')
    require(source != store and store not in source.parents, 'STORE_OVERLAPS_SOURCE')
    if source in store.parents:
        storeRelative = store.relative_to(source).as_posix()
        require(not relevantToIncludes(storeRelative, includeRules),
                'STORE_OVERLAPS_SOURCE')
    require(not set(immutableRules) & set(excludeRules), 'RULES_CONFLICT')
    consistencyDigest = None
    consistentSnapshot = False
    if consistencyProof:
        proof = loadManifest(consistencyProof, key)
        writerChecks = proof.get('writerChecks', {})
        require(proof.get('kind') == 'apple-order-mgr-file-consistency'
                and proof.get('sourceRoot') == str(source)
                and proof.get('queuePaused') is True
                and proof.get('inFlight') == 0
                and proof.get('activeWriters') == 0
                and proof.get('externalRequestsTriggered') is False
                and writerChecks.get('queueDatabaseRunning') == 0
                and writerChecks.get('collectorProcessCount') == 0
                and writerChecks.get('queueServiceInactive') is True,
                'CONSISTENCY_PROOF_INVALID')
        observed = parseUtc(proof.get('observedAtUtc'))
        age = (datetime.datetime.utcnow() - observed).total_seconds()
        require(0 <= age <= 600, 'CONSISTENCY_PROOF_STALE')
        consistencyDigest = proof['authentication']['digest']
        consistentSnapshot = True
    entries, counters = scanSource(
        source, store, previous, immutableRules, excludeRules, includeRules)
    expectedInventory = {}
    for item in entries:
        expected = {
            'type': item['type'], 'mode': item['mode'],
            'uid': item['uid'], 'gid': item['gid'],
            'fingerprint': item['fingerprint'],
        }
        if item['type'] == 'symlink':
            expected['target'] = item['target']
            expected['targetPath'] = item['targetPath']
        expectedInventory[item['path']] = expected
    require(statSource(source, includeRules, excludeRules) == expectedInventory,
            'SOURCE_TREE_CHANGED')
    currentByPath = {item['path']: item for item in entries}
    previousByPath = {item['path']: item for item in previous.get('entries', [])}
    deleted = sorted(set(previousByPath) - set(currentByPath))
    changed = []
    for path, item in currentByPath.items():
        prior = previousByPath.get(path)
        comparable = ('type', 'mode', 'uid', 'gid', 'target', 'size', 'sha256',
                      'classification')
        if prior is None or any(item.get(field) != prior.get(field) for field in comparable):
            changed.append(path)
    document = {
        'schemaVersion': SCHEMA_VERSION,
        'kind': 'apple-order-mgr-business-files',
        'releaseId': releaseId,
        'createdAtUtc': utcNow(),
        'sourceRoot': str(source),
        'objectStore': str(store),
        'baseManifestDigest': baseDigest,
        'keyVersion': keyVersion,
        'immutableRules': immutableRules,
        'excludedPaths': excludeRules,
        'includedPaths': includeRules,
        'consistentSnapshot': consistentSnapshot,
        'sourceInventoryVerified': True,
        'consistencyProofDigest': consistencyDigest,
        'entries': entries,
        'changes': {'changed': sorted(changed), 'deleted': deleted},
        'metrics': counters,
    }
    authenticate(document, key)
    writeJsonAtomic(output, document)
    return document


def emptyDestination(destination):
    """恢复目标必须是新建空目录，避免覆盖其他数据。"""
    destination = Path(destination).absolute()
    if destination.exists():
        require(destination.is_dir() and not destination.is_symlink(),
                'DESTINATION_INVALID')
        require(not any(destination.iterdir()), 'DESTINATION_NOT_EMPTY')
    else:
        destination.mkdir(parents=True, mode=0o700)
    require(destination == destination.resolve(), 'DESTINATION_PARENT_SYMLINK')
    return destination


def safeDestination(destination, relative):
    """把验证过的相对路径限定到恢复目录。"""
    relative = normalizedRelative(relative)
    return destination.joinpath(*PurePosixPath(relative).parts)


def posixNormalize(path):
    """规范化相对 POSIX 路径并拒绝越界。"""
    parts = []
    for part in path.parts:
        if part in ('', '.'):
            continue
        if part == '..':
            require(bool(parts), 'LINK_OUTSIDE')
            parts.pop()
        else:
            parts.append(part)
    require(bool(parts), 'LINK_OUTSIDE')
    return '/'.join(parts)


def linkTargetPath(sourceRoot, linkPath, linkTarget):
    """把链接原始target映射为源清单内路径，不跟随文件系统链接。"""
    require(isinstance(linkTarget, str) and linkTarget and '\x00' not in linkTarget,
            'SOURCE_LINK_OUTSIDE')
    target = PurePosixPath(linkTarget)
    if target.is_absolute():
        try:
            relative = target.relative_to(PurePosixPath(str(sourceRoot)))
        except ValueError:
            raise FileBackupError('SOURCE_LINK_OUTSIDE')
        return posixNormalize(relative)
    return posixNormalize(PurePosixPath(linkPath).parent.joinpath(target))


def validateOwner(uid, gid):
    """拒绝布尔值、负数及超出常见 32 位 uid/gid 范围的 owner。"""
    require(isinstance(uid, int) and not isinstance(uid, bool)
            and isinstance(gid, int) and not isinstance(gid, bool)
            and 0 <= uid <= 2147483647 and 0 <= gid <= 2147483647,
            'MANIFEST_OWNER_INVALID')
    return uid, gid


def createOwnershipMap(manifestPath, output, key, mappings):
    """创建限定到单份manifest的受认证隔离恢复owner映射。"""
    manifest = loadManifest(manifestPath, key)
    require(not Path(output).exists(), 'EVIDENCE_ALREADY_EXISTS')
    require(isinstance(mappings, dict) and mappings, 'OWNERSHIP_MAP_INVALID')
    normalized = {}
    for source, target in mappings.items():
        require(isinstance(source, str) and ':' in source
                and isinstance(target, dict), 'OWNERSHIP_MAP_INVALID')
        parts = source.split(':')
        require(len(parts) == 2 and all(part.isdigit() for part in parts),
                'OWNERSHIP_MAP_INVALID')
        sourceUid, sourceGid = validateOwner(int(parts[0]), int(parts[1]))
        targetUid, targetGid = validateOwner(target.get('uid'), target.get('gid'))
        normalized['%d:%d' % (sourceUid, sourceGid)] = {
            'uid': targetUid, 'gid': targetGid,
        }
    owners = {'%d:%d' % validateOwner(item.get('uid'), item.get('gid'))
              for item in manifest.get('entries', [])}
    require(owners.issubset(set(normalized)), 'OWNERSHIP_MAP_INCOMPLETE')
    document = {
        'schemaVersion': SCHEMA_VERSION,
        'kind': 'apple-order-mgr-ownership-map',
        'createdAtUtc': utcNow(),
        'manifestDigest': manifest['authentication']['digest'],
        'mappings': normalized,
    }
    authenticate(document, key)
    writeJsonAtomic(output, document)
    return document


def loadOwnershipMap(path, manifest, key):
    """验证owner映射认证、manifest作用域与owner范围。"""
    document = loadManifest(path, key)
    require(document.get('kind') == 'apple-order-mgr-ownership-map'
            and document.get('manifestDigest')
            == manifest['authentication']['digest'], 'OWNERSHIP_MAP_SCOPE')
    mappings = document.get('mappings')
    require(isinstance(mappings, dict) and mappings, 'OWNERSHIP_MAP_INVALID')
    normalized = {}
    for source, target in mappings.items():
        require(isinstance(source, str) and ':' in source
                and isinstance(target, dict), 'OWNERSHIP_MAP_INVALID')
        parts = source.split(':')
        require(len(parts) == 2 and all(part.isdigit() for part in parts),
                'OWNERSHIP_MAP_INVALID')
        sourceUid, sourceGid = validateOwner(int(parts[0]), int(parts[1]))
        targetUid, targetGid = validateOwner(target.get('uid'), target.get('gid'))
        normalized['%d:%d' % (sourceUid, sourceGid)] = (targetUid, targetGid)
    return document, normalized


def applyAndVerifyOwnership(destination, entries, policy, mappings=None):
    """不跟随链接地应用owner，最后逐项lstat验证owner与mode。"""
    require(policy in ('preserve', 'authenticated-map'), 'OWNERSHIP_POLICY_INVALID')
    resolvedOwners = {}
    for item in entries:
        sourceUid, sourceGid = validateOwner(item.get('uid'), item.get('gid'))
        if policy == 'preserve':
            owner = (sourceUid, sourceGid)
        else:
            owner = mappings.get('%d:%d' % (sourceUid, sourceGid))
            require(owner is not None, 'OWNERSHIP_MAP_INCOMPLETE')
        resolvedOwners[item['path']] = owner
    ordered = sorted(entries, key=lambda item: (
        item['type'] == 'directory', -item['path'].count('/'), item['path']))
    for item in ordered:
        target = safeDestination(destination, item['path'])
        uid, gid = resolvedOwners[item['path']]
        try:
            if item['type'] == 'symlink':
                require(hasattr(os, 'lchown'), 'RESTORE_OWNERSHIP_UNSUPPORTED')
                os.lchown(str(target), uid, gid)
            else:
                os.chown(str(target), uid, gid)
                os.chmod(str(target), item['mode'])
        except OSError:
            raise FileBackupError('RESTORE_OWNERSHIP_FAILED')
    for item in entries:
        target = safeDestination(destination, item['path'])
        metadata = target.lstat()
        uid, gid = resolvedOwners[item['path']]
        require(metadata.st_uid == uid and metadata.st_gid == gid,
                'RESTORE_OWNERSHIP_VERIFY_FAILED')
        if item['type'] != 'symlink':
            require(stat.S_IMODE(metadata.st_mode) == item['mode'],
                    'RESTORE_MODE_VERIFY_FAILED')
    originalOwners = sorted('%s:%d:%d' % ((item['path'],) + validateOwner(
        item.get('uid'), item.get('gid')))
        for item in entries)
    restoredOwners = sorted('%s:%d:%d' % ((item['path'],)
                            + resolvedOwners[item['path']]) for item in entries)
    return {
        'policy': policy,
        'entriesVerified': len(entries),
        'originalOwnersDigest': hashlib.sha256(
            canonicalBytes(originalOwners)).hexdigest(),
        'restoredOwnersDigest': hashlib.sha256(
            canonicalBytes(restoredOwners)).hexdigest(),
    }


def restoreManifest(manifestPath, destination, key, storeOverride=None,
                    ownershipMapPath=None):
    """在无副作用空目录中恢复完整视图并逐文件重新散列。"""
    document = loadManifest(manifestPath, key)
    destination = emptyDestination(destination)
    store = secureDirectory(storeOverride or document['objectStore'])
    entries = document.get('entries')
    require(isinstance(entries, list), 'MANIFEST_ENTRIES')
    ownershipPolicy = 'authenticated-map' if ownershipMapPath else 'preserve'
    ownershipDocument = None
    ownershipMappings = None
    if ownershipMapPath:
        ownershipDocument, ownershipMappings = loadOwnershipMap(
            ownershipMapPath, document, key)
    seen = set()
    directories, files, links = [], [], []
    for item in entries:
        require(isinstance(item, dict), 'MANIFEST_ENTRIES')
        relative = normalizedRelative(item.get('path'))
        require(relative not in seen, 'MANIFEST_DUPLICATE_PATH')
        seen.add(relative)
        itemType = item.get('type')
        require(itemType in ('directory', 'file', 'symlink'), 'MANIFEST_ENTRY_TYPE')
        validateOwner(item.get('uid'), item.get('gid'))
        (directories if itemType == 'directory' else files if itemType == 'file'
         else links).append(item)
    for item in sorted(directories, key=lambda value: value['path'].count('/')):
        target = safeDestination(destination, item['path'])
        target.mkdir(mode=0o700, parents=True, exist_ok=False)
    bytesRestored = 0
    for item in files:
        target = safeDestination(destination, item['path'])
        require(target.parent == destination or target.parent.exists(), 'PARENT_MISSING')
        sourceObject = objectPath(store, item['sha256'])
        require(sourceObject.parent == secureObjectParent(
            store, item['sha256'], create=False),
                'OBJECT_STORE_UNSAFE')
        require(sourceObject.is_file() and not sourceObject.is_symlink(), 'OBJECT_MISSING')
        actualDigest, actualSize = sha256File(sourceObject)
        require(actualDigest == item['sha256'] and actualSize == item['size'],
                'OBJECT_CORRUPT')
        shutil.copyfile(str(sourceObject), str(target))
        target.chmod(item['mode'])
        restoredDigest, restoredSize = sha256File(target)
        require(restoredDigest == item['sha256'] and restoredSize == item['size'],
                'RESTORE_VERIFY_FAILED')
        bytesRestored += restoredSize
    absoluteLinksRemapped = 0
    sourceRoot = PurePosixPath(document.get('sourceRoot', ''))
    restoredLinks = []
    for item in links:
        target = safeDestination(destination, item['path'])
        linkTarget = item.get('target')
        require(isinstance(linkTarget, str), 'LINK_OUTSIDE')
        normalized = linkTargetPath(sourceRoot, item['path'], linkTarget)
        require(item.get('targetPath', normalized) == normalized,
                'LINK_TARGET_MISMATCH')
        require(normalized in seen, 'LINK_OUTSIDE')
        restoredTarget = linkTarget
        if os.path.isabs(linkTarget):
            restoredTarget = os.path.relpath(
                str(safeDestination(destination, normalized)), str(target.parent))
            absoluteLinksRemapped += 1
        target.symlink_to(restoredTarget)
        restoredLinks.append(target)
    for target in restoredLinks:
        try:
            resolved = target.resolve(strict=True)
            resolved.relative_to(destination)
        except ValueError:
            raise FileBackupError('LINK_OUTSIDE')
        except OSError:
            raise FileBackupError('LINK_TARGET_MISSING')
    ownership = applyAndVerifyOwnership(
        destination, entries, ownershipPolicy, ownershipMappings)
    ownership['mapDigest'] = (ownershipDocument['authentication']['digest']
                              if ownershipDocument else None)
    return {
        'passed': True,
        'schemaVersion': SCHEMA_VERSION,
        'kind': 'apple-order-mgr-files-restore',
        'releaseId': document['releaseId'],
        'manifestDigest': document['authentication']['digest'],
        'entries': len(entries),
        'files': len(files),
        'links': len(links),
        'bytesRestored': bytesRestored,
        'absoluteLinksRemapped': absoluteLinksRemapped,
        'linkVerification': True,
        'ownershipVerification': True,
        'ownership': ownership,
        'completeVerification': True,
        'consistentSnapshot': document.get('consistentSnapshot') is True,
        'sourceInventoryVerified': document.get('sourceInventoryVerified') is True,
    }


def parseUtc(value):
    """解析本工具生成的 UTC 时间。"""
    require(isinstance(value, str) and value.endswith('Z'), 'TIME_INVALID')
    try:
        return datetime.datetime.strptime(value, '%Y-%m-%dT%H:%M:%SZ')
    except ValueError:
        raise FileBackupError('TIME_INVALID')


def createConsistencyProof(source, stateEvidence, output, key):
    """认证暂停领取、在途排空且未触发外部请求的文件快照边界。"""
    require(not Path(output).exists(), 'EVIDENCE_ALREADY_EXISTS')
    try:
        state = json.loads(Path(stateEvidence).read_text(encoding='utf-8'))
    except (OSError, ValueError):
        raise FileBackupError('CONSISTENCY_STATE_INVALID')
    writerChecks = state.get('writerChecks', {})
    require(state.get('passed') is True and state.get('queuePaused') is True
            and state.get('inFlight') == 0 and state.get('activeWriters') == 0
            and state.get('externalRequestsTriggered') is False
            and writerChecks.get('queueDatabaseRunning') == 0
            and writerChecks.get('collectorProcessCount') == 0
            and writerChecks.get('queueServiceInactive') is True,
            'CONSISTENCY_STATE_INVALID')
    observed = parseUtc(state.get('observedAtUtc'))
    age = (datetime.datetime.utcnow() - observed).total_seconds()
    require(0 <= age <= 600, 'CONSISTENCY_PROOF_STALE')
    stateDigest, _size = sha256File(stateEvidence)
    document = {
        'schemaVersion': SCHEMA_VERSION,
        'kind': 'apple-order-mgr-file-consistency',
        'createdAtUtc': utcNow(),
        'observedAtUtc': state['observedAtUtc'],
        'sourceRoot': str(Path(source).absolute()),
        'queuePaused': True,
        'inFlight': 0,
        'activeWriters': 0,
        'writerChecks': {
            'queueDatabaseRunning': 0,
            'collectorProcessCount': 0,
            'queueServiceInactive': True,
        },
        'externalRequestsTriggered': False,
        'stateEvidenceDigest': stateDigest,
    }
    authenticate(document, key)
    writeJsonAtomic(output, document)
    return document


def directoryState(path):
    """完整散列目录内普通文件和目录元数据，拒绝链接及特殊文件。"""
    records = []
    for root, dirNames, fileNames in os.walk(str(path), topdown=True, followlinks=False):
        rootPath = Path(root)
        for name in sorted(dirNames):
            child = rootPath / name
            require(not child.is_symlink() and child.is_dir(), 'CLEANUP_UNSAFE_ENTRY')
            relative = child.relative_to(path).as_posix()
            records.append({'path': relative, 'type': 'directory',
                            'mode': stat.S_IMODE(child.stat().st_mode)})
        for name in sorted(fileNames):
            child = rootPath / name
            require(not child.is_symlink() and child.is_file(), 'CLEANUP_UNSAFE_ENTRY')
            relative = child.relative_to(path).as_posix()
            digest, size = sha256File(child)
            records.append({'path': relative, 'type': 'file', 'size': size,
                            'sha256': digest,
                            'mode': stat.S_IMODE(child.stat().st_mode)})
    records.sort(key=lambda item: item['path'])
    return records, hashlib.sha256(canonicalBytes(records)).hexdigest()


def loadBackupSet(path, key):
    """读取一个已认证且已完成恢复证明的备份集合。"""
    document = loadManifest(path / 'backup-set.json', key)
    require(document.get('kind') == 'apple-order-mgr-backup-set',
            'BACKUP_SET_KIND')
    backupId = document.get('backupId')
    require(isinstance(backupId, str) and path.name == backupId,
            'BACKUP_SET_ID')
    dependencies = document.get('dependencies', [])
    require(isinstance(dependencies, list)
            and all(isinstance(value, str) and value for value in dependencies),
            'BACKUP_SET_DEPENDENCIES')
    evidence = document.get('recoveryEvidence', {})
    evidencePath = path / evidence.get('path', '')
    require(document.get('completeRecoverable') is True
            and evidence.get('completeRestore') is True
            and evidencePath.is_file() and not evidencePath.is_symlink(),
            'BACKUP_SET_NOT_RECOVERABLE')
    digest, _size = sha256File(evidencePath)
    require(digest == evidence.get('sha256'), 'BACKUP_SET_RECOVERY_EVIDENCE')
    return document


def createBackupSetManifest(directory, key, backupId, createdAtUtc,
                            recoveryEvidencePath, dependencies=None,
                            sourceDigest=None, baselineDigest=None):
    """在完整恢复成功后认证一个可恢复备份集合。"""
    directory = Path(directory).absolute()
    require(directory.is_dir() and not directory.is_symlink(), 'BACKUP_SET_DIRECTORY')
    require(directory.name == backupId and '/' not in backupId, 'BACKUP_SET_ID')
    parseUtc(createdAtUtc)
    evidence = Path(recoveryEvidencePath).absolute()
    try:
        relativeEvidence = evidence.relative_to(directory).as_posix()
    except ValueError:
        raise FileBackupError('BACKUP_SET_RECOVERY_EVIDENCE')
    require(evidence.is_file() and not evidence.is_symlink(),
            'BACKUP_SET_RECOVERY_EVIDENCE')
    evidencePayload = loadManifest(evidence, key)
    require(evidencePayload.get('kind') == 'apple-order-mgr-complete-recovery'
            and evidencePayload.get('passed') is True
            and evidencePayload.get('databaseCompleteRestore') is True
            and evidencePayload.get('filesCompleteRestore') is True
            and evidencePayload.get('sideEffectsDisabled') is True,
            'BACKUP_SET_NOT_RECOVERABLE')
    evidenceDigest, evidenceSize = sha256File(evidence)
    dependencies = dependencies or []
    require(all(isinstance(value, str) and value for value in dependencies),
            'BACKUP_SET_DEPENDENCIES')
    document = {
        'schemaVersion': SCHEMA_VERSION,
        'kind': 'apple-order-mgr-backup-set',
        'backupId': backupId,
        'createdAtUtc': createdAtUtc,
        'completeRecoverable': True,
        'dependencies': sorted(set(dependencies)),
        'sourceDigest': sourceDigest,
        'baselineDigest': baselineDigest,
        'recoveryEvidence': {
            'path': relativeEvidence,
            'sha256': evidenceDigest,
            'size': evidenceSize,
            'completeRestore': True,
        },
    }
    authenticate(document, key)
    writeJsonAtomic(directory / 'backup-set.json', document)
    return document


def createRecoveryBundleEvidence(databaseEvidence, filesEvidence, output, key,
                                 sourceDigest, baselineDigest):
    """把数据库与文件完整恢复证据绑定为受认证恢复证明。"""
    require(not Path(output).exists(), 'EVIDENCE_ALREADY_EXISTS')
    try:
        database = json.loads(Path(databaseEvidence).read_text(encoding='utf-8'))
        files = json.loads(Path(filesEvidence).read_text(encoding='utf-8'))
    except (OSError, ValueError):
        raise FileBackupError('RECOVERY_EVIDENCE_INVALID')
    require(database.get('kind') == 'apple-order-mgr-database-restore'
            and database.get('passed') is True
            and database.get('completeRestore') is True
            and database.get('completeVerification') is True,
            'RECOVERY_EVIDENCE_INVALID')
    require(files.get('kind') == 'apple-order-mgr-files-restore'
            and files.get('passed') is True
            and files.get('completeVerification') is True
            and files.get('ownershipVerification') is True
            and files.get('ownership', {}).get('policy')
            in ('preserve', 'authenticated-map')
            and files.get('consistentSnapshot') is True
            and files.get('sourceInventoryVerified') is True,
            'RECOVERY_EVIDENCE_INVALID')
    databaseDigest, databaseSize = sha256File(databaseEvidence)
    filesDigest, filesSize = sha256File(filesEvidence)
    document = {
        'schemaVersion': SCHEMA_VERSION,
        'kind': 'apple-order-mgr-complete-recovery',
        'passed': True,
        'createdAtUtc': utcNow(),
        'sourceDigest': sourceDigest,
        'baselineDigest': baselineDigest,
        'databaseCompleteRestore': True,
        'filesCompleteRestore': True,
        'sideEffectsDisabled': all(database.get('sideEffectsDisabled', {}).values()),
        'evidence': {
            'database': {'path': str(Path(databaseEvidence).absolute()),
                         'sha256': databaseDigest, 'size': databaseSize},
            'files': {'path': str(Path(filesEvidence).absolute()),
                      'sha256': filesDigest, 'size': filesSize},
        },
    }
    require(document['sideEffectsDisabled'] is True, 'RECOVERY_EVIDENCE_INVALID')
    authenticate(document, key)
    writeJsonAtomic(output, document)
    return document


def loadProtectedReferences(path):
    """读取 current/rollback/base/dependency 保护引用。"""
    referencePath = Path(path)
    require(referencePath.is_file() and not referencePath.is_symlink(),
            'CLEANUP_REFERENCES_INVALID')
    raw = referencePath.read_bytes()
    try:
        payload = json.loads(raw.decode('utf-8'))
    except ValueError:
        raise FileBackupError('CLEANUP_REFERENCES_INVALID')
    protected = set()
    for field in ('current', 'rollback', 'base', 'dependencies'):
        values = payload.get(field, [])
        if isinstance(values, str):
            values = [values]
        require(isinstance(values, list)
                and all(isinstance(value, str) and value for value in values),
                'CLEANUP_REFERENCES_INVALID')
        protected.update(values)
    return protected, hashlib.sha256(raw).hexdigest()


def scanBackupRoot(root, key):
    """只扫描精确根目录的一层认证备份集合。"""
    root = Path(root).absolute()
    require(root.is_dir() and not root.is_symlink() and root == root.resolve(),
            'CLEANUP_ROOT_INVALID')
    sets = {}
    unknown = []
    for child in sorted(root.iterdir(), key=lambda value: value.name):
        require(not child.is_symlink(), 'CLEANUP_ROOT_SYMLINK')
        if not child.is_dir() or not (child / 'backup-set.json').is_file():
            unknown.append(child.name)
            continue
        document = loadBackupSet(child, key)
        _records, stateDigest = directoryState(child)
        sets[child.name] = {
            'path': child,
            'document': document,
            'stateDigest': stateDigest,
            'active': (child / '.active').exists(),
        }
    rootState = [{
        'backupId': backupId,
        'manifestDigest': item['document']['authentication']['digest'],
        'stateDigest': item['stateDigest'],
        'active': item['active'],
    } for backupId, item in sorted(sets.items())]
    return sets, unknown, hashlib.sha256(canonicalBytes(rootState)).hexdigest()


def dependencyClosure(sets, protected):
    """递归保护所有基档与依赖。"""
    pending = list(protected)
    while pending:
        backupId = pending.pop()
        item = sets.get(backupId)
        if not item:
            continue
        for dependency in item['document'].get('dependencies', []):
            require(dependency in sets, 'CLEANUP_DEPENDENCY_MISSING')
            if dependency not in protected:
                protected.add(dependency)
                pending.append(dependency)
    return protected


def buildCleanupPlan(root, referencesPath, output, key, allowedRoot,
                     now=None, retentionDays=7, minimumComplete=2,
                     maximumCandidates=1):
    """生成认证删除计划，不删除任何文件。"""
    root = Path(root).absolute()
    allowedRoot = Path(allowedRoot).absolute()
    require(root == allowedRoot and root == root.resolve(), 'CLEANUP_ROOT_NOT_ALLOWED')
    require(retentionDays >= 7 and minimumComplete >= 2, 'CLEANUP_POLICY_WEAK')
    require(maximumCandidates == 1, 'CLEANUP_BATCH_UNSAFE')
    require(not Path(output).exists(), 'CLEANUP_PLAN_ALREADY_EXISTS')
    now = now or datetime.datetime.utcnow()
    sets, unknown, rootStateDigest = scanBackupRoot(root, key)
    referenced, referencesDigest = loadProtectedReferences(referencesPath)
    require(all(backupId in sets for backupId in referenced),
            'CLEANUP_REFERENCE_MISSING')
    protected = set(referenced)
    cutoff = now - datetime.timedelta(days=retentionDays)
    ordered = sorted(sets.items(), key=lambda item: parseUtc(
        item[1]['document']['createdAtUtc']), reverse=True)
    protected.update(backupId for backupId, _item in ordered[:minimumComplete])
    for backupId, item in ordered:
        created = parseUtc(item['document']['createdAtUtc'])
        if created >= cutoff or item['active']:
            protected.add(backupId)
    protected = dependencyClosure(sets, protected)
    eligible = []
    for backupId, item in ordered:
        if backupId not in protected:
            eligible.append({
                'backupId': backupId,
                'stateDigest': item['stateDigest'],
                'manifestDigest': item['document']['authentication']['digest'],
            })
    document = {
        'schemaVersion': SCHEMA_VERSION,
        'kind': 'apple-order-mgr-cleanup-plan',
        'createdAtUtc': now.replace(microsecond=0).isoformat() + 'Z',
        'root': str(root),
        'policy': {'retentionDays': retentionDays,
                   'minimumCompleteRecoverableSets': minimumComplete},
        'referencesPath': str(Path(referencesPath).absolute()),
        'referencesDigest': referencesDigest,
        'rootStateDigest': rootStateDigest,
        'protected': sorted(protected),
        'candidates': eligible[:maximumCandidates],
        'remainingEligibleCount': max(0, len(eligible) - maximumCandidates),
        'unknownEntriesIgnored': unknown,
    }
    authenticate(document, key)
    writeJsonAtomic(output, document)
    return document


def safeRemoveTree(path, expectedDigest):
    """最终重核目录摘要后删除单个已批准集合。"""
    require(path.is_dir() and not path.is_symlink(), 'CLEANUP_TARGET_INVALID')
    _records, actualDigest = directoryState(path)
    require(actualDigest == expectedDigest, 'CLEANUP_TARGET_CHANGED')
    shutil.rmtree(str(path))


def applyCleanupPlan(planPath, key, allowedRoot, confirmDigest):
    """重核全部状态后应用已认证清理计划。"""
    plan = loadManifest(planPath, key)
    require(plan.get('kind') == 'apple-order-mgr-cleanup-plan', 'CLEANUP_PLAN_KIND')
    planDigest = plan['authentication']['digest']
    require(hmac.compare_digest(planDigest, confirmDigest), 'CLEANUP_CONFIRMATION')
    root = Path(plan['root']).absolute()
    require(root == Path(allowedRoot).absolute() and root == root.resolve(),
            'CLEANUP_ROOT_NOT_ALLOWED')
    sets, _unknown, rootStateDigest = scanBackupRoot(root, key)
    require(rootStateDigest == plan['rootStateDigest'], 'CLEANUP_ROOT_CHANGED')
    references, referencesDigest = loadProtectedReferences(plan['referencesPath'])
    require(referencesDigest == plan['referencesDigest'], 'CLEANUP_REFERENCES_CHANGED')
    protected = dependencyClosure(sets, set(references) | set(plan['protected']))
    candidates = plan.get('candidates', [])
    require(len(candidates) <= 1, 'CLEANUP_BATCH_UNSAFE')
    require(all(item.get('backupId') not in protected for item in candidates),
            'CLEANUP_TARGET_PROTECTED')
    removed = []
    for item in candidates:
        backupId = item.get('backupId')
        require(backupId in sets and not sets[backupId]['active'],
                'CLEANUP_TARGET_CHANGED')
        require(sets[backupId]['document']['authentication']['digest']
                == item.get('manifestDigest'), 'CLEANUP_TARGET_CHANGED')
        safeRemoveTree(sets[backupId]['path'], item.get('stateDigest'))
        removed.append(backupId)
    return {'passed': True, 'planDigest': planDigest, 'removed': removed,
            'removedCount': len(removed)}


def parseOwnershipMappings(value):
    """解析 CLI 提供的 owner map JSON 对象。"""
    try:
        mappings = json.loads(value)
    except ValueError:
        raise FileBackupError('OWNERSHIP_MAP_INVALID')
    require(isinstance(mappings, dict), 'OWNERSHIP_MAP_INVALID')
    return mappings


def main():
    """命令行入口只输出摘要和固定错误码。"""
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command')
    snapshot = sub.add_parser('snapshot')
    snapshot.add_argument('--source', required=True)
    snapshot.add_argument('--store', required=True)
    snapshot.add_argument('--manifest', required=True)
    snapshot.add_argument('--key-file', required=True)
    snapshot.add_argument('--key-version')
    snapshot.add_argument('--release-id', required=True)
    snapshot.add_argument('--base-manifest')
    snapshot.add_argument('--immutable-path', action='append', default=[])
    snapshot.add_argument('--exclude-path', action='append', default=[])
    snapshot.add_argument('--include-path', action='append', default=[])
    snapshot.add_argument('--consistency-proof')
    restore = sub.add_parser('restore')
    restore.add_argument('--manifest', required=True)
    restore.add_argument('--destination', required=True)
    restore.add_argument('--key-file', required=True)
    restore.add_argument('--store')
    restore.add_argument('--ownership-map')
    ownership = sub.add_parser('ownership-map')
    ownership.add_argument('--manifest', required=True)
    ownership.add_argument('--output', required=True)
    ownership.add_argument('--mapping-json', required=True)
    ownership.add_argument('--key-file', required=True)
    register = sub.add_parser('register-backup-set')
    register.add_argument('--directory', required=True)
    register.add_argument('--backup-id', required=True)
    register.add_argument('--created-at-utc', required=True)
    register.add_argument('--recovery-evidence', required=True)
    register.add_argument('--dependency', action='append', default=[])
    register.add_argument('--source-digest')
    register.add_argument('--baseline-digest')
    register.add_argument('--key-file', required=True)
    bundle = sub.add_parser('recovery-bundle')
    bundle.add_argument('--database-evidence', required=True)
    bundle.add_argument('--files-evidence', required=True)
    bundle.add_argument('--output', required=True)
    bundle.add_argument('--source-digest', required=True)
    bundle.add_argument('--baseline-digest', required=True)
    bundle.add_argument('--key-file', required=True)
    consistency = sub.add_parser('consistency-proof')
    consistency.add_argument('--source', required=True)
    consistency.add_argument('--state-evidence', required=True)
    consistency.add_argument('--output', required=True)
    consistency.add_argument('--key-file', required=True)
    cleanupPlan = sub.add_parser('cleanup-plan')
    cleanupPlan.add_argument('--root', default=DEFAULT_BACKUP_ROOT)
    cleanupPlan.add_argument('--references', required=True)
    cleanupPlan.add_argument('--output', required=True)
    cleanupPlan.add_argument('--key-file', required=True)
    cleanupApply = sub.add_parser('cleanup-apply')
    cleanupApply.add_argument('--plan', required=True)
    cleanupApply.add_argument('--confirm-digest', required=True)
    cleanupApply.add_argument('--key-file', required=True)
    args = parser.parse_args()
    try:
        require(args.command is not None, 'COMMAND_REQUIRED')
        key = readKey(args.key_file)
        if args.command == 'snapshot':
            result = createManifest(
                args.source, args.store, args.manifest, key, args.release_id,
                args.base_manifest, args.immutable_path, args.exclude_path,
                args.key_version, args.consistency_proof, args.include_path)
            output = {
                'passed': True,
                'releaseId': result['releaseId'],
                'manifestDigest': result['authentication']['digest'],
                'entries': len(result['entries']),
                'changes': result['changes'],
                'metrics': result['metrics'],
            }
        elif args.command == 'restore':
            output = restoreManifest(
                args.manifest, args.destination, key, args.store,
                args.ownership_map)
        elif args.command == 'ownership-map':
            result = createOwnershipMap(
                args.manifest, args.output, key,
                parseOwnershipMappings(args.mapping_json))
            output = {
                'passed': True,
                'kind': result['kind'],
                'manifestDigest': result['manifestDigest'],
                'mapDigest': result['authentication']['digest'],
            }
        elif args.command == 'register-backup-set':
            result = createBackupSetManifest(
                args.directory, key, args.backup_id, args.created_at_utc,
                args.recovery_evidence, args.dependency, args.source_digest,
                args.baseline_digest)
            output = {'passed': True, 'backupId': result['backupId'],
                      'manifestDigest': result['authentication']['digest']}
        elif args.command == 'recovery-bundle':
            result = createRecoveryBundleEvidence(
                args.database_evidence, args.files_evidence, args.output, key,
                args.source_digest, args.baseline_digest)
            output = {'passed': True,
                      'evidenceDigest': result['authentication']['digest'],
                      'databaseCompleteRestore': True,
                      'filesCompleteRestore': True}
        elif args.command == 'consistency-proof':
            result = createConsistencyProof(
                args.source, args.state_evidence, args.output, key)
            output = {'passed': True,
                      'proofDigest': result['authentication']['digest'],
                      'consistentSnapshot': True}
        elif args.command == 'cleanup-plan':
            result = buildCleanupPlan(args.root, args.references, args.output, key,
                                      DEFAULT_BACKUP_ROOT)
            output = {'passed': True,
                      'planDigest': result['authentication']['digest'],
                      'candidateCount': len(result['candidates']),
                      'candidates': [item['backupId'] for item in result['candidates']],
                      'protectedCount': len(result['protected'])}
        else:
            output = applyCleanupPlan(args.plan, key, DEFAULT_BACKUP_ROOT,
                                      args.confirm_digest)
        print(json.dumps(output, ensure_ascii=False, sort_keys=True))
        return 0
    except Exception as error:
        code = error.code if isinstance(error, FileBackupError) else 'FILE_BACKUP_FAILED'
        print(json.dumps({'passed': False, 'code': code}, sort_keys=True))
        return 1


if __name__ == '__main__':
    sys.exit(main())
