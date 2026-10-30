const { Client } = require('pg');
const config = require('../config/database');
const { sequelize, DuoQuotePricingSetting } = require('../models');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');

const CHANNEL = 'duo_quote_pricing_changed';
const MAX_CLIENTS = 200;
const MAX_CLIENTS_PER_IP = 20;
const HEARTBEAT_MS = 15000;
const MAX_STREAM_AGE_MS = 20 * 60 * 1000;
const RETRY_MS = 3000;
const MAX_RECONNECT_MS = 30000;
const PG_CLOSE_TIMEOUT_MS = 1000;

function unavailable() {
  return new ApiError(503, 'DUO_EVENTS_UNAVAILABLE', '实时通知暂不可用，请稍后重试');
}

function validateVersion(version) {
  if (!Number.isSafeInteger(version) || version < 0) throw unavailable();
  return version;
}

function createListenerClient() {
  const options = {
    connectionTimeoutMillis: 5000,
    // pg官方连接参数使用固定snake_case。
    // eslint-disable-next-line camelcase
    query_timeout: 5000,
    keepAlive: true,
    ssl: config.dialectOptions?.ssl || false,
  };
  if (config.url) return new Client({ ...options, connectionString: config.url });
  return new Client({
    ...options,
    host: config.host,
    port: config.port,
    user: config.username,
    password: config.password,
    database: config.database,
  });
}

async function readCurrentVersion() {
  try {
    const setting = await DuoQuotePricingSetting.findByPk(1, {
      attributes: ['version'],
      raw: true,
    });
    if (!setting) throw unavailable();
    return validateVersion(setting.version);
  } catch (error) {
    logger.debug('读取Duo通知版本失败', { errorType: error.name });
    throw unavailable();
  }
}

/** 同一API实例共享一个懒启动PG监听，连接对象仅在首次订阅时创建。 */
class DuoQuoteEvents {
  constructor(options = {}) {
    this.createClient = options.createClient || createListenerClient;
    this.readVersion = options.readVersion || readCurrentVersion;
    this.maxClients = options.maxClients ?? MAX_CLIENTS;
    this.maxPerIp = options.maxPerIp ?? MAX_CLIENTS_PER_IP;
    this.heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
    this.maxAgeMs = options.maxAgeMs ?? MAX_STREAM_AGE_MS;
    this.clients = new Set();
    this.ipCounts = new Map();
    this.client = null;
    this.connecting = null;
    this.ready = false;
    this.stopped = false;
    this.lastVersion = -1;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.closing = new Set();
  }

  closeClient(client) {
    if (!client) return Promise.resolve();
    client.removeAllListeners('notification');
    client.removeAllListeners('end');
    client.removeAllListeners('error');
    client.on('error', () => {});
    const promise = Promise.resolve()
      .then(() => client.end())
      .catch(error => {
        logger.debug('关闭Duo通知监听失败', { errorType: error.name });
      });
    this.closing.add(promise);
    promise.finally(() => this.closing.delete(promise));
    return promise;
  }

  scheduleReconnect() {
    if (this.stopped || !this.clients.size || this.reconnectTimer) return;
    const wait = Math.min(MAX_RECONNECT_MS, 1000 * 2 ** Math.min(this.reconnectAttempt, 5));
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(
      () => {
        this.reconnectTimer = null;
        this.ensureReady().catch(() => this.scheduleReconnect());
      },
      wait + Math.floor(Math.random() * 250)
    );
    this.reconnectTimer.unref?.();
  }

  disconnected(client, error) {
    if (client !== this.client) return;
    this.client = null;
    this.ready = false;
    this.closeClient(client);
    if (error)
      logger.warn('Duo通知监听中断', { errorType: error.name, errorCode: error.code || null });
    this.scheduleReconnect();
  }

  receive(client, event) {
    if (client !== this.client || event.channel !== CHANNEL || this.stopped) return;
    try {
      if (typeof event.payload !== 'string' || event.payload.length > 64) return;
      const data = JSON.parse(event.payload);
      if (!data || Object.keys(data).length !== 1) return;
      this.broadcast(validateVersion(data.version));
    } catch (_error) {
      // 不记录原始通知；非法内容不广播，不允许将PG payload变成公开旁路。
    }
  }

  async ensureReady() {
    try {
      if (this.stopped) throw unavailable();
      if (this.ready) return;
      if (this.connecting) return await this.connecting;
      const client = this.createClient();
      this.client = client;
      client.on('notification', event => this.receive(client, event));
      client.on('error', error => this.disconnected(client, error));
      client.on('end', () => this.disconnected(client));
      const operation = (async () => {
        try {
          await client.connect();
          if (client !== this.client || this.stopped) throw unavailable();
          await client.query(`LISTEN ${CHANNEL}`);
          if (client !== this.client || this.stopped) throw unavailable();
          this.ready = true;
          this.reconnectAttempt = 0;
          // LISTEN后读取，补回断线期间已经提交而无法重播的通知。
          this.broadcast(validateVersion(await this.readVersion()));
        } catch (error) {
          this.disconnected(client, error);
          throw unavailable();
        }
      })();
      this.connecting = operation;
      try {
        await operation;
      } finally {
        if (this.connecting === operation) this.connecting = null;
      }
    } catch (error) {
      logger.debug('Duo通知监听未就绪', { errorType: error.name });
      throw unavailable();
    }
  }

  write(record, content) {
    if (record.closed) return false;
    try {
      if (!record.res.write(content)) {
        record.res.destroy();
        this.remove(record);
        return false;
      }
      return true;
    } catch (_error) {
      if (!record.res.destroyed) record.res.destroy();
      this.remove(record);
      return false;
    }
  }

  sendVersion(record, version, initial = false) {
    if (record.closed || (!initial && version <= record.lastVersion)) return;
    record.lastVersion = version;
    this.write(
      record,
      `${initial ? `retry: ${RETRY_MS}\n` : ''}id: ${version}\nevent: quote-version\ndata: ${JSON.stringify({ version })}\n\n`
    );
  }

  broadcast(version) {
    this.lastVersion = Math.max(this.lastVersion, version);
    for (const record of this.clients) {
      record.pendingVersion = Math.max(record.pendingVersion, version);
      if (record.ready) this.sendVersion(record, record.pendingVersion);
    }
  }

  remove(record, endPending = false) {
    if (record.closed) return;
    record.closed = true;
    clearTimeout(record.maxAgeTimer);
    record.res.removeListener('close', record.cleanup);
    record.res.removeListener('error', record.cleanup);
    record.req.removeListener('aborted', record.cleanup);
    this.clients.delete(record);
    const count = (this.ipCounts.get(record.ip) || 1) - 1;
    if (count) this.ipCounts.set(record.ip, count);
    else this.ipCounts.delete(record.ip);
    if (
      !record.res.destroyed &&
      !record.res.writableEnded &&
      (record.res.headersSent || endPending)
    ) {
      if (!record.res.headersSent) record.res.statusCode = 503;
      record.res.end();
    }
    if (!this.clients.size) {
      clearInterval(this.heartbeatTimer);
      clearTimeout(this.reconnectTimer);
      this.heartbeatTimer = null;
      this.reconnectTimer = null;
      const client = this.client;
      this.client = null;
      this.ready = false;
      this.closeClient(client);
    }
  }

  startHeartbeat() {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      for (const record of this.clients) {
        if (record.ready) this.write(record, ': heartbeat\n\n');
      }
    }, this.heartbeatMs);
    this.heartbeatTimer.unref?.();
  }

  /** 建立匿名SSE流；版本查询期间通知先缓冲，避免首连窗口漏变更。 */
  async subscribe(req, res) {
    let record;
    try {
      if (process.env.QUOTE_DUO_PUBLIC_ENABLED !== 'true') {
        throw new ApiError(503, 'QUOTE_PAGE_PAUSED', '报价页面暂未开放');
      }
      if (this.stopped) throw unavailable();
      const ip = req.ip || req.socket?.remoteAddress || 'unknown';
      if (this.clients.size >= this.maxClients || (this.ipCounts.get(ip) || 0) >= this.maxPerIp) {
        throw new ApiError(429, 'DUO_EVENTS_LIMITED', '实时通知连接较多，请稍后重试');
      }
      record = { req, res, ip, ready: false, closed: false, lastVersion: -1, pendingVersion: -1 };
      record.cleanup = () => this.remove(record);
      this.clients.add(record);
      this.ipCounts.set(ip, (this.ipCounts.get(ip) || 0) + 1);
      // res.close覆盖连接断开；req.aborted覆盖建立流前中断，避免误用请求正文完成的close。
      res.once('close', record.cleanup);
      res.once('error', record.cleanup);
      req.once('aborted', record.cleanup);
      await this.ensureReady();
      if (record.closed) return;
      const version = validateVersion(await this.readVersion());
      if (record.closed || this.stopped) return;
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store, no-transform');
      res.setHeader('X-Accel-Buffering', 'no');
      req.socket?.setTimeout(0);
      res.setTimeout?.(0);
      res.flushHeaders?.();
      record.ready = true;
      this.sendVersion(record, Math.max(version, record.pendingVersion, this.lastVersion), true);
      if (record.closed) return;
      record.maxAgeTimer = setTimeout(record.cleanup, this.maxAgeMs);
      record.maxAgeTimer.unref?.();
      this.startHeartbeat();
    } catch (error) {
      if (record) this.remove(record);
      if (res.destroyed || res.headersSent || res.writableEnded) return;
      throw error;
    }
  }

  /** 先结束本服务全部流和PG连接，供API在server.close前调用。 */
  async stop() {
    try {
      this.stopped = true;
      clearTimeout(this.reconnectTimer);
      clearInterval(this.heartbeatTimer);
      this.reconnectTimer = null;
      this.heartbeatTimer = null;
      for (const record of [...this.clients]) this.remove(record, true);
      const client = this.client;
      this.client = null;
      this.ready = false;
      this.closeClient(client);
      let timer;
      await Promise.race([
        Promise.all([...this.closing]),
        new Promise(resolve => {
          timer = setTimeout(resolve, PG_CLOSE_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]);
      clearTimeout(timer);
    } catch (error) {
      logger.warn('关闭Duo实时通知失败', { errorType: error.name });
    }
  }
}

const hub = new DuoQuoteEvents();

/** 在现有调价事务内排队通知；SQL失败由原事务整体回滚。 @param {Object} transaction 事务 @param {number} version 新版本 @returns {Promise<void>} */
async function notifyDuoQuoteVersion(transaction, version) {
  try {
    validateVersion(version);
    await sequelize.query('SELECT pg_notify(:channel, :payload)', {
      replacements: { channel: CHANNEL, payload: JSON.stringify({ version }) },
      transaction,
    });
  } catch (error) {
    logger.warn('Duo调价事务通知失败', { errorType: error.name, errorCode: error.code || null });
    throw error;
  }
}

/** 建立公开流。 @param {Object} req 请求 @param {Object} res 响应 @returns {Promise<void>} */
async function subscribeDuoQuoteEvents(req, res) {
  try {
    await hub.subscribe(req, res);
  } catch (error) {
    logger.debug('建立Duo实时通知失败', { errorType: error.name });
    throw error;
  }
}

/** 优雅停止实时通知。 @returns {Promise<void>} */
async function stopDuoQuoteEvents() {
  try {
    await hub.stop();
  } catch (error) {
    logger.warn('停止Duo实时通知失败', { errorType: error.name });
  }
}

module.exports = {
  CHANNEL,
  DuoQuoteEvents,
  notifyDuoQuoteVersion,
  subscribeDuoQuoteEvents,
  stopDuoQuoteEvents,
};
