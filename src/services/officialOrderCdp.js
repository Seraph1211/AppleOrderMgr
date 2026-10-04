/* global WebSocket */
const { EventEmitter } = require('events');
const { fault: fail } = require('./officialOrderSupport');

// 固定 Node.js 22+ 的原生 WebSocket；独立容器不开放 CDP 端口。
const CDP_TIMEOUT_MS = 12000;
/** 带超时和关闭清理的原生 CDP 多会话连接。 */
class Cdp extends EventEmitter {
  constructor() {
    super();
    this.sequence = 0;
    this.pending = new Map();
  }
  async open(url) {
    try {
      this.socket = new WebSocket(url);
      await new Promise((resolve, reject) => {
        this.socket.addEventListener('open', resolve, { once: true });
        this.socket.addEventListener('error', () => reject(fail('CDP_OPEN_FAILED')), {
          once: true,
        });
      });
      this.socket.addEventListener('message', event => {
        let item;
        try {
          item = JSON.parse(event.data);
        } catch (_error) {
          this.emit('fault', fail('CDP_INVALID_MESSAGE'));
          return;
        }
        if (item.id) {
          const pending = this.pending.get(item.id);
          if (!pending) return;
          this.pending.delete(item.id);
          clearTimeout(pending.timer);
          if (item.error) {
            pending.reject(
              Object.assign(fail('CDP_COMMAND_FAILED'), {
                method: pending.method,
                detail: item.error.message,
              })
            );
          } else {
            pending.resolve(item.result);
          }
        } else this.emit('event', item);
      });
      this.socket.addEventListener('close', () => this.rejectPending());
    } catch (error) {
      error.component = 'officialOrderCdp';
      throw error;
    }
  }
  send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(fail('CDP_TIMEOUT'));
      }, CDP_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.socket.send(
          JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })
        );
      } catch (_error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(fail('CDP_CLOSED'));
      }
    });
  }
  rejectPending() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(fail('CDP_CLOSED'));
    }
    this.pending.clear();
  }
  close() {
    this.rejectPending();
    this.socket?.close();
  }
}

module.exports = Cdp;
