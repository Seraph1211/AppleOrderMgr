"""发布脚本共用工具；仅在显式调用入口时执行操作。"""
import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path

RELEASE_DIR = 'scripts/releases/20261016-identity-internal-api'
MIGRATION = '20261016000002-add-identity-internal-api.js'
EXCLUDED_LOG_DATA = [
    'public.monitor_log_entries', 'public.monitor_log_entries_*',
    'public.monitor_log_files', 'public.monitor_log_blocks', 'public.monitor_log_blocks_*',
    'public.monitor_log_block_accounts', 'public.monitor_log_block_accounts_*',
    'public.monitor_log_receipts',
]
NEW_TABLES = ['identity_api_tokens', 'identity_api_usage', 'identity_service_state', 'identity_api_dedup', 'identity_api_events']
assert sys.version_info >= (3, 11), 'REQUIRES_PYTHON_3_11'
os.umask(0o077)


def run(args, **kwargs):
    return subprocess.run(args, check=True, stdin=subprocess.DEVNULL, **kwargs)


def capture(args, **kwargs):
    return subprocess.check_output(args, text=True, **kwargs).strip()


def read_json(path):
    return json.loads(Path(path).read_text())


def write_json(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def sha(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def hashes(path):
    return {str(p.relative_to(path)): sha(p) for p in Path(path).rglob('*') if p.is_file()}


def config(path):
    c = read_json(path)
    assert c['approved'] is True, 'RELEASE_CONFIGURATION_NOT_APPROVED'
    for key in ['approvedCommit', 'baselineCommit']:
        assert re.fullmatch(r'[a-f0-9]{40}', c[key] or ''), key
    for service in ['api', 'migrator', 'frontend']:
        assert re.fullmatch(r'sha256:[a-f0-9]{64}', c['baselineImages'][service]['localId'] or ''), service
        if service != 'frontend':
            assert re.fullmatch(r'sha256:[a-f0-9]{64}', c['baselineImages'][service]['id'] or ''), service
    for key in ['release', 'baselineRelease']:
        assert re.fullmatch(r'[a-z0-9-]+', c[key]), key
    assert c['release'] != c['baselineRelease']
    assert re.fullmatch(r'[a-zA-Z0-9_]+', c['database'])
    return c


def server_paths(c):
    root = Path(c['root'])
    return root, root / 'releases' / c['baselineRelease'], root / 'releases' / c['release'], Path(c['backupRoot']) / c['release']


def assert_current(c):
    root, old, _, _ = server_paths(c)
    assert (root / 'current').resolve() == old, 'PRODUCTION_RELEASE_DRIFT'
    api = read_inspect(c['apiContainer'])
    assert api['Image'] == c['baselineImages']['api']['id'], 'PRODUCTION_IMAGE_DRIFT'
    return api


def read_inspect(name):
    return json.loads(capture(['docker', 'inspect', name]))[0]


def safe_container(container):
    """仅保存非敏感配置指纹，不输出环境变量明文。"""
    return {'name': container['Name'], 'id': container['Id'], 'image': container['Image'],
            'startedAt': container['State']['StartedAt'],
            'envDigest': hashlib.sha256(json.dumps(sorted(container['Config']['Env'])).encode()).hexdigest(),
            'runtime': {k: container['Config'][k] for k in ['Cmd', 'User', 'WorkingDir']},
            'host': {k: container['HostConfig'][k] for k in ['PortBindings', 'ReadonlyRootfs', 'Binds', 'Memory', 'NanoCpus']}}


def compose(cwd):
    return ['docker', 'compose', '--env-file', 'release.env', '-f', 'docker-compose.prod.yml', '-f', 'images.override.yml']


def log_run(args, path, cwd=None):
    with Path(path).open('w') as log:
        run(args, cwd=cwd, stdout=log, stderr=log)


def psql(database):
    return ['runuser', '-u', 'postgres', '--', 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-d', database]


def database_snapshot(command, snapshot=None, omit_batch_token=False):
    """逐行读取固定长度哈希，禁止聚合完整行或无界结果到内存。"""
    prefix = "SET TIME ZONE 'UTC'; SET work_mem='8MB'; SET statement_timeout='120s'; "
    if snapshot:
        assert re.fullmatch(r'[0-9A-F-]+', snapshot)
        prefix = "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET TRANSACTION SNAPSHOT '" + snapshot + "'; " + prefix
    def query(sql):
        return capture(command + ['-c', prefix + sql + ('; COMMIT' if snapshot else '')])
    names = query("SELECT n.nspname||'.'||c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','archive') AND c.relkind IN ('r','p') AND NOT c.relispartition ORDER BY 1").splitlines()
    result = {'tables': {}, 'migrations': json.loads(query('SELECT coalesce(json_agg(name ORDER BY name),\'[]\') FROM "SequelizeMeta"'))}
    for name in names:
        schema, table = name.split('.')
        assert re.fullmatch(r'[A-Za-z0-9_]+', schema) and re.fullmatch(r'[A-Za-z0-9_]+', table)
        if re.match(r'^monitor_log_(entries($|_)|files$|blocks($|_)|block_accounts($|_)|receipts$)', table):
            continue
        quoted = '"' + schema + '"."' + table + '"'
        expr = "to_jsonb(t)-'api_token_id'" if omit_batch_token and table == 'identity_verification_batches' else 'to_jsonb(t)'
        sql = "SELECT md5((" + expr + ")::text) FROM " + quoted + " t ORDER BY 1"
        process = subprocess.Popen(command + ['-c', prefix + sql + ('; COMMIT' if snapshot else '')], stdout=subprocess.PIPE, text=True)
        h, count = hashlib.sha256(), 0
        for line in process.stdout:
            row_hash = line.strip()
            assert re.fullmatch(r'[a-f0-9]{32}', row_hash), 'UNEXPECTED_SNAPSHOT_OUTPUT'
            h.update(row_hash.encode() + b'\n')
            count += 1
        assert process.wait() == 0, 'SNAPSHOT_QUERY_FAILED'
        result['tables'][name] = {'count': count, 'sha256': h.hexdigest()}
    return result


def archive_image_ids(path):
    """Docker Desktop本地索引ID与服务器config ID可不同，以导出Config字节为准。"""
    import tarfile
    with tarfile.open(path) as archive:
        result = {}
        for entry in json.load(archive.extractfile('manifest.json')):
            digest = 'sha256:' + hashlib.sha256(archive.extractfile(entry['Config']).read()).hexdigest()
            for tag in entry['RepoTags'] or []:
                result[tag] = digest
        return result


PROTECTED_IDENTITY_TABLES = (
    'identity_verification_batches',
    'identity_verification_items',
    'users',
    'user_permissions',
    'user_permission_events',
)


def identity_activity(command, snapshot=None):
    """仅返回任务计数；暂停/预览pending保留，仅活动批次pending属于阻断范围。"""
    prefix = "SET statement_timeout='15s'; "
    if snapshot:
        assert re.fullmatch(r'[0-9A-F-]+', snapshot)
        prefix = "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET TRANSACTION SNAPSHOT '" + snapshot + "'; " + prefix
    sql = """SELECT json_build_object(
        'processingItems', (SELECT count(*) FROM identity_verification_items WHERE status='processing'),
        'pendingItems', (SELECT count(*) FROM identity_verification_items WHERE status='pending'),
        'pendingActiveItems', (SELECT count(*) FROM identity_verification_items i JOIN identity_verification_batches b ON b.id=i.batch_id WHERE i.status='pending' AND b.status IN ('queued','running')),
        'queuedOrRunningBatches', (SELECT count(*) FROM identity_verification_batches WHERE status IN ('queued','running'))
    )"""
    result = json.loads(capture(command + ['-c', prefix + sql + ('; COMMIT' if snapshot else '')]))
    assert set(result) == {'processingItems', 'pendingItems', 'pendingActiveItems', 'queuedOrRunningBatches'}
    assert all(isinstance(value, int) and value >= 0 for value in result.values())
    return result


def identity_is_idle(activity):
    """暂停/草稿批次的pending属于合法历史，不作为活动任务。"""
    keys = ['processingItems', 'pendingActiveItems', 'queuedOrRunningBatches']
    assert all(isinstance(activity[key], int) and activity[key] >= 0 for key in keys)
    return not any(activity[key] for key in keys)


def assert_identity_idle(activity):
    """有活动/处理中任务时停止，禁止通过重启或更改状态清理任务。"""
    assert identity_is_idle(activity), 'IDENTITY_TASKS_NOT_IDLE_STOP_RELEASE'


def protected_identity_snapshot(command):
    """一致性只读快照：数据库逐行返回32位哈希，客户端流式摘要，不返回PII。"""
    from datetime import datetime, timezone
    owner = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=subprocess.DEVNULL, text=True)
    try:
        owner.stdin.write('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SELECT pg_export_snapshot();\n')
        owner.stdin.flush()
        snapshot = owner.stdout.readline().strip()
        assert re.fullmatch(r'[0-9A-F-]+', snapshot), 'PROTECTED_SNAPSHOT_EXPORT_FAILED'
        report = {'capturedAt': datetime.now(timezone.utc).isoformat(), 'tables': {},
                  'activity': identity_activity(command, snapshot=snapshot),
                  'batchColumnsOmitted': ['api_token_id']}
        prefix = "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET TRANSACTION SNAPSHOT '" + snapshot + "'; SET TIME ZONE 'UTC'; SET work_mem='8MB'; SET statement_timeout='120s'; "
        for table in PROTECTED_IDENTITY_TABLES:
            # 排除新增列后，迁移前后比较完全相同的旧列；不调用解密函数。
            expr = "to_jsonb(t)-'api_token_id'" if table == 'identity_verification_batches' else 'to_jsonb(t)'
            sql = 'SELECT md5((' + expr + ')::text) FROM public."' + table + '" t ORDER BY 1'
            process = subprocess.Popen(command + ['-c', prefix + sql + '; COMMIT'],
                                       stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
            count, digest = 0, hashlib.sha256()
            try:
                for line in process.stdout:
                    value = line.strip()
                    assert re.fullmatch(r'[a-f0-9]{32}', value), 'PROTECTED_SNAPSHOT_OUTPUT_INVALID'
                    digest.update(value.encode() + b'\n')
                    count += 1
                assert process.wait() == 0, 'PROTECTED_SNAPSHOT_QUERY_FAILED:' + table
            finally:
                process.stdout.close()
                if process.poll() is None:
                    process.terminate()
                    process.wait(timeout=10)
            report['tables'][table] = {'count': count, 'sha256': digest.hexdigest()}
        return report
    finally:
        if owner.poll() is None:
            try:
                owner.stdin.write('ROLLBACK;\n')
                owner.stdin.flush()
                owner.stdin.close()
                owner.wait(timeout=10)
            except (BrokenPipeError, subprocess.TimeoutExpired):
                owner.terminate()
                owner.wait(timeout=10)
        owner.stdout.close()
