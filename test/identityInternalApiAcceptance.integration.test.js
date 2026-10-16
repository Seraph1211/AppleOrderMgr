const crypto = require('crypto');
const { fork } = require('child_process');
const path = require('path');
const XLSX = require('xlsx');
const enabled = process.env.RUN_IDENTITY_INTERNAL_ACCEPTANCE === 'true';
const describeAcceptance = enabled ? describe : describe.skip;
const CARD = '110101199001010015';
jest.setTimeout(30000);

describeAcceptance('内部身份API独立真实HTTP与PostgreSQL验收', () => {
  let models;
  let people;
  let processes = [];
  let calls = [];
  let output = '';
  let apiToken;
  let tokenId;
  const roots = ['http://127.0.0.1:3896', 'http://127.0.0.1:3897'];
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const sql = async (query, replacements = {}) => {
    try {
      return await models.sequelize.query(query, { replacements });
    } catch (error) {
      throw new Error('独立验收操作失败', { cause: error });
    }
  };
  const request = async (route, actor = 'owner', options = {}, instance = 0) => {
    try {
      const response = await fetch(roots[instance] + route, {
        ...options,
        headers: {
          'X-Forwarded-Proto': 'https',
          ...(actor ? { Authorization: `Bearer ${people[actor].jwt}` } : {}),
          ...(options.body ? { 'Content-Type': 'application/json' } : {}),
          ...options.headers,
        },
      });
      const body = await response.text();
      return {
        status: response.status,
        headers: response.headers,
        body: body ? JSON.parse(body) : null,
      };
    } catch (error) {
      throw new Error('独立验收操作失败', { cause: error });
    }
  };
  const management = (suffix = '', actor = 'owner', method = 'GET', body) =>
    request(`/api/identity-verifications/api-token${suffix}`, actor, {
      method,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const verify = (name = '合成甲', token = apiToken, instance = 0, options = {}) =>
    request(
      `/api/internal/v1/identity/verify?${new URLSearchParams({ name, idCardNumber: CARD, token })}`,
      null,
      options,
      instance
    );
  const releaseSpacing = async () => {
    try {
      await sql(
        "UPDATE identity_verification_items SET started_at=NOW()-INTERVAL '2 seconds' WHERE started_at IS NOT NULL"
      );
    } catch (error) {
      throw new Error('独立验收操作失败', { cause: error });
    }
  };
  const command = async (child, type, value) => {
    try {
      const id = crypto.randomUUID();
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('验收子进程未响应')), 15000);
        const listener = msg => {
          if (msg.type === 'ack' && msg.id === id) {
            clearTimeout(timer);
            child.off('message', listener);
            msg.error ? reject(new Error('验收子进程操作失败')) : resolve();
          }
        };
        child.on('message', listener);
        child.send({ type, value, id });
      });
    } catch (error) {
      throw new Error('独立验收操作失败', { cause: error });
    }
  };
  beforeAll(async () => {
    if (
      process.env.DB_NAME !== 'apple_order_mgr_identity_test_2026101601' ||
      process.env.DB_NAME_TEST !== process.env.DB_NAME ||
      process.env.DATABASE_URL
    )
      throw new Error('必须使用本独立验收专库');
    models = require('../src/models');
    people = {};
    for (const key of ['admin', 'owner', 'other', 'readOnly']) {
      const sessionId = crypto.randomUUID();
      const user = await models.User.create({
        username: `api_acceptance_${key}_${Date.now()}`,
        password: 'Synthetic-pass-42',
        role: key === 'admin' ? 'admin' : 'operator',
        activeSessions: [
          {
            id: sessionId,
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 3600000).toISOString(),
          },
        ],
      });
      people[key] = {
        user,
        jwt: require('../src/utils/jwtUtils').generateToken({
          userId: user.id,
          username: user.username,
          role: user.role,
          sessionId,
        }),
      };
    }
    await models.UserPermission.bulkCreate(
      ['owner', 'other', 'readOnly'].flatMap(key =>
        (key === 'readOnly' ? ['identity.read'] : ['identity.read', 'identity.api']).map(
          permissionCode => ({
            userId: people[key].user.id,
            permissionCode,
            grantedBy: people.admin.user.id,
          })
        )
      )
    );
    processes = roots.map((_root, i) => {
      const child = fork(path.join(__dirname, 'identityInternalApiAcceptanceServer.js'), {
        env: { ...process.env, NODE_ENV: 'test', PORT: String(3896 + i), TRUST_PROXY: 'loopback' },
        silent: true,
      });
      child.on('message', msg => {
        if (msg.type === 'provider') calls.push({ ...msg, instance: i });
      });
      child.stdout.on('data', data => {
        output += data;
      });
      child.stderr.on('data', data => {
        output += data;
      });
      return child;
    });
    for (const root of roots) {
      let ready = false;
      for (let i = 0; i < 80; i++) {
        try {
          if ((await fetch(`${root}/api/health/ready`)).ok) {
            ready = true;
            break;
          }
        } catch (_error) {
          /* 仅等待本地合成HTTP就绪 */
        }
        await wait(100);
      }
      if (!ready) throw new Error(`隔离HTTP未就绪：${output.slice(-1500)}`);
    }
  });
  beforeEach(async () => {
    await sql(
      'TRUNCATE identity_api_events,identity_api_dedup,identity_api_usage,identity_verification_items,identity_verification_batches,identity_api_tokens RESTART IDENTITY CASCADE'
    );
    await sql('UPDATE identity_service_state SET paused=false,pause_reason=NULL');
    await people.owner.user.update({ status: 'active' });
    await models.UserPermission.findOrCreate({
      where: { userId: people.owner.user.id, permissionCode: 'identity.api' },
      defaults: { grantedBy: people.admin.user.id },
    });
    await models.UserPermission.findOrCreate({
      where: { userId: people.owner.user.id, permissionCode: 'identity.read' },
      defaults: { grantedBy: people.admin.user.id },
    });
    calls = [];
    output = '';
    expect((await management('', 'owner', 'POST')).status).toBe(200);
    const revealed = await management('/reveal', 'owner', 'POST');
    expect(revealed.status).toBe(200);
    apiToken = revealed.body.data.token;
    tokenId = (await management()).body.data.token.id;
  });
  afterAll(async () => {
    for (const child of processes) child.kill('SIGTERM');
    await wait(300);
    for (const child of processes) if (child.exitCode === null) child.kill('SIGKILL');
    if (models) await models.sequelize.close();
  });
  test('仅read+api即可调用，与verify/batch独立；确定DTO无身份字段及禁止缓存', async () => {
    const response = await verify();
    expect((await management()).body.data.limits).toEqual({
      requestsPerMinute: 50,
      dailyProviderCalls: 500,
      dedupSeconds: 600,
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      data: { status: 'matched', matched: true, reused: false },
    });
    expect(response.body.requestId).toBeTruthy();
    expect(response.body.data.verificationId).toBeTruthy();
    expect(JSON.stringify(response.body)).not.toContain(CARD);
    expect(JSON.stringify(response.body)).not.toContain('合成甲');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(calls).toHaveLength(1);
    await releaseSpacing();
    expect((await verify('合成不一致')).body.data).toMatchObject({
      status: 'mismatched',
      matched: false,
    });
  });
  test('令牌随机摘要及AES持久化；本人可反复复制、其他人不能指定本人', async () => {
    expect(apiToken.length).toBeGreaterThanOrEqual(43);
    const [rows] = await sql(
      'SELECT token_hash,token_ciphertext,expires_at FROM identity_api_tokens WHERE id=:id',
      { id: tokenId }
    );
    expect(rows[0].token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(rows[0].token_hash).not.toBe(apiToken);
    expect(rows[0].token_ciphertext).toMatch(/^enc:/);
    expect(rows[0].token_ciphertext).not.toContain(apiToken);
    expect(new Date(rows[0].expires_at).getTime() - Date.now()).toBeGreaterThan(89 * 86400000);
    expect(new Date(rows[0].expires_at).getTime() - Date.now()).toBeLessThanOrEqual(90 * 86400000);
    expect((await management('/reveal', 'owner', 'POST')).body.data.token).toBe(apiToken);
    const other = await management('/reveal', 'other', 'POST', { userId: people.owner.user.id });
    expect(other.status).not.toBe(200);
    expect((await management('', 'readOnly')).status).toBe(403);
  });
  test('严格三个单值参数：重复、额外、嵌套、数组、非法证件均不调用', async () => {
    const base = `/api/internal/v1/identity/verify?name=合成甲&idCardNumber=${CARD}&token=${encodeURIComponent(apiToken)}`;
    for (const suffix of [
      '&name=重复',
      '&callback=foo',
      '&name[]=数组',
      '&name[x]=对象',
      '&token=重复',
    ])
      expect((await request(base + suffix, null)).status).toBe(400);
    expect((await request(base.replace(CARD, '110101199002300015'), null)).status).toBe(400);
    expect((await request(base.replace(CARD, '110101199001010016'), null)).status).toBe(400);
    expect(calls).toHaveLength(0);
  });
  test('HTTP、HEAD及其他方法、未知路径安全拒绝且全部no-store、不开放跨域', async () => {
    expect(
      (await verify('合成甲', apiToken, 0, { headers: { 'X-Forwarded-Proto': 'http' } })).status
    ).toBe(400);
    for (const method of ['HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const result = await verify('合成甲', apiToken, 0, {
        method,
        headers: { Origin: 'https://probe.invalid' },
      });
      expect(result.status).toBe(405);
      expect(result.headers.get('cache-control')).toBe('no-store');
      expect(result.headers.get('access-control-allow-origin')).toBeNull();
    }
    const missing = await request(
      `/api/internal/v1/identity/missing?name=敏感探针&idCardNumber=${CARD}&token=${apiToken}`,
      null
    );
    expect(missing.status).toBe(404);
    expect(missing.headers.get('cache-control')).toBe('no-store');
    expect(calls).toHaveLength(0);
    expect(output).not.toContain(CARD);
    expect(output).not.toContain(apiToken);
    expect(output).not.toContain('敏感探针');
  });
  test('撤权、账号停用、撤销、过期即时拒绝；轮换废除旧令牌', async () => {
    await models.UserPermission.destroy({
      where: { userId: people.owner.user.id, permissionCode: 'identity.api' },
    });
    expect((await verify()).status).toBe(403);
    expect((await management('/reveal', 'owner', 'POST')).status).toBe(403);
    await models.UserPermission.create({
      userId: people.owner.user.id,
      permissionCode: 'identity.api',
      grantedBy: people.admin.user.id,
    });
    await people.owner.user.update({ status: 'locked' });
    expect((await verify()).status).toBe(403);
    await people.owner.user.update({ status: 'active' });
    await management('/reset', 'owner', 'POST');
    expect((await verify()).status).toBe(401);
    apiToken = (await management('/reveal', 'owner', 'POST')).body.data.token;
    await management('', 'owner', 'DELETE');
    expect((await verify()).status).toBe(401);
    await management('', 'owner', 'POST');
    apiToken = (await management('/reveal', 'owner', 'POST')).body.data.token;
    await sql(
      "UPDATE identity_api_tokens SET expires_at=NOW()-INTERVAL '1 second' WHERE user_id=:id",
      { id: people.owner.user.id }
    );
    expect((await verify()).status).toBe(401);
    expect(calls).toHaveLength(0);
  });
  test('确定结果599秒复用、601秒新调用，归一化相同输入复用，不同姓名和员工独立', async () => {
    const first = await verify();
    expect(first.status).toBe(200);
    await sql("UPDATE identity_verification_items SET finished_at=NOW()-INTERVAL '599 seconds'");
    const reused = await verify(' 合成甲 ');
    expect(reused.status).toBe(200);
    expect(reused.body.data).toMatchObject({
      verificationId: first.body.data.verificationId,
      reused: true,
    });
    expect(calls).toHaveLength(1);
    await sql("UPDATE identity_verification_items SET finished_at=NOW()-INTERVAL '601 seconds'");
    await releaseSpacing();
    expect((await verify()).body.data.reused).toBe(false);
    expect(calls).toHaveLength(2);
    await releaseSpacing();
    expect((await verify('合成乙')).status).toBe(200);
    await management('', 'other', 'POST');
    const otherToken = (await management('/reveal', 'other', 'POST')).body.data.token;
    await releaseSpacing();
    expect((await verify('合成甲', otherToken)).body.data.reused).toBe(false);
    expect(calls).toHaveLength(4);
  });
  test('第50次允许复用、第51次拒绝；500次新调用边界且复用不占日额度', async () => {
    expect((await verify()).status).toBe(200);
    await sql("UPDATE identity_api_usage SET count=49 WHERE user_id=:id AND kind='minute'", {
      id: people.owner.user.id,
    });
    expect((await verify()).status).toBe(200);
    const limited = await verify();
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMIT');
    expect(limited.headers.get('retry-after')).toBeTruthy();
    await sql("UPDATE identity_api_usage SET count=0 WHERE kind='minute'");
    await sql("UPDATE identity_api_usage SET count=499 WHERE user_id=:id AND kind='day'", {
      id: people.owner.user.id,
    });
    await releaseSpacing();
    expect((await verify('合成第五百次')).status).toBe(200);
    await releaseSpacing();
    const dailyLimited = await verify('合成第五百零一次');
    expect(dailyLimited.status).toBe(429);
    expect(dailyLimited.body.error.code).toBe('DAILY_LIMIT');
    expect(dailyLimited.headers.get('retry-after')).toBeTruthy();
    expect((await verify()).body.data.reused).toBe(true);
    const [rows] = await sql(
      "SELECT count FROM identity_api_usage WHERE user_id=:id AND kind='day'",
      { id: people.owner.user.id }
    );
    expect(rows[0].count).toBe(500);
    expect(calls).toHaveLength(2);
    const reset = await management('/reset', 'owner', 'POST');
    expect(reset.status).toBe(200);
    expect(reset.body.data).toMatchObject({
      limits: { requestsPerMinute: 50, dailyProviderCalls: 500, dedupSeconds: 600 },
      usage: { providerCalls: 500 },
    });
    const previousToken = apiToken;
    apiToken = (await management('/reveal', 'owner', 'POST')).body.data.token;
    expect((await verify('合成重置后超额', previousToken)).status).toBe(401);
    expect((await verify('合成重置后超额')).body.error.code).toBe('DAILY_LIMIT');
    expect((await verify()).body.data.reused).toBe(true);
    expect(calls).toHaveLength(2);
  });
  test('多进程相同请求并发最多一次；执行中其他请求不排队、全局500ms起点间隔', async () => {
    await command(processes[0], 'delay', 250);
    const pending = verify('合成并发');
    await wait(80);
    expect((await verify('合成并发', apiToken, 1)).status).toBe(429);
    expect((await verify('合成其他', apiToken, 1)).status).toBe(429);
    expect((await pending).status).toBe(200);
    expect((await verify('合成间隔', apiToken, 1)).status).toBe(429);
    expect(calls).toHaveLength(1);
    await wait(550);
    expect((await verify('合成间隔', apiToken, 1)).status).toBe(200);
    expect(calls[1].at - calls[0].at).toBeGreaterThanOrEqual(500);
    await command(processes[0], 'delay', 30);
  });
  test('未知及超时不误判不重试，409阻断跨进程，管理员审计释放后才可新调用', async () => {
    const unknown = await verify('合成异常');
    expect(unknown.status).toBe(502);
    expect(unknown.body).toMatchObject({ success: false, status: 'unknown', matched: null });
    expect((await verify('合成异常', apiToken, 1)).status).toBe(409);
    expect(calls).toHaveLength(1);
    const id = unknown.body.verificationId;
    expect(
      (
        await request(`/api/identity-verifications/api-admin/unknown/${id}/resolve`, 'owner', {
          method: 'POST',
          body: JSON.stringify({ action: 'release', reason: '合成核查明确允许重验' }),
        })
      ).status
    ).toBe(403);
    expect(
      (
        await request(`/api/identity-verifications/api-admin/unknown/${id}/resolve`, 'admin', {
          method: 'POST',
          body: JSON.stringify({ action: 'release', reason: '合成核查明确允许重验' }),
        })
      ).status
    ).toBe(200);
    await releaseSpacing();
    expect((await verify('合成异常')).status).toBe(502);
    expect(calls).toHaveLength(2);
    await releaseSpacing();
    const timeout = await verify('合成超时');
    expect(timeout.status).toBe(504);
    expect((await verify('合成超时')).status).toBe(409);
    expect(calls).toHaveLength(3);
    expect(output).not.toContain(CARD);
    expect(output).not.toContain(apiToken);
    const [events] = await sql('SELECT action FROM identity_api_events WHERE item_id=:id', { id });
    expect(events.length).toBeGreaterThan(0);
  });
  test('供应商额度异常跨进程全局暂停；管理员恢复后新请求正常', async () => {
    expect((await verify('合成额度')).status).toBe(503);
    expect((await verify('合成恢复', apiToken, 1)).body.error.code).toBe('SERVICE_PAUSED');
    expect(calls).toHaveLength(1);
    expect(
      (
        await request('/api/identity-verifications/api-admin/service', 'admin', {
          method: 'PATCH',
          body: JSON.stringify({ paused: false }),
        })
      ).status
    ).toBe(200);
    await releaseSpacing();
    expect((await verify('合成恢复', apiToken, 1)).status).toBe(200);
  });
  test('大小写、编码、畸形路径与重复斜杠不会泄漏敏感query或调用供应商', async () => {
    const probe = 'SyntheticSecretProbe_110101199001010015';
    for (const pathname of [
      '/API/internal/v1/identity/verify',
      '/api/internal/v1/identityevil',
      '/api/internal/v1/%69dentity/verify',
      '//api/internal/v1/identity/verify',
      '/api/internal/v1/identity/%ZZ',
    ]) {
      const result = await request(
        `${pathname}?name=合成敏感路径探针&idCardNumber=${CARD}&token=${probe}`,
        null,
        { headers: { Referer: `https://probe.invalid/?secret=${probe}` } }
      );
      expect(result.status).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(result.body)).not.toContain(probe);
      expect(JSON.stringify(result.body)).not.toContain(CARD);
    }
    await wait(40);
    expect(output).not.toContain(probe);
    expect(output).not.toContain(CARD);
    expect(output).not.toContain('合成敏感路径探针');
    expect(calls).toHaveLength(0);
  });
  test('北京时间跨日独立日额度，两个数据库事务争抢最后一次只允许一个成功', async () => {
    const execution = require('../src/services/identityExecutionService');
    const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-16T15:59:59.000Z'));
    try {
      expect(execution.usageDate()).toBe('2026-10-16');
      await models.sequelize.transaction(transaction =>
        execution.reserveUsage(people.owner.user.id, 'day', transaction)
      );
      await sql("UPDATE identity_api_usage SET count=499 WHERE kind='day' AND period='2026-10-16'");
      const claims = await Promise.allSettled(
        [1, 2].map(() =>
          models.sequelize.transaction(transaction =>
            execution.reserveUsage(people.owner.user.id, 'day', transaction)
          )
        )
      );
      expect(claims.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      expect(claims.find(result => result.status === 'rejected').reason).toMatchObject({
        statusCode: 429,
        code: 'DAILY_LIMIT',
      });
      clock.mockReturnValue(Date.parse('2026-10-16T16:00:00.000Z'));
      expect(execution.usageDate()).toBe('2026-10-17');
      await models.sequelize.transaction(transaction =>
        execution.reserveUsage(people.owner.user.id, 'day', transaction)
      );
      const [rows] = await sql(
        "SELECT period,count FROM identity_api_usage WHERE kind='day' ORDER BY period"
      );
      expect(rows).toEqual([
        { period: '2026-10-16', count: 500 },
        { period: '2026-10-17', count: 1 },
      ]);
    } finally {
      clock.mockRestore();
    }
  });
  test('服务暂停时页面单人及批量start返回503，不新增队列；预览仍可用', async () => {
    await models.UserPermission.bulkCreate(
      ['identity.verify', 'identity.batch'].map(permissionCode => ({
        userId: people.owner.user.id,
        permissionCode,
        grantedBy: people.admin.user.id,
      })),
      { ignoreDuplicates: true }
    );
    await request('/api/identity-verifications/api-admin/service', 'admin', {
      method: 'PATCH',
      body: JSON.stringify({ paused: true }),
    });
    const status = await request('/api/identity-verifications/status');
    expect(status.body.data.paused).toBe(true);
    const single = await request('/api/identity-verifications/single', 'owner', {
      method: 'POST',
      headers: { 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ name: '合成页面暂停', idCardNumber: CARD }),
    });
    expect(single.status).toBe(503);
    expect(single.body.error.code).toBe('SERVICE_PAUSED');
    expect(await models.IdentityVerificationBatch.count()).toBe(0);
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      book,
      XLSX.utils.aoa_to_sheet([
        ['姓名', '身份证号'],
        ['合成预览', CARD],
      ]),
      '身份核验'
    );
    const service = require('../src/services/identityVerificationService');
    const preview = await service.preview(
      people.owner.user,
      XLSX.write(book, { type: 'buffer', bookType: 'xlsx' })
    );
    const start = await request(
      `/api/identity-verifications/batches/${preview.batch.id}/start`,
      'owner',
      { method: 'POST' }
    );
    expect(start.status).toBe(503);
    expect(start.body.error.code).toBe('SERVICE_PAUSED');
    expect((await models.IdentityVerificationBatch.findByPk(preview.batch.id)).status).toBe(
      'draft'
    );
    expect(calls).toHaveLength(0);
  });
  test('API日额度耗尽不影响现有Excel；全局暂停仍阻止Excel供应商发送', async () => {
    await models.UserPermission.findOrCreate({
      where: { userId: people.owner.user.id, permissionCode: 'identity.batch' },
      defaults: { grantedBy: people.admin.user.id },
    });
    expect((await verify()).status).toBe(200);
    await sql("UPDATE identity_api_usage SET count=500 WHERE kind='day'");
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      book,
      XLSX.utils.aoa_to_sheet([
        ['姓名', '身份证号'],
        ['合成独立批量', CARD],
      ]),
      '身份核验'
    );
    const service = require('../src/services/identityVerificationService');
    const preview = await service.preview(
      people.owner.user,
      XLSX.write(book, { type: 'buffer', bookType: 'xlsx' })
    );
    await service.control(people.owner.user, preview.batch.id, 'start');
    await request('/api/identity-verifications/api-admin/service', 'admin', {
      method: 'PATCH',
      body: JSON.stringify({ paused: true }),
    });
    await releaseSpacing();
    await command(processes[1], 'runner');
    expect(calls).toHaveLength(1);
    await request('/api/identity-verifications/api-admin/service', 'admin', {
      method: 'PATCH',
      body: JSON.stringify({ paused: false }),
    });
    await command(processes[1], 'runner');
    expect(calls).toHaveLength(2);
    const detail = await service.detail(people.owner.user, preview.batch.id);
    expect(detail.rows[0].status).toBe('matched');
    const [usage] = await sql("SELECT count FROM identity_api_usage WHERE kind='day'");
    expect(usage[0].count).toBe(500);
  });
  test('单人／Excel与API跨进程共享在途槽，API在途不会被后台恢复为unknown', async () => {
    await models.UserPermission.destroy({
      where: {
        userId: people.owner.user.id,
        permissionCode: ['identity.verify', 'identity.batch'],
      },
    });
    await models.UserPermission.bulkCreate(
      ['identity.verify', 'identity.batch'].map(permissionCode => ({
        userId: people.owner.user.id,
        permissionCode,
        grantedBy: people.admin.user.id,
      }))
    );
    await command(processes[0], 'delay', 250);
    const pending = verify('合成API在途');
    await wait(80);
    const queued = await request('/api/identity-verifications/single', 'owner', {
      method: 'POST',
      headers: { 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ name: '合成页面', idCardNumber: CARD }),
    });
    expect(queued.status).toBe(202);
    await command(processes[1], 'runner');
    expect(calls).toHaveLength(1);
    expect((await pending).status).toBe(200);
    await releaseSpacing();
    await command(processes[1], 'runner');
    expect(calls).toHaveLength(2);
    const [rows] = await sql('SELECT status FROM identity_verification_items ORDER BY id');
    expect(rows.map(row => row.status)).toEqual(['matched', 'matched']);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ['姓名', '身份证号'],
        ['合成Excel', CARD],
      ]),
      '身份核验'
    );
    const service = require('../src/services/identityVerificationService');
    const preview = await service.preview(
      people.owner.user,
      XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' })
    );
    await service.control(people.owner.user, preview.batch.id, 'start');
    await command(processes[1], 'delay', 250);
    await releaseSpacing();
    const work = command(processes[1], 'runner');
    await wait(80);
    expect((await verify('合成Excel竞争')).status).toBe(429);
    await work;
    expect(calls).toHaveLength(3);
    await command(processes[0], 'delay', 30);
    await command(processes[1], 'delay', 30);
  });
});
