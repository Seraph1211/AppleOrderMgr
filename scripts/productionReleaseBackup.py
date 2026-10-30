#!/usr/bin/env python3
"""生产发布数据库完整备份、流式传输与隔离恢复；兼容 Python 3.6。"""
import argparse
import datetime
import hashlib
import hmac
import json
import os
import re
import select
import subprocess
import sys
import tempfile
from pathlib import Path


CHUNK_SIZE = 1024 * 1024
SNAPSHOT_PATTERN = re.compile(r'^[A-Za-z0-9-]{5,128}$')
AOS_LOG_EXCLUSIONS = (
    'public.monitor_log_entries',
    'public.monitor_log_entries_*',
    'public.monitor_log_files',
    'public.monitor_log_blocks',
    'public.monitor_log_blocks_*',
    'public.monitor_log_block_accounts',
    'public.monitor_log_block_accounts_*',
    'public.monitor_log_receipts',
)
SIDE_EFFECT_GUARDS = (
    'mail', 'wecom', 'officialQueue', 'schedulers', 'externalWrites',
)
ISOLATION_PROOF_MAX_AGE_SECONDS = 600


class BackupError(Exception):
    """数据库备份固定错误码。"""

    def __init__(self, code):
        super().__init__(code)
        self.code = code


def require(condition, code):
    """条件不满足时失败关闭。"""
    if not condition:
        raise BackupError(code)


def utcNow():
    """返回带 Z 的 UTC 时间。"""
    return datetime.datetime.utcnow().replace(microsecond=0).isoformat() + 'Z'


def canonicalBytes(payload):
    """生成认证用稳定 JSON。"""
    return json.dumps(payload, sort_keys=True, separators=(',', ':')).encode('utf-8')


def authenticate(document, key):
    """为隔离证明生成 HMAC-SHA256。"""
    payload = dict(document)
    payload.pop('authentication', None)
    document['authentication'] = {
        'algorithm': 'hmac-sha256',
        'digest': hmac.new(key, canonicalBytes(payload), hashlib.sha256).hexdigest(),
    }
    return document


def verifyAuthentication(document, key, code):
    """验证 HMAC-SHA256 文档。"""
    authentication = document.get('authentication', {})
    payload = dict(document)
    payload.pop('authentication', None)
    expected = hmac.new(key, canonicalBytes(payload), hashlib.sha256).hexdigest()
    require(authentication.get('algorithm') == 'hmac-sha256'
            and hmac.compare_digest(authentication.get('digest', ''), expected), code)
    return document


def readProofKey(path):
    """读取 0600 且至少 32 字节的隔离证明密钥。"""
    keyPath = Path(path)
    require(keyPath.is_file() and not keyPath.is_symlink(), 'RESTORE_PROOF_KEY')
    require(keyPath.stat().st_mode & 0o077 == 0, 'RESTORE_PROOF_KEY')
    key = keyPath.read_bytes()
    require(len(key) >= 32, 'RESTORE_PROOF_KEY')
    return key


def sha256File(path):
    """完整读取文件并返回 SHA-256 与字节数。"""
    digest = hashlib.sha256()
    size = 0
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(CHUNK_SIZE), b''):
            digest.update(chunk)
            size += len(chunk)
    return digest.hexdigest(), size


def writeJsonAtomic(path, payload):
    """以 0600 权限原子写 JSON 证据。"""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix='.' + path.name + '-',
                                              dir=str(path.parent))
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
            json.dump(payload, stream, ensure_ascii=False, sort_keys=True, indent=2)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, str(path))
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def commandEnvironment(environment):
    """合并显式环境；调用方不需要把凭据写入命令。"""
    merged = os.environ.copy()
    if environment:
        merged.update(environment)
    return merged


def validateSql(path):
    """读取只读校验 SQL，拒绝事务终止和 psql 外部命令。"""
    sqlPath = Path(path)
    require(sqlPath.is_file() and not sqlPath.is_symlink(), 'VALIDATION_SQL_INVALID')
    text = sqlPath.read_text(encoding='utf-8')
    lowered = text.lower()
    forbidden = ('commit', 'rollback', '\\!', '\\q', 'copy ', 'create ', 'alter ',
                 'drop ', 'truncate ', 'insert ', 'update ', 'delete ')
    require(not any(re.search(r'(^|\W)' + re.escape(token), lowered)
                    for token in forbidden), 'VALIDATION_SQL_NOT_READ_ONLY')
    require(text.strip(), 'VALIDATION_SQL_INVALID')
    return text


def psqlCommand(psql, database, connectionArgs=None):
    """构造不经 shell 的 psql 命令。"""
    return [psql, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'] + list(
        connectionArgs or []) + ['--dbname', database]


class SnapshotSession(object):
    """保持导出快照事务存活，供 dump 与校验共同使用。"""

    def __init__(self, psql, database, connectionArgs=None, environment=None,
                 timeout=30):
        self.command = psqlCommand(psql, database, connectionArgs)
        self.environment = commandEnvironment(environment)
        self.timeout = timeout
        self.process = None
        self.snapshotId = None

    def __enter__(self):
        self.process = subprocess.Popen(
            self.command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, universal_newlines=True, bufsize=1,
            env=self.environment)
        statement = ("BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY DEFERRABLE;\n"
                     "SELECT pg_export_snapshot();\n")
        self.process.stdin.write(statement)
        self.process.stdin.flush()
        ready, _write, _error = select.select([self.process.stdout], [], [], self.timeout)
        require(bool(ready), 'DB_SNAPSHOT_TIMEOUT')
        snapshot = self.process.stdout.readline().strip()
        require(SNAPSHOT_PATTERN.match(snapshot) is not None, 'DB_SNAPSHOT_FAILED')
        self.snapshotId = snapshot
        return self

    def __exit__(self, errorType, _error, _traceback):
        if not self.process:
            return
        try:
            if self.process.poll() is None:
                self.process.stdin.write('ROLLBACK;\n')
                self.process.stdin.flush()
                self.process.stdin.close()
                self.process.wait(timeout=10)
        except (BrokenPipeError, subprocess.TimeoutExpired):
            self.process.kill()
            self.process.wait()
        if errorType is None:
            require(self.process.returncode == 0, 'DB_SNAPSHOT_FAILED')


def runValidation(psql, database, validationSql, snapshotId=None,
                  connectionArgs=None, environment=None):
    """在同一导出快照或隔离恢复库中执行只读 JSON 校验。"""
    text = validateSql(validationSql)
    statements = ['BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY;']
    if snapshotId:
        require(SNAPSHOT_PATTERN.match(snapshotId) is not None, 'DB_SNAPSHOT_FAILED')
        statements.append("SET TRANSACTION SNAPSHOT '%s';" % snapshotId)
    statements.append("SET LOCAL TIME ZONE 'UTC';")
    statements.append(text)
    statements.append('ROLLBACK;')
    result = subprocess.run(
        psqlCommand(psql, database, connectionArgs),
        input=('\n'.join(statements) + '\n').encode('utf-8'),
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        env=commandEnvironment(environment))
    require(result.returncode == 0, 'DB_VALIDATION_FAILED')
    lines = [line for line in result.stdout.decode('utf-8').splitlines() if line.strip()]
    require(bool(lines), 'DB_VALIDATION_EMPTY')
    try:
        payload = json.loads(lines[-1])
    except ValueError:
        raise BackupError('DB_VALIDATION_INVALID')
    require(isinstance(payload, dict) and payload.get('passed') is True,
            'DB_VALIDATION_FAILED')
    return payload


def validateDatabaseFingerprint(payload):
    """要求全业务表、schema 与 Migration 摘要，拒绝仅返回 passed 的弱校验。"""
    tables = payload.get('businessTables')
    require(payload.get('validationVersion') == 1
            and isinstance(payload.get('businessTableCount'), int)
            and isinstance(tables, dict)
            and len(tables) == payload.get('businessTableCount')
            and isinstance(payload.get('schemaDigest'), str)
            and len(payload.get('schemaDigest')) == 32
            and isinstance(payload.get('migrationDigest'), str)
            and len(payload.get('migrationDigest')) == 32
            and isinstance(payload.get('migrationCount'), int)
            and isinstance(payload.get('sequenceStates'), dict)
            and payload.get('sequenceStatesSnapshotAligned') is False
            and payload.get('sequenceSafetyPassed') is True
            and payload.get('excludedTableData') == list(AOS_LOG_EXCLUSIONS),
            'DB_VALIDATION_INCOMPLETE')
    for summary in tables.values():
        require(isinstance(summary, dict)
                and isinstance(summary.get('rowCount'), int)
                and summary.get('rowCount') >= 0
                and isinstance(summary.get('rowDigest'), str)
                and len(summary.get('rowDigest')) == 32,
                'DB_VALIDATION_INCOMPLETE')
    return payload


def validateSchemaDiagnostic(payload):
    """验证 schema round-trip 诊断的六项摘要与列序空洞明细。"""
    fields = ('columnsRawDigest', 'columnsDenseDigest', 'constraintsDigest',
              'indexesDigest', 'typesDigest', 'sequencesDigest')
    require(isinstance(payload, dict) and payload.get('passed') is True
            and all(isinstance(payload.get(field), str)
                    and len(payload.get(field)) == 32 for field in fields)
            and isinstance(payload.get('ordinalGaps'), list),
            'SCHEMA_DIAGNOSTIC_INVALID')
    for gap in payload['ordinalGaps']:
        require(isinstance(gap, dict)
                and isinstance(gap.get('table'), str)
                and isinstance(gap.get('column'), str)
                and isinstance(gap.get('ordinalPosition'), int)
                and isinstance(gap.get('densePosition'), int),
                'SCHEMA_DIAGNOSTIC_INVALID')
    return payload


def schemaDigestFromDiagnostic(payload, denseColumns=False):
    """按正式 validation 的顺序合成原始或 dense 列序 schema 摘要。"""
    columnField = 'columnsDenseDigest' if denseColumns else 'columnsRawDigest'
    combined = (payload[columnField] + payload['constraintsDigest']
                + payload['indexesDigest'] + payload['typesDigest']
                + payload['sequencesDigest'])
    return hashlib.md5(combined.encode('utf-8')).hexdigest()


def createDatabaseBackup(database, output, validationSql, evidenceOutput,
                         pgDump='pg_dump', psql='psql', connectionArgs=None,
                         environment=None):
    """用同一 PostgreSQL 快照生成完整业务 dump 与校验证据。"""
    output = Path(output).absolute()
    evidenceOutput = Path(evidenceOutput).absolute()
    require(os.path.realpath(str(output)) != os.path.realpath(str(evidenceOutput)),
            'BACKUP_PATH_CONFLICT')
    require(not output.exists() and not evidenceOutput.exists(),
            'BACKUP_OUTPUT_ALREADY_EXISTS')
    output.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporaryName = tempfile.mkstemp(prefix='.' + output.name + '-',
                                                  dir=str(output.parent))
    os.close(descriptor)
    temporary = Path(temporaryName)
    startedAt = utcNow()
    try:
        with SnapshotSession(psql, database, connectionArgs, environment) as snapshot:
            command = [pgDump, '-Fc', '--snapshot', snapshot.snapshotId,
                       '--file', str(temporary)]
            for table in AOS_LOG_EXCLUSIONS:
                command.append('--exclude-table-data=' + table)
            command += list(connectionArgs or []) + [database]
            result = subprocess.run(command, stdout=subprocess.PIPE,
                                    stderr=subprocess.PIPE,
                                    env=commandEnvironment(environment))
            require(result.returncode == 0, 'PG_DUMP_FAILED')
            validation = runValidation(
                psql, database, validationSql, snapshot.snapshotId,
                connectionArgs, environment)
            validateDatabaseFingerprint(validation)
            snapshotId = snapshot.snapshotId
        os.chmod(str(temporary), 0o600)
        os.replace(str(temporary), str(output))
        digest, size = sha256File(output)
        require(size > 0, 'PG_DUMP_EMPTY')
        payload = {
            'passed': True,
            'completeBusinessBackup': True,
            'sourceDatabase': database,
            'snapshotId': snapshotId,
            'startedAtUtc': startedAt,
            'finishedAtUtc': utcNow(),
            'dump': {'path': str(output), 'sha256': digest, 'size': size,
                     'format': 'custom'},
            'excludedTableData': list(AOS_LOG_EXCLUSIONS),
            'sameSnapshotValidation': validation,
        }
        writeJsonAtomic(evidenceOutput, payload)
        return payload
    finally:
        if temporary.exists():
            temporary.unlink()


def createSourceSchemaArchive(database, output, schemaSql, evidenceOutput,
                              expectedSchemaDigest, businessDumpSha256, key,
                              pgDump='pg_dump', pgRestore='pg_restore', psql='psql',
                              connectionArgs=None, environment=None):
    """在无 DDL 窗口生成只含 schema 的原生 archive，并验证前后未漂移。"""
    output = Path(output).absolute()
    evidenceOutput = Path(evidenceOutput).absolute()
    require(os.path.realpath(str(output)) != os.path.realpath(str(evidenceOutput)),
            'BACKUP_PATH_CONFLICT')
    require(not output.exists() and not evidenceOutput.exists(),
            'BACKUP_OUTPUT_ALREADY_EXISTS')
    require(isinstance(expectedSchemaDigest, str)
            and len(expectedSchemaDigest) == 32,
            'EXPECTED_SCHEMA_DIGEST_INVALID')
    require(isinstance(businessDumpSha256, str)
            and len(businessDumpSha256) == 64,
            'BACKUP_DIGEST_MISMATCH')
    before = validateSchemaDiagnostic(runValidation(
        psql, database, schemaSql, connectionArgs=connectionArgs,
        environment=environment))
    require(schemaDigestFromDiagnostic(before) == expectedSchemaDigest,
            'SOURCE_SCHEMA_SNAPSHOT_MISMATCH')
    output.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporaryName = tempfile.mkstemp(
        prefix='.' + output.name + '-', dir=str(output.parent))
    os.close(descriptor)
    temporary = Path(temporaryName)
    try:
        command = [pgDump, '-Fc', '--schema-only', '--no-owner',
                   '--no-privileges', '--file', str(temporary)]
        command += list(connectionArgs or []) + [database]
        dumped = subprocess.run(command, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE,
                                env=commandEnvironment(environment))
        require(dumped.returncode == 0, 'PG_SCHEMA_DUMP_FAILED')
        listed = subprocess.run(
            [pgRestore, '--list', str(temporary)], stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, env=commandEnvironment(environment))
        require(listed.returncode == 0, 'PG_SCHEMA_LIST_FAILED')
        listBytes = listed.stdout
        listText = listBytes.decode('utf-8')
        dataEntries = [line for line in listText.splitlines()
                       if re.search(r';\s+\d+\s+\d+\s+'
                                    r'(?:TABLE DATA|BLOB|BLOBS)\b', line)]
        require(not dataEntries, 'PG_SCHEMA_ARCHIVE_CONTAINS_DATA')
        after = validateSchemaDiagnostic(runValidation(
            psql, database, schemaSql, connectionArgs=connectionArgs,
            environment=environment))
        require(before == after
                and schemaDigestFromDiagnostic(after) == expectedSchemaDigest,
                'SOURCE_SCHEMA_CHANGED_DURING_EXPORT')
        digest, size = sha256File(temporary)
        require(size > 0, 'PG_DUMP_EMPTY')
        os.chmod(str(temporary), 0o600)
        os.replace(str(temporary), str(output))
        payload = {
            'schemaVersion': 1,
            'kind': 'apple-order-mgr-source-schema-archive',
            'passed': True,
            'sourceDatabase': database,
            'businessDumpSha256': businessDumpSha256,
            'expectedSourceSchemaDigest': expectedSchemaDigest,
            'beforeDiagnostic': before,
            'afterDiagnostic': after,
            'archive': {
                'path': str(output), 'sha256': digest, 'size': size,
                'format': 'custom-schema-only',
                'listSha256': hashlib.sha256(listBytes).hexdigest(),
                'tableDataEntryCount': 0,
                'largeObjectDataEntryCount': 0,
            },
            'finishedAtUtc': utcNow(),
        }
        authenticate(payload, key)
        writeJsonAtomic(evidenceOutput, payload)
        return payload
    finally:
        if temporary.exists():
            temporary.unlink()


def runCheckedPipeline(commands, output, environment=None):
    """执行不经 shell 的管道，任一段失败都失败关闭并复核落盘摘要。"""
    require(isinstance(commands, list) and commands
            and all(isinstance(command, list) and command for command in commands),
            'PIPELINE_INVALID')
    output = Path(output).absolute()
    require(not output.exists(), 'PIPELINE_OUTPUT_ALREADY_EXISTS')
    output.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporaryName = tempfile.mkstemp(prefix='.' + output.name + '-',
                                                  dir=str(output.parent))
    os.close(descriptor)
    processes = []
    logDescriptor, logName = tempfile.mkstemp(prefix='.pipeline-',
                                               dir=str(output.parent))
    try:
        previous = None
        with os.fdopen(logDescriptor, 'wb') as errorLog, open(temporaryName, 'wb') as destination:
            for index, command in enumerate(commands):
                stdout = destination if index == len(commands) - 1 else subprocess.PIPE
                process = subprocess.Popen(
                    command, stdin=previous, stdout=stdout, stderr=errorLog,
                    env=commandEnvironment(environment))
                if previous is not None:
                    previous.close()
                previous = process.stdout if stdout == subprocess.PIPE else None
                processes.append(process)
            for process in processes:
                process.wait()
            destination.flush()
            os.fsync(destination.fileno())
        require(all(process.returncode == 0 for process in processes),
                'PIPELINE_FAILED')
        os.chmod(temporaryName, 0o600)
        os.replace(temporaryName, str(output))
        digest, size = sha256File(output)
        require(size > 0, 'PIPELINE_EMPTY')
        return {'passed': True, 'path': str(output), 'sha256': digest, 'size': size,
                'segments': len(commands)}
    finally:
        for process in processes:
            if process.poll() is None:
                process.kill()
                process.wait()
        if os.path.exists(temporaryName):
            os.unlink(temporaryName)
        if os.path.exists(logName):
            os.unlink(logName)


def createIsolationProof(container, targetDatabase, sourceDatabase, output, key,
                         docker='docker', databaseUser='postgres'):
    """实时读取容器隔离状态并生成受认证证明，不落盘原始 inspect。"""
    require(targetDatabase.startswith('apple_order_mgr_restore_')
            and targetDatabase != sourceDatabase, 'RESTORE_TARGET_NAME')
    result = subprocess.run([docker, 'inspect', container], stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE)
    require(result.returncode == 0, 'RESTORE_CONTAINER_INSPECT')
    try:
        inspect = json.loads(result.stdout.decode('utf-8'))
    except ValueError:
        raise BackupError('RESTORE_CONTAINER_INSPECT')
    require(isinstance(inspect, list) and len(inspect) == 1,
            'RESTORE_CONTAINER_INSPECT')
    item = inspect[0]
    host = item.get('HostConfig', {})
    network = item.get('NetworkSettings', {})
    labels = item.get('Config', {}).get('Labels') or {}
    require(host.get('NetworkMode') == 'none'
            and not (network.get('Ports') or {})
            and labels.get('com.apple-order-mgr.isolated-restore') == 'true'
            and labels.get('com.apple-order-mgr.side-effects-disabled') == 'true'
            and labels.get('com.apple-order-mgr.postgres-major') == '15'
            and labels.get('com.apple-order-mgr.restore-database') == targetDatabase
            and item.get('State', {}).get('Running') is True,
            'RESTORE_ISOLATION')
    selected = {
        'containerId': item.get('Id'),
        'networkMode': host.get('NetworkMode'),
        'publishedPorts': network.get('Ports') or {},
        'running': item.get('State', {}).get('Running'),
        'labels': {
            'isolatedRestore': labels.get('com.apple-order-mgr.isolated-restore'),
            'sideEffectsDisabled': labels.get(
                'com.apple-order-mgr.side-effects-disabled'),
            'postgresMajor': labels.get('com.apple-order-mgr.postgres-major'),
            'restoreDatabase': labels.get('com.apple-order-mgr.restore-database'),
        },
    }
    proof = {
        'schemaVersion': 1,
        'kind': 'apple-order-mgr-restore-isolation',
        'generatedAtUtc': utcNow(),
        'container': container,
        'containerId': item.get('Id'),
        'inspectDigest': hashlib.sha256(canonicalBytes(selected)).hexdigest(),
        'targetDatabase': targetDatabase,
        'sourceDatabase': sourceDatabase,
        'databaseUser': databaseUser,
        'networkMode': 'none',
        'publishedPorts': [],
        'postgresMajor': 15,
        'testDatabaseMarker': targetDatabase,
        'sideEffectsDisabled': {name: True for name in SIDE_EFFECT_GUARDS},
    }
    authenticate(proof, key)
    require(not Path(output).exists(), 'EVIDENCE_ALREADY_EXISTS')
    writeJsonAtomic(output, proof)
    return proof


def loadIsolationProof(path, targetDatabase, key):
    """验证新鲜受认证证明、专用库名、无网络及副作用关闭。"""
    proofPath = Path(path)
    require(proofPath.is_file() and not proofPath.is_symlink(), 'RESTORE_ISOLATION')
    try:
        proof = json.loads(proofPath.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        raise BackupError('RESTORE_ISOLATION')
    verifyAuthentication(proof, key, 'RESTORE_ISOLATION_AUTHENTICATION')
    require(proof.get('kind') == 'apple-order-mgr-restore-isolation',
            'RESTORE_ISOLATION')
    guards = proof.get('sideEffectsDisabled', {})
    require(targetDatabase.startswith('apple_order_mgr_restore_'),
            'RESTORE_TARGET_NAME')
    try:
        generated = datetime.datetime.strptime(
            proof.get('generatedAtUtc', ''), '%Y-%m-%dT%H:%M:%SZ')
    except ValueError:
        raise BackupError('RESTORE_ISOLATION_STALE')
    age = (datetime.datetime.utcnow() - generated).total_seconds()
    require(proof.get('targetDatabase') == targetDatabase
            and isinstance(proof.get('databaseUser'), str)
            and proof.get('databaseUser')
            and proof.get('networkMode') == 'none'
            and proof.get('publishedPorts') == []
            and proof.get('postgresMajor') == 15
            and proof.get('testDatabaseMarker') == targetDatabase
            and all(guards.get(name) is True for name in SIDE_EFFECT_GUARDS),
            'RESTORE_ISOLATION')
    require(proof.get('sourceDatabase') != targetDatabase, 'RESTORE_TARGET_IS_SOURCE')
    require(0 <= age <= ISOLATION_PROOF_MAX_AGE_SECONDS, 'RESTORE_ISOLATION_STALE')
    return proof


def verifyLiveIsolation(proof, docker='docker'):
    """恢复前再次读取容器状态，拒绝证明生成后的网络或标签变化。"""
    result = subprocess.run([docker, 'inspect', proof['container']],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    require(result.returncode == 0, 'RESTORE_CONTAINER_INSPECT')
    try:
        item = json.loads(result.stdout.decode('utf-8'))[0]
    except (ValueError, IndexError, TypeError):
        raise BackupError('RESTORE_CONTAINER_INSPECT')
    labels = item.get('Config', {}).get('Labels') or {}
    selected = {
        'containerId': item.get('Id'),
        'networkMode': item.get('HostConfig', {}).get('NetworkMode'),
        'publishedPorts': item.get('NetworkSettings', {}).get('Ports') or {},
        'running': item.get('State', {}).get('Running'),
        'labels': {
            'isolatedRestore': labels.get('com.apple-order-mgr.isolated-restore'),
            'sideEffectsDisabled': labels.get(
                'com.apple-order-mgr.side-effects-disabled'),
            'postgresMajor': labels.get('com.apple-order-mgr.postgres-major'),
            'restoreDatabase': labels.get('com.apple-order-mgr.restore-database'),
        },
    }
    require(item.get('Id') == proof.get('containerId')
            and hashlib.sha256(canonicalBytes(selected)).hexdigest()
            == proof.get('inspectDigest'), 'RESTORE_ISOLATION_CHANGED')
    return item


def runContainerPsql(docker, containerId, psql, targetDatabase, databaseUser,
                     sql, errorCode):
    """只通过已证明容器的 docker exec 运行 psql 并解析末行 JSON。"""
    command = [docker, 'exec', '-i', containerId, psql, '-X', '-qAt', '-v',
               'ON_ERROR_STOP=1', '--dbname', targetDatabase]
    command += ['--username', databaseUser]
    result = subprocess.run(command, input=(sql + '\n').encode('utf-8'),
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    require(result.returncode == 0, errorCode)
    lines = [line for line in result.stdout.decode('utf-8').splitlines() if line.strip()]
    require(bool(lines), errorCode)
    try:
        payload = json.loads(lines[-1])
    except ValueError:
        raise BackupError(errorCode)
    return payload


def verifyContainerDumpMount(inspect, dump, containerDumpPath):
    """确认已校验 dump 以只读精确挂载进入同一个隔离容器。"""
    dump = str(Path(dump).resolve())
    require(isinstance(containerDumpPath, str)
            and containerDumpPath.startswith('/restore-input/'),
            'RESTORE_DUMP_MOUNT')
    matches = [mount for mount in inspect.get('Mounts', [])
               if mount.get('Destination') == containerDumpPath]
    require(len(matches) == 1 and str(Path(matches[0].get('Source', '')).resolve()) == dump
            and matches[0].get('RW') is False, 'RESTORE_DUMP_MOUNT')
    return True


def restoreDatabaseBackup(dump, expectedSha256, targetDatabase, isolationProof,
                          validationSql, evidenceOutput, pgRestore='pg_restore',
                          psql='psql', jobs=2, connectionArgs=None,
                          environment=None, migrationCommand=None, proofKey=None,
                          docker='docker', containerDumpPath=None):
    """完整恢复 dump，执行可选迁移并验证业务不变量。"""
    require(1 <= jobs <= 4, 'RESTORE_JOBS_INVALID')
    require(not Path(evidenceOutput).exists(), 'EVIDENCE_ALREADY_EXISTS')
    require(isinstance(proofKey, bytes) and len(proofKey) >= 32,
            'RESTORE_PROOF_KEY')
    require(not connectionArgs and not environment,
            'RESTORE_EXTERNAL_CONNECTION_FORBIDDEN')
    proof = loadIsolationProof(isolationProof, targetDatabase, proofKey)
    inspect = verifyLiveIsolation(proof, docker)
    digest, size = sha256File(dump)
    require(hmacCompare(digest, expectedSha256), 'BACKUP_DIGEST_MISMATCH')
    verifyContainerDumpMount(inspect, dump, containerDumpPath)
    emptySql = ("SELECT json_build_object('passed', current_database() = '"
                + targetDatabase.replace("'", "''")
                + "', 'userTables', count(*), 'serverVersionNum', "
                  "current_setting('server_version_num')::int) FROM pg_class c "
                  "JOIN pg_namespace n ON n.oid=c.relnamespace "
                  "WHERE c.relkind IN ('r','p') AND n.nspname NOT IN "
                  "('pg_catalog','information_schema');")
    emptyCheck = runContainerPsql(
        docker, proof['containerId'], psql, targetDatabase, proof['databaseUser'], emptySql,
        'RESTORE_EMPTY_CHECK_FAILED')
    require(emptyCheck.get('passed') is True and emptyCheck.get('userTables') == 0,
            'RESTORE_TARGET_NOT_EMPTY')
    require(150000 <= emptyCheck.get('serverVersionNum', 0) < 160000,
            'RESTORE_POSTGRES_VERSION')
    command = [docker, 'exec', proof['containerId'], pgRestore,
               '--exit-on-error', '--no-owner', '--no-privileges',
               '--jobs', str(jobs), '--dbname', targetDatabase]
    command += ['--username', proof['databaseUser'], containerDumpPath]
    result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            env=commandEnvironment(None))
    require(result.returncode == 0, 'PG_RESTORE_FAILED')
    migrationPassed = None
    if migrationCommand:
        require(isinstance(migrationCommand, list) and len(migrationCommand) >= 5
                and migrationCommand[:3] == [docker, 'exec', proof['containerId']],
                'MIGRATION_COMMAND_INVALID')
        migration = subprocess.run(migrationCommand, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE,
                                   env=commandEnvironment(None))
        require(migration.returncode == 0, 'RESTORE_MIGRATION_FAILED')
        migrationPassed = True
    validationText = validateSql(validationSql)
    validationSqlText = ('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\n'
                         "SET LOCAL TIME ZONE 'UTC';\n"
                         + validationText + '\nROLLBACK;')
    validation = runContainerPsql(
        docker, proof['containerId'], psql, targetDatabase, proof['databaseUser'],
        validationSqlText,
        'DB_VALIDATION_FAILED')
    require(validation.get('passed') is True, 'DB_VALIDATION_FAILED')
    validateDatabaseFingerprint(validation)
    payload = {
        'passed': True,
        'kind': 'apple-order-mgr-database-restore',
        'completeRestore': True,
        'completeVerification': True,
        'sourceDatabase': proof.get('sourceDatabase'),
        'targetDatabase': targetDatabase,
        'networkMode': 'none',
        'sideEffectsDisabled': proof['sideEffectsDisabled'],
        'dump': {'path': str(Path(dump).absolute()), 'sha256': digest, 'size': size},
        'restoreJobs': jobs,
        'containerId': proof['containerId'],
        'containerDumpPath': containerDumpPath,
        'emptyTargetCheck': emptyCheck,
        'migrationPassed': migrationPassed,
        'validation': validation,
        'finishedAtUtc': utcNow(),
    }
    writeJsonAtomic(evidenceOutput, payload)
    return payload


def runContainerSchemaDiagnostic(docker, containerId, psql, targetDatabase,
                                 databaseUser, schemaSql):
    """在指定隔离容器中以 UTC 只读事务生成 schema component 摘要。"""
    text = validateSql(schemaSql)
    statement = ('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\n'
                 "SET LOCAL TIME ZONE 'UTC';\n" + text + '\nROLLBACK;')
    payload = runContainerPsql(
        docker, containerId, psql, targetDatabase, databaseUser, statement,
        'SCHEMA_DIAGNOSTIC_FAILED')
    return validateSchemaDiagnostic(payload)


def verifyReadOnlyRestoreContainer(containerId, docker='docker'):
    """复核既有完整恢复容器仍为运行中的无网、无端口隔离容器。"""
    result = subprocess.run([docker, 'inspect', containerId], stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE)
    require(result.returncode == 0, 'RESTORE_CONTAINER_INSPECT')
    try:
        items = json.loads(result.stdout.decode('utf-8'))
    except ValueError:
        raise BackupError('RESTORE_CONTAINER_INSPECT')
    require(isinstance(items, list) and len(items) == 1,
            'RESTORE_CONTAINER_INSPECT')
    item = items[0]
    require(item.get('Id') == containerId
            and item.get('State', {}).get('Running') is True
            and item.get('HostConfig', {}).get('NetworkMode') == 'none'
            and not (item.get('NetworkSettings', {}).get('Ports') or {}),
            'RESTORE_ISOLATION')
    return item


def createSchemaRoundtripEvidence(
        dump, expectedSha256, targetDatabase, isolationProof, schemaSql,
        fullRestoreEvidence, output, proofKey, pgRestore='pg_restore', psql='psql',
        docker='docker', containerDumpPath=None):
    """在第二个全新隔离库执行 schema-only 恢复并与完整恢复逐组件比较。"""
    require(not Path(output).exists(), 'EVIDENCE_ALREADY_EXISTS')
    require(isinstance(proofKey, bytes) and len(proofKey) >= 32,
            'RESTORE_PROOF_KEY')
    proof = loadIsolationProof(isolationProof, targetDatabase, proofKey)
    inspect = verifyLiveIsolation(proof, docker)
    digest, size = sha256File(dump)
    require(hmacCompare(digest, expectedSha256), 'BACKUP_DIGEST_MISMATCH')
    verifyContainerDumpMount(inspect, dump, containerDumpPath)
    try:
        restored = json.loads(Path(fullRestoreEvidence).read_text(encoding='utf-8'))
    except (OSError, ValueError):
        raise BackupError('VALIDATION_EVIDENCE_INVALID')
    require(restored.get('kind') == 'apple-order-mgr-database-restore'
            and restored.get('completeRestore') is True
            and restored.get('completeVerification') is True
            and restored.get('dump', {}).get('sha256') == digest
            and restored.get('containerId') != proof.get('containerId'),
            'SCHEMA_ROUNDTRIP_INVALID')
    fullContainerId = restored.get('containerId')
    verifyReadOnlyRestoreContainer(fullContainerId, docker)

    emptySql = ("SELECT json_build_object('passed', current_database() = '"
                + targetDatabase.replace("'", "''")
                + "', 'userTables', count(*), 'serverVersionNum', "
                  "current_setting('server_version_num')::int) FROM pg_class c "
                  "JOIN pg_namespace n ON n.oid=c.relnamespace "
                  "WHERE c.relkind IN ('r','p') AND n.nspname NOT IN "
                  "('pg_catalog','information_schema');")
    emptyCheck = runContainerPsql(
        docker, proof['containerId'], psql, targetDatabase, proof['databaseUser'],
        emptySql, 'RESTORE_EMPTY_CHECK_FAILED')
    require(emptyCheck.get('passed') is True and emptyCheck.get('userTables') == 0,
            'RESTORE_TARGET_NOT_EMPTY')
    require(150000 <= emptyCheck.get('serverVersionNum', 0) < 160000,
            'RESTORE_POSTGRES_VERSION')
    command = [docker, 'exec', proof['containerId'], pgRestore,
               '--exit-on-error', '--no-owner', '--no-privileges', '--schema-only',
               '--dbname', targetDatabase, '--username', proof['databaseUser'],
               containerDumpPath]
    result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            env=commandEnvironment(None))
    require(result.returncode == 0, 'PG_RESTORE_FAILED')
    schemaOnly = runContainerSchemaDiagnostic(
        docker, proof['containerId'], psql, targetDatabase, proof['databaseUser'],
        schemaSql)
    fullRestore = runContainerSchemaDiagnostic(
        docker, fullContainerId, psql, restored['targetDatabase'],
        proof['databaseUser'], schemaSql)
    componentFields = ('columnsRawDigest', 'columnsDenseDigest',
                       'constraintsDigest', 'indexesDigest', 'typesDigest',
                       'sequencesDigest', 'ordinalGaps')
    require(all(schemaOnly.get(field) == fullRestore.get(field)
                for field in componentFields), 'SCHEMA_ROUNDTRIP_MISMATCH')
    payload = {
        'schemaVersion': 1,
        'kind': 'apple-order-mgr-schema-roundtrip',
        'passed': True,
        'dump': {'path': str(Path(dump).absolute()), 'sha256': digest, 'size': size},
        'schemaOnlyRestore': {
            'containerId': proof['containerId'],
            'targetDatabase': targetDatabase,
            'networkMode': 'none',
            'serverVersionNum': emptyCheck.get('serverVersionNum'),
            'validation': schemaOnly,
            'schemaDigest': schemaDigestFromDiagnostic(schemaOnly),
        },
        'fullRestore': {
            'containerId': fullContainerId,
            'targetDatabase': restored['targetDatabase'],
            'validation': fullRestore,
            'schemaDigest': schemaDigestFromDiagnostic(fullRestore),
        },
        'componentsExactlyMatch': True,
        'finishedAtUtc': utcNow(),
    }
    authenticate(payload, proofKey)
    writeJsonAtomic(output, payload)
    return payload


def validateNativeInventory(payload):
    """验证数据库原生 catalog inventory 的完整组件数组。"""
    names = ('schemas', 'columns', 'types', 'sequences', 'constraints', 'indexes',
             'partitions', 'functions', 'triggers', 'relations', 'comments')
    components = payload.get('components') if isinstance(payload, dict) else None
    require(payload.get('passed') is True
            and payload.get('inventoryVersion') == 1
            and isinstance(payload.get('serverVersionNum'), int)
            and 150000 <= payload.get('serverVersionNum') < 160000
            and isinstance(components, dict)
            and set(components) == set(names)
            and all(isinstance(components.get(name), list) for name in names),
            'SCHEMA_NATIVE_INVENTORY_INVALID')
    return payload


def inventorySummary(payload):
    """只在证据中保存有序结构清单摘要，避免输出完整 catalog。"""
    components = payload['components']
    return {
        name: {
            'count': len(components[name]),
            'sha256': hashlib.sha256(
                canonicalBytes(components[name])).hexdigest(),
        }
        for name in sorted(components)
    }


def verifyNativeSchemaEquality(inventories, diagnostics):
    """逐对象比较reference、business schema-only与完整恢复。"""
    names = ('reference', 'businessSchemaOnly', 'fullRestore')
    require(isinstance(inventories, dict) and set(inventories) == set(names)
            and isinstance(diagnostics, dict) and set(diagnostics) == set(names),
            'SCHEMA_NATIVE_INVENTORY_INVALID')
    for name in names:
        validateNativeInventory(inventories[name])
        validateSchemaDiagnostic(diagnostics[name])
    referenceInventory = inventories['reference']['components']
    require(inventories['businessSchemaOnly']['components'] == referenceInventory
            and inventories['fullRestore']['components'] == referenceInventory,
            'SCHEMA_NATIVE_INVENTORY_MISMATCH')
    referenceDiagnostic = diagnostics['reference']
    require(diagnostics['businessSchemaOnly'] == referenceDiagnostic
            and diagnostics['fullRestore'] == referenceDiagnostic,
            'SCHEMA_NATIVE_DIAGNOSTIC_MISMATCH')
    return True


def readAuthenticatedDocument(path, key, kind, code):
    """读取指定kind的HMAC认证JSON。"""
    try:
        document = json.loads(Path(path).read_text(encoding='utf-8'))
    except (OSError, ValueError):
        raise BackupError(code)
    verifyAuthentication(document, key, code)
    require(document.get('kind') == kind and document.get('passed') is True, code)
    return document


def verifySchemaArchiveList(pgRestore, archive, expectedListSha, environment=None):
    """复核schema archive目录无TABLE DATA或large-object data。"""
    listed = subprocess.run([pgRestore, '--list', str(archive)],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            env=commandEnvironment(environment))
    require(listed.returncode == 0, 'PG_SCHEMA_LIST_FAILED')
    require(hashlib.sha256(listed.stdout).hexdigest() == expectedListSha,
            'PG_SCHEMA_LIST_CHANGED')
    text = listed.stdout.decode('utf-8')
    dataEntries = [line for line in text.splitlines()
                   if re.search(r';\s+\d+\s+\d+\s+'
                                r'(?:TABLE DATA|BLOB|BLOBS)\b', line)]
    require(not dataEntries, 'PG_SCHEMA_ARCHIVE_CONTAINS_DATA')
    return True


def writeBinaryExclusive(path, payload):
    """以0600独占写数据库原生SQL证据，不覆盖已有attempt。"""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
    except Exception:
        if path.exists():
            path.unlink()
        raise


def runCanonicalSchemaDump(docker, containerId, database, databaseUser,
                           clientImage, restrictKey):
    """用同一固定镜像中的pg_dump连接目标容器loopback并生成完整schema SQL。"""
    inspect = subprocess.run([docker, 'inspect', containerId], stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE)
    require(inspect.returncode == 0, 'RESTORE_CONTAINER_INSPECT')
    try:
        item = json.loads(inspect.stdout.decode('utf-8'))[0]
    except (ValueError, IndexError, TypeError):
        raise BackupError('RESTORE_CONTAINER_INSPECT')
    require(item.get('Id') == containerId
            and item.get('HostConfig', {}).get('NetworkMode') == 'none'
            and item.get('State', {}).get('Running') is True,
            'RESTORE_ISOLATION')
    environmentValues = item.get('Config', {}).get('Env') or []
    password = next((value.split('=', 1)[1] for value in environmentValues
                     if value.startswith('POSTGRES_PASSWORD=')), None)
    imageInspect = subprocess.run([docker, 'image', 'inspect', clientImage],
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    require(imageInspect.returncode == 0, 'SCHEMA_DUMP_CLIENT_IMAGE')
    try:
        imageItem = json.loads(imageInspect.stdout.decode('utf-8'))[0]
    except (ValueError, IndexError, TypeError):
        raise BackupError('SCHEMA_DUMP_CLIENT_IMAGE')
    imageId = imageItem.get('Id')
    require(isinstance(imageId, str) and imageId.startswith('sha256:'),
            'SCHEMA_DUMP_CLIENT_IMAGE')
    command = [
        docker, 'run', '--rm', '--pull', 'never', '--network',
        'container:' + containerId,
    ]
    environment = commandEnvironment(None)
    if isinstance(password, str) and password:
        command += ['-e', 'PGPASSWORD']
        environment['PGPASSWORD'] = password
    command += [
        imageId,
        'pg_dump', '--host', '127.0.0.1', '--port', '5432',
        '--username', databaseUser, '--schema-only', '--no-owner',
        '--no-privileges', '--restrict-key', restrictKey, database,
    ]
    try:
        result = subprocess.run(command, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, timeout=300,
                                env=environment)
    except subprocess.TimeoutExpired:
        raise BackupError('SCHEMA_CANONICAL_DUMP_TIMEOUT')
    require(result.returncode == 0, 'SCHEMA_CANONICAL_DUMP_FAILED')
    require(0 < len(result.stdout) <= 64 * 1024 * 1024,
            'SCHEMA_CANONICAL_DUMP_INVALID')
    return result.stdout, imageId


def verifyCanonicalSchemaSql(canonicalSql):
    """完整SQL必须逐字节一致；禁止删除header、cast或其他正文后比较。"""
    require(set(canonicalSql) == {
        'reference', 'businessSchemaOnly', 'fullRestore'},
        'SCHEMA_CANONICAL_SQL_MISMATCH')
    reference = canonicalSql['reference']
    require(isinstance(reference, bytes) and reference
            and canonicalSql['businessSchemaOnly'] == reference
            and canonicalSql['fullRestore'] == reference,
            'SCHEMA_CANONICAL_SQL_MISMATCH')
    return True


def createNativeSchemaEvidence(
        sourceSchemaArchive, sourceSchemaEvidence, referenceDatabase,
        referenceIsolationProof, referenceContainerArchivePath,
        businessRoundtripEvidence, fullRestoreEvidence, schemaSql, inventorySql,
        originalComparison, invalidationEvidence, schemaSqlOutputDir, output,
        proofKey, pgRestore='pg_restore', psql='psql', docker='docker',
        schemaDumpClientImage='postgres:15.18-alpine'):
    """用数据库原生schema重放证明source archive、business dump与完整恢复一致。"""
    require(not Path(output).exists(), 'EVIDENCE_ALREADY_EXISTS')
    schemaSqlOutputDir = Path(schemaSqlOutputDir).absolute()
    require(not schemaSqlOutputDir.exists(), 'EVIDENCE_ALREADY_EXISTS')
    require(schemaSqlOutputDir.parent.is_dir()
            and not schemaSqlOutputDir.parent.is_symlink()
            and schemaSqlOutputDir.parent == schemaSqlOutputDir.parent.resolve(),
            'SCHEMA_SQL_OUTPUT_DIRECTORY')
    require(os.path.realpath(str(schemaSqlOutputDir))
            != os.path.realpath(str(Path(output).absolute())),
            'BACKUP_PATH_CONFLICT')
    source = readAuthenticatedDocument(
        sourceSchemaEvidence, proofKey,
        'apple-order-mgr-source-schema-archive', 'SOURCE_SCHEMA_EVIDENCE_INVALID')
    roundtrip = readAuthenticatedDocument(
        businessRoundtripEvidence, proofKey,
        'apple-order-mgr-schema-roundtrip', 'SCHEMA_ROUNDTRIP_INVALID')
    referenceProof = loadIsolationProof(
        referenceIsolationProof, referenceDatabase, proofKey)
    referenceInspect = verifyLiveIsolation(referenceProof, docker)
    sourceDigest, sourceSize = sha256File(sourceSchemaArchive)
    require(source.get('archive', {}).get('sha256') == sourceDigest
            and source.get('archive', {}).get('size') == sourceSize,
            'SOURCE_SCHEMA_ARCHIVE_CHANGED')
    verifySchemaArchiveList(
        pgRestore, sourceSchemaArchive,
        source.get('archive', {}).get('listSha256'))
    verifyContainerDumpMount(
        referenceInspect, sourceSchemaArchive, referenceContainerArchivePath)
    try:
        restored = json.loads(Path(fullRestoreEvidence).read_text(encoding='utf-8'))
        original = json.loads(Path(originalComparison).read_text(encoding='utf-8'))
        invalidation = json.loads(Path(invalidationEvidence).read_text(encoding='utf-8'))
    except (OSError, ValueError):
        raise BackupError('VALIDATION_EVIDENCE_INVALID')
    businessDumpSha = source.get('businessDumpSha256')
    require(restored.get('kind') == 'apple-order-mgr-database-restore'
            and restored.get('completeRestore') is True
            and restored.get('dump', {}).get('sha256') == businessDumpSha
            and roundtrip.get('dump', {}).get('sha256') == businessDumpSha,
            'SCHEMA_NATIVE_DUMP_BINDING')
    originalDigest = sha256File(originalComparison)[0]
    require(original.get('passed') is False
            and 'schemaDigest' in original.get('mismatches', []),
            'ORIGINAL_COMPARISON_INVALID')
    invalidatedName = invalidation.get('invalidatedEvidence')
    require(isinstance(invalidatedName, str)
            and Path(invalidatedName).name == invalidatedName,
            'INVALIDATION_EVIDENCE_INVALID')
    invalidatedPath = Path(invalidationEvidence).parent / str(invalidatedName)
    require(invalidation.get('passed') is False
            and invalidation.get('reasonCode') == 'UNSAFE_REGEX_SCHEMA_EQUIVALENCE'
            and invalidatedPath.is_file()
            and sha256File(invalidatedPath)[0]
            == invalidation.get('invalidatedEvidenceSha256'),
            'INVALIDATION_EVIDENCE_INVALID')

    emptySql = ("SELECT json_build_object('passed', current_database() = '"
                + referenceDatabase.replace("'", "''")
                + "', 'userTables', count(*), 'serverVersionNum', "
                  "current_setting('server_version_num')::int) FROM pg_class c "
                  "JOIN pg_namespace n ON n.oid=c.relnamespace "
                  "WHERE c.relkind IN ('r','p') AND n.nspname NOT IN "
                  "('pg_catalog','information_schema');")
    emptyCheck = runContainerPsql(
        docker, referenceProof['containerId'], psql, referenceDatabase,
        referenceProof['databaseUser'], emptySql, 'RESTORE_EMPTY_CHECK_FAILED')
    require(emptyCheck.get('passed') is True and emptyCheck.get('userTables') == 0,
            'RESTORE_TARGET_NOT_EMPTY')
    require(150000 <= emptyCheck.get('serverVersionNum', 0) < 160000,
            'RESTORE_POSTGRES_VERSION')
    restoredSchema = subprocess.run([
        docker, 'exec', referenceProof['containerId'], pgRestore,
        '--exit-on-error', '--no-owner', '--no-privileges', '--schema-only',
        '--dbname', referenceDatabase, '--username', referenceProof['databaseUser'],
        referenceContainerArchivePath,
    ], stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=commandEnvironment(None))
    require(restoredSchema.returncode == 0, 'PG_RESTORE_FAILED')
    postRestoreDigest, postRestoreSize = sha256File(sourceSchemaArchive)
    require(postRestoreDigest == sourceDigest and postRestoreSize == sourceSize,
            'SOURCE_SCHEMA_ARCHIVE_CHANGED')

    schemaOnlyContainer = roundtrip.get('schemaOnlyRestore', {}).get('containerId')
    fullContainer = restored.get('containerId')
    require(len({referenceProof['containerId'], schemaOnlyContainer, fullContainer}) == 3,
            'SCHEMA_NATIVE_CONTAINER_REUSE')
    verifyReadOnlyRestoreContainer(schemaOnlyContainer, docker)
    verifyReadOnlyRestoreContainer(fullContainer, docker)
    inventoryText = validateSql(inventorySql)
    inventoryStatement = ('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\n'
                          "SET LOCAL TIME ZONE 'UTC';\n" + inventoryText
                          + '\nROLLBACK;')
    targets = (
        ('reference', referenceProof['containerId'], referenceDatabase),
        ('businessSchemaOnly', schemaOnlyContainer,
         roundtrip['schemaOnlyRestore']['targetDatabase']),
        ('fullRestore', fullContainer, restored['targetDatabase']),
    )
    inventories = {}
    diagnostics = {}
    for name, containerId, database in targets:
        inventories[name] = validateNativeInventory(runContainerPsql(
            docker, containerId, psql, database, referenceProof['databaseUser'],
            inventoryStatement, 'SCHEMA_NATIVE_INVENTORY_FAILED'))
        diagnostics[name] = runContainerSchemaDiagnostic(
            docker, containerId, psql, database, referenceProof['databaseUser'],
            schemaSql)
    verifyNativeSchemaEquality(inventories, diagnostics)
    referenceDiagnostic = diagnostics['reference']
    restrictKey = 'appleordermgr' + businessDumpSha[:40]
    canonicalSql = {}
    clientImageIds = set()
    for name, containerId, database in targets:
        sqlBytes, clientImageId = runCanonicalSchemaDump(
            docker, containerId, database, referenceProof['databaseUser'],
            schemaDumpClientImage, restrictKey)
        canonicalSql[name] = sqlBytes
        clientImageIds.add(clientImageId)
    require(len(clientImageIds) == 1, 'SCHEMA_DUMP_CLIENT_IMAGE_CHANGED')
    verifyCanonicalSchemaSql(canonicalSql)
    schemaSqlOutputDir.mkdir(parents=True, mode=0o700)
    require(not schemaSqlOutputDir.is_symlink()
            and schemaSqlOutputDir == schemaSqlOutputDir.resolve(),
            'SCHEMA_SQL_OUTPUT_DIRECTORY')
    canonicalSqlEvidence = {}
    for name in sorted(canonicalSql):
        path = schemaSqlOutputDir / (name + '.schema.sql')
        writeBinaryExclusive(path, canonicalSql[name])
        canonicalSqlEvidence[name] = {
            'path': str(path),
            'sha256': hashlib.sha256(canonicalSql[name]).hexdigest(),
            'size': len(canonicalSql[name]),
        }
    expectedSource = source.get('expectedSourceSchemaDigest')
    require(schemaDigestFromDiagnostic(source.get('beforeDiagnostic'))
            == expectedSource
            and source.get('beforeDiagnostic') == source.get('afterDiagnostic'),
            'SOURCE_SCHEMA_EVIDENCE_INVALID')
    summaries = {name: inventorySummary(value) for name, value in inventories.items()}
    inventoryDigests = {
        name: hashlib.sha256(canonicalBytes(value)).hexdigest()
        for name, value in inventories.items()
    }
    diagnosticDigests = {
        name: hashlib.sha256(canonicalBytes(value)).hexdigest()
        for name, value in diagnostics.items()
    }
    payload = {
        'schemaVersion': 1,
        'kind': 'apple-order-mgr-native-schema-proof',
        'passed': True,
        'method': 'postgresql-native-schema-archive-replay',
        'toolSha256': sha256File(Path(__file__))[0],
        'schemaSqlSha256': sha256File(schemaSql)[0],
        'inventorySqlSha256': sha256File(inventorySql)[0],
        'businessDumpSha256': businessDumpSha,
        'sourceSchemaArchive': {
            'sha256': sourceDigest,
            'size': sourceSize,
            'listSha256': source['archive']['listSha256'],
            'tableDataEntryCount': 0,
            'largeObjectDataEntryCount': 0,
        },
        'sourceSchemaEvidenceSha256': sha256File(sourceSchemaEvidence)[0],
        'businessRoundtripEvidenceSha256': sha256File(
            businessRoundtripEvidence)[0],
        'fullRestoreEvidenceSha256': sha256File(fullRestoreEvidence)[0],
        'referenceIsolationProofSha256': sha256File(
            referenceIsolationProof)[0],
        'sourceRawSchemaDigest': expectedSource,
        'sourceBeforeAfterExact': True,
        'canonicalSchemaDigest': schemaDigestFromDiagnostic(referenceDiagnostic),
        'containers': {
            name: {'containerId': containerId, 'targetDatabase': database,
                   'networkMode': 'none',
                   'serverVersionNum': inventories[name]['serverVersionNum']}
            for name, containerId, database in targets
        },
        'inventoryExactAcrossThreeRestores': True,
        'diagnosticExactAcrossThreeRestores': True,
        'canonicalSqlExactAcrossThreeRestores': True,
        'canonicalSql': canonicalSqlEvidence,
        'canonicalSqlClientImage': schemaDumpClientImage,
        'canonicalSqlClientImageId': next(iter(clientImageIds)),
        'canonicalSqlRestrictKeySha256': hashlib.sha256(
            restrictKey.encode('utf-8')).hexdigest(),
        'inventories': summaries,
        'inventoryEvidenceSha256': inventoryDigests,
        'diagnosticEvidenceSha256': diagnosticDigests,
        'originalFailedComparison': {
            'sha256': originalDigest, 'passed': False,
            'mismatches': original.get('mismatches'),
        },
        'invalidatedAttempt': {
            'sha256': invalidation.get('invalidatedEvidenceSha256'),
            'invalidationEvidenceSha256': sha256File(invalidationEvidence)[0],
            'reasonCode': invalidation.get('reasonCode'),
        },
        'finishedAtUtc': utcNow(),
    }
    authenticate(payload, proofKey)
    writeJsonAtomic(output, payload)
    return payload


def hmacCompare(left, right):
    """兼容 Python 3.6 的常量时间字符串比较。"""
    import hmac
    return isinstance(right, str) and hmac.compare_digest(left, right)


def loadSchemaDiagnostic(path):
    """读取直接 JSON 或 Sequelize 单行查询包装后的 schema 诊断。"""
    try:
        payload = json.loads(Path(path).read_text(encoding='utf-8'))
    except (OSError, ValueError):
        raise BackupError('SCHEMA_DIAGNOSTIC_INVALID')
    if (isinstance(payload, list) and len(payload) == 1
            and isinstance(payload[0], dict)
            and isinstance(payload[0].get('json_build_object'), dict)):
        payload = payload[0]['json_build_object']
    return validateSchemaDiagnostic(payload)


def compareValidationEvidence(sourceEvidence, restoreEvidence, output,
                              schemaRoundtripEvidence=None,
                              sourceSchemaDiagnostic=None,
                              sourceDefinitions=None, restoreDefinitions=None,
                              proofKey=None, nativeSchemaEvidence=None):
    """比较同快照源摘要与完整恢复摘要，任何业务差异都失败关闭。"""
    require(not Path(output).exists(), 'EVIDENCE_ALREADY_EXISTS')
    try:
        source = json.loads(Path(sourceEvidence).read_text(encoding='utf-8'))
        restored = json.loads(Path(restoreEvidence).read_text(encoding='utf-8'))
    except (OSError, ValueError):
        raise BackupError('VALIDATION_EVIDENCE_INVALID')
    require(source.get('completeBusinessBackup') is True
            and restored.get('kind') == 'apple-order-mgr-database-restore'
            and restored.get('completeRestore') is True,
            'VALIDATION_EVIDENCE_INVALID')
    sourceValidation = source.get('sameSnapshotValidation', {})
    restoreValidation = restored.get('validation', {})
    validateDatabaseFingerprint(sourceValidation)
    validateDatabaseFingerprint(restoreValidation)
    fields = ('validationVersion', 'businessTableCount', 'businessTables',
              'migrationDigest', 'migrationCount', 'excludedTableData')
    mismatches = [field for field in fields
                  if sourceValidation.get(field) != restoreValidation.get(field)]
    rawSchemaMismatch = (sourceValidation.get('schemaDigest')
                         != restoreValidation.get('schemaDigest'))
    schemaComparison = None
    roundtripInputs = (schemaRoundtripEvidence, sourceSchemaDiagnostic,
                       sourceDefinitions, restoreDefinitions)
    if any(value is not None for value in roundtripInputs):
        raise BackupError('SCHEMA_REGEX_COMPARISON_RETIRED')
    if nativeSchemaEvidence is not None:
        require(isinstance(proofKey, bytes) and len(proofKey) >= 32,
                'RESTORE_PROOF_KEY')
        native = readAuthenticatedDocument(
            nativeSchemaEvidence, proofKey,
            'apple-order-mgr-native-schema-proof',
            'SCHEMA_NATIVE_EVIDENCE_INVALID')
        require(native.get('businessDumpSha256')
                == source.get('dump', {}).get('sha256')
                == restored.get('dump', {}).get('sha256')
                and native.get('sourceRawSchemaDigest')
                == sourceValidation.get('schemaDigest')
                and native.get('canonicalSchemaDigest')
                == restoreValidation.get('schemaDigest')
                and native.get('sourceBeforeAfterExact') is True
                and native.get('inventoryExactAcrossThreeRestores') is True
                and native.get('diagnosticExactAcrossThreeRestores') is True
                and native.get('canonicalSqlExactAcrossThreeRestores') is True
                and native.get('containers', {}).get('fullRestore', {}).get(
                    'containerId') == restored.get('containerId'),
                'SCHEMA_NATIVE_EVIDENCE_INVALID')
        schemaComparison = {
            'passed': True,
            'method': native.get('method'),
            'sourceRawSchemaDigest': sourceValidation.get('schemaDigest'),
            'restoreCanonicalSchemaDigest': restoreValidation.get('schemaDigest'),
            'rawSourceRestoreMismatchPreserved': rawSchemaMismatch,
            'inventoryExactAcrossThreeRestores': True,
            'canonicalSqlExactAcrossThreeRestores': True,
            'nativeEvidenceDigest': hashlib.sha256(
                canonicalBytes(native)).hexdigest(),
        }
    elif rawSchemaMismatch:
        mismatches.append('schemaDigest')
    payload = {
        'passed': not mismatches,
        'kind': 'apple-order-mgr-database-restore-comparison',
        'sourceSnapshotId': source.get('snapshotId'),
        'sourceValidationDigest': hashlib.sha256(
            canonicalBytes(sourceValidation)).hexdigest(),
        'restoreValidationDigest': hashlib.sha256(
            canonicalBytes(restoreValidation)).hexdigest(),
        'comparedFields': list(fields) + ['schema'],
        'mismatches': mismatches,
        'rawSourceRestoreMismatches': (
            ['schemaDigest'] if rawSchemaMismatch else []),
        'schemaComparison': schemaComparison,
        'sequenceValidation': {
            'sourceSnapshotAligned': False,
            'restoreSafetyPassed': restoreValidation.get('sequenceSafetyPassed'),
            'restoredStateDigest': hashlib.sha256(canonicalBytes(
                restoreValidation.get('sequenceStates', {}))).hexdigest(),
        },
        'finishedAtUtc': utcNow(),
    }
    writeJsonAtomic(output, payload)
    require(not mismatches, 'DATABASE_RESTORE_MISMATCH')
    return payload


def parseCommand(value):
    """解析 CLI 中的 JSON argv 数组。"""
    try:
        command = json.loads(value)
    except ValueError:
        raise BackupError('COMMAND_INVALID')
    require(isinstance(command, list) and command
            and all(isinstance(item, str) and item for item in command),
            'COMMAND_INVALID')
    return command


def main():
    """命令行只输出摘要与固定错误码。"""
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command')
    backup = sub.add_parser('database-backup')
    backup.add_argument('--database', required=True)
    backup.add_argument('--output', required=True)
    backup.add_argument('--validation-sql', required=True)
    backup.add_argument('--evidence', required=True)
    backup.add_argument('--pg-dump', default='pg_dump')
    backup.add_argument('--psql', default='psql')
    schemaSource = sub.add_parser('schema-source-archive')
    schemaSource.add_argument('--database', required=True)
    schemaSource.add_argument('--output', required=True)
    schemaSource.add_argument('--schema-sql', required=True)
    schemaSource.add_argument('--evidence', required=True)
    schemaSource.add_argument('--expected-schema-digest', required=True)
    schemaSource.add_argument('--business-dump-sha256', required=True)
    schemaSource.add_argument('--proof-key-file', required=True)
    schemaSource.add_argument('--pg-dump', default='pg_dump')
    schemaSource.add_argument('--pg-restore', default='pg_restore')
    schemaSource.add_argument('--psql', default='psql')
    restore = sub.add_parser('database-restore')
    restore.add_argument('--dump', required=True)
    restore.add_argument('--sha256', required=True)
    restore.add_argument('--target-database', required=True)
    restore.add_argument('--isolation-proof', required=True)
    restore.add_argument('--validation-sql', required=True)
    restore.add_argument('--evidence', required=True)
    restore.add_argument('--pg-restore', default='pg_restore')
    restore.add_argument('--psql', default='psql')
    restore.add_argument('--jobs', type=int, default=2)
    restore.add_argument('--migration-command-json')
    restore.add_argument('--proof-key-file', required=True)
    restore.add_argument('--docker', default='docker')
    restore.add_argument('--container-dump-path', required=True)
    schemaRoundtrip = sub.add_parser('schema-roundtrip')
    schemaRoundtrip.add_argument('--dump', required=True)
    schemaRoundtrip.add_argument('--sha256', required=True)
    schemaRoundtrip.add_argument('--target-database', required=True)
    schemaRoundtrip.add_argument('--isolation-proof', required=True)
    schemaRoundtrip.add_argument('--schema-sql', required=True)
    schemaRoundtrip.add_argument('--full-restore-evidence', required=True)
    schemaRoundtrip.add_argument('--evidence', required=True)
    schemaRoundtrip.add_argument('--proof-key-file', required=True)
    schemaRoundtrip.add_argument('--pg-restore', default='pg_restore')
    schemaRoundtrip.add_argument('--psql', default='psql')
    schemaRoundtrip.add_argument('--docker', default='docker')
    schemaRoundtrip.add_argument('--container-dump-path', required=True)
    nativeSchema = sub.add_parser('schema-native-proof')
    nativeSchema.add_argument('--source-schema-archive', required=True)
    nativeSchema.add_argument('--source-schema-evidence', required=True)
    nativeSchema.add_argument('--reference-database', required=True)
    nativeSchema.add_argument('--reference-isolation-proof', required=True)
    nativeSchema.add_argument('--reference-container-archive-path', required=True)
    nativeSchema.add_argument('--business-roundtrip-evidence', required=True)
    nativeSchema.add_argument('--full-restore-evidence', required=True)
    nativeSchema.add_argument('--schema-sql', required=True)
    nativeSchema.add_argument('--inventory-sql', required=True)
    nativeSchema.add_argument('--original-comparison', required=True)
    nativeSchema.add_argument('--invalidation-evidence', required=True)
    nativeSchema.add_argument('--schema-sql-output-dir', required=True)
    nativeSchema.add_argument('--output', required=True)
    nativeSchema.add_argument('--proof-key-file', required=True)
    nativeSchema.add_argument('--pg-restore', default='pg_restore')
    nativeSchema.add_argument('--psql', default='psql')
    nativeSchema.add_argument('--docker', default='docker')
    nativeSchema.add_argument('--schema-dump-client-image',
                              default='postgres:15.18-alpine')
    isolation = sub.add_parser('isolation-proof')
    isolation.add_argument('--container', required=True)
    isolation.add_argument('--target-database', required=True)
    isolation.add_argument('--source-database', required=True)
    isolation.add_argument('--output', required=True)
    isolation.add_argument('--proof-key-file', required=True)
    isolation.add_argument('--docker', default='docker')
    isolation.add_argument('--database-user', default='postgres')
    stream = sub.add_parser('stream-copy')
    stream.add_argument('--command-json', action='append', required=True)
    stream.add_argument('--output', required=True)
    compare = sub.add_parser('compare-validations')
    compare.add_argument('--source-evidence', required=True)
    compare.add_argument('--restore-evidence', required=True)
    compare.add_argument('--output', required=True)
    compare.add_argument('--schema-roundtrip-evidence')
    compare.add_argument('--source-schema-diagnostic')
    compare.add_argument('--source-definitions')
    compare.add_argument('--restore-definitions')
    compare.add_argument('--native-schema-evidence')
    compare.add_argument('--proof-key-file')
    args = parser.parse_args()
    try:
        require(args.command is not None, 'COMMAND_REQUIRED')
        if args.command == 'database-backup':
            result = createDatabaseBackup(
                args.database, args.output, args.validation_sql, args.evidence,
                args.pg_dump, args.psql)
        elif args.command == 'schema-source-archive':
            document = createSourceSchemaArchive(
                args.database, args.output, args.schema_sql, args.evidence,
                args.expected_schema_digest, args.business_dump_sha256,
                readProofKey(args.proof_key_file), args.pg_dump,
                args.pg_restore, args.psql)
            result = {
                'passed': True,
                'sha256': document['archive']['sha256'],
                'bytes': document['archive']['size'],
                'rawSchemaDigest': schemaDigestFromDiagnostic(
                    document['afterDiagnostic']),
            }
        elif args.command == 'database-restore':
            migration = (parseCommand(args.migration_command_json)
                         if args.migration_command_json else None)
            result = restoreDatabaseBackup(
                args.dump, args.sha256, args.target_database, args.isolation_proof,
                args.validation_sql, args.evidence, args.pg_restore, args.psql,
                args.jobs, migrationCommand=migration,
                proofKey=readProofKey(args.proof_key_file), docker=args.docker,
                containerDumpPath=args.container_dump_path)
        elif args.command == 'isolation-proof':
            result = createIsolationProof(
                args.container, args.target_database, args.source_database,
                args.output, readProofKey(args.proof_key_file), args.docker,
                args.database_user)
        elif args.command == 'schema-roundtrip':
            result = createSchemaRoundtripEvidence(
                args.dump, args.sha256, args.target_database,
                args.isolation_proof, args.schema_sql,
                args.full_restore_evidence, args.evidence,
                readProofKey(args.proof_key_file), args.pg_restore, args.psql,
                args.docker, args.container_dump_path)
        elif args.command == 'schema-native-proof':
            result = createNativeSchemaEvidence(
                args.source_schema_archive, args.source_schema_evidence,
                args.reference_database, args.reference_isolation_proof,
                args.reference_container_archive_path,
                args.business_roundtrip_evidence, args.full_restore_evidence,
                args.schema_sql, args.inventory_sql, args.original_comparison,
                args.invalidation_evidence, args.schema_sql_output_dir,
                args.output,
                readProofKey(args.proof_key_file), args.pg_restore, args.psql,
                args.docker, args.schema_dump_client_image)
        elif args.command == 'compare-validations':
            result = compareValidationEvidence(
                args.source_evidence, args.restore_evidence, args.output,
                args.schema_roundtrip_evidence, args.source_schema_diagnostic,
                args.source_definitions, args.restore_definitions,
                (readProofKey(args.proof_key_file)
                 if args.proof_key_file else None), args.native_schema_evidence)
        else:
            result = runCheckedPipeline(
                [parseCommand(value) for value in args.command_json], args.output)
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
        return 0
    except Exception as error:
        code = error.code if isinstance(error, BackupError) else 'BACKUP_FAILED'
        print(json.dumps({'passed': False, 'code': code}, sort_keys=True))
        return 1


if __name__ == '__main__':
    sys.exit(main())
