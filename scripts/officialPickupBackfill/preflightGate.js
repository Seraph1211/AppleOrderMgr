const { createRequire } = require('module');
const appRequire = createRequire('/app/package.json');
const fs = require('fs');
const path = require('path');
const root = '/research';
const PLAN_AGE_MS = 86400000;
const INPUT_AGE_MS = 300000;
const MAX_ORDER_ID = 2147483647;
const DAILY_ATTEMPTS = 10;
const PROXY_541_LIMIT = 3;
const PREFLIGHT_VERSION = 2;
const PLAN_SCHEMA_VERSION = 3;
const MILLISECONDS_PER_SECOND = 1000;
const ARGV_OFFSET = 2;
const RECEIPT_ATTEMPTS = 2;

/** 仅查询访客当前账号冷却和订单次数；预检不是 Gate 许可，也不创建运行。 */
async function preflightHttp(client, directory, id, browser = false) {
  let started = false;
  try {
    // 旧入口仍可从 /ops 挂载运行；仅 HTTP 模式读取新 release 的相对依赖。
    const { hash, readPrivate, fault } = require('../../src/services/officialOrderSupport');
    const { validateReadUrl } = require('../../src/services/officialOrderHttpCollector');
    if (!path.isAbsolute(directory) || !Number.isSafeInteger(id) || id < 1 || id > MAX_ORDER_ID)
      throw fault('INPUT_INVALID');
    if (fs.existsSync(`${directory}/private/STOP`)) throw fault('REQUEST_STOPPED');
    const planBytes = readPrivate(`${directory}/private/plan.json`, false);
    const plan = JSON.parse(planBytes);
    const now = Date.now();
    const age = now - Date.parse(plan.startedAt);
    if (
      plan.schemaVersion !== PLAN_SCHEMA_VERSION ||
      plan.scope !== 'missing-fields' ||
      plan.cutoff !== null ||
      !Number.isFinite(age) ||
      age < 0 ||
      age > PLAN_AGE_MS ||
      plan.policy?.loginCooldown !== true ||
      plan.policy?.apiHealthCheck !== true ||
      plan.policy?.proxy541Limit !== PROXY_541_LIMIT ||
      !Array.isArray(plan.entries) ||
      new Set(plan.entries.map(entry => entry.id)).size !== plan.entries.length
    )
      throw fault('BACKFILL_SCOPE_INVALID');
    const entry = plan.entries.find(value => value.id === id);
    if (!entry || !/^W\d{10}$/.test(entry.orderNumber)) throw fault('BACKFILL_SCOPE_INVALID');
    const inputBytes = readPrivate(`${directory}/private/request-${id}.json`, false);
    const input = JSON.parse(inputBytes);
    const inputAge = now - Date.parse(input.capturedAt);
    const sample = input.samples?.[0];
    if (
      !Array.isArray(input.samples) ||
      input.samples.length !== 1 ||
      (input.failures !== undefined && (!Array.isArray(input.failures) || input.failures.length)) ||
      !Number.isFinite(inputAge) ||
      inputAge < 0 ||
      inputAge > INPUT_AGE_MS ||
      sample.id !== id ||
      sample.orderNumber !== entry.orderNumber ||
      !/^[a-f0-9]{64}$/.test(sample.accountHash) ||
      !/^[a-f0-9]{32}$/.test(sample.beforeRowHash)
    )
      throw fault('INPUT_INVALID');
    const initial = validateReadUrl(sample.url);
    if (!initial.pathname.split('/').map(decodeURIComponent).includes(sample.orderNumber))
      throw fault('LINK_IDENTITY_MISMATCH');
    await client.query('BEGIN READ ONLY');
    started = true;
    await client.query("SET LOCAL statement_timeout='8s'");
    const loginQuery = browser
      ? `, EXISTS(SELECT 1 FROM collector_pauses
          WHERE scope='login' AND key=$1 AND until_at>now()) AS "loginPaused"`
      : '';
    const { rows } = await client.query(
      `SELECT EXISTS(SELECT 1 FROM collector_pauses
          WHERE scope='account' AND key=$1 AND until_at>now()) AS "accountPaused",
        (SELECT count(*)::int FROM collector_attempts
          WHERE order_hash=$2 AND created_at>now()-interval '24 hours') AS attempts ${loginQuery}`,
      [sample.accountHash, hash(sample.orderNumber)]
    );
    if (
      rows.length !== 1 ||
      typeof rows[0].accountPaused !== 'boolean' ||
      !Number.isSafeInteger(rows[0].attempts) ||
      rows[0].attempts < 0 ||
      (browser && typeof rows[0].loginPaused !== 'boolean')
    )
      throw fault('GATE_PREFLIGHT_FAILED');
    if (fs.existsSync(`${directory}/private/STOP`)) throw fault('REQUEST_STOPPED');
    const { accountPaused, attempts } = rows[0];
    const browserOutcome = accountPaused
      ? 'ACCOUNT_COOLDOWN'
      : rows[0].loginPaused
        ? 'LOGIN_COOLDOWN'
        : attempts > DAILY_ATTEMPTS - RECEIPT_ATTEMPTS
          ? 'RECEIPT_ATTEMPT_LIMIT'
          : 'BROWSER_PREFLIGHT_ALLOWED';
    return {
      version: PREFLIGHT_VERSION,
      outcome: browser
        ? browserOutcome
        : accountPaused
          ? 'ACCOUNT_COOLDOWN'
          : attempts >= DAILY_ATTEMPTS
            ? 'ORDER_ATTEMPT_LIMIT'
            : 'HTTP_PREFLIGHT_ALLOWED',
      orderId: id,
      checkedAt: Date.now() / MILLISECONDS_PER_SECOND,
      planSha256: hash(planBytes),
      inputSha256: hash(inputBytes),
      accountPaused,
      attempts,
      ...(browser
        ? { mode: 'browser', requiredAttempts: RECEIPT_ATTEMPTS, loginPaused: rows[0].loginPaused }
        : {}),
    };
  } catch (error) {
    error.component = 'officialHttpPreflight';
    throw error;
  } finally {
    if (started) await client.query('ROLLBACK');
  }
}

/** 浏览器收据预检同时检查登录暂停，并为详情与收据保留两次次数。 */
async function preflightBrowser(client, directory, id) {
  try {
    return await preflightHttp(client, directory, id, true);
  } catch (error) {
    error.component = 'officialBrowserPreflight';
    throw error;
  }
}

async function main() {
  let client;
  const [mode, rawId, ...extra] = process.argv.slice(ARGV_OFFSET);
  const isHttp = mode === '--http';
  const isBrowser = mode === '--browser';
  const isScoped = isHttp || isBrowser;
  try {
    const config = JSON.parse(fs.readFileSync(root + '/private/db.json'));
    if (
      isScoped &&
      (config.host !== 'apple-account-research-db' || config.database !== 'apple_account_research')
    )
      throw new Error('ISOLATED_DATABASE_REQUIRED');
    const { Client } = appRequire('pg');
    client = new Client({ ...config, connectionTimeoutMillis: 10000 });
    if (isScoped) {
      if (extra.length || !/^[1-9]\d*$/.test(rawId || '')) throw new Error('INPUT_INVALID');
      await client.connect();
      process.stdout.write(
        JSON.stringify(
          await (isBrowser ? preflightBrowser : preflightHttp)(client, root, Number(rawId))
        )
      );
      return;
    }
    const plan = JSON.parse(fs.readFileSync(root + '/private/plan.json'));
    const ids = plan.entries.map(entry => String(entry.id));
    await client.connect();
    await client.query('BEGIN READ ONLY');
    if (mode === '--proxies') {
      const { rows } = await client.query(
        "SELECT key,reason FROM collector_pauses WHERE scope='proxy' " +
          "AND until_at>now() AND reason<>'HTTP_541'"
      );
      process.stdout.write(JSON.stringify(rows));
      return;
    }
    const { rows } = await client.query(
      `
      SELECT r.sample_id AS id,count(DISTINCT a.run_id)::int AS attempts,
        max(p.until_at) FILTER(WHERE p.scope='account') AS account_until,
        max(p.until_at) FILTER(WHERE p.scope='login') AS login_until
      FROM collector_attempts a JOIN runs r ON r.id=a.run_id
      LEFT JOIN collector_pauses p ON p.key=a.account_hash
        AND p.scope IN ('account','login') AND p.until_at>now()
      WHERE r.sample_id::text=ANY($1::text[]) AND a.created_at>now()-interval '24 hours'
      GROUP BY r.sample_id`,
      [ids]
    );
    process.stdout.write(JSON.stringify(rows));
  } catch (error) {
    process.stderr.write(
      isScoped
        ? 'GATE_PREFLIGHT_FAILED'
        : /^[A-Z_0-9]+$/.test(error.code || '')
          ? error.code
          : 'GATE_PREFLIGHT_FAILED'
    );
    process.exitCode = 1;
  } finally {
    if (client) await client.end();
  }
}
if (require.main === module)
  main().catch(() => {
    process.exitCode = 1;
  });
module.exports = { preflightHttp, preflightBrowser };
