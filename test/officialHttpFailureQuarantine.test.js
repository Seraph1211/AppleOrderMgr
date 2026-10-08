/* eslint-disable no-magic-numbers -- 私密失败链合成测试，不连接数据库或官网。 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { encrypt, decrypt, proxyFingerprint } = require('../src/services/officialOrderSupport');
const {
  verifyHttpFailureQuarantine,
} = require('../scripts/officialPickupBackfill/verifyHttpFailureQuarantine');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
let root;
let now;
let proof;
let audit;
let plan;
let urls;
let key;
let proofName;
const write = (relative, value) => {
  const filename = path.join(root, relative);
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    filename,
    Buffer.isBuffer(value) || typeof value === 'string' ? value : JSON.stringify(value),
    { mode: 0o600 }
  );
};
const verify = (replayClosed = false) => {
  write(`private/${proofName}`, proof);
  const bytes = fs.readFileSync(path.join(root, 'private', proofName));
  return verifyHttpFailureQuarantine(root, proofName, hash(bytes), now, replayClosed);
};
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'http-failure-quarantine-'));
  now = Math.floor(Date.now() / 1000);
  const iso = offset => new Date((now + offset) * 1000).toISOString();
  key = crypto.randomBytes(32);
  const attempt = 'a'.repeat(32);
  const order = 'W1234567890';
  urls = ['www', 'secure7.www', 'secure8.www'].map(
    (host, index) =>
      `https://${host}.apple.com.cn/shop/order/${index ? 'guest' : 'list'}/${order}/owner%40example.test`
  );
  plan = {
    schemaVersion: 3,
    scope: 'missing-fields',
    cutoff: null,
    policy: { loginCooldown: true, apiHealthCheck: true, proxy541Limit: 3 },
    entries: [
      {
        id: 426,
        orderNumber: order,
        rowHash: 'b'.repeat(32),
        previousDate: null,
        previousDevices: [],
      },
    ],
  };
  write('private/plan.json', plan);
  const proxy = { host: 'synthetic.test', port: 1234, username: 'user', password: 'private' };
  write('private/iproyal-cn.json', { entries: [proxy] });
  write('private/request-426.json', {
    samples: [{ id: 426, orderNumber: order, url: urls[0], accountHash: 'c'.repeat(64) }],
  });
  write('private/evidence.key', key);
  audit = {
    outcome: 'EGRESS_CHANGED_OR_UNVERIFIED',
    originalOutcome: 'HTTP_541',
    runId: 959,
    requests: 3,
    egressAfterError: 'RUNTIME_COMMAND_FAILED',
    attemptId: attempt,
    targetOrderId: 426,
    proxyIndex: 0,
    startedAt: now - 30,
    finishedAt: now - 19,
    elapsedSeconds: 11,
    egressHash: 'd'.repeat(64),
    egressAfterHash: null,
    egressVerifiedAfter: false,
    businessWrites: 0,
    cleanup: { attempted: true, removed: true, outcome: 'REMOVED' },
    containerName: `apple-official-http-sample-${attempt}`,
  };
  write(`private/http-sample-426-${attempt}.json`, audit);
  const events = [];
  for (let index = 0; index < 3; index++) {
    write(
      `evidence/run-959/request-${index + 1}.enc`,
      encrypt(
        {
          url: urls[index],
          method: 'GET',
          headers: {},
          body: null,
          observedAt: iso(-28 + index * 2),
        },
        key
      )
    );
    if (index === 2) continue;
    // 与真实 303 的空正文一致，密文仅包含 12 字节 IV 和 16 字节认证标签。
    const body = Buffer.alloc(0);
    const file = `body-${index + 1}-${hash(body).slice(0, 16)}.enc`;
    const response = {
      status: 303,
      url: urls[index],
      rawHeaders: [['Location', urls[index + 1]]],
      cookies: [],
      bodyBase64: body.toString('base64'),
    };
    write(`evidence/run-959/response-${index + 1}.enc`, encrypt(response, key));
    write(`evidence/run-959/${file}`, encrypt(body, key));
    events.push({
      message: 'http_response',
      method: 'GET',
      status: 303,
      runId: 959,
      urlHash: hash(urls[index]),
      file,
      sha256: hash(body),
      bytes: body.length,
      observedAt: iso(-27 + index * 2),
    });
  }
  write(
    'evidence/run-959/events.jsonl',
    events.map(event => JSON.stringify(event)).join('\n') + '\n'
  );
  proofName = `http-failure-proof-426-${attempt}.json`;
  proof = {
    version: 1,
    kind: 'HTTP_FAILURE_QUARANTINE',
    planSha256: hash(fs.readFileSync(path.join(root, 'private/plan.json'))),
    orderId: 426,
    runId: 959,
    batchAttemptId: 'e'.repeat(32),
    sampleAttemptId: attempt,
    sampleAuditSha256: hash(
      fs.readFileSync(path.join(root, `private/http-sample-426-${attempt}.json`))
    ),
    observedAt: now - 1,
    business: {
      queriedAt: now - 10,
      database: 'production',
      row: {
        id: 426,
        orderNumber: order,
        rowHash: 'b'.repeat(32),
        actualPickupDate: null,
        devices: [],
      },
    },
    research: {
      queriedAt: now - 9,
      database: 'research',
      run: {
        id: 959,
        sampleId: 426,
        mode: 'collect',
        outcome: 'HTTP_541',
        requests: 3,
        startedAt: iso(-29),
        finishedAt: iso(-20),
      },
      attempts: [
        {
          runId: 959,
          orderHash: hash(order),
          accountHash: 'c'.repeat(64),
          proxyHash: proxyFingerprint({ ...proxy, provider: 'iproyal' }),
          loginAt: null,
        },
      ],
    },
  };
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test('历史回放读取封存旧输入，保持原相对路径摘要且拒绝归档篡改', () => {
  const closed = verify();
  const original = fs.readFileSync(path.join(root, 'private/request-426.json'));
  const archived = `private/http-quarantine-input-426-${proof.sampleAttemptId}.json`;
  write(archived, original);
  write('private/request-426.json', { capturedAt: 'new', samples: [] });
  expect(verify(true)).toEqual(closed);
  expect(() => verify()).toThrow();
  write(archived, { samples: [] });
  expect(() => verify(true)).toThrow();
});

test('精确失败链核验只返回隔离证据摘要，不捏造第三响应或出口成功', () => {
  const result = verify();
  expect(result).toMatchObject({
    outcome: 'HTTP_FAILURE_QUARANTINE_VERIFIED',
    orderId: 426,
    runId: 959,
  });
  expect(Object.keys(result.files)).toHaveLength(12);
  expect(result).not.toHaveProperty('egressVerifiedAfter');
  expect(result).not.toHaveProperty('egressAfterHash');
  expect(JSON.stringify(result)).not.toMatch(/owner|private-cookie|W1234567890/);
  expect(fs.existsSync(path.join(root, 'evidence/run-959/response-3.enc'))).toBe(false);
});

test('两个空正文 303 的最短认证密文均可验证，空正文摘要仍绑定原始事件', () => {
  const directory = path.join(root, 'evidence/run-959');
  const files = fs.readdirSync(directory).filter(name => name.startsWith('body-'));
  expect(files).toHaveLength(2);
  for (const filename of files) {
    expect(fs.readFileSync(path.join(directory, filename))).toHaveLength(28);
  }
  const events = fs.readFileSync(path.join(directory, 'events.jsonl'), 'utf8').trim().split('\n');
  expect(events.map(event => JSON.parse(event).bytes)).toEqual([0, 0]);
  expect(verify().outcome).toBe('HTTP_FAILURE_QUARANTINE_VERIFIED');
});

test.each(['tag', 'truncated'])('空正文证据 %s 损坏不能用于失败隔离', kind => {
  const file = `evidence/run-959/body-1-${hash(Buffer.alloc(0)).slice(0, 16)}.enc`;
  let encrypted = fs.readFileSync(path.join(root, file));
  if (kind === 'tag') encrypted[12] ^= 1;
  if (kind === 'truncated') encrypted = encrypted.subarray(0, 27);
  write(file, encrypted);
  expect(verify).toThrow('HTTP_QUARANTINE_EVIDENCE_INVALID');
});

test.each([
  [
    '过期',
    value => {
      value.observedAt = now - 301;
    },
  ],
  [
    '未来',
    value => {
      value.observedAt = now + 1;
    },
  ],
  [
    '订单行变化',
    value => {
      value.business.row.rowHash = 'f'.repeat(32);
    },
  ],
  [
    '日期变化',
    value => {
      value.business.row.actualPickupDate = '2026-09-01';
    },
  ],
  [
    '设备变化',
    value => {
      value.business.row.devices.push({ id: 1 });
    },
  ],
  [
    '研究未结束',
    value => {
      value.research.run.finishedAt = null;
    },
  ],
  [
    '研究成功',
    value => {
      value.research.run.outcome = 'SUCCEEDED';
    },
  ],
  [
    '研究计数变动',
    value => {
      value.research.run.requests = 4;
    },
  ],
  [
    '另一订单',
    value => {
      value.research.run.sampleId = 427;
    },
  ],
  [
    '重复attempt',
    value => {
      value.research.attempts.push(value.research.attempts[0]);
    },
  ],
  [
    '已提交密码',
    value => {
      value.research.attempts[0].loginAt = new Date().toISOString();
    },
  ],
  [
    '账号不符',
    value => {
      value.research.attempts[0].accountHash = 'f'.repeat(64);
    },
  ],
  [
    '出口配置不符',
    value => {
      value.research.attempts[0].proxyHash = 'f'.repeat(64);
    },
  ],
  [
    '数据库同源',
    value => {
      value.business.database = 'research';
    },
  ],
  [
    '额外证明字段',
    value => {
      value.businessWrites = 0;
    },
  ],
])('证明不能绕过失败边界：%s', (_label, mutate) => {
  mutate(proof);
  expect(verify).toThrow('HTTP_QUARANTINE_EVIDENCE_INVALID');
});

test('明确超时终态仅在研究运行与三次只读请求证据一致时允许隔离', () => {
  audit.originalOutcome = 'HTTP_TIMEOUT';
  write(`private/http-sample-426-${proof.sampleAttemptId}.json`, audit);
  proof.sampleAuditSha256 = hash(
    fs.readFileSync(path.join(root, `private/http-sample-426-${proof.sampleAttemptId}.json`))
  );
  proof.research.run.outcome = 'HTTP_TIMEOUT';
  expect(verify().outcome).toBe('HTTP_FAILURE_QUARANTINE_VERIFIED');
  expect(fs.existsSync(path.join(root, 'evidence/run-959/response-3.enc'))).toBe(false);
});

test('三GET连接失败且后验未知，沿用原两次303密文链', () => {
  audit.originalOutcome = 'PROXY_CONNECTION_FAILED';
  proof.research.run.outcome = audit.originalOutcome;
  write(`private/http-sample-426-${proof.sampleAttemptId}.json`, audit);
  proof.sampleAuditSha256 = hash(
    fs.readFileSync(path.join(root, `private/http-sample-426-${proof.sampleAttemptId}.json`))
  );
  expect(verify().outcome).toBe('HTTP_FAILURE_QUARANTINE_VERIFIED');
  proof.research.run.outcome = 'HTTP_TIMEOUT';
  expect(() => verify()).toThrow();
});

test.each([
  ['HTTP_TIMEOUT', 'HTTP_541'],
  ['HTTP_541', 'HTTP_TIMEOUT'],
])('不同失败终态不能相互替代：%s / %s', (sampleOutcome, runOutcome) => {
  audit.originalOutcome = sampleOutcome;
  write(`private/http-sample-426-${proof.sampleAttemptId}.json`, audit);
  proof.sampleAuditSha256 = hash(
    fs.readFileSync(path.join(root, `private/http-sample-426-${proof.sampleAttemptId}.json`))
  );
  proof.research.run.outcome = runOutcome;
  expect(verify).toThrow('HTTP_QUARANTINE_EVIDENCE_INVALID');
});

test.each(['SUCCEEDED', 'STATE_WRITE_FAILED', 'COLLECTOR_TIMEOUT', 'HTTP_TRANSPORT_FAILED'])(
  '采样原结果%s不能隔离',
  outcome => {
    audit.originalOutcome = outcome;
    write(`private/http-sample-426-${proof.sampleAttemptId}.json`, audit);
    proof.sampleAuditSha256 = hash(
      fs.readFileSync(path.join(root, `private/http-sample-426-${proof.sampleAttemptId}.json`))
    );
    expect(verify).toThrow('HTTP_QUARANTINE_EVIDENCE_INVALID');
  }
);

test.each(['post', 'wrong-url', 'response-extra', 'cipher', 'event', 'permissions', 'symlink'])(
  '密文/原文链不明时拒绝：%s',
  kind => {
    const request = {
      url: urls[2],
      method: 'GET',
      headers: {},
      body: null,
      observedAt: new Date((now - 24) * 1000).toISOString(),
    };
    if (kind === 'post') request.method = 'POST';
    if (kind === 'wrong-url') request.url = 'https://www.apple.com.cn/shop/order/guest/another';
    if (['post', 'wrong-url'].includes(kind))
      write('evidence/run-959/request-3.enc', encrypt(request, key));
    if (kind === 'response-extra')
      write('evidence/run-959/response-3.enc', encrypt({ status: 541 }, key));
    if (kind === 'cipher') write('evidence/run-959/request-3.enc', Buffer.from('invalid'));
    if (kind === 'event') write('evidence/run-959/events.jsonl', '{}\n');
    const filename = path.join(root, 'evidence/run-959/request-3.enc');
    if (kind === 'permissions') fs.chmodSync(filename, 0o644);
    if (kind === 'symlink') {
      fs.renameSync(filename, `${filename}.old`);
      fs.symlinkSync(`${filename}.old`, filename);
    }
    expect(verify).toThrow('HTTP_QUARANTINE_EVIDENCE_INVALID');
  }
);

const persistAudit = () => {
  const filename = `private/http-sample-426-${proof.sampleAttemptId}.json`;
  write(filename, audit);
  proof.sampleAuditSha256 = hash(fs.readFileSync(path.join(root, filename)));
};
const readEncrypted = filename =>
  JSON.parse(decrypt(fs.readFileSync(path.join(root, 'evidence/run-959', filename)), key));
const changeRequest = (index, mutate) => {
  const request = readEncrypted(`request-${index}.enc`);
  mutate(request);
  write(`evidence/run-959/request-${index}.enc`, encrypt(request, key));
};
const changeResponse = (index, mutate) => {
  const response = readEncrypted(`response-${index}.enc`);
  mutate(response);
  write(`evidence/run-959/response-${index}.enc`, encrypt(response, key));
};
const readEvents = () =>
  fs
    .readFileSync(path.join(root, 'evidence/run-959/events.jsonl'), 'utf8')
    .trimEnd()
    .split('\n')
    .map(line => JSON.parse(line));
const saveEvents = events =>
  write(
    'evidence/run-959/events.jsonl',
    events.map(event => JSON.stringify(event)).join('\n') + '\n'
  );
const replaceBody = (index, text) => {
  const body = Buffer.from(text);
  const events = readEvents();
  fs.unlinkSync(path.join(root, 'evidence/run-959', events[index - 1].file));
  const filename = `body-${index}-${hash(body).slice(0, 16)}.enc`;
  write(`evidence/run-959/${filename}`, encrypt(body, key));
  changeResponse(index, response => {
    response.bodyBase64 = body.toString('base64');
  });
  Object.assign(events[index - 1], { file: filename, sha256: hash(body), bytes: body.length });
  saveEvents(events);
};

describe('第四次只读挑战连接失败且实际出口变化', () => {
  beforeEach(() => {
    audit.originalOutcome = 'PROXY_CONNECTION_FAILED';
    audit.requests = 4;
    delete audit.egressAfterError;
    audit.egressAfterHash = 'f'.repeat(64);
    persistAudit();
    proof.research.run.outcome = 'PROXY_CONNECTION_FAILED';
    proof.research.run.requests = 4;
    write('private/http-rejected-egress.json', [audit.egressHash, audit.egressAfterHash]);
    urls.push(new URL('/shop/shld/work/v2_1/q', urls[2]).href);
    write(
      'evidence/run-959/request-4.enc',
      encrypt(
        {
          url: urls[3],
          method: 'GET',
          headers: { Referer: urls[2] },
          body: null,
          observedAt: new Date((now - 22) * 1000).toISOString(),
        },
        key
      )
    );
    const body = Buffer.from(
      '<html><script id="shldVerify" src="/shop/shld/v2_1/verify.js"></script></html>'
    );
    const file = `body-3-${hash(body).slice(0, 16)}.enc`;
    write(
      'evidence/run-959/response-3.enc',
      encrypt(
        {
          status: 200,
          url: urls[2],
          rawHeaders: [['Content-Type', 'text/html; charset=utf-8']],
          cookies: [],
          bodyBase64: body.toString('base64'),
        },
        key
      )
    );
    write(`evidence/run-959/${file}`, encrypt(body, key));
    const events = readEvents();
    events.push({
      message: 'http_response',
      method: 'GET',
      status: 200,
      runId: 959,
      urlHash: hash(urls[2]),
      file,
      sha256: hash(body),
      bytes: body.length,
      observedAt: new Date((now - 23) * 1000).toISOString(),
    });
    saveEvents(events);
  });

  test('第四请求连接失败且后验未知保留null，不伪造出口变化', () => {
    audit.egressAfterHash = null;
    audit.egressAfterError = 'RUNTIME_COMMAND_FAILED';
    write(`private/http-sample-426-${audit.attemptId}.json`, audit);
    proof.sampleAuditSha256 = hash(
      fs.readFileSync(path.join(root, `private/http-sample-426-${audit.attemptId}.json`))
    );
    expect(verify().egressAfterHash).toBeNull();
  });

  test('四次 GET、303/303/200 和原文发现的挑战绑定实际前后出口，不产生成功制品', () => {
    const before = fs.readdirSync(path.join(root, 'evidence/run-959')).sort();
    const result = verify();
    expect(result).toMatchObject({
      outcome: 'HTTP_FAILURE_QUARANTINE_VERIFIED',
      orderId: 426,
      runId: 959,
      egressHash: audit.egressHash,
      egressAfterHash: audit.egressAfterHash,
    });
    expect(result.files).not.toHaveProperty('private/http-rejected-egress.json');
    expect(Object.keys(result.files)).toHaveLength(15);
    expect(fs.readdirSync(path.join(root, 'evidence/run-959')).sort()).toEqual(before);
    expect(before).toHaveLength(11);
    expect(before).not.toContain('response-4.enc');
    expect(result).not.toHaveProperty('egressVerifiedAfter');
    expect(JSON.stringify(result)).not.toMatch(/owner|private-cookie|W1234567890|Referer|https:/);
  });

  test('拒用台账追加其他出口不改变已绑定原证据的回放结果', () => {
    const first = verify();
    write('private/http-rejected-egress.json', [
      audit.egressHash,
      audit.egressAfterHash,
      '1'.repeat(64),
    ]);
    expect(verify()).toEqual(first);
  });

  test.each([
    [
      '三次请求',
      value => {
        value.requests = 3;
      },
    ],
    [
      '五次请求',
      value => {
        value.requests = 5;
      },
    ],
    [
      '其他失败',
      value => {
        value.originalOutcome = 'HTTP_TIMEOUT';
      },
    ],
    [
      '成功',
      value => {
        value.outcome = 'SUCCEEDED';
      },
    ],
    [
      '后探测缺失',
      value => {
        value.egressAfterHash = null;
      },
    ],
    [
      '相同出口',
      value => {
        value.egressAfterHash = value.egressHash;
      },
    ],
    [
      '后探测错误字段',
      value => {
        value.egressAfterError = 'RUNTIME_COMMAND_FAILED';
      },
    ],
    [
      '无效后摘要',
      value => {
        value.egressAfterHash = 'unknown';
      },
    ],
    [
      '伪装出口成功',
      value => {
        value.egressVerifiedAfter = true;
      },
    ],
    [
      '业务写入',
      value => {
        value.businessWrites = 1;
      },
    ],
    [
      '清理未确认',
      value => {
        value.cleanup.removed = false;
      },
    ],
  ])('审计不满足独立窄分支时拒绝：%s', (_label, mutate) => {
    mutate(audit);
    persistAudit();
    expect(verify).toThrow('HTTP_QUARANTINE_EVIDENCE_INVALID');
  });

  test.each(['before', 'after', 'invalid', 'missing'])('实际出口拒用检查不能省略：%s', kind => {
    const file = 'private/http-rejected-egress.json';
    if (kind === 'missing') fs.unlinkSync(path.join(root, file));
    else
      write(
        file,
        kind === 'invalid' ? {} : [kind === 'before' ? audit.egressAfterHash : audit.egressHash]
      );
    expect(verify).toThrow('HTTP_QUARANTINE_EVIDENCE_INVALID');
  });

  test.each([
    'results/order-426-run-1000.json',
    'http-receipt-426-run-1000.json',
    'receipt-probe-426.json',
    'http-apply-426-other.json',
    'http-apply-basis-426-run-1000.json',
    'browser-receipt-bind-426-other.json',
    'http-apply-intent-426.json',
    'browser-receipt-bind-intent-426.json',
  ])('已有成功或写入制品时不隔离：%s', filename => {
    write(`private/${filename}`, {});
    expect(verify).toThrow('HTTP_QUARANTINE_EVIDENCE_INVALID');
  });

  test('未决意图即使是断开的符号链接也不能伪装为不存在', () => {
    fs.symlinkSync('absent-target', path.join(root, 'private/http-apply-intent-426.json'));
    expect(verify).toThrow('HTTP_QUARANTINE_EVIDENCE_INVALID');
  });

  test.each([1, 2, 3, 4])('第 %i 次请求不能改成 POST', index => {
    changeRequest(index, request => {
      request.method = 'POST';
    });
    expect(verify).toThrow('HTTP_QUARANTINE_EVIDENCE_INVALID');
  });

  test.each([1, 2, 3, 4])('第 %i 次请求正文必须为空', index => {
    changeRequest(index, request => {
      request.body = 'payload';
    });
    expect(verify).toThrow('HTTP_QUARANTINE_EVIDENCE_INVALID');
  });

  test.each([
    ['缺少', {}],
    ['另一来源', { Referer: 'https://www.apple.com.cn/shop/order/guest/other' }],
    ['另一大小写', { referer: 'current' }],
    ['额外请求头', { Referer: 'current', Authorization: 'synthetic' }],
  ])('挑战请求精确来源头拒绝：%s', (_label, headers) => {
    const changed = { ...headers };
    for (const key of Object.keys(changed)) if (changed[key] === 'current') changed[key] = urls[2];
    changeRequest(4, request => {
      request.headers = changed;
    });
    expect(verify).toThrow('HTTP_QUARANTINE_EVIDENCE_INVALID');
  });

  test.each([1, 2, 3])('第 %i 次 GET 不能携带额外认证或来源头', index => {
    changeRequest(index, request => {
      request.headers = { Referer: urls[0] };
    });
    expect(verify).toThrow('HTTP_QUARANTINE_EVIDENCE_INVALID');
  });

  test.each([
    ['缺少挑战脚本', '<html></html>'],
    ['重复挑战脚本', '<script id="shldVerify" src="/shop/shld/v2_1/verify.js"></script>'.repeat(2)],
    [
      '另一个官方分片',
      '<script id="shldVerify" src="https://secure9.www.apple.com.cn/shop/shld/v2_1/verify.js"></script>',
    ],
    [
      '非官方来源',
      '<script id="shldVerify" src="https://example.test/shop/shld/v2_1/verify.js"></script>',
    ],
    ['查询参数', '<script id="shldVerify" src="/shop/shld/v2_1/verify.js?extra=1"></script>'],
    ['片段', '<script id="shldVerify" src="/shop/shld/v2_1/verify.js#extra"></script>'],
    ['另一个版本', '<script id="shldVerify" src="/shop/shld/v9_9/verify.js"></script>'],
  ])('即使正文摘要全部重算也拒绝非原生同源挑战：%s', (_label, body) => {
    replaceBody(3, body);
    expect(verify).toThrow('HTTP_QUARANTINE_EVIDENCE_INVALID');
  });

  test.each([1, 2])('第 %i 个跳转只接受已确认的空正文形状', index => {
    replaceBody(index, '<html>other</html>');
    expect(verify).toThrow('HTTP_QUARANTINE_EVIDENCE_INVALID');
  });

  test('200 正文不能携带另一个跳转目的地', () => {
    changeResponse(3, response => {
      response.rawHeaders.push(['Location', urls[3]]);
    });
    expect(verify).toThrow('HTTP_QUARANTINE_EVIDENCE_INVALID');
  });

  test('其他目标的已保存结果不被误认为本订单的未知写入', () => {
    write('private/results/order-4260-run-1000.json', {});
    write('private/http-apply-intent-427.json', {});
    expect(verify().outcome).toBe('HTTP_FAILURE_QUARANTINE_VERIFIED');
  });

  test.each([
    'status',
    'location',
    'url',
    'extra-response',
    'extra-request',
    'third-body-tag',
    'event-hash',
    'event-run',
    'event-time',
    'late-request',
  ])('响应和原始事件链仍须精确：%s', kind => {
    if (kind === 'status')
      changeResponse(3, response => {
        response.status = 541;
      });
    if (kind === 'location')
      changeResponse(2, response => {
        response.rawHeaders = [['Location', urls[0]]];
      });
    if (kind === 'url')
      changeResponse(3, response => {
        response.url = urls[0];
      });
    if (kind === 'extra-response')
      write('evidence/run-959/response-4.enc', encrypt({ status: 200 }, key));
    if (kind === 'extra-request')
      write('evidence/run-959/request-5.enc', encrypt({ method: 'POST' }, key));
    if (kind === 'third-body-tag') {
      const file = readEvents()[2].file;
      const bytes = fs.readFileSync(path.join(root, 'evidence/run-959', file));
      bytes[12] ^= 1;
      write(`evidence/run-959/${file}`, bytes);
    }
    if (kind.startsWith('event-')) {
      const events = readEvents();
      if (kind === 'event-hash') events[2].sha256 = '0'.repeat(64);
      if (kind === 'event-run') events[2].runId = 960;
      if (kind === 'event-time') events[2].observedAt = new Date((now - 21) * 1000).toISOString();
      saveEvents(events);
    }
    if (kind === 'late-request')
      changeRequest(4, request => {
        request.observedAt = new Date((now - 18) * 1000).toISOString();
      });
    expect(verify).toThrow('HTTP_QUARANTINE_EVIDENCE_INVALID');
  });

  test.each([
    'count',
    'outcome',
    'attempt',
    'password',
    'order',
    'account',
    'proxy',
    'baseline',
    'freshness',
  ])('研究和业务原值证明不因新分支而降低：%s', kind => {
    if (kind === 'count') proof.research.run.requests = 3;
    if (kind === 'outcome') proof.research.run.outcome = 'HTTP_TIMEOUT';
    if (kind === 'attempt') proof.research.attempts.push({ ...proof.research.attempts[0] });
    if (kind === 'password') proof.research.attempts[0].loginAt = proof.research.run.startedAt;
    if (kind === 'order') proof.research.attempts[0].orderHash = '0'.repeat(64);
    if (kind === 'account') proof.research.attempts[0].accountHash = '0'.repeat(64);
    if (kind === 'proxy') proof.research.attempts[0].proxyHash = '0'.repeat(64);
    if (kind === 'baseline') proof.business.row.rowHash = '0'.repeat(32);
    if (kind === 'freshness') proof.business.queriedAt = now - 301;
    expect(verify).toThrow('HTTP_QUARANTINE_EVIDENCE_INVALID');
  });
});

describe('首303后八次guest自重定向的只读失败', () => {
  const notice =
    '<html>\r\n<head><title>307 Temporary Redirect</title></head>\r\n<body>\r\n' +
    '<center><h1>307 Temporary Redirect</h1></center>\r\n<hr><center>Apple</center>\r\n' +
    '</body>\r\n</html>\r\n';
  beforeEach(() => {
    audit.originalOutcome = 'REDIRECT_LIMIT';
    audit.requests = 9;
    persistAudit();
    proof.research.run.outcome = 'REDIRECT_LIMIT';
    proof.research.run.requests = 9;
    write('private/http-rejected-egress.json', [audit.egressHash]);
    const order = plan.entries[0].orderNumber;
    const first = `https://www.apple.com.cn/xc/cn/vieworder/${order}/synthetic-token`;
    const guest = `https://secure7.www.apple.com.cn/shop/order/guest/${order}/synthetic-token?e=true`;
    urls = [first, ...Array(8).fill(guest)];
    write('private/request-426.json', {
      samples: [{ id: 426, orderNumber: order, url: first, accountHash: 'c'.repeat(64) }],
    });
    fs.rmSync(path.join(root, 'evidence/run-959'), { recursive: true });
    const events = [];
    urls.forEach((url, index) => {
      const observedAt = new Date((now - 28.5 + index * 0.8) * 1000).toISOString();
      write(
        `evidence/run-959/request-${index + 1}.enc`,
        encrypt(
          {
            url,
            method: 'GET',
            headers: {},
            body: null,
            observedAt,
          },
          key
        )
      );
      const status = index === 0 ? 303 : 307;
      const body = Buffer.from(index === 0 ? '' : notice);
      const file = `body-${index + 1}-${hash(body).slice(0, 16)}.enc`;
      write(
        `evidence/run-959/response-${index + 1}.enc`,
        encrypt(
          {
            status,
            url,
            rawHeaders: [
              ['Location', guest],
              ['Content-Type', 'text/html'],
            ],
            headers: { location: guest, 'content-type': 'text/html' },
            cookies: [],
            bodyBase64: body.toString('base64'),
          },
          key
        )
      );
      write(`evidence/run-959/${file}`, encrypt(body, key));
      events.push({
        message: 'http_response',
        method: 'GET',
        status,
        runId: 959,
        urlHash: hash(url),
        file,
        sha256: hash(body),
        bytes: body.length,
        observedAt: new Date((now - 28.25 + index * 0.8) * 1000).toISOString(),
      });
    });
    saveEvents(events);
  });

  test('完整28文件只封存失败摘要，拒用追加可回放且无出口成功或业务完成', () => {
    const result = verify();
    expect(Object.keys(result.files).filter(name => name.startsWith('evidence/'))).toHaveLength(28);
    expect(result).toMatchObject({
      outcome: 'HTTP_FAILURE_QUARANTINE_VERIFIED',
      orderId: 426,
      runId: 959,
    });
    expect(result).not.toHaveProperty('egressAfterHash');
    expect(result).not.toHaveProperty('egressVerifiedAfter');
    expect(result.files).not.toHaveProperty('private/http-rejected-egress.json');
    expect(JSON.stringify(result)).not.toMatch(/W1234567890|synthetic-token|https:/);
    write('private/http-rejected-egress.json', [audit.egressHash, 'f'.repeat(64)]);
    expect(verify()).toEqual(result);
  });

  test('安全通知允许LF换行但不按固定正文长度或SHA判定', () => {
    for (let index = 2; index <= 9; index++) replaceBody(index, notice.replace(/\r\n/g, '\n'));
    expect(verify().outcome).toBe('HTTP_FAILURE_QUARANTINE_VERIFIED');
  });

  test.each([
    ['terminal', 'HTTP_TIMEOUT'],
    ['terminal', 'HTTP_541'],
    ['terminal', 'SUCCEEDED'],
    ['requests', 8],
    ['requests', 10],
    ['requests', true],
    ['after', 'f'.repeat(64)],
    ['afterError', 'HTTP_TIMEOUT'],
    ['verified', true],
  ])('九GET不能借用其他末态/出口形状：%s/%s', (kind, value) => {
    if (kind === 'terminal') {
      audit.originalOutcome = value;
      proof.research.run.outcome = value;
    }
    if (kind === 'requests') {
      audit.requests = value;
      proof.research.run.requests = value;
    }
    if (kind === 'after') audit.egressAfterHash = value;
    if (kind === 'afterError') audit.egressAfterError = value;
    if (kind === 'verified') audit.egressVerifiedAfter = value;
    persistAudit();
    expect(verify).toThrow('HTTP_QUARANTINE_EVIDENCE_INVALID');
  });

  test.each([
    'post',
    'body',
    'header',
    'extra-key',
    'first-path',
    'first-query',
    'guest-query',
    'guest-order',
    'guest-change',
    'signin',
    'late',
  ])('请求仍精确限定：%s', kind => {
    const index = kind.startsWith('first') ? 1 : 9;
    changeRequest(index, request => {
      if (kind === 'post') request.method = 'POST';
      if (kind === 'body') request.body = '';
      if (kind === 'header') request.headers = { Referer: urls[0] };
      if (kind === 'extra-key') request.action = 'read';
      if (kind === 'first-path')
        request.url = request.url.replace('/xc/cn/vieworder/', '/shop/order/list/');
      if (kind === 'first-query') request.url += '?e=true';
      if (kind === 'guest-query') request.url = request.url.replace('?e=true', '');
      if (kind === 'guest-order') request.url = request.url.replace('W1234567890', 'W9999999999');
      if (kind === 'guest-change') request.url = request.url.replace('secure7', 'secure8');
      if (kind === 'signin') request.url = 'https://secure7.www.apple.com.cn/shop/signIn/account';
      if (kind === 'late') request.observedAt = new Date((now - 18) * 1000).toISOString();
    });
    expect(verify).toThrow('HTTP_QUARANTINE_EVIDENCE_INVALID');
  });

  test.each([
    'last-200',
    'last-303',
    'first-307',
    'url',
    'missing-location',
    'duplicate-location',
    'normalized-mismatch',
    'normalized-duplicate',
    'relative-self',
    'different-location',
    'content-type',
    'extra-response',
    'missing-response',
    'cipher',
    'body-hash',
    'event-count',
    'event-late',
  ])('响应密文/重定向/时序仍完整：%s', kind => {
    if (kind === 'first-307')
      changeResponse(1, value => {
        value.status = 307;
      });
    if (kind === 'extra-response') write('evidence/run-959/response-10.enc', encrypt({}, key));
    if (kind === 'missing-response')
      fs.unlinkSync(path.join(root, 'evidence/run-959/response-9.enc'));
    if (kind === 'cipher') write('evidence/run-959/response-9.enc', Buffer.alloc(28));
    if (kind === 'body-hash')
      write(`evidence/run-959/${readEvents()[8].file}`, encrypt('bad', key));
    if (kind.startsWith('event')) {
      const events = readEvents();
      if (kind === 'event-count') events.pop();
      else events[8].observedAt = new Date((now - 19) * 1000).toISOString();
      saveEvents(events);
    } else if (
      !['first-307', 'extra-response', 'missing-response', 'cipher', 'body-hash'].includes(kind)
    ) {
      changeResponse(9, value => {
        if (kind === 'last-200') value.status = 200;
        if (kind === 'last-303') value.status = 303;
        if (kind === 'url') value.url = urls[0];
        if (kind === 'missing-location') value.rawHeaders.shift();
        if (kind === 'duplicate-location') value.rawHeaders.push(['location', urls[1]]);
        if (kind === 'normalized-mismatch') value.headers.location = urls[0];
        if (kind === 'normalized-duplicate') value.headers.Location = urls[1];
        if (kind === 'relative-self') {
          value.rawHeaders[0][1] = new URL(urls[1]).pathname + '?e=true';
          value.headers.location = value.rawHeaders[0][1];
        }
        if (kind === 'different-location') {
          value.rawHeaders[0][1] = urls[0];
          value.headers.location = urls[0];
        }
        if (kind === 'content-type') {
          value.rawHeaders[1][1] = 'application/json';
          value.headers['content-type'] = 'application/json';
        }
      });
    }
    expect(verify).toThrow('HTTP_QUARANTINE_EVIDENCE_INVALID');
  });

  test.each(['first-body', 'script', 'form', 'model', 'all-other', 'different-bytes'])(
    '正文只允许同字节的静态重定向通知：%s',
    kind => {
      if (kind === 'first-body') replaceBody(1, notice);
      if (kind === 'script') replaceBody(9, notice.replace('</body>', '<script>1</script></body>'));
      if (kind === 'form') replaceBody(9, notice.replace('</body>', '<form></form></body>'));
      if (kind === 'model') replaceBody(9, '{"orderDetail":{}}');
      if (kind === 'all-other')
        for (let index = 2; index <= 9; index++) replaceBody(index, '<html>redirect</html>');
      if (kind === 'different-bytes') replaceBody(9, notice.replace(/\r\n/g, '\n'));
      expect(verify).toThrow('HTTP_QUARANTINE_EVIDENCE_INVALID');
    }
  );

  test.each([
    'requests',
    'outcome',
    'login',
    'attempt',
    'row',
    'date',
    'devices',
    'stale',
    'unrejected',
    'result',
    'intent',
  ])('原业务、唯一研究失败及负向保护不放宽：%s', kind => {
    if (kind === 'requests') proof.research.run.requests = 8;
    if (kind === 'outcome') proof.research.run.outcome = 'HTTP_TIMEOUT';
    if (kind === 'login') proof.research.attempts[0].loginAt = proof.research.run.startedAt;
    if (kind === 'attempt') proof.research.attempts.push({ ...proof.research.attempts[0] });
    if (kind === 'row') proof.business.row.rowHash = '0'.repeat(32);
    if (kind === 'date') proof.business.row.actualPickupDate = '2026-10-01';
    if (kind === 'devices') proof.business.row.devices = [{ id: 'unexpected' }];
    if (kind === 'stale') proof.business.queriedAt = now - 301;
    if (kind === 'unrejected') write('private/http-rejected-egress.json', []);
    if (kind === 'result') write('private/results/order-426-run-959.json', {});
    if (kind === 'intent') write('private/http-apply-intent-426.json', { state: 'APPLY_STARTED' });
    expect(verify).toThrow('HTTP_QUARANTINE_EVIDENCE_INVALID');
  });
});

describe('首次跳转后第二个 GET 超时', () => {
  beforeEach(() => {
    audit.originalOutcome = 'HTTP_TIMEOUT';
    audit.requests = 2;
    proof.research.run.outcome = 'HTTP_TIMEOUT';
    proof.research.run.requests = 2;
    for (const name of [
      'request-3.enc',
      'response-2.enc',
      `body-2-${hash(Buffer.alloc(0)).slice(0, 16)}.enc`,
    ])
      fs.unlinkSync(path.join(root, 'evidence/run-959', name));
    const event = fs
      .readFileSync(path.join(root, 'evidence/run-959/events.jsonl'), 'utf8')
      .split('\n')[0];
    write('evidence/run-959/events.jsonl', event + '\n');
    write(`private/http-sample-426-${audit.attemptId}.json`, audit);
    proof.sampleAuditSha256 = hash(
      fs.readFileSync(path.join(root, `private/http-sample-426-${audit.attemptId}.json`))
    );
  });
  test('密文、重定向和双库证据一致时只隔离失败', () => {
    expect(verify().outcome).toBe('HTTP_FAILURE_QUARANTINE_VERIFIED');
  });
  test('不能将两次请求的 541 冒充已确认超时', () => {
    audit.originalOutcome = 'HTTP_541';
    write(`private/http-sample-426-${audit.attemptId}.json`, audit);
    proof.sampleAuditSha256 = hash(
      fs.readFileSync(path.join(root, `private/http-sample-426-${audit.attemptId}.json`))
    );
    expect(() => verify()).toThrow();
  });
  test('第二次请求携带 POST 正文时拒绝', () => {
    const filename = 'evidence/run-959/request-2.enc';
    const request = JSON.parse(decrypt(fs.readFileSync(path.join(root, filename)), key));
    request.method = 'POST';
    request.body = 'unexpected';
    write(filename, encrypt(request, key));
    expect(() => verify()).toThrow();
  });
});

describe('详情已取得但出口后验失败，只能隔离而不能回写', () => {
  beforeEach(() => {
    const { buildLifecycleJson } = require('./fixtures/officialOrderLifecycle');
    const { parseOfficialOrderDetail } = require('../src/services/officialOrderParser');
    const directory = path.join(root, 'evidence/run-959');
    fs.rmSync(directory, { recursive: true });
    urls = [
      ...urls,
      'https://secure8.www.apple.com.cn/shop/shld/work/v1_0/q',
      'https://secure8.www.apple.com.cn/shop/shld/work/v1_0/q',
      'https://secure8.www.apple.com.cn/shop/orderx/guestx/W1234567890/synthetic?_a=fetchOrder&_m=guestOrderSpinner',
    ];
    audit.originalOutcome = 'SUCCEEDED';
    delete audit.requests;
    audit.orderId = 426;
    audit.resultFile = '/research/private/results/order-426-run-959.json';
    audit.receiptOutcome = 'RECEIPT_NOT_REQUESTED';
    audit.finishedAt = now - 14;
    audit.elapsedSeconds = 16;
    proof.research.run.outcome = 'SUCCEEDED';
    proof.research.run.requests = 6;
    proof.research.run.finishedAt = new Date((now - 15) * 1000).toISOString();
    write('private/http-rejected-egress.json', [audit.egressHash]);
    const detail = Buffer.from(JSON.stringify(buildLifecycleJson('PICKED_UP')));
    const events = [];
    for (let index = 0; index < 6; index++) {
      const method = index < 4 ? 'GET' : 'POST';
      const body = index === 5 ? detail : Buffer.alloc(0);
      const file = `body-${index + 1}-${hash(body).slice(0, 16)}.enc`;
      const status = index < 2 ? 303 : 200;
      const observedAt = new Date((now - 27 + index * 2) * 1000).toISOString();
      write(
        `evidence/run-959/request-${index + 1}.enc`,
        encrypt(
          {
            url: urls[index],
            method,
            headers: {},
            body: method === 'GET' ? null : 'synthetic',
            observedAt: new Date((now - 28 + index * 2) * 1000).toISOString(),
          },
          key
        )
      );
      write(
        `evidence/run-959/response-${index + 1}.enc`,
        encrypt(
          {
            url: urls[index],
            status,
            rawHeaders: index < 2 ? [['Location', urls[index + 1]]] : [],
            bodyBase64: body.toString('base64'),
          },
          key
        )
      );
      write(`evidence/run-959/${file}`, encrypt(body, key));
      events.push({
        message: 'http_response',
        method,
        status,
        runId: 959,
        urlHash: hash(urls[index]),
        file,
        sha256: hash(body),
        bytes: body.length,
        observedAt,
      });
    }
    const source = { ...events[5], cached: false };
    write('private/results/order-426-run-959.json', {
      systemOrderId: 426,
      ...parseOfficialOrderDetail(detail.toString(), 'W1234567890'),
      source,
    });
    write(
      'evidence/run-959/events.jsonl',
      events.map(event => JSON.stringify(event)).join('\n') + '\n'
    );
    write(`private/http-sample-426-${audit.attemptId}.json`, audit);
    proof.sampleAuditSha256 = hash(
      fs.readFileSync(path.join(root, `private/http-sample-426-${audit.attemptId}.json`))
    );
  });
  test('已取得详情但前后出口明确不同，两个出口均保持拒用', () => {
    delete audit.egressAfterError;
    audit.egressAfterHash = 'f'.repeat(64);
    write('private/http-rejected-egress.json', [audit.egressHash, audit.egressAfterHash]);
    write(`private/http-sample-426-${audit.attemptId}.json`, audit);
    proof.sampleAuditSha256 = hash(
      fs.readFileSync(path.join(root, `private/http-sample-426-${audit.attemptId}.json`))
    );
    expect(verify().egressAfterHash).toBe(audit.egressAfterHash);
  });

  test('封存详情和六次只读取数原文，出口仍未核实', () => {
    const result = verify();
    expect(result.outcome).toBe('HTTP_FAILURE_QUARANTINE_VERIFIED');
    expect(result.files['private/results/order-426-run-959.json']).toMatch(/^[a-f0-9]{64}$/);
    expect(result.egressVerifiedAfter).toBeUndefined();
  });
  test('存在回写意图时不能用只读失败隔离', () => {
    write('private/http-apply-intent-426.json', { state: 'APPLY_STARTED' });
    expect(() => verify()).toThrow();
  });
  test('伪造详情字段会被密文重新解析拒绝', () => {
    const filename = 'private/results/order-426-run-959.json';
    const result = JSON.parse(fs.readFileSync(path.join(root, filename)));
    result.products[0].rawStatus = 'CANCELLED';
    write(filename, result);
    expect(() => verify()).toThrow();
  });
  test('额外详情来源不能混入', () => {
    write('private/results/order-426-run-958.json', {});
    expect(() => verify()).toThrow();
  });
  test('旧失败回放保留原摘要，后续结果不冒充旧成功', () => {
    const closed = verify();
    write('private/results/order-426-run-1000.json', { newer: true });
    expect(() => verify()).toThrow();
    expect(verify(true)).toEqual(closed);
  });
  test('历史回放仍重新认证旧密文且不接受旧详情被改写', () => {
    verify();
    write('private/results/order-426-run-1000.json', { newer: true });
    write('evidence/run-959/request-6.enc', Buffer.alloc(28));
    expect(() => verify(true)).toThrow('HTTP_QUARANTINE_EVIDENCE_INVALID');
  });
  test('POST结算路由不是只读取数', () => {
    const filename = 'evidence/run-959/request-6.enc';
    const request = JSON.parse(decrypt(fs.readFileSync(path.join(root, filename)), key));
    request.url = 'https://secure8.www.apple.com.cn/shop/checkout';
    write(filename, encrypt(request, key));
    expect(() => verify()).toThrow();
  });
});

test('三GET连接失败且出口核验一致，只封存失败并保留真实出口标志', () => {
  delete audit.originalOutcome;
  delete audit.egressAfterError;
  audit.outcome = 'PROXY_CONNECTION_FAILED';
  audit.egressAfterHash = audit.egressHash;
  audit.egressVerifiedAfter = true;
  proof.research.run.outcome = audit.outcome;
  write(`private/http-sample-426-${audit.attemptId}.json`, audit);
  proof.sampleAuditSha256 = hash(
    fs.readFileSync(path.join(root, `private/http-sample-426-${audit.attemptId}.json`))
  );
  expect(verify().egressAfterHash).toBe(audit.egressHash);
});
