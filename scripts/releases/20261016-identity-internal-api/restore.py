"""本地隔离恢复；不访问生产数据库、不开端口、不恢复 AOS 日志数据。"""
import argparse
import json
import time
import tarfile
from pathlib import Path
from common import config, database_snapshot, hashes, read_json, run, sha, write_json


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('config')
    parser.add_argument('backup')
    args = parser.parse_args()
    c, backup = config(args.config), Path(args.backup).resolve()
    manifest = read_json(backup / 'backup-manifest.json')
    for name, digest in manifest['files'].items():
        assert sha(backup / name) == digest, 'BACKUP_CHECKSUM_MISMATCH'
    name, database = 'identity-internal-api-release-restore', 'identity_internal_api_release_restore'
    run(['docker', 'run', '-d', '--name', name, '--network', 'none', '--memory', '1g', '--cpus', '1', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '-e', 'POSTGRES_DB=' + database, c['restorePostgresImage']], stdout=None)
    ready = False
    import subprocess
    for _ in range(40):
        if subprocess.call(['docker', 'exec', name, 'pg_isready', '-U', 'postgres', '-d', database], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) == 0:
            ready = True
            break
        time.sleep(1)
    assert ready, 'RESTORE_DATABASE_UNAVAILABLE'
    with (backup / 'business.dump').open('rb') as dump, (backup / 'restore.log').open('wb') as log:
        subprocess.run(['docker', 'exec', '-i', name, 'pg_restore', '--exit-on-error', '--no-owner', '--no-privileges', '-U', 'postgres', '-d', database], stdin=dump, stdout=log, stderr=log, check=True)
    command = ['docker', 'exec', name, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', database]
    restored = database_snapshot(command)
    assert restored == read_json(backup / 'production-snapshot.json'), 'RESTORED_BUSINESS_DATA_MISMATCH'
    files_restore = backup / 'business-files-restored'
    files_restore.mkdir(exist_ok=False)
    with tarfile.open(backup / 'business-files.tar.gz') as archive:
        for member in archive.getmembers():
            assert (files_restore / member.name).resolve().is_relative_to(files_restore.resolve())
            assert not member.issym() and not member.islnk()
        archive.extractall(files_restore, filter='data')
    assert hashes(files_restore) == read_json(backup / 'business-file-hashes.json'), 'BUSINESS_FILE_RESTORE_MISMATCH'
    write_json(backup / 'restored-snapshot.json', restored)
    print(json.dumps({'restored': True, 'tablesMatched': len(restored['tables']), 'migrationsMatched': len(restored['migrations'])}))


if __name__ == '__main__':
    main()
