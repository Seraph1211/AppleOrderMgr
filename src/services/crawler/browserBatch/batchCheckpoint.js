const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { batchError, readPrivateFile } = require('./batchConfig');

const STATES = new Set([
  'pending',
  'collecting',
  'submitting',
  'succeeded',
  'failed',
  'needs_review',
]);

/** 为一个批次取得独占锁并加载可续跑状态；锁遗留时要求人工核对进程。 */
function openBatchCheckpoint(config) {
  const file = config.checkpointFile;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let lock;
  try {
    lock = fs.openSync(`${file}.lock`, 'wx', 0o600);
  } catch (_error) {
    throw batchError('CHECKPOINT_LOCKED');
  }
  const fingerprint = crypto
    .createHash('sha256')
    .update(JSON.stringify([config.apiBaseUrl, config.orderIds]))
    .digest('hex');
  let state;
  let closed = false;
  function save() {
    if (closed) throw batchError('CHECKPOINT_CLOSED');
    const temp = `${file}.${crypto.randomUUID()}.tmp`;
    let fd;
    try {
      fd = fs.openSync(temp, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify(state, null, 2));
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(temp, file);
      // 同步目录项，确保 submitting 标记先于网络提交持久化。
      const dir = fs.openSync(path.dirname(file), 'r');
      try {
        fs.fsyncSync(dir);
      } finally {
        fs.closeSync(dir);
      }
    } catch (_error) {
      throw batchError('CHECKPOINT_WRITE_FAILED');
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    }
  }
  function close() {
    if (closed) return;
    closed = true;
    fs.closeSync(lock);
    fs.unlinkSync(`${file}.lock`);
  }
  try {
    fs.writeFileSync(
      lock,
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })
    );
    if (fs.existsSync(file)) {
      state = JSON.parse(readPrivateFile(file));
      if (
        state.version !== 1 ||
        state.fingerprint !== fingerprint ||
        !Array.isArray(state.orders) ||
        state.orders.length !== config.orderIds.length ||
        state.orders.some(
          (row, index) =>
            row.id !== config.orderIds[index] ||
            !STATES.has(row.status) ||
            !Number.isInteger(row.attempts) ||
            row.attempts < 0 ||
            row.attempts > 3
        )
      )
        throw batchError('CHECKPOINT_MISMATCH');
      state = {
        version: 1,
        fingerprint,
        orders: state.orders.map(row => ({
          id: row.id,
          status: row.status,
          attempts: row.attempts,
          code: /^[A-Z_]{1,64}$/.test(row.code) ? row.code : null,
          lastProxyHash: /^[a-f0-9]{64}$/.test(row.lastProxyHash) ? row.lastProxyHash : null,
        })),
      };
      for (const row of state.orders) {
        if (row.status === 'submitting') {
          row.status = 'needs_review';
          row.code = 'SUBMISSION_UNCERTAIN';
        } else if (row.status === 'collecting') {
          row.status = row.attempts < 3 ? 'pending' : 'failed';
          row.code = 'INTERRUPTED';
        }
      }
    } else {
      state = {
        version: 1,
        fingerprint,
        orders: config.orderIds.map(id => ({
          id,
          status: 'pending',
          attempts: 0,
          code: null,
          lastProxyHash: null,
        })),
      };
    }
    save();
    return { orders: state.orders, save, close };
  } catch (error) {
    close();
    throw error;
  }
}

module.exports = { openBatchCheckpoint };
