const net = require('net');
const { createEmailScanner } = require('../src/services/emailScanner');
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

// 真实 node-imap + 专用回环协议服务器；不读取真实邮箱配置或连接外部网络。
test('真实 IMAP 协议接收已读邮件，UIDNEXT=0，BODY.PEEK 不修改已读状态', async () => {
  const sockets = new Set();
  const commands = [];
  const raw = Buffer.from('Subject: synthetic\r\n\r\nlocal fixture');
  let hasMail = false;
  let cursor = { lastUid: null, bootstrapSince: new Date() };
  let onInitialScan;
  let onReceived;
  const initialScan = new Promise(resolve => {
    onInitialScan = resolve;
  });
  const received = new Promise(resolve => {
    onReceived = resolve;
  });
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    socket.write('* OK local synthetic IMAP\r\n');
    let buffer = '';
    socket.on('data', data => {
      buffer += data.toString();
      while (buffer.includes('\r\n')) {
        const end = buffer.indexOf('\r\n');
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const [tag, verb] = line.split(' ');
        if (verb !== 'LOGIN') commands.push(line);
        if (verb === 'CAPABILITY') socket.write('* CAPABILITY IMAP4rev1 ID\r\n');
        if (verb === 'ID') socket.write('* ID NIL\r\n');
        if (verb === 'LIST') socket.write('* LIST () "/" "INBOX"\r\n');
        if (verb === 'SELECT')
          socket.write(
            '* FLAGS (\\Seen)\r\n* 0 EXISTS\r\n* OK [UIDVALIDITY 7] stable\r\n* OK [UIDNEXT 0] unknown\r\n'
          );
        if (line.includes('UID SEARCH')) socket.write(`* SEARCH${hasMail ? ' 101' : ''}\r\n`);
        if (line.includes('UID FETCH')) {
          socket.write(`* 1 FETCH (UID 101 FLAGS (\\Seen) INTERNALDATE "09-Sep-2026 05:00:00 +0800" BODY[] {${raw.length}}\r\n`);
          socket.write(raw);
          socket.write(')\r\n');
        }
        socket.write(`${tag} OK complete\r\n`);
      }
    });
  });
  const wait = promise => {
    let timer;
    return Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                JSON.stringify({
                  commands,
                  errors: require('../src/utils/logger').error.mock.calls,
                })
              )
            ),
          2000
        );
      }),
    ]).finally(() => clearTimeout(timer));
  };
  let scanner;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    scanner = createEmailScanner({
      imapConfig: {
        host: '127.0.0.1',
        port: server.address().port,
        tls: false,
        user: 'fixture',
        password: 'fixture',
        mailbox: 'INBOX',
      },
      mailboxIdentityHash: 'a'.repeat(64),
      loadCursor: () => Promise.resolve({ ...cursor }),
      advanceCursor: (_identity, uid) => {
        cursor.lastUid = uid;
        return Promise.resolve();
      },
      onState: state => {
        if (state.lastScanSucceededAt) onInitialScan();
        return Promise.resolve();
      },
      receive: message => {
        onReceived(message);
        return Promise.resolve({ created: true });
      },
    });
    scanner.start();
    await wait(initialScan);
    hasMail = true;
    for (const socket of sockets) socket.write('* 1 EXISTS\r\n');
    const message = await wait(received);
    expect(message.emailUid).toBe(101);
    expect(message.rawBuffer.equals(raw)).toBe(true);
    await wait(scanner.requestScan('verification'));
    expect(cursor.lastUid).toBe(101);
    expect(commands.some(line => line.includes('BODY.PEEK[]'))).toBe(true);
    expect(commands.some(line => line.includes('UNSEEN'))).toBe(false);
  } finally {
    await scanner?.stop();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
}, 10000);
