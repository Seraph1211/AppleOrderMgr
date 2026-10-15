"""在已验证的隔离恢复库演练唯一迁移；所有旧业务列和历史须保持。"""
import argparse
import json
from pathlib import Path
from common import MIGRATION, NEW_TABLES, capture, config, database_snapshot, log_run, read_json, write_json


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('config')
    parser.add_argument('backup')
    args = parser.parse_args()
    c, backup = config(args.config), Path(args.backup).resolve()
    before = read_json(backup / 'restored-snapshot.json')
    assert before == read_json(backup / 'production-snapshot.json'), 'RESTORE_NOT_VERIFIED'
    assert MIGRATION not in before['migrations']
    name, database = 'identity-internal-api-release-restore', 'identity_internal_api_release_restore'
    command = ['docker', 'exec', name, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', database]
    migration = ['docker', 'run', '--rm', '--platform', 'linux/amd64', '--network', 'container:' + name, '-e', 'DB_HOST=127.0.0.1', '-e', 'DB_PORT=5432', '-e', 'DB_NAME=' + database, '-e', 'DB_USER=postgres', '-e', 'DB_SSL=false', '-e', 'NODE_ENV=production', c['images']['migrator'], 'npx', 'sequelize-cli', 'db:migrate']
    log_run(migration, backup / 'rehearsal-migration.log')
    after = database_snapshot(command, omit_batch_token=True)
    assert set(after['migrations']) - set(before['migrations']) == {MIGRATION}
    assert set(before['migrations']) <= set(after['migrations'])
    for name, expected in before['tables'].items():
        if name != 'public.SequelizeMeta':
            assert after['tables'][name] == expected, 'OLD_BUSINESS_DATA_CHANGED:' + name
    new = set(after['tables']) - set(before['tables'])
    assert new == {'public.' + table for table in NEW_TABLES}
    for table in NEW_TABLES:
        assert after['tables']['public.' + table]['count'] == (1 if table == 'identity_service_state' else 0)
    state = capture(command + ['-c', "SELECT paused::text||':'||coalesce(pause_reason,'') FROM identity_service_state WHERE id=1"])
    assert state == 'false:'
    assert capture(command + ['-c', 'SELECT count(*) FROM identity_verification_batches WHERE api_token_id IS NOT NULL']) == '0'
    # 演练不触发provider，也不写入合成令牌或真实身份；保留库供独立验收。
    write_json(backup / 'rehearsal-after.json', after)
    write_json(backup / 'rehearsal-result.json', {'migrationPassed': True, 'migration': MIGRATION, 'backupDumpSha256': read_json(backup / 'backup-manifest.json')['files']['business.dump'], 'protectedTablesMatched': len(before['tables']) - 1, 'newTables': sorted(new), 'oldIdentityBatchColumnsPreserved': True, 'providerCalled': False})
    print(json.dumps({'migrationPassed': True, 'protectedTablesMatched': len(before['tables']) - 1}))


if __name__ == '__main__':
    main()
