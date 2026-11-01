/* eslint-disable no-magic-numbers -- 专用测试库版本与超时边界。 */
const { Client } = require('pg');
const { encrypt, decrypt } = require('../src/utils/fieldEncryption');

/** 检查发布回归测试依赖；仅使用测试专用账号和事务临时表。 */
async function main() {
  let client;
  try {
    if (process.env.NODE_ENV !== 'test' || !process.env.RELEASE_TEST_PGHOST) {
      throw new Error('RELEASE_TEST_ENV_REQUIRED');
    }
    if (decrypt(encrypt('release-test-only')) !== 'release-test-only') {
      throw new Error('RELEASE_TEST_KEY_INVALID');
    }
    client = new Client({
      host: process.env.RELEASE_TEST_PGHOST,
      port: Number(process.env.RELEASE_TEST_PGPORT || 5432),
      user: 'postgres',
      password: 'test-only',
      database: 'postgres',
      connectionTimeoutMillis: 5000,
      // eslint-disable-next-line camelcase -- node-postgres 的配置名称。
      query_timeout: 5000,
    });
    await client.connect();
    await client.query('BEGIN');
    const result = await client.query("SELECT current_setting('server_version_num') AS version");
    if (Number(result.rows[0].version) < 150000) {
      throw new Error('RELEASE_TEST_PG_VERSION');
    }
    await client.query('CREATE TEMP TABLE release_environment_probe(id integer) ON COMMIT DROP');
    await client.query('INSERT INTO release_environment_probe VALUES (1)');
    await client.query('ROLLBACK');
    process.stdout.write('{"passed":true,"check":"release-test-environment"}\n');
  } catch (_error) {
    process.stderr.write('{"passed":false,"code":"RELEASE_TEST_ENV_FAILED"}\n');
    process.exitCode = 1;
  } finally {
    if (client) {
      try {
        await client.end();
      } catch (_error) {
        process.exitCode = 1;
      }
    }
  }
}

main();
