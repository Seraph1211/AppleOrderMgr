const crypto = require('crypto');
const { Client } = require('pg');
const { fault, hash, delay, permittedUrl } = require('./officialOrderSupport');

const MILLISECONDS_PER_SECOND = 1000;
const GLOBAL_LOCK = 261003;
const ACCOUNT_LOCK = 261004;
const REQUEST_INTERVAL_MS = 210;
const JITTER_MS = 20;
const RUN_REQUEST_LIMIT = 200;
const MAX_RUN_REQUEST_LIMIT = 400;
const RUN_TIME_MS = 180000;
const DAILY_ORDER_ATTEMPTS = 10;
const LOGIN_COOLDOWN_SECONDS = 900;
const ACCOUNT_PAUSE_SECONDS = 900;
const PROXY_PAUSE_SECONDS = 1800;
const PROXY_541_LIMIT = 3;

/** 隔离研究库的全局许可、账号互斥及持久化冷却，不连接业务数据库。 */
class OfficialOrderGate {
  constructor(config, totalLimit, runRequestLimit = RUN_REQUEST_LIMIT, batchPolicy = {}) {
    if (
      config.host !== 'apple-account-research-db' ||
      config.database !== 'apple_account_research' ||
      !Number.isSafeInteger(totalLimit) ||
      totalLimit <= 0 ||
      !Number.isSafeInteger(runRequestLimit) ||
      runRequestLimit < 1 ||
      runRequestLimit > MAX_RUN_REQUEST_LIMIT
    ) {
      throw fault('ISOLATED_DATABASE_REQUIRED');
    }
    this.client = new Client({
      ...config,
      connectionTimeoutMillis: 10000,
      options: '-c statement_timeout=10000',
    });
    this.lockClient = new Client({
      ...config,
      connectionTimeoutMillis: 10000,
      options: '-c statement_timeout=10000',
    });
    this.totalLimit = totalLimit;
    this.runRequestLimit = runRequestLimit;
    this.loginCooldown = batchPolicy.loginCooldown !== false;
    this.rotate541 = batchPolicy.proxy541Limit === PROXY_541_LIMIT;
    this.chain = Promise.resolve();
    this.requests = 0;
  }

  async openAccount(sample, proxyHash) {
    try {
      await this.client.connect();
      await this.lockClient.connect();
      this.accountHash = sample.accountHash;
      this.proxyHash = proxyHash;
      const locked = await this.lockClient.query(
        'SELECT pg_try_advisory_lock($1,hashtext($2)) AS locked',
        [ACCOUNT_LOCK, sample.accountHash]
      );
      if (!locked.rows[0].locked) throw fault('ACCOUNT_BUSY');
      await this.assertAvailable('account', sample.accountHash);
      await this.assertAvailable('proxy', proxyHash);
      const budget = await this.lockClient.query('SELECT requests FROM budget WHERE id=1');
      if (!budget.rows.length || budget.rows[0].requests >= this.totalLimit) {
        throw fault('REQUEST_BUDGET');
      }
      this.started = Date.now();
    } catch (error) {
      error.component = 'officialOrderGate';
      throw error;
    }
  }

  async open(sample, proxyHash) {
    try {
      await this.openAccount(sample, proxyHash);
      return await this.startOrder(sample);
    } catch (error) {
      error.component = 'officialOrderGate';
      throw error;
    }
  }

  async startOrder(sample) {
    try {
      if (sample.accountHash !== this.accountHash) throw fault('ACCOUNT_MISMATCH');
      if (this.requests >= this.runRequestLimit) throw fault('REQUEST_BUDGET');
      if (Date.now() - this.started >= RUN_TIME_MS) throw fault('TIME_BUDGET');
      const attempts = await this.lockClient.query(
        `SELECT count(*)::int AS count FROM collector_attempts
         WHERE order_hash=$1 AND created_at > now()-interval '24 hours'`,
        [sample.orderHash]
      );
      if (attempts.rows[0].count >= DAILY_ORDER_ATTEMPTS) throw fault('ORDER_ATTEMPT_LIMIT');
      await this.lockClient.query('BEGIN');
      try {
        const run = await this.lockClient.query(
          "INSERT INTO runs(sample_id,mode) VALUES($1,'collect') RETURNING id",
          [sample.id]
        );
        this.id = run.rows[0].id;
        await this.lockClient.query(
          `INSERT INTO collector_attempts(run_id,order_hash,account_hash,proxy_hash)
           VALUES($1,$2,$3,$4)`,
          [this.id, sample.orderHash, sample.accountHash, this.proxyHash]
        );
        await this.lockClient.query('COMMIT');
      } catch (error) {
        await this.lockClient.query('ROLLBACK');
        throw error;
      }
      return this.id;
    } catch (error) {
      error.component = 'officialOrderGate';
      throw error;
    }
  }

  async assertAvailable(scope, key) {
    try {
      const paused = await this.lockClient.query(
        'SELECT reason FROM collector_pauses WHERE scope=$1 AND key=$2 AND until_at>now()',
        [scope, key]
      );
      if (
        paused.rows.some(row => !(scope === 'proxy' && this.rotate541 && row.reason === 'HTTP_541'))
      )
        throw fault(`${scope.toUpperCase()}_COOLDOWN`);
    } catch (error) {
      error.component = 'officialOrderGate';
      throw error;
    }
  }

  async pause(scope, key, reason, seconds = LOGIN_COOLDOWN_SECONDS) {
    try {
      await this.lockClient.query(
        `INSERT INTO collector_pauses(scope,key,reason,until_at)
         VALUES($1,$2,$3,now()+$4*interval '1 second')
         ON CONFLICT(scope,key) DO UPDATE SET reason=excluded.reason,
           until_at=greatest(collector_pauses.until_at,excluded.until_at)`,
        [scope, key, reason, seconds]
      );
    } catch (error) {
      error.component = 'officialOrderGate';
      throw error;
    }
  }

  async claimLogin() {
    try {
      if (this.loginCooldown) {
        await this.assertAvailable('login', this.accountHash);
        await this.pause('login', this.accountHash, 'LOGIN_SUBMITTED');
      }
      await this.lockClient.query('UPDATE collector_attempts SET login_at=now() WHERE run_id=$1', [
        this.id,
      ]);
    } catch (error) {
      error.component = 'officialOrderGate';
      throw error;
    }
  }

  async permit(value, isStopped) {
    const previous = this.chain;
    let release;
    this.chain = new Promise(resolve => {
      release = resolve;
    });
    let locked = false;
    try {
      await previous;
      permittedUrl(value);
      if (isStopped()) throw fault('REQUEST_STOPPED');
      await this.client.query('SELECT pg_advisory_lock($1)', [GLOBAL_LOCK]);
      locked = true;
      const budget = (
        await this.client.query(
          `SELECT requests,extract(epoch FROM(clock_timestamp()-last_request))*1000 AS gap
         FROM budget WHERE id=1`
        )
      ).rows[0];
      if (budget.requests >= this.totalLimit || this.requests >= this.runRequestLimit) {
        throw fault('REQUEST_BUDGET');
      }
      if (Date.now() - this.started >= RUN_TIME_MS) throw fault('TIME_BUDGET');
      const interval = REQUEST_INTERVAL_MS + crypto.randomInt(JITTER_MS);
      await delay(Math.max(0, interval - Number(budget.gap ?? interval)));
      if (isStopped()) throw fault('REQUEST_STOPPED');
      // 许可先落盘，再由调用方继续网络请求；取消或失败不退还预算。
      await this.client.query('BEGIN');
      try {
        await this.client.query(
          'UPDATE budget SET requests=requests+1,last_request=clock_timestamp() WHERE id=1'
        );
        await this.client.query('UPDATE runs SET requests=requests+1 WHERE id=$1', [this.id]);
        await this.client.query('COMMIT');
      } catch (error) {
        await this.client.query('ROLLBACK');
        throw error;
      }
      this.requests += 1;
      return { index: this.requests, urlHash: hash(value) };
    } catch (error) {
      error.component = 'officialOrderGate';
      throw error;
    } finally {
      try {
        if (locked) await this.client.query('SELECT pg_advisory_unlock($1)', [GLOBAL_LOCK]);
      } finally {
        release();
      }
    }
  }

  async recordFailure(code, retryAfter) {
    try {
      if (
        [
          'HTTP_429',
          'HTTP_541',
          'HTTP_407',
          'HTTP_AUTH_FAILED',
          'PROXY_CONNECTION_FAILED',
        ].includes(code) &&
        !(code === 'HTTP_541' && this.rotate541)
      ) {
        let seconds = Number(retryAfter);
        if (!Number.isFinite(seconds))
          seconds = (Date.parse(retryAfter) - Date.now()) / MILLISECONDS_PER_SECOND;
        seconds = Math.max(PROXY_PAUSE_SECONDS, Number.isFinite(seconds) ? seconds : 0);
        await this.pause('proxy', this.proxyHash, code, Math.ceil(seconds));
      }
      if (
        ['AUTH_REJECTED', 'AUTH_PRECONDITION_REQUIRED', 'HUMAN_VERIFICATION_REQUIRED'].includes(
          code
        )
      ) {
        await this.pause('account', this.accountHash, code, ACCOUNT_PAUSE_SECONDS);
      }
    } catch (error) {
      error.component = 'officialOrderGate';
      throw error;
    }
  }

  async finishOrder(outcome) {
    try {
      await this.chain;
      if (this.id) {
        await this.lockClient.query('UPDATE runs SET finished_at=now(),outcome=$2 WHERE id=$1', [
          this.id,
          outcome,
        ]);
        this.id = null;
      }
    } catch (error) {
      error.component = 'officialOrderGate';
      throw error;
    }
  }

  async close(outcome) {
    try {
      await this.chain;
      if (this.id) {
        await this.lockClient.query('UPDATE runs SET finished_at=now(),outcome=$2 WHERE id=$1', [
          this.id,
          outcome,
        ]);
      }
    } finally {
      await Promise.allSettled([this.client.end(), this.lockClient.end()]);
    }
  }
}

module.exports = OfficialOrderGate;
