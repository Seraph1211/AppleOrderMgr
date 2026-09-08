const Imap = require('node-imap');
const logger = require('../utils/logger');

const POLL_INTERVAL_MS = 30_000;
const COMMAND_TIMEOUT_MS = 30_000;
const RECONNECT_DELAY_MS = 30_000;
const STOP_TIMEOUT_MS = 10_000;
const BATCH_SIZE = 20;
const MAX_UID = 4294967295;

function scanError(reason) {
  return Object.assign(new Error('邮件扫描暂时不可用'), { code: 'IMAP_TEMPORARY', reason });
}

/**
 * 创建独立的 UID 扫描器；连接代际、网络取消和扫描计划都属于本实例。
 * @param {Object} options - IMAP 配置及持久化／状态回调
 * @returns {Object} 启停、扫描、已读确认和状态接口
 */
function createEmailScanner(options) {
  let running = false;
  let current = null;
  let generation = 0;
  let pollTimer = null;
  let reconnectTimer = null;
  const inFlight = new Set();
  let stateTail = Promise.resolve();

  function track(promise) {
    inFlight.add(promise);
    promise.then(
      () => inFlight.delete(promise),
      () => inFlight.delete(promise)
    );
    return promise;
  }

  function isCurrent(session) {
    return running && current === session && !session.closed;
  }

  function updateState(updates) {
    stateTail = stateTail.catch(() => {}).then(() => options.onState(updates));
    return stateTail;
  }

  function publish(updates) {
    return track(
      Promise.resolve()
        .then(() => updateState(updates))
        .catch(() => {
          logger.warn('邮件扫描状态保存失败', { errorCode: 'DATABASE_TEMPORARY' });
        })
    );
  }

  function disconnect(session, reason) {
    if (!isCurrent(session)) return;
    session.closed = true;
    current = null;
    for (const cancel of [...session.cancellations]) cancel(scanError(reason));
    session.connection.destroy();
    logger[reason === 'stopped' ? 'info' : 'warn']('IMAP 连接结束', {
      generation: session.generation,
      reason,
      errorCode: 'IMAP_TEMPORARY',
    });
    publish(
      reason === 'stopped'
        ? { isConnected: false }
        : { isConnected: false, lastScanErrorCode: 'IMAP_TEMPORARY' }
    );
    if (running && !reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (running && !current) connect();
      }, RECONNECT_DELAY_MS);
      reconnectTimer.unref?.();
    }
  }

  function operation(session, kind, execute) {
    return new Promise((resolve, reject) => {
      if (!isCurrent(session)) {
        reject(scanError('stale_connection'));
        return;
      }
      let settled = false;
      let dispose = null;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        session.cancellations.delete(cancel);
        if (typeof dispose === 'function') dispose();
        if (error) reject(error);
        else resolve(value);
      };
      const cancel = error => finish(error);
      const timer = setTimeout(() => {
        finish(scanError(`${kind}_timeout`));
        disconnect(session, `${kind}_timeout`);
      }, COMMAND_TIMEOUT_MS);
      session.cancellations.add(cancel);
      try {
        dispose = execute((error, value) => {
          if (!isCurrent(session)) finish(scanError('stale_connection'));
          else finish(error, value);
        });
        if (settled && typeof dispose === 'function') dispose();
      } catch (error) {
        finish(error);
      }
    });
  }

  function promiseOperation(session, kind, action) {
    return operation(session, kind, done => {
      Promise.resolve()
        .then(action)
        .then(value => done(null, value), done);
    });
  }

  function fetchBatch(session, uids) {
    return operation(session, 'fetch', done => {
      const messages = new Map();
      const buffers = new Set();
      const fetch = session.connection.fetch(uids, { bodies: '', markSeen: false });
      let failed = false;
      let ended = false;
      let pendingBodies = 0;
      const fail = () => {
        failed = true;
        done(scanError('body_stream'));
      };
      const complete = () => {
        if (failed || !ended || pendingBodies > 0) return;
        if (uids.some(uid => !messages.has(uid))) done(scanError('missing_uid'));
        else
          done(
            null,
            uids.map(uid => messages.get(uid))
          );
      };
      fetch.on('error', fail);
      fetch.on('message', msg => {
        if (failed || !isCurrent(session)) return;
        pendingBodies += 1;
        let uid = null;
        const chunks = [];
        buffers.add(chunks);
        msg.on('attributes', attrs => {
          uid = Number(attrs.uid);
        });
        msg.on('body', stream => {
          stream.on('data', chunk => {
            if (!failed && isCurrent(session)) chunks.push(Buffer.from(chunk));
          });
          stream.on('error', fail);
        });
        msg.on('error', fail);
        msg.once('end', () => {
          pendingBodies -= 1;
          if (!uids.includes(uid) || messages.has(uid)) {
            fail();
            return;
          }
          messages.set(uid, { emailUid: uid, rawBuffer: Buffer.concat(chunks) });
          buffers.delete(chunks);
          complete();
        });
      });
      fetch.once('end', () => {
        ended = true;
        complete();
      });
      return () => {
        failed = true;
        for (const chunks of buffers) chunks.length = 0;
        buffers.clear();
      };
    });
  }

  async function scan(session, reason) {
    const startedAt = new Date();
    let matchedCount = 0;
    let receivedCount = 0;
    try {
      await promiseOperation(session, 'scan_state', () =>
        updateState({ lastScanStartedAt: startedAt })
      );
      const lowerBound = session.cursor.lastUid === null ? 1 : session.cursor.lastUid + 1;
      const criteria =
        session.cursor.lastUid === null
          ? [['SINCE', new Date(session.cursor.bootstrapSince)]]
          : [['UID', `${Math.min(lowerBound, MAX_UID)}:*`]];
      const matches = await operation(session, 'search', done =>
        session.connection.search(criteria, done)
      );
      const uids = [...new Set((matches || []).map(Number))].sort((a, b) => a - b);
      if (uids.some(uid => !Number.isInteger(uid) || uid < 1 || uid > MAX_UID))
        throw scanError('invalid_uid');
      const newUids = uids.filter(uid => uid >= lowerBound);
      matchedCount = newUids.length;
      logger.info('邮件扫描搜索完成', {
        generation: session.generation,
        reason,
        matchedCount,
        durationMs: Date.now() - startedAt.getTime(),
      });
      for (let offset = 0; offset < newUids.length; offset += BATCH_SIZE) {
        const batch = newUids.slice(offset, offset + BATCH_SIZE);
        const messages = await fetchBatch(session, batch);
        for (const message of messages) {
          const received = await promiseOperation(session, 'persist', () =>
            options.receive(message, session.identity)
          );
          if (received?.created) receivedCount += 1;
        }
        await promiseOperation(session, 'checkpoint', () =>
          options.advanceCursor(session.identity, batch[batch.length - 1])
        );
        session.cursor.lastUid = batch[batch.length - 1];
      }
      await promiseOperation(session, 'scan_state', () =>
        updateState({
          lastScanSucceededAt: new Date(),
          lastScanDurationMs: Date.now() - startedAt.getTime(),
          lastScanErrorCode: null,
        })
      );
      logger.info('邮件扫描完成', {
        generation: session.generation,
        reason,
        matchedCount,
        receivedCount,
        durationMs: Date.now() - startedAt.getTime(),
      });
    } catch (error) {
      logger.error('邮件扫描失败', {
        generation: session.generation,
        reason: error.reason || 'scan_failed',
        errorCode: 'IMAP_TEMPORARY',
        matchedCount,
        receivedCount,
        durationMs: Date.now() - startedAt.getTime(),
      });
      if (isCurrent(session)) disconnect(session, error.reason || 'scan_failed');
    }
  }

  /** 合并所有触发；下一轮从可靠游标继续，繁忙期间不丢失回查范围。 */
  function requestScan(reason = 'requested') {
    const session = current;
    if (!session || !isCurrent(session) || !session.ready) return Promise.resolve();
    session.pending = true;
    if (session.scanning) return session.scanning;
    session.scanning = track(
      (async () => {
        try {
          while (session.pending && isCurrent(session)) {
            session.pending = false;
            await scan(session, reason);
            reason = 'coalesced';
          }
        } catch (_error) {
          disconnect(session, 'scan_failed');
        } finally {
          session.scanning = null;
        }
      })()
    );
    return session.scanning;
  }

  async function initialize(session) {
    try {
      if (session.connection.serverSupports('ID')) {
        await operation(session, 'id', done =>
          session.connection.id({ name: 'AppleOrderManager', version: '1.0.0' }, done)
        );
      }
      const box = await operation(session, 'open', done =>
        session.connection.openBox(options.imapConfig.mailbox, false, done)
      );
      const validity = Number(box.uidvalidity);
      if (!Number.isInteger(validity) || validity < 1 || validity > MAX_UID)
        throw scanError('invalid_uidvalidity');
      session.identity = {
        mailboxIdentityHash: options.mailboxIdentityHash,
        uidValidity: String(validity),
      };
      session.cursor = await promiseOperation(session, 'cursor', () =>
        options.loadCursor(session.identity)
      );
      session.ready = true;
      await promiseOperation(session, 'connected_state', () =>
        updateState({ mailboxIdentityHash: options.mailboxIdentityHash, isConnected: true })
      );
      logger.info('IMAP 邮箱已就绪', { generation: session.generation });
      requestScan('connected');
    } catch (error) {
      disconnect(session, error.reason || 'initialize_failed');
    }
  }

  function connect() {
    const session = {
      generation: ++generation,
      ready: false,
      closed: false,
      pending: false,
      scanning: null,
      cancellations: new Set(),
    };
    current = session;
    const connection = new Imap({
      ...options.imapConfig,
      keepalive: { interval: 10_000, forceNoop: true },
      connTimeout: COMMAND_TIMEOUT_MS,
      authTimeout: 10_000,
      debug: line => {
        // 原始协议含认证明文，只归类服务器退出原因，绝不输出原行。
        if (/^<=.*\* BYE\b/i.test(line)) {
          session.closeReason = /autologout/i.test(line) ? 'server_autologout' : 'server_bye';
        }
      },
    });
    session.connection = connection;
    connection.once('ready', () => {
      if (isCurrent(session)) track(initialize(session));
    });
    connection.on('mail', count => {
      if (!isCurrent(session)) return;
      logger.info('收到新邮件事件', { generation: session.generation, count });
      requestScan('mail');
    });
    connection.on('uidvalidity', value => {
      if (session.identity && String(value) !== session.identity.uidValidity)
        disconnect(session, 'uidvalidity_changed');
    });
    connection.on('error', () => disconnect(session, 'connection_error'));
    connection.once('end', () => disconnect(session, session.closeReason || 'connection_end'));
    connection.once('close', () => disconnect(session, session.closeReason || 'connection_close'));
    // 除 TCP/认证超时外，覆盖 ready 永远不触发的连接阶段。
    operation(session, 'connect', done => {
      connection.once('ready', () => done(null));
      connection.connect();
    }).catch(() => disconnect(session, 'connect_failed'));
  }

  function start() {
    if (running) return;
    running = true;
    publish({ isConnected: false });
    pollTimer = setInterval(() => requestScan('poll'), POLL_INTERVAL_MS);
    pollTimer.unref?.();
    connect();
  }

  async function stop() {
    try {
      const session = current;
      if (session) disconnect(session, 'stopped');
      running = false;
      clearInterval(pollTimer);
      clearTimeout(reconnectTimer);
      pollTimer = reconnectTimer = null;
      let timer;
      await Promise.race([
        Promise.allSettled([...inFlight]),
        new Promise(resolve => {
          timer = setTimeout(resolve, STOP_TIMEOUT_MS);
        }),
      ]).finally(() => clearTimeout(timer));
    } catch (_error) {
      logger.warn('邮件扫描器停止未完整收敛', { errorCode: 'IMAP_TEMPORARY' });
    }
  }

  function addSeenFlag(record) {
    const session = current;
    if (
      !session?.ready ||
      !isCurrent(session) ||
      String(record.uidValidity) !== session.identity.uidValidity ||
      record.mailboxIdentityHash !== session.identity.mailboxIdentityHash
    ) {
      return Promise.reject(scanError('ack_identity_changed'));
    }
    return operation(session, 'ack', done =>
      session.connection.addFlags(record.emailUid, '\\Seen', done)
    );
  }

  function getStatus() {
    return {
      isConnected: !!current?.ready,
      uidValidity: current?.identity?.uidValidity || null,
      isProcessing: !!current?.scanning,
      generation,
      inFlightCount: inFlight.size,
    };
  }

  return { start, stop, requestScan, addSeenFlag, getStatus };
}

module.exports = { createEmailScanner };
