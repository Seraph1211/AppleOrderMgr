const { EventEmitter } = require('events');
jest.mock('node-imap', () => jest.fn());
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const Imap = require('node-imap');
const logger = require('../src/utils/logger');
const { createEmailScanner } = require('../src/services/emailScanner');

const flush = async () => {
  for (let i = 0; i < 100; i++) await Promise.resolve();
};

describe('邮件 UID 扫描与连接恢复', () => {
  let scanner;
  let options;
  let connections;
  let mail;
  let validity;
  let cursors;
  let persisted;
  let searchAction;
  let fetchAction;
  let states;

  function defaultFetch(uids) {
    const fetch = new EventEmitter();
    Promise.resolve().then(() => {
      for (const uid of uids) {
        const msg = new EventEmitter();
        const stream = new EventEmitter();
        fetch.emit('message', msg, uid);
        msg.emit('attributes', { uid });
        msg.emit('body', stream);
        stream.emit('data', Buffer.from(`synthetic-${uid}`));
        msg.emit('end');
      }
      fetch.emit('end');
    });
    return fetch;
  }

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    connections = [];
    mail = [];
    validity = 1;
    cursors = new Map();
    persisted = new Set();
    states = [];
    searchAction = (criteria, done) => {
      const threshold = criteria[0][0] === 'UID' ? Number(criteria[0][1].split(':')[0]) : 1;
      const result = mail.filter(item => item.uid >= threshold).map(item => item.uid);
      done(null, result);
    };
    fetchAction = defaultFetch;
    Imap.mockImplementation(config => {
      const connection = new EventEmitter();
      connection.config = config;
      connection.connect = jest.fn(() => {
        Promise.resolve().then(() => connection.emit('ready'));
      });
      connection.serverSupports = () => true;
      connection.id = jest.fn((_data, done) => done(null));
      connection.openBox = jest.fn((_name, _readOnly, done) =>
        done(null, { uidvalidity: validity, uidnext: 0 })
      );
      connection.search = jest.fn((criteria, done) => searchAction(criteria, done));
      connection.fetch = jest.fn((uids, settings) => fetchAction(uids, settings));
      connection.addFlags = jest.fn((_uid, _flag, done) => done(null));
      connection.destroy = jest.fn(() => {
        connection.emit('end');
        connection.emit('close', false);
      });
      connections.push(connection);
      return connection;
    });
    options = {
      imapConfig: {
        host: 'synthetic.invalid',
        user: 'private@example.com',
        password: 'secret-fixture',
        mailbox: 'INBOX',
      },
      mailboxIdentityHash: 'a'.repeat(64),
      onState: jest.fn(update => {
        states.push(update);
        return Promise.resolve();
      }),
      loadCursor: jest.fn(identity => {
        const key = JSON.stringify(identity);
        if (!cursors.has(key))
          cursors.set(key, { lastUid: null, bootstrapSince: new Date(Date.now() - 86400000) });
        return Promise.resolve({ ...cursors.get(key) });
      }),
      advanceCursor: jest.fn((identity, lastUid) => {
        expect(persisted.has(`${identity.uidValidity}:${lastUid}`)).toBe(true);
        cursors.get(JSON.stringify(identity)).lastUid = lastUid;
        return Promise.resolve();
      }),
      receive: jest.fn(({ emailUid }, identity) => {
        const key = `${identity.uidValidity}:${emailUid}`;
        const created = !persisted.has(key);
        persisted.add(key);
        return Promise.resolve({ created });
      }),
    };
    scanner = createEmailScanner(options);
  });

  afterEach(async () => {
    const stopped = scanner.stop();
    await flush();
    await jest.advanceTimersByTimeAsync(10000);
    await stopped;
    jest.useRealTimers();
  });

  test('已读新邮件由 mail 通知立即收取，UIDNEXT=0 不影响', async () => {
    scanner.start();
    await flush();
    mail.push({ uid: 10, seen: true });
    connections[0].emit('mail', 1);
    await flush();
    expect(persisted.has('1:10')).toBe(true);
    expect(connections[0].search.mock.calls.flat(3)).not.toContain('UNSEEN');
    expect(connections[0].fetch).toHaveBeenCalledWith([10], { bodies: '', markSeen: false });
  });

  test('没有 mail 通知时 30 秒兜底收取，重复触发不重复接收', async () => {
    scanner.start();
    await flush();
    mail.push({ uid: 20, seen: true });
    await jest.advanceTimersByTimeAsync(30000);
    await flush();
    expect(options.receive).toHaveBeenCalledTimes(1);
    connections[0].emit('mail', 1);
    await flush();
    expect(options.receive).toHaveBeenCalledTimes(1);
    expect(connections[0].search).toHaveBeenLastCalledWith([['UID', '21:*']], expect.any(Function));
  });

  test('过滤 IMAP 范围意外返回的旧 UID', async () => {
    mail.push({ uid: 50 });
    scanner.start();
    await flush();
    searchAction = (_criteria, done) => done(null, [50]);
    await scanner.requestScan();
    expect(options.receive).toHaveBeenCalledTimes(1);
  });

  test('繁忙时的补查保留，已读邮件不会退回 UNSEEN 条件', async () => {
    let finish;
    searchAction = (_criteria, done) => {
      finish = done;
    };
    scanner.start();
    await flush();
    await jest.advanceTimersByTimeAsync(15000);
    connections[0].emit('mail', 1);
    searchAction = (_criteria, done) => done(null, [30]);
    finish(null, []);
    await flush();
    expect(persisted.has('1:30')).toBe(true);
    expect(connections[0].search).toHaveBeenCalledTimes(2);
    expect(connections[0].search.mock.calls[1][0][0][0]).toBe('SINCE');
  });

  test('SEARCH 永不回调时超时重连，新连接继续收取，迟到回调无效', async () => {
    let late;
    searchAction = (_criteria, done) => {
      late = done;
    };
    scanner.start();
    await flush();
    await jest.advanceTimersByTimeAsync(30000);
    await flush();
    expect(connections[0].destroy).toHaveBeenCalledTimes(1);
    searchAction = (_criteria, done) => done(null, [40]);
    await jest.advanceTimersByTimeAsync(30000);
    await flush();
    expect(connections).toHaveLength(2);
    expect(persisted.has('1:40')).toBe(true);
    late(null, [999]);
    connections[0].emit('mail', 1);
    connections[0].emit('error', new Error('late'));
    await flush();
    expect(persisted.has('1:999')).toBe(false);
    expect(scanner.getStatus().isConnected).toBe(true);
  });

  test('断线立即取消未返回搜索，不等超时；补查计时不因重连后移', async () => {
    scanner.start();
    await flush();
    await jest.advanceTimersByTimeAsync(10000);
    searchAction = () => {};
    scanner.requestScan();
    await flush();
    connections[0].emit('close', false);
    await flush();
    searchAction = (_criteria, done) => done(null, []);
    await jest.advanceTimersByTimeAsync(30000);
    await flush();
    expect(connections).toHaveLength(2);
    const calls = connections[1].search.mock.calls.length;
    await jest.advanceTimersByTimeAsync(20000);
    await flush();
    expect(connections[1].search.mock.calls.length).toBe(calls + 1);
  });

  test('重启沿用可靠游标，UIDVALIDITY 变化重新回查', async () => {
    mail.push({ uid: 70 });
    scanner.start();
    await flush();
    await scanner.stop();
    scanner = createEmailScanner(options);
    scanner.start();
    await flush();
    expect(connections[1].search.mock.calls[0][0]).toEqual([['UID', '71:*']]);
    validity = 2;
    connections[1].emit('end');
    await jest.advanceTimersByTimeAsync(30000);
    await flush();
    expect(connections[2].search.mock.calls[0][0][0][0]).toBe('SINCE');
    expect(persisted.has('2:70')).toBe(true);
    expect(cursors.size).toBe(2);
  });

  test('部分持久化失败不越过缺口，下次重连幂等补全后才推进', async () => {
    mail = [{ uid: 1 }, { uid: 2 }, { uid: 3 }];
    const receive = options.receive.getMockImplementation();
    options.receive.mockImplementation((...args) => {
      if (args[0].emailUid === 2)
        return Promise.reject(new Error('synthetic database unavailable'));
      return receive(...args);
    });
    scanner.start();
    await flush();
    expect(options.advanceCursor).not.toHaveBeenCalled();
    expect(persisted.has('1:3')).toBe(false);
    options.receive.mockImplementation(receive);
    await jest.advanceTimersByTimeAsync(30000);
    await flush();
    expect([...persisted]).toEqual(['1:1', '1:2', '1:3']);
    expect(options.advanceCursor).toHaveBeenCalledWith(expect.any(Object), 3);
  });

  test('FETCH 无结束或正文无结束时都有截止时间，不推进游标', async () => {
    mail = [{ uid: 80 }];
    fetchAction = () => {
      const fetch = new EventEmitter();
      Promise.resolve().then(() => {
        const msg = new EventEmitter();
        fetch.emit('message', msg, 1);
        fetch.emit('end');
      });
      return fetch;
    };
    scanner.start();
    await flush();
    await jest.advanceTimersByTimeAsync(30000);
    await flush();
    expect(options.advanceCursor).not.toHaveBeenCalled();
    expect(scanner.getStatus().isConnected).toBe(false);
  });

  test('正文流错误不创建接收记录；缺失 UID 不能当作成功', async () => {
    mail = [{ uid: 90 }];
    fetchAction = () => {
      const fetch = new EventEmitter();
      Promise.resolve().then(() => fetch.emit('end'));
      return fetch;
    };
    scanner.start();
    await flush();
    expect(options.receive).not.toHaveBeenCalled();
    expect(options.advanceCursor).not.toHaveBeenCalled();
    expect(scanner.getStatus().isConnected).toBe(false);
  });

  test('已读确认绑定邮箱代际，确认超时会受控重连', async () => {
    scanner.start();
    await flush();
    await expect(
      scanner.addSeenFlag({
        emailUid: 1,
        uidValidity: '2',
        mailboxIdentityHash: options.mailboxIdentityHash,
      })
    ).rejects.toThrow();
    expect(connections[0].addFlags).not.toHaveBeenCalled();
    connections[0].addFlags.mockImplementation(() => {});
    const pending = scanner.addSeenFlag({
      emailUid: 1,
      uidValidity: '1',
      mailboxIdentityHash: options.mailboxIdentityHash,
    });
    const result = expect(pending).rejects.toThrow();
    await jest.advanceTimersByTimeAsync(30000);
    await result;
    expect(scanner.getStatus().isConnected).toBe(false);
  });

  test('停机取消网络等待且不会重连，重复 start 不建立第二个连接', async () => {
    searchAction = () => {};
    scanner.start();
    scanner.start();
    await flush();
    await scanner.stop();
    await jest.advanceTimersByTimeAsync(120000);
    expect(connections).toHaveLength(1);
    expect(scanner.getStatus().isConnected).toBe(false);
  });

  test('批次分片后推进，第二批下载失败不会越过第一批进度', async () => {
    mail = Array.from({ length: 21 }, (_item, i) => ({ uid: i + 1 }));
    fetchAction = uids => {
      if (uids[0] !== 21) return defaultFetch(uids);
      const fetch = new EventEmitter();
      Promise.resolve().then(() => fetch.emit('error', new Error('synthetic fetch failure')));
      return fetch;
    };
    scanner.start(); await flush(); await flush(); await flush();
    expect(connections[0].fetch.mock.calls.map(call => call[0].length)).toEqual([20, 1]);
    expect(options.advanceCursor).toHaveBeenCalledTimes(1);
    expect(options.advanceCursor).toHaveBeenCalledWith(expect.any(Object), 20);
    expect(persisted.has('1:21')).toBe(false);
  });

  test('正文 stream error 立即结束本轮，不保存不完整内容', async () => {
    mail = [{ uid: 90 }];
    fetchAction = () => {
      const fetch = new EventEmitter();
      Promise.resolve().then(() => {
        const msg = new EventEmitter(); const stream = new EventEmitter();
        fetch.emit('message', msg, 1); msg.emit('body', stream);
        stream.emit('error', new Error('synthetic body failure'));
      });
      return fetch;
    };
    scanner.start(); await flush();
    expect(options.receive).not.toHaveBeenCalled();
    expect(scanner.getStatus().isConnected).toBe(false);
  });

  test('UIDVALIDITY 缺失时关闭连接，不能使用 unknown 游标', async () => {
    validity = 0; scanner.start(); await flush();
    expect(options.loadCursor).not.toHaveBeenCalled();
    expect(scanner.getStatus().isConnected).toBe(false);
  });

  test('打开的邮箱代际变化时立即断线，旧已读确认失效', async () => {
    scanner.start(); await flush();
    connections[0].emit('uidvalidity', 2); await flush();
    expect(scanner.getStatus().isConnected).toBe(false);
    await expect(scanner.addSeenFlag({ emailUid: 1, uidValidity: '1', mailboxIdentityHash: options.mailboxIdentityHash })).rejects.toThrow();
  });

  test('异常 UID 搜索响应不用于抓取或推进', async () => {
    searchAction = (_criteria, done) => done(null, ['not-a-uid']);
    scanner.start(); await flush();
    expect(connections[0].fetch).not.toHaveBeenCalled();
    expect(scanner.getStatus().isConnected).toBe(false);
  });

  test('只记录脱敏 BYE 分类，日志不包含认证内容', async () => {
    scanner.start();
    await flush();
    connections[0].config.debug('=> A1 LOGIN private@example.com secret-fixture');
    connections[0].config.debug('<= * BYE Autologout');
    connections[0].emit('end');
    await flush();
    expect(logger.warn).toHaveBeenCalledWith(
      'IMAP 连接结束',
      expect.objectContaining({ reason: 'server_autologout' })
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toMatch(/secret-fixture|private@example/);
  });
});
