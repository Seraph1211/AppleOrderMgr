const crypto = require('crypto');
const { Client } = require('pg');
const config = require('../config/database');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const queryService = require('./applePurchaseInventoryQueryService');

const CHANNEL = 'apple_purchase_inventory_version';
const HEARTBEAT_MS = 20_000;
const MAX_CLIENTS = 200;
const MAX_CLIENTS_PER_IP = 20;

function unavailable() {
  return new ApiError(503, 'SERVICE_UNAVAILABLE', '库存实时通知暂不可用');
}

function validateVersion(value) {
  if (!value || !/^\d+$/.test(value.observations) || !/^\d+$/.test(value.monitorChanges)) {
    throw unavailable();
  }
  return { observations: String(value.observations), monitorChanges: String(value.monitorChanges) };
}

function createListenerClient() {
  if (process.env.NODE_ENV === 'production' && !process.env.APPLE_PURCHASE_SYNC_READ_DATABASE_URL) {
    throw unavailable();
  }
  const connectionString = process.env.APPLE_PURCHASE_SYNC_READ_DATABASE_URL || config.url;
  const options = {
    connectionTimeoutMillis: 5000,
    // pg 官方连接参数使用固定 snake_case。
    // eslint-disable-next-line camelcase
    query_timeout: 5000,
    keepAlive: true,
    ssl: config.dialectOptions?.ssl || false,
  };
  if (connectionString) return new Client({ ...options, connectionString });
  return new Client({
    ...options,
    host: config.host,
    port: config.port,
    user: config.username,
    password: config.password,
    database: config.database,
  });
}

class ApplePurchaseInventoryEvents {
  constructor(options = {}) {
    this.createClient = options.createClient || createListenerClient;
    this.readVersion = options.readVersion || queryService.highWater;
    this.heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
    this.maxClients = options.maxClients ?? MAX_CLIENTS;
    this.maxPerIp = options.maxPerIp ?? MAX_CLIENTS_PER_IP;
    this.clients = new Set();
    this.ipCounts = new Map();
    this.listener = null;
    this.connecting = null;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.stopped = false;
    this.ready = false;
    this.lastVersion = { observations: '0', monitorChanges: '0' };
  }

  closeListener(client) {
    if (!client) return Promise.resolve();
    client.removeAllListeners();
    client.on('error', () => {});
    return client.end().catch(() => {});
  }

  scheduleReconnect() {
    if (this.stopped || !this.clients.size || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.ensureReady().catch(() => this.scheduleReconnect());
    }, 2000);
    this.reconnectTimer.unref?.();
  }

  disconnected(client, error) {
    if (this.listener !== client) return;
    this.listener = null;
    this.ready = false;
    this.closeListener(client);
    if (error)
      logger.warn('ApplePurchase 库存通知监听中断', {
        errorType: error.name,
        errorCode: error.code,
      });
    this.scheduleReconnect();
  }

  receive(client, notification) {
    if (client !== this.listener || notification.channel !== CHANNEL || this.stopped) return;
    try {
      if (typeof notification.payload !== 'string' || notification.payload.length > 160) return;
      const version = validateVersion(JSON.parse(notification.payload));
      this.broadcast(version);
    } catch (_error) {
      // 原始 PG payload 永不写日志或响应。
    }
  }

  async ensureReady() {
    if (this.stopped) throw unavailable();
    if (this.ready) return;
    if (this.connecting) return await this.connecting;
    const client = this.createClient();
    this.listener = client;
    client.on('notification', notification => this.receive(client, notification));
    client.on('error', error => this.disconnected(client, error));
    client.on('end', () => this.disconnected(client));
    this.connecting = (async () => {
      try {
        await client.connect();
        await client.query(`LISTEN ${CHANNEL}`);
        if (client !== this.listener || this.stopped) throw unavailable();
        this.ready = true;
        this.broadcast(validateVersion(await this.readVersion()));
      } catch (_error) {
        this.disconnected(client);
        throw unavailable();
      } finally {
        this.connecting = null;
      }
    })();
    return await this.connecting;
  }

  write(record, content) {
    if (record.closed) return;
    try {
      if (!record.res.write(content)) record.res.destroy();
    } catch (_error) {
      if (!record.res.destroyed) record.res.destroy();
    }
  }

  send(record, version, initial = false) {
    if (record.closed) return;
    const key = `${version.observations}:${version.monitorChanges}`;
    if (!initial && record.lastKey === key) return;
    record.lastKey = key;
    const data = { ...version, serverTime: new Date().toISOString() };
    this.write(
      record,
      `${initial ? 'retry: 3000\n' : ''}event: inventory-version\nid: ${crypto.randomUUID()}\ndata: ${JSON.stringify(data)}\n\n`
    );
  }

  broadcast(version) {
    this.lastVersion = version;
    for (const record of this.clients) {
      record.pending = version;
      if (record.ready) this.send(record, version);
    }
  }

  remove(record) {
    if (record.closed) return;
    record.closed = true;
    record.res.removeListener('close', record.cleanup);
    record.res.removeListener('error', record.cleanup);
    record.req.removeListener('aborted', record.cleanup);
    this.clients.delete(record);
    const count = (this.ipCounts.get(record.ip) || 1) - 1;
    if (count) this.ipCounts.set(record.ip, count);
    else this.ipCounts.delete(record.ip);
    if (!this.clients.size) {
      clearInterval(this.heartbeatTimer);
      clearTimeout(this.reconnectTimer);
      this.heartbeatTimer = null;
      this.reconnectTimer = null;
      const client = this.listener;
      this.listener = null;
      this.ready = false;
      this.closeListener(client);
    }
  }

  startHeartbeat() {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      for (const record of this.clients) if (record.ready) this.write(record, ': heartbeat\n\n');
    }, this.heartbeatMs);
    this.heartbeatTimer.unref?.();
  }

  /** 建立已登录网页 SSE；首帧在 LISTEN 后重读高水位。 @returns {Promise<void>} 完成 */
  async subscribe(req, res) {
    let record;
    try {
      const ip = req.ip || req.socket?.remoteAddress || 'unknown';
      if (this.clients.size >= this.maxClients || (this.ipCounts.get(ip) || 0) >= this.maxPerIp) {
        throw new ApiError(429, 'RATE_LIMITED', '实时通知连接较多，请稍后重试');
      }
      record = {
        req,
        res,
        ip,
        ready: false,
        closed: false,
        pending: this.lastVersion,
        lastKey: null,
      };
      record.cleanup = () => this.remove(record);
      this.clients.add(record);
      this.ipCounts.set(ip, (this.ipCounts.get(ip) || 0) + 1);
      res.once('close', record.cleanup);
      res.once('error', record.cleanup);
      req.once('aborted', record.cleanup);
      await this.ensureReady();
      const version = validateVersion(await this.readVersion());
      if (record.closed) return;
      res.status(200);
      res.set({
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store, no-transform',
        'X-Accel-Buffering': 'no',
      });
      req.socket?.setTimeout(0);
      res.setTimeout?.(0);
      res.flushHeaders?.();
      record.ready = true;
      this.send(record, record.pending || version, true);
      this.startHeartbeat();
    } catch (error) {
      if (record) this.remove(record);
      throw error;
    }
  }

  /** 关闭 SSE 与专用 LISTEN 连接。 @returns {Promise<void>} 完成 */
  async stop() {
    this.stopped = true;
    clearInterval(this.heartbeatTimer);
    clearTimeout(this.reconnectTimer);
    for (const record of [...this.clients]) {
      this.remove(record);
      if (!record.res.writableEnded) record.res.end();
    }
    const client = this.listener;
    this.listener = null;
    this.ready = false;
    await this.closeListener(client);
  }
}

const hub = new ApplePurchaseInventoryEvents();

async function subscribe(req, res) {
  return await hub.subscribe(req, res);
}

async function stopApplePurchaseInventoryEvents() {
  return await hub.stop();
}

module.exports = {
  ApplePurchaseInventoryEvents,
  CHANNEL,
  stopApplePurchaseInventoryEvents,
  subscribe,
};
