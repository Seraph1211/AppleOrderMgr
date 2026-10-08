/* eslint-disable no-magic-numbers -- 仅接受已确认的三/四 GET 失败或九 GET 自重定向链。 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseOfficialOrderDetail } = require('../../src/services/officialOrderParser');
const assert = require('assert/strict');
const { decrypt, proxyFingerprint } = require('../../src/services/officialOrderSupport');
const {
  validateReadUrl,
  discoverShieldUrl,
} = require('../../src/services/officialOrderHttpCollector');

const MAX_BYTES = 8 * 1024 * 1024;
const REDIRECT_NOTICE =
  [
    '<html>',
    '<head><title>307 Temporary Redirect</title></head>',
    '<body>',
    '<center><h1>307 Temporary Redirect</h1></center>',
    '<hr><center>Apple</center>',
    '</body>',
    '</html>',
  ].join('\n') + '\n';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const keys = (value, expected) => {
  assert(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), expected.split(' ').sort());
};
const seconds = value => {
  const result = Date.parse(value) / 1000;
  assert(Number.isFinite(result));
  return result;
};

function assertNoSuccessArtifacts(root, orderId, allowedResult = null) {
  const privateDirectory = path.join(root, 'private');
  const names = fs.readdirSync(privateDirectory);
  const forbidden = new RegExp(
    `^(?:http-receipt-${orderId}-run-.*|receipt-probe-${orderId}|` +
      `http-apply-${orderId}-.*|http-apply-basis-${orderId}-.*|` +
      `browser-receipt-bind-${orderId}-.*|http-apply-intent-${orderId}|` +
      `browser-receipt-bind-intent-${orderId})\\.json$`
  );
  assert(!names.some(name => forbidden.test(name)));
  if (names.includes('results')) {
    const directory = path.join(privateDirectory, 'results');
    assert(fs.lstatSync(directory).isDirectory());
    assert(fs.realpathSync(directory) === path.join(fs.realpathSync(root), 'private/results'));
    const resultName = new RegExp(`^order-${orderId}-run-.*\\.json$`);
    const matches = fs.readdirSync(directory).filter(name => resultName.test(name));
    assert(
      allowedResult ? matches.length === 1 && matches[0] === allowedResult : matches.length === 0
    );
  }
}

/** 只读核验父代理生成的数据库证明及原始加密失败链；不会创建成功订单证据。 */
function verifyHttpFailureQuarantine(root, proofName, proofSha, at, replayClosed = false) {
  try {
    assert(typeof replayClosed === 'boolean');
    assert(path.isAbsolute(root));
    assert(/^http-failure-proof-[1-9][0-9]*-[a-f0-9]{32}\.json$/.test(proofName));
    assert(/^[a-f0-9]{64}$/.test(proofSha));
    assert(Number.isFinite(at) && at > 0 && at <= Date.now() / 1000);
    const files = {};
    const read = relative => {
      const filename = path.join(root, relative);
      const info = fs.lstatSync(filename);
      assert(info.isFile() && !(info.mode & 0o077) && info.size <= MAX_BYTES);
      assert(fs.realpathSync(filename) === path.join(fs.realpathSync(root), relative));
      const bytes = fs.readFileSync(filename);
      files[relative] = sha(bytes);
      return bytes;
    };
    const json = relative => JSON.parse(read(relative).toString('utf8'));
    const proofBytes = read(`private/${proofName}`);
    assert(sha(proofBytes) === proofSha);
    const proof = JSON.parse(proofBytes);
    keys(
      proof,
      'version kind planSha256 orderId runId batchAttemptId sampleAttemptId ' +
        'sampleAuditSha256 observedAt business research'
    );
    assert(proof.version === 1 && proof.kind === 'HTTP_FAILURE_QUARANTINE');
    assert(Number.isSafeInteger(proof.orderId) && proof.orderId > 0);
    assert(Number.isSafeInteger(proof.runId) && proof.runId > 0);
    assert(/^[a-f0-9]{32}$/.test(proof.batchAttemptId));
    assert(/^[a-f0-9]{32}$/.test(proof.sampleAttemptId));
    assert(proofName === `http-failure-proof-${proof.orderId}-${proof.sampleAttemptId}.json`);
    assert(
      typeof proof.observedAt === 'number' &&
        at - proof.observedAt >= 0 &&
        at - proof.observedAt <= 300
    );
    const plan = json('private/plan.json');
    assert(files['private/plan.json'] === proof.planSha256);
    assert(plan.schemaVersion === 3 && plan.scope === 'missing-fields' && plan.cutoff === null);
    assert.deepEqual(plan.policy, { loginCooldown: true, apiHealthCheck: true, proxy541Limit: 3 });
    const entries = plan.entries.filter(value => value.id === proof.orderId);
    assert(entries.length === 1);
    const entry = entries[0];
    const auditName = `http-sample-${proof.orderId}-${proof.sampleAttemptId}.json`;
    const audit = json(`private/${auditName}`);
    assert(files[`private/${auditName}`] === proof.sampleAuditSha256);
    const completeUnverified = audit.originalOutcome === 'SUCCEEDED';
    const stableConnection = audit.outcome === 'PROXY_CONNECTION_FAILED';
    const changedExit = typeof audit.egressAfterHash === 'string' && !stableConnection;
    const challengeConnectionFailure =
      audit.originalOutcome === 'PROXY_CONNECTION_FAILED' && audit.requests === 4;
    const redirectLimit = audit.originalOutcome === 'REDIRECT_LIMIT';
    const earlyTimeout = audit.originalOutcome === 'HTTP_TIMEOUT' && audit.requests === 2;
    const requestCount = completeUnverified
      ? 6
      : redirectLimit
        ? 9
        : challengeConnectionFailure
          ? 4
          : earlyTimeout
            ? 2
            : 3;
    const responseCount = redirectLimit || completeUnverified ? requestCount : requestCount - 1;
    keys(
      audit,
      'outcome runId attemptId targetOrderId proxyIndex ' +
        (stableConnection ? '' : 'originalOutcome ') +
        (completeUnverified ? 'orderId resultFile receiptOutcome ' : 'requests ') +
        'startedAt finishedAt elapsedSeconds egressHash egressAfterHash ' +
        'egressVerifiedAfter businessWrites cleanup containerName' +
        (stableConnection || changedExit ? '' : ' egressAfterError')
    );
    assert(
      (audit.outcome === 'EGRESS_CHANGED_OR_UNVERIFIED' || stableConnection) &&
        (stableConnection ||
          completeUnverified ||
          challengeConnectionFailure ||
          redirectLimit ||
          ['HTTP_541', 'HTTP_TIMEOUT', 'PROXY_CONNECTION_FAILED'].includes(audit.originalOutcome))
    );
    if (!stableConnection && !changedExit)
      assert(audit.egressAfterError === 'RUNTIME_COMMAND_FAILED');
    assert(
      audit.runId === proof.runId &&
        (completeUnverified || audit.requests === requestCount) &&
        audit.targetOrderId === proof.orderId
    );
    assert(audit.attemptId === proof.sampleAttemptId && audit.businessWrites === 0);
    assert(Number.isSafeInteger(audit.proxyIndex) && audit.proxyIndex >= 0);
    assert(audit.containerName === `apple-official-http-sample-${proof.sampleAttemptId}`);
    assert.deepEqual(audit.cleanup, { attempted: true, removed: true, outcome: 'REMOVED' });
    assert(/^[a-f0-9]{64}$/.test(audit.egressHash));
    assert(audit.egressVerifiedAfter === stableConnection);
    if (stableConnection) {
      assert(audit.egressAfterHash === audit.egressHash);
      if (!replayClosed) assertNoSuccessArtifacts(root, proof.orderId);
    }
    if (challengeConnectionFailure || redirectLimit || completeUnverified) {
      if (changedExit) {
        assert(/^[a-f0-9]{64}$/.test(audit.egressAfterHash));
        assert(audit.egressAfterHash !== audit.egressHash);
      } else assert(audit.egressAfterHash === null);
      const rejected = json('private/http-rejected-egress.json');
      assert(
        Array.isArray(rejected) &&
          rejected.every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))
      );
      assert(rejected.includes(audit.egressHash));
      if (changedExit) assert(rejected.includes(audit.egressAfterHash));
      // 拒用台账可以追加；回放重新检查成员资格，不冻结整份可增长台账。
      delete files['private/http-rejected-egress.json'];
      if (!replayClosed) {
        assertNoSuccessArtifacts(
          root,
          proof.orderId,
          completeUnverified ? `order-${proof.orderId}-run-${proof.runId}.json` : null
        );
      }
      if (completeUnverified) {
        assert(audit.orderId === proof.orderId && audit.receiptOutcome === 'RECEIPT_NOT_REQUESTED');
        assert(
          audit.resultFile ===
            `/research/private/results/order-${proof.orderId}-run-${proof.runId}.json`
        );
      }
    } else if (!stableConnection) assert(audit.egressAfterHash === null);
    assert(typeof audit.startedAt === 'number' && typeof audit.finishedAt === 'number');
    assert(audit.startedAt <= audit.finishedAt && audit.finishedAt <= proof.observedAt);
    const inputName = `private/request-${proof.orderId}.json`;
    const archivedInput =
      `private/http-quarantine-input-${proof.orderId}-${proof.sampleAttemptId}.json`;
    const useArchive = replayClosed && fs.existsSync(path.join(root, archivedInput));
    const inputBytes = read(useArchive ? archivedInput : inputName);
    if (useArchive) {
      delete files[archivedInput];
      files[inputName] = sha(inputBytes);
    }
    const input = JSON.parse(inputBytes.toString('utf8'));
    assert(input.samples.length === 1);
    const sample = input.samples[0];
    assert(sample.id === proof.orderId && sample.orderNumber === entry.orderNumber);
    assert(/^[a-f0-9]{64}$/.test(sample.accountHash));
    const proxies = JSON.parse(read('private/iproyal-cn.json')).entries;
    const proxy = proxies[audit.proxyIndex];
    assert(proxy);
    // 目录允许后续追加代理；事件只绑定当前条目的指纹，不绑定整个可扩展目录。
    delete files['private/iproyal-cn.json'];
    const proxyHash = proxyFingerprint({ ...proxy, provider: 'iproyal' });
    keys(proof.business, 'queriedAt database row');
    keys(proof.business.row, 'id orderNumber rowHash actualPickupDate devices');
    keys(proof.research, 'queriedAt database run attempts');
    const run = proof.research.run;
    keys(run, 'id sampleId mode outcome requests startedAt finishedAt');
    assert(run.id === proof.runId && run.sampleId === proof.orderId && run.mode === 'collect');
    assert(
      run.outcome === (stableConnection ? audit.outcome : audit.originalOutcome) &&
        run.requests === requestCount
    );
    const runStart = seconds(run.startedAt);
    const runEnd = seconds(run.finishedAt);
    assert(audit.startedAt <= runStart && runStart <= runEnd && runEnd <= audit.finishedAt);
    for (const part of [proof.business, proof.research]) {
      assert(typeof part.database === 'string' && part.database.length > 0);
      assert(typeof part.queriedAt === 'number' && runEnd <= part.queriedAt);
      assert(part.queriedAt <= proof.observedAt && at - part.queriedAt <= 300);
    }
    assert(proof.business.database !== proof.research.database);
    const row = proof.business.row;
    assert(
      row.id === entry.id && row.orderNumber === entry.orderNumber && row.rowHash === entry.rowHash
    );
    assert(row.actualPickupDate === entry.previousDate);
    assert.deepEqual(row.devices, entry.previousDevices);
    assert(Array.isArray(proof.research.attempts) && proof.research.attempts.length === 1);
    const attempt = proof.research.attempts[0];
    keys(attempt, 'runId orderHash accountHash proxyHash loginAt');
    assert(attempt.runId === proof.runId && attempt.orderHash === sha(entry.orderNumber));
    assert(
      attempt.accountHash === sample.accountHash &&
        attempt.proxyHash === proxyHash &&
        attempt.loginAt === null
    );
    const directory = `evidence/run-${proof.runId}`;
    const names = fs.readdirSync(path.join(root, directory)).sort();
    assert(
      names.length ===
        (completeUnverified
          ? 19
          : redirectLimit
            ? 28
            : challengeConnectionFailure
              ? 11
              : earlyTimeout
                ? 5
                : 8)
    );
    const evidenceName = new RegExp(
      completeUnverified
        ? '^(?:request-[1-6]\\.enc|response-[1-6]\\.enc|body-[1-6]-[a-f0-9]{16}\\.enc|events\\.jsonl)$'
        : redirectLimit
          ? '^(?:request-[1-9]\\.enc|response-[1-9]\\.enc|' +
            'body-[1-9]-[a-f0-9]{16}\\.enc|events\\.jsonl)$'
          : challengeConnectionFailure
            ? '^(?:request-[1234]\\.enc|response-[123]\\.enc|' +
              'body-[123]-[a-f0-9]{16}\\.enc|events\\.jsonl)$'
            : earlyTimeout
              ? '^(?:request-[12]\\.enc|response-1\\.enc|body-1-[a-f0-9]{16}\\.enc|events\\.jsonl)$'
              : '^(?:request-[123]\\.enc|response-[12]\\.enc|' +
                'body-[12]-[a-f0-9]{16}\\.enc|events\\.jsonl)$'
    );
    assert(names.every(name => evidenceName.test(name)));
    const key = read('private/evidence.key');
    delete files['private/evidence.key'];
    const decoded = name => JSON.parse(decrypt(read(`${directory}/${name}`), key).toString('utf8'));
    const requests = Array.from({ length: requestCount }, (_value, index) =>
      decoded(`request-${index + 1}.enc`)
    );
    for (const request of requests) {
      if (!completeUnverified) assert(request.method === 'GET' && request.body === null);
      validateReadUrl(request.url, request.method);
      assert(runStart <= seconds(request.observedAt) && seconds(request.observedAt) <= runEnd);
    }
    if (completeUnverified) {
      assert.deepEqual(
        requests.map(request => request.method),
        ['GET', 'GET', 'GET', 'GET', 'POST', 'POST']
      );
      for (const request of requests.slice(0, 4)) assert(request.body === null);
      assert(/^\/shop\/shld\/work\/v[0-9_]+\/q$/.test(new URL(requests[3].url).pathname));
      assert(requests[4].url === requests[3].url);
      const detailUrl = new URL(requests[5].url);
      assert(detailUrl.pathname.startsWith('/shop/orderx/guestx/'));
      assert(detailUrl.pathname.split('/').map(decodeURIComponent).includes(entry.orderNumber));
    }
    if (earlyTimeout) {
      for (const request of requests) {
        keys(request, 'url method headers body observedAt');
        assert.deepEqual(request.headers, {});
      }
      assert(/^\/shop\/order\/guest\//.test(new URL(requests[1].url).pathname));
    }
    if (challengeConnectionFailure) {
      for (const request of requests) keys(request, 'url method headers body observedAt');
      for (const request of requests.slice(0, 3)) assert.deepEqual(request.headers, {});
      assert.deepEqual(requests[3].headers, { Referer: requests[2].url });
      for (const request of requests.slice(1, 3))
        assert(/^\/shop\/order\/guest\//.test(new URL(request.url).pathname));
    }
    if (redirectLimit) {
      for (const request of requests) {
        keys(request, 'url method headers body observedAt');
        assert.deepEqual(request.headers, {});
      }
      const first = new URL(requests[0].url);
      const guest = new URL(requests[1].url);
      const firstParts = first.pathname.split('/');
      const guestParts = guest.pathname.split('/');
      assert(first.hostname === 'www.apple.com.cn' && first.search === '' && first.hash === '');
      assert(firstParts.length === 6 && firstParts.slice(0, 4).join('/') === '/xc/cn/vieworder');
      assert(decodeURIComponent(firstParts[4]) === entry.orderNumber && firstParts[5]);
      assert(/^secure\d*\.www\.apple\.com\.cn$/.test(guest.hostname));
      assert(guestParts.length === 6 && guestParts.slice(0, 4).join('/') === '/shop/order/guest');
      assert(decodeURIComponent(guestParts[4]) === entry.orderNumber && guestParts[5]);
      assert(guest.search === '?e=true' && guest.hash === '');
      assert(requests.slice(1).every(request => request.url === requests[1].url));
    }
    assert(requests[0].url === sample.url);
    assert(
      new URL(requests[0].url).pathname
        .split('/')
        .map(decodeURIComponent)
        .includes(entry.orderNumber)
    );
    const eventBytes = read(`${directory}/events.jsonl`);
    assert(eventBytes.at(-1) === 10);
    const events = eventBytes
      .toString('utf8')
      .trimEnd()
      .split('\n')
      .map(line => JSON.parse(line));
    assert(events.length === responseCount);
    let redirectBody;
    for (let index = 0; index < responseCount; index++) {
      const response = decoded(`response-${index + 1}.enc`);
      const event = events[index];
      const status = redirectLimit ? (index === 0 ? 303 : 307) : index < 2 ? 303 : 200;
      assert(response.status === status && response.url === requests[index].url);
      const locations = response.rawHeaders.filter(pair => pair[0].toLowerCase() === 'location');
      if (redirectLimit) {
        const normalized = Object.entries(response.headers).filter(
          ([name]) => name.toLowerCase() === 'location'
        );
        assert(locations.length === 1 && normalized.length === 1);
        assert(normalized[0][1] === locations[0][1]);
        assert(new URL(locations[0][1], response.url).href === requests[1].url);
        if (index > 0) {
          // 已观察的循环为精确自指，不能接受相对目标、其他跳转或脚本页面。
          assert(locations[0][1] === requests[index].url);
          const contentTypes = response.rawHeaders.filter(
            ([name]) => name.toLowerCase() === 'content-type'
          );
          const normalizedTypes = Object.entries(response.headers).filter(
            ([name]) => name.toLowerCase() === 'content-type'
          );
          assert(contentTypes.length === 1 && contentTypes[0][1] === 'text/html');
          assert(normalizedTypes.length === 1 && normalizedTypes[0][1] === 'text/html');
        }
      } else if (index < 2)
        assert(
          locations.length === 1 &&
            new URL(locations[0][1], response.url).href === requests[index + 1].url
        );
      else assert(locations.length === 0);
      const body = Buffer.from(response.bodyBase64, 'base64');
      assert(body.toString('base64') === response.bodyBase64);
      const bodyName = `body-${index + 1}-${sha(body).slice(0, 16)}.enc`;
      assert.deepEqual(decrypt(read(`${directory}/${bodyName}`), key), body);
      assert(
        event.message === 'http_response' &&
          event.method === requests[index].method &&
          event.status === status
      );
      assert(event.runId === proof.runId && event.urlHash === sha(requests[index].url));
      assert(event.file === bodyName && event.sha256 === sha(body) && event.bytes === body.length);
      assert(seconds(requests[index].observedAt) <= seconds(event.observedAt));
      assert(
        seconds(event.observedAt) <=
          (index + 1 < requestCount ? seconds(requests[index + 1].observedAt) : runEnd)
      );
      if (earlyTimeout) assert(body.length === 0);
      if (redirectLimit) {
        if (index === 0) assert(body.length === 0);
        else {
          assert(body.toString('utf8').replace(/\r\n/g, '\n') === REDIRECT_NOTICE);
          if (redirectBody) assert.deepEqual(body, redirectBody);
          redirectBody = body;
        }
      }
      if (challengeConnectionFailure) {
        if (index < 2) assert(body.length === 0);
        else {
          assert(body.length > 0);
          assert(discoverShieldUrl(body.toString('utf8'), response.url) === requests[3].url);
        }
      }
    }
    if (completeUnverified) {
      const result = json(`private/results/order-${proof.orderId}-run-${proof.runId}.json`);
      const response = decoded('response-6.enc');
      const body = Buffer.from(response.bodyBase64, 'base64');
      const source = result.source;
      const parsed = parseOfficialOrderDetail(body.toString('utf8'), entry.orderNumber);
      assert(parsed && parsed.identityMatched === true);
      assert(result.systemOrderId === proof.orderId && result.orderNumber === entry.orderNumber);
      const withoutSource = { ...result };
      delete withoutSource.source;
      assert.deepEqual(withoutSource, { systemOrderId: proof.orderId, ...parsed });
      assert(source.runId === proof.runId && source.sha256 === sha(body));
      assert(source.file === `body-6-${sha(body).slice(0, 16)}.enc`);
      assert(
        source.status === 200 && source.cached === false && source.urlHash === sha(requests[5].url)
      );
      assert(source.observedAt === events[5].observedAt);
    }
    return {
      outcome: 'HTTP_FAILURE_QUARANTINE_VERIFIED',
      orderId: proof.orderId,
      runId: proof.runId,
      batchAttemptId: proof.batchAttemptId,
      sampleAttemptId: proof.sampleAttemptId,
      sampleAuditSha256: proof.sampleAuditSha256,
      proofSha256: proofSha,
      planSha256: proof.planSha256,
      proxyHash,
      egressHash: audit.egressHash,
      ...(challengeConnectionFailure || changedExit || stableConnection
        ? { egressAfterHash: audit.egressAfterHash }
        : {}),
      files,
    };
  } catch (_error) {
    throw Object.assign(new Error('HTTP_QUARANTINE_EVIDENCE_INVALID'), {
      code: 'HTTP_QUARANTINE_EVIDENCE_INVALID',
    });
  }
}

if (require.main === module) {
  try {
    const [root, proofName, proofSha, at, mode = 'close-current', ...extra] = process.argv.slice(2);
    assert(!extra.length && ['close-current', 'replay-closed'].includes(mode));
    process.stdout.write(
      `${JSON.stringify(
        verifyHttpFailureQuarantine(root, proofName, proofSha, Number(at), mode === 'replay-closed')
      )}\n`
    );
  } catch (_error) {
    process.stderr.write('{"outcome":"HTTP_QUARANTINE_EVIDENCE_INVALID"}\n');
    process.exitCode = 1;
  }
}
module.exports = { verifyHttpFailureQuarantine };
