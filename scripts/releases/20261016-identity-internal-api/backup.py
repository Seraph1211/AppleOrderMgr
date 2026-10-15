"""服务器备份；须核准配置和原始日志目录，生产迁移之前执行。"""
import argparse
import json
import re
import subprocess
from pathlib import Path
from common import EXCLUDED_LOG_DATA, assert_current, capture, config, database_snapshot, psql, read_inspect, run, safe_container, server_paths, sha, write_json


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('config')
    args = parser.parse_args()
    c = config(args.config)
    assert c['backupInventoryApproved'] is True, 'BUSINESS_FILE_INVENTORY_NOT_APPROVED'
    assert_current(c)
    root, old, _, backup = server_paths(c)
    backup.mkdir(mode=0o700, exist_ok=False)
    names = capture(['docker', 'ps', '--format', '{{.Names}}']).splitlines()
    write_json(backup / 'containers-before.json', [safe_container(read_inspect(n)) for n in names])
    (backup / 'nginx.conf').write_bytes(Path(c['nginxSite']).read_bytes())
    write_json(backup / 'shared-env-hashes.json', {str(p): sha(p) for p in (root / 'shared').glob('*.env')})
    run(['tar', '-czf', str(backup / 'deployment-files.tar.gz'), '-C', str(old), '.'])
    exclusions = []
    for raw_path in c['aosRawPaths']:
        path = Path(raw_path)
        assert path.is_absolute() and root in path.parents and path != root
        exclusions.append('--exclude=' + str(path).lstrip('/'))
        exclusions.append('--exclude=' + str(path).lstrip('/') + '/**')
    business_paths = [Path(p) for p in c['businessPaths']]
    assert business_paths and all(p.is_absolute() and p.exists() for p in business_paths)
    assert root / 'shared' not in business_paths, 'SELECT_BUSINESS_PATHS_DO_NOT_ARCHIVE_ALL_SHARED'
    business_hashes = {}
    excluded = [Path(path) for path in c['aosRawPaths']]
    for source in business_paths:
        files = [source] if source.is_file() else source.rglob('*')
        for item in files:
            assert not item.is_symlink(), 'BUSINESS_BACKUP_SYMLINK_REQUIRES_REVIEW'
            if item.is_file() and not any(item == raw or item.is_relative_to(raw) for raw in excluded):
                business_hashes[str(item).lstrip('/')] = sha(item)
    write_json(backup / 'business-file-hashes.json', business_hashes)
    # 使用经核准清单备份共享业务文件，排除明确的原始 AOS 日志目录；不读取或输出内容。
    run(['tar', '-czf', str(backup / 'business-files.tar.gz')] + exclusions + ['-C', '/'] + [str(p).lstrip('/') for p in business_paths])
    write_json(backup / 'backup-scope.json', {'businessPaths': c['businessPaths'], 'aosRawPathsExcluded': c['aosRawPaths'], 'excludedTableData': EXCLUDED_LOG_DATA})
    owner = subprocess.Popen(psql(c['database']), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    owner.stdin.write('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SELECT pg_export_snapshot();\n')
    owner.stdin.flush()
    snapshot = owner.stdout.readline().strip()
    assert re.fullmatch(r'[0-9A-F-]+', snapshot), 'SNAPSHOT_EXPORT_FAILED'
    try:
        report = database_snapshot(psql(c['database']), snapshot=snapshot)
        write_json(backup / 'production-snapshot.json', report)
        with (backup / 'business.dump').open('wb') as output:
            run(['runuser', '-u', 'postgres', '--', 'pg_dump', '-Fc', '--snapshot=' + snapshot] + ['--exclude-table-data=' + p for p in EXCLUDED_LOG_DATA] + [c['database']], stdout=output)
        write_json(backup / 'backup-manifest.json', {'files': {name: sha(backup / name) for name in ['business.dump', 'deployment-files.tar.gz', 'business-files.tar.gz', 'business-file-hashes.json', 'nginx.conf']}, 'baselineRelease': c['baselineRelease'], 'baselineApiImage': c['baselineImages']['api']['id']})
        print(json.dumps({'backupComplete': True, 'businessTables': len(report['tables']), 'aosLogDataExcluded': True}))
    finally:
        owner.stdin.write('ROLLBACK;\n')
        owner.stdin.flush()
        owner.stdin.close()
        owner.wait(timeout=20)


if __name__ == '__main__':
    main()
