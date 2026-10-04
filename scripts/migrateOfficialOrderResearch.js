const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { readPrivate } = require('../src/services/officialOrderSupport');

const CLI_ARGUMENT_OFFSET = 2;

/** 显式迁移专用研究库；采集器启动时不建表、不 alter，不访问业务库。 */
async function main() {
  let client;
  try {
    const root = process.argv[CLI_ARGUMENT_OFFSET];
    if (!root || !path.isAbsolute(root)) throw new Error('ROOT_INVALID');
    const config = readPrivate(`${root}/private/db.json`);
    if (
      config.host !== 'apple-account-research-db' ||
      config.database !== 'apple_account_research'
    ) {
      throw new Error('ISOLATED_DATABASE_REQUIRED');
    }
    client = new Client(config);
    await client.connect();
    await client.query('BEGIN');
    await client.query(`CREATE TABLE IF NOT EXISTS collector_migrations
      (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const existing = await client.query('SELECT version FROM collector_migrations WHERE version=1');
    if (!existing.rows.length) {
      const sql = fs.readFileSync(
        path.join(__dirname, 'officialOrder/migrations/001-initialize.sql'),
        'utf8'
      );
      await client.query(sql);
      await client.query('INSERT INTO collector_migrations(version) VALUES(1)');
    }
    await client.query('COMMIT');
    process.stdout.write(`${JSON.stringify({ migration: 1, applied: !existing.rows.length })}\n`);
  } catch (_error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    process.stderr.write('RESEARCH_MIGRATION_FAILED\n');
    process.exitCode = 1;
  } finally {
    if (client) await client.end().catch(() => {});
  }
}

main();
