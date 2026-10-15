"""服务器正式切换；只更新API、静态前端和本站点Nginx，迁移仅up。"""
import argparse
import json
import os
import stat
import time
import urllib.request
from pathlib import Path
from common import MIGRATION, assert_current, assert_identity_idle, capture, compose, config, hashes, identity_activity, identity_is_idle, log_run, protected_identity_snapshot, psql, read_inspect, read_json, safe_container, server_paths, sha, write_json


def atomic_site(path, content):
    metadata = path.stat()
    temporary = path.with_name(path.name + '.identity-next')
    with temporary.open('xb') as output:
        output.write(content)
        output.flush()
        os.fsync(output.fileno())
    os.chmod(temporary, stat.S_IMODE(metadata.st_mode))
    os.chown(temporary, metadata.st_uid, metadata.st_gid)
    os.replace(temporary, path)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('config')
    args = parser.parse_args()
    c = config(args.config)
    api_before = safe_container(assert_current(c))
    root, old, new, backup = server_paths(c)
    manifest = read_json(new / 'artifact-manifest.json')
    preflight = read_json(backup / 'candidate-preflight.json')
    rehearsal = read_json(backup / 'rehearsal-result.json')
    source = read_json(backup / 'production-snapshot.json')
    assert source == read_json(backup / 'restored-snapshot.json'), 'RESTORE_NOT_VERIFIED'
    assert rehearsal['migrationPassed'] and rehearsal['migration'] == MIGRATION
    assert rehearsal['backupDumpSha256'] == sha(backup / 'business.dump')
    assert manifest['commit'] == c['approvedCommit'] == preflight['commit']
    assert preflight['nginxCandidateTestPassed'] is True
    site = Path(c['nginxSite'])
    assert sha(site) == preflight['nginxBaselineSha256'] == sha(backup / 'nginx.conf'), 'NGINX_BASELINE_DRIFT'
    assert sha(new / 'nginx-candidate.conf') == preflight['nginxCandidateSha256']
    assert hashes(new / 'frontend') == manifest['frontend']
    for path, expected in read_json(backup / 'shared-env-hashes.json').items():
        assert sha(path) == expected, 'SHARED_ENV_DRIFT'
    baseline = read_json(backup / 'containers-before.json')
    for previous in baseline:
        current = safe_container(read_inspect(previous['id']))
        assert current == previous, 'CONTAINER_DRIFT_BEFORE_CUTOVER'
    def query(sql): return capture(psql(c['database']) + ['-c', sql])
    migrations = json.loads(query('SELECT json_agg(name ORDER BY name) FROM "SequelizeMeta"'))
    assert migrations == source['migrations'] and MIGRATION not in migrations, 'PRODUCTION_MIGRATION_DRIFT'
    # 只读preflight必须没有活动任务；保留暂停/预览pending，避免重启中断计费调用。
    activity_before = identity_activity(psql(c['database']))
    write_json(backup / 'identity-activity-preflight.json', activity_before)
    assert_identity_idle(activity_before)
    protected_before = protected_identity_snapshot(psql(c['database']))
    write_json(backup / 'protected-business-before.json', protected_before)
    assert_identity_idle(protected_before['activity'])
    # migrations以预先演练的唯一新增为准；不执行down，不清除审计或用量。
    log_run(compose(new) + ['--profile', 'tools', 'run', '--interactive=false', '-T', '--rm', 'migrate'], backup / 'production-migration.log', cwd=new)
    actual = json.loads(query('SELECT json_agg(name ORDER BY name) FROM "SequelizeMeta"'))
    assert set(actual) == set(migrations) | {MIGRATION}, 'UNEXPECTED_MIGRATIONS'
    assert query('SELECT count(*) FROM identity_service_state WHERE id=1 AND NOT paused') == '1'
    protected_after = protected_identity_snapshot(psql(c['database']))
    write_json(backup / 'protected-business-after.json', protected_after)
    protected_evidence = {
        'migration': MIGRATION,
        'beforeSha256': sha(backup / 'protected-business-before.json'),
        'afterSha256': sha(backup / 'protected-business-after.json'),
        'tablesMatched': protected_before['tables'] == protected_after['tables'],
        'tasksIdleBefore': identity_is_idle(protected_before['activity']),
        'tasksIdleAfter': identity_is_idle(protected_after['activity']),
        'protectedTables': sorted(protected_before['tables']),
    }
    write_json(backup / 'protected-business-check.json', protected_evidence)
    assert protected_evidence['tablesMatched'], 'PROTECTED_BUSINESS_DATA_CHANGED_STOP_CUTOVER'
    assert_identity_idle(protected_after['activity'])
    nginx_published = False
    api_update_attempted = False
    try:
        # 隔离nginx -t已通过；原子替换后再次检查，失败立即恢复原文件，绝不reload坏配置。
        atomic_site(site, (new / 'nginx-candidate.conf').read_bytes())
        try:
            log_run(['nginx', '-t'], backup / 'nginx-live-test.log')
            log_run(['systemctl', 'reload', 'nginx'], backup / 'nginx-reload.log')
            nginx_published = True
        except Exception:
            atomic_site(site, (backup / 'nginx.conf').read_bytes())
            log_run(['nginx', '-t'], backup / 'nginx-restored-test.log')
            log_run(['systemctl', 'reload', 'nginx'], backup / 'nginx-restored-reload.log')
            raise
        os.chmod(new, 0o755)
        for path in (new / 'frontend').rglob('*'):
            os.chmod(path, 0o755 if path.is_dir() else 0o644)
        os.chmod(new / 'frontend', 0o755)
        for name in ['release.env', 'images.override.yml']:
            os.chmod(new / name, 0o600)
        # Nginx发布期间若新任务到达也停止；未尝试更新API时异常分支不得重启旧API。
        activity_cutover = identity_activity(psql(c['database']))
        write_json(backup / 'identity-activity-cutover.json', activity_cutover)
        assert_identity_idle(activity_cutover)
        api_update_attempted = True
        log_run(compose(new) + ['up', '-d', '--no-deps', 'api'], backup / 'api-cutover.log', cwd=new)
        for _ in range(30):
            api = read_inspect(c['apiContainer'])
            if api['State'].get('Health', {}).get('Status') == 'healthy': break
            time.sleep(2)
        else: raise RuntimeError('API_NOT_HEALTHY')
        assert api['Image'] == manifest['imageIds']['api'], 'RUNNING_IMAGE_MISMATCH'
        now = safe_container(api)
        for key in ['envDigest', 'runtime', 'host']:
            assert now[key] == api_before[key], 'API_RUNTIME_CONFIGURATION_CHANGED'
        assert urllib.request.urlopen(c['apiReadyUrl'], timeout=10).status == 200
        for previous in baseline:
            if previous['name'] != api_before['name']:
                assert safe_container(read_inspect(previous['id'])) == previous, 'OTHER_CONTAINER_RESTARTED'
        next_pointer = root / ('current.' + c['release'] + '-next')
        next_pointer.symlink_to(new)
        os.replace(next_pointer, root / 'current')
    except Exception:
        # 代码回退保留新增结构及审计。已发布的安全Nginx保留，避免已复制令牌再次进入旧查询日志。
        if api_update_attempted:
            log_run(compose(old) + ['up', '-d', '--no-deps', 'api'], backup / 'api-rollback.log', cwd=old)
        if (root / 'current').resolve() != old:
            rollback = root / ('current.' + c['release'] + '-rollback')
            rollback.symlink_to(old)
            os.replace(rollback, root / 'current')
        write_json(backup / 'cutover-failure.json', {'apiRolledBack': api_update_attempted, 'schemaPreserved': True, 'secureNginxRetained': nginx_published, 'requiresIndependentReadback': True})
        raise
    write_json(backup / 'production-cutover.json', {'release': c['release'], 'commit': manifest['commit'], 'apiHealthy': True, 'nginxSha256': sha(site), 'nginxReloaded': True, 'migration': MIGRATION, 'otherContainersUnchanged': len(baseline) - 1, 'current': str(new), 'providerCalled': False, 'protectedBusinessTablesMatched': len(protected_before['tables']), 'protectedEvidenceSha256': sha(backup / 'protected-business-check.json')})
    print(json.dumps({'deployed': True, 'release': c['release'], 'independentReadbackRequired': True}))


if __name__ == '__main__':
    main()
