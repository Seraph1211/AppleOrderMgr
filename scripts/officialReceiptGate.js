const { Client } = require('pg');
const {
  readPrivate,
  validateSample,
  fault,
  proxyFingerprint,
  writePrivate,
} = require('../src/services/officialOrderSupport');
const { verifyReceiptEvidence } = require('../src/services/officialReceiptEvidence');

/** 采集调度预检与采后只读 Gate 对账；最终网络准入仍由共享 Gate 决定。 */
async function main() {
  let client;
  try {
    const [mode, root, batchId, requestKey] = process.argv.slice(2);
    if (root !== '/research' || !['preflight', 'snapshot', 'verify'].includes(mode))
      throw fault('RECEIPT_COMMAND_INVALID');
    if (mode === 'verify') {
      const payload = verifyReceiptEvidence(root, { batchId, requestKey });
      writePrivate(`${root}/private/binding.json`, JSON.stringify(payload));
      process.stdout.write(
        JSON.stringify({ outcome: 'RECEIPT_PROOF_VERIFIED', serialCount: payload.items.length }) +
          '\n'
      );
      return;
    }
    const config = readPrivate(`${root}/private/db.json`);
    if (config.host !== 'apple-account-research-db' || config.database !== 'apple_account_research')
      throw fault('ISOLATED_DATABASE_REQUIRED');
    const sample = validateSample(readPrivate(`${root}/private/input.json`).samples[0]);
    client = new Client({
      ...config,
      connectionTimeoutMillis: 10000,
      options: '-c statement_timeout=10000',
    });
    await client.connect();
    await client.query('BEGIN READ ONLY');
    let value;
    if (mode === 'snapshot') {
      const result = readPrivate(`${root}/private/result.json`);
      const query = await client.query(
        `SELECT r.id AS "runId",r.sample_id AS "orderId",r.requests,r.outcome,r.finished_at AS "finishedAt",
        a.account_hash AS "accountHash",a.order_hash AS "orderHash" FROM runs r JOIN collector_attempts a ON a.run_id=r.id WHERE r.id=$1 AND r.sample_id=$2`,
        [result.runId, sample.id]
      );
      if (query.rows.length !== 1) throw fault('RECEIPT_GATE_RUN_MISSING');
      value = query.rows[0];
      value.runId = Number(value.runId);
      writePrivate(`${root}/private/gate.json`, JSON.stringify(value));
    } else {
      const proxy = readPrivate(`${root}/private/proxy.json`);
      const pauses = await client.query(
        `SELECT max(until_at) AS until FROM collector_pauses WHERE until_at>now() AND
        ((scope IN ('account','login') AND key=$1) OR (scope='proxy' AND key=$2))`,
        [sample.accountHash, proxyFingerprint(proxy)]
      );
      const attempts = await client.query(
        "SELECT count(*)::int AS count,min(created_at)+interval '24 hours' AS until FROM collector_attempts WHERE order_hash=$1 AND created_at>now()-interval '24 hours'",
        [sample.orderHash]
      );
      const budget = await client.query('SELECT requests FROM budget WHERE id=1');
      const settings = readPrivate(`${root}/private/settings.json`);
      if (!budget.rows.length || budget.rows[0].requests >= settings.totalRequestLimit)
        throw fault('REQUEST_BUDGET');
      const until = attempts.rows[0].count >= 10 ? attempts.rows[0].until : pauses.rows[0].until;
      value = {
        outcome: until ? 'RECEIPT_DEFERRED' : 'RECEIPT_READY',
        retryAt: until || null,
        attempts: attempts.rows[0].count,
      };
    }
    await client.query('COMMIT');
    process.stdout.write(JSON.stringify(value) + '\n');
  } catch (error) {
    process.stdout.write(
      JSON.stringify({
        outcome: /^[A-Z_0-9]+$/.test(error.code || '') ? error.code : 'RECEIPT_GATE_FAILED',
      }) + '\n'
    );
    process.exitCode = 1;
  } finally {
    if (client) await client.end().catch(() => {});
  }
}
main().catch(() => {
  process.exitCode = 1;
});
