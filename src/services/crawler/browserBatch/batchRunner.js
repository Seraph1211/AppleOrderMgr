const crypto = require('crypto');
const { batchError } = require('./batchConfig');

const RETRYABLE = new Set(['APPLE_THROTTLED', 'NETWORK_FAILED', 'COLLECTION_TIMEOUT']);
const STOP_BATCH = new Set([
  'API_AUTH_REQUIRED',
  'REFRESH_PAUSED',
  'BROWSER_REFRESH_DISABLED',
  'API_UNREACHABLE',
  'API_RESPONSE_INVALID',
  'CHECKPOINT_WRITE_FAILED',
  'BROWSER_DISCONNECTED',
  'INVALID_BATCH_TICKET',
  'PERMIT_DENIED',
]);

function createProxyPool(proxies) {
  const entries = proxies.map(server => ({
    server,
    hash: crypto.createHash('sha256').update(server).digest('hex'),
    busy: false,
  }));
  const waiters = new Set();
  let nextIndex = 0;
  function acquire(exclude, signal) {
    return new Promise((resolve, reject) => {
      const finish = (error, value) => {
        waiters.delete(check);
        signal.removeEventListener('abort', check);
        if (error) reject(error);
        else resolve(value);
      };
      const check = () => {
        if (signal.aborted) return finish(batchError('CANCELLED'));
        const candidates = [...entries.slice(nextIndex), ...entries.slice(0, nextIndex)].filter(
          entry => entry.hash !== exclude
        );
        if (!candidates.length) return finish(batchError('NO_ALTERNATE_PROXY'));
        const entry = candidates.find(value => !value.busy);
        if (entry) {
          entry.busy = true;
          nextIndex = (entries.indexOf(entry) + 1) % entries.length;
          finish(null, entry);
        }
      };
      waiters.add(check);
      signal.addEventListener('abort', check, { once: true });
      check();
    });
  }
  return {
    acquire,
    release(entry) {
      entry.busy = false;
      for (const wake of [...waiters]) wake();
    },
  };
}

/** 运行最多十个隔离采集任务；仅完整采集成功后提交，提交不确定时禁止自动重放。 */
async function runBrowserBatch({
  config,
  checkpoint,
  api,
  collect,
  signal,
  onProgress = () => {},
}) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const pool = createProxyPool(config.proxies);
  let cursor = 0;
  let fatalCode = null;
  const pending = checkpoint.orders.filter(row => row.status === 'pending');
  function persist(row) {
    checkpoint.save();
    onProgress({ id: row.id, status: row.status, attempts: row.attempts, code: row.code });
  }
  async function work() {
    try {
      while (!controller.signal.aborted && cursor < pending.length) {
        const row = pending[cursor++];
        while (!controller.signal.aborted && row.status === 'pending' && row.attempts < 3) {
          let lease;
          let submitting = false;
          try {
            lease = await pool.acquire(row.lastProxyHash, controller.signal);
            row.attempts += 1;
            row.lastProxyHash = lease.hash;
            row.status = 'collecting';
            row.code = null;
            persist(row);
            const task = await api.start(row.id, controller.signal);
            const page = await collect({
              task,
              proxy: lease.server,
              signal: controller.signal,
              permit: permitSignal => api.permit(row.id, task.ticket, permitSignal),
            });
            controller.signal.throwIfAborted();
            row.status = 'submitting';
            persist(row);
            submitting = true;
            const result = await api.submit(row.id, task.ticket, page, controller.signal);
            if (result?.success !== true || result.orderId !== row.id) {
              throw batchError('SUBMISSION_UNCERTAIN');
            }
            row.status = 'succeeded';
            row.code = null;
            persist(row);
          } catch (error) {
            const code = error.code || 'COLLECTION_INVALID';
            if (STOP_BATCH.has(code)) {
              fatalCode = fatalCode || code;
              controller.abort();
            }
            row.code = submitting
              ? 'SUBMISSION_UNCERTAIN'
              : controller.signal.aborted
                ? 'CANCELLED'
                : code;
            if (submitting) row.status = 'needs_review';
            else if (controller.signal.aborted) {
              row.status = row.attempts < 3 ? 'pending' : 'failed';
            } else if (RETRYABLE.has(code) && row.attempts < 3) row.status = 'pending';
            else if (
              ['NO_STRUCTURED_DATA', 'COLLECTION_INVALID', 'BROWSER_ORDER_CHANGED'].includes(code)
            )
              row.status = 'needs_review';
            else row.status = 'failed';
            persist(row);
          } finally {
            if (lease) pool.release(lease);
          }
        }
        if (row.status === 'pending' && row.attempts >= 3) {
          row.status = 'failed';
          persist(row);
        }
      }
    } catch (error) {
      fatalCode = error.code || 'BATCH_FAILED';
      controller.abort();
    }
  }
  try {
    await Promise.all(Array.from({ length: config.concurrency }, () => work()));
    const counts = {};
    for (const row of checkpoint.orders) counts[row.status] = (counts[row.status] || 0) + 1;
    return { counts, fatalCode, cancelled: controller.signal.aborted };
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}

module.exports = { runBrowserBatch };
