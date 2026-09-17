/* eslint-env node, browser */
/* eslint-disable camelcase -- 合成 API 契约 */
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      serviceWorkers: 'block',
    });
    const page = await context.newPage(),
      errors = [],
      writes = [],
      requests = [];
    const permissions = ['recipients', 'apple_ids']
      .flatMap(resource =>
        ['read', 'create', 'edit', 'import', 'template.read'].map(action => `${resource}.${action}`)
      )
      .concat([
        'recipients.bind_apple_ids',
        'recipients.export',
        'recipients.export_sensitive',
        'apple_ids.secrets.read',
        'orders.read',
        'orders.edit',
      ]);
    const recipient = {
      id: 1,
      name: '欧阳明',
      last_name: '欧阳',
      first_name: '明',
      id_card_number: '110101199001010001',
      real_phone: '13900000000',
      phone: '13800000000',
      email: '13800000000@vvv8.net',
      province: '四川省',
      city: '成都市',
      district: '武侯区',
      street_address: '合成街道1号',
      apple_id: 'a@example.invalid',
      apple_id_ref: 1,
      password: 'synthetic-pass',
      notes: '原备注',
      status: '异常',
      order_count: 2,
      created_at: '2026-09-17T00:00:00Z',
    };
    const account = {
      id: 1,
      apple_id: 'a@example.invalid',
      password: 'synthetic-pass',
      country: '中国',
      status: '未使用',
      notes: '唯一备注',
      recipient_count: 1,
      order_count: 2,
      recipients: [{ id: 1, name: '欧阳明' }],
    };
    const qa = {
      question1: '问题一',
      answer1: '答案一',
      question2: '问题二',
      answer2: '答案二',
      question3: '问题三',
      answer3: '答案三',
    };
    const plan = resolved => ({
      summary: { total: 2, records: 1, invalid: 0, conflicts: resolved ? 0 : 1, blocked: 0 },
      records: [
        {
          id: 'g0',
          kind: 'recipient',
          label: '欧阳明 1101**********0001',
          sources: ['合成.xlsx / 北京 / 第2行'],
          fields: { TAG: resolved ? '新TAG' : '旧TAG' },
          action: '更新',
          problems: [],
        },
      ],
      conflicts: [
        {
          id: 'g0:tag',
          groupId: 'g0',
          field: 'TAG',
          resolved,
          options: [
            { key: 'existing', source: '系统已有', value: '旧TAG' },
            { key: 'source0', source: '合成来源', value: '新TAG' },
          ],
        },
      ],
      errors: [],
    });
    page.on('pageerror', error => errors.push(error.message));
    await context.addInitScript(() =>
      localStorage.setItem('token', 'synthetic-profile-management')
    );
    await context.route('**/*', async route => {
      try {
        const request = route.request(),
          url = new URL(request.url());
        if (!url.pathname.startsWith('/api/')) {
          if (url.origin === 'http://127.0.0.1:5173') await route.continue();
          else await route.abort();
          return;
        }
        requests.push({ path: url.pathname, query: Object.fromEntries(url.searchParams) });
        let data;
        if (url.pathname === '/api/auth/me')
          data = {
            id: 1,
            username: '合成测试',
            role: 'operator',
            permissions,
            availableHome: '/recipients',
          };
        else if (url.pathname === '/api/recipients' && request.method() === 'GET')
          data = { recipients: [recipient], total: 1 };
        else if (url.pathname === '/api/apple-ids' && request.method() === 'GET')
          data = { apple_ids: [account], total: 1 };
        else if (url.pathname.endsWith('/bindings'))
          data = [
            {
              id: 1,
              recipient_name: '欧阳明',
              apple_id: 'a@example.invalid',
              started_at: null,
              ended_at: null,
              observed_at: '2026-09-17T00:00:00Z',
            },
          ];
        else if (url.pathname === '/api/recipients/1' && request.method() === 'GET')
          data = recipient;
        else if (url.pathname === '/api/apple-ids/1' && request.method() === 'GET')
          data = {
            ...account,
            ...(url.searchParams.get('includeSecrets') === 'true' ? { security_qa: qa } : {}),
          };
        else if (
          ['/api/recipients/1', '/api/apple-ids/1', '/api/recipients', '/api/apple-ids'].includes(
            url.pathname
          )
        ) {
          writes.push({ path: url.pathname, body: request.postDataJSON() });
          data = {};
        } else if (url.pathname === '/api/orders')
          data = {
            total: 1,
            orders: [
              {
                id: 9,
                order_number: 'W7000000009',
                apple_id: 'a@example.invalid',
                recipient_name: '欧阳明',
                status: 'pending',
              },
            ],
          };
        else if (url.pathname === '/api/import/preview')
          data = { sessionToken: 'synthetic-preview', ...plan(false) };
        else if (url.pathname === '/api/import/review') {
          writes.push({ path: url.pathname, body: request.postDataJSON() });
          data = plan(true);
        } else if (url.pathname === '/api/import/execute') {
          writes.push({ path: url.pathname, body: request.postDataJSON() });
          data = { imported: 0, updated: 1, skipped: 1, errors: [] };
        } else if (url.pathname === '/api/import/associations/preview')
          data = {
            token: 'synthetic-link',
            nextCursor: null,
            records: [
              {
                orderId: 9,
                orderNumber: 'W7000000009',
                recipientId: 1,
                recipientName: '欧阳明',
                appleIdRef: 1,
                matchable: true,
              },
            ],
          };
        else if (url.pathname === '/api/import/associations/execute') {
          writes.push({ path: url.pathname, body: request.postDataJSON() });
          data = { updated: 1 };
        } else if (url.pathname === '/api/recipients/export') {
          await route.fulfill({
            contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            body: 'synthetic-file',
          });
          return;
        } else throw new Error(`未预期请求 ${url.pathname}`);
        await route.fulfill({ json: { success: true, data } });
      } catch (error) {
        errors.push(error.message);
        await route.abort();
      }
    });
    await page.goto('http://127.0.0.1:5173/recipients');
    await page.getByText('13900000000', { exact: true }).waitFor();
    await page.getByRole('button', { name: '编辑取机人 1' }).click();
    assert.equal(await page.getByLabel('姓 *', { exact: true }).inputValue(), '欧阳');
    await page.getByLabel('街道地址', { exact: true }).fill('新街道9号');
    await page.getByLabel('真实联系电话', { exact: true }).fill('');
    await page.getByLabel('备注', { exact: true }).fill('新备注');
    await page.getByLabel('绑定 Apple ID（留空解除绑定）').fill('b@example.invalid');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.equal(writes[0].body.lastName, '欧阳');
    assert.equal(writes[0].body.expectedAppleIdRef, 1);
    assert.equal(writes[0].body.appleId, 'b@example.invalid');
    assert.equal(writes[0].body.realPhone, '');
    assert.equal(writes[0].body.streetAddress, '新街道9号');
    assert.equal(writes[0].body.notes, '新备注');
    await page.getByRole('button', { name: '2', exact: true }).click();
    await page.getByRole('heading', { name: '绑定历史（最近 200 条）' }).waitFor();
    assert(
      requests.some(request => request.path === '/api/orders' && request.query.recipient_id === '1')
    );
    await page
      .getByRole('dialog')
      .getByRole('button', { name: '关闭', exact: true })
      .last()
      .click();
    await page.getByRole('button', { name: '批量导入', exact: true }).click();
    await page.getByLabel('选择导入文件').setInputFiles({
      name: '合成.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: Buffer.from('synthetic-preview-only'),
    });
    await page.getByRole('button', { name: '生成预览', exact: true }).click();
    await page.getByText('未裁定差异 1', { exact: false }).waitFor();
    await page.screenshot({ path: '/tmp/profile-management-import.png', fullPage: true });
    assert.equal(writes.filter(x => x.path === '/api/import/execute').length, 0);
    assert.equal(await page.getByRole('button', { name: '确认导入有效档案' }).isDisabled(), true);
    await page
      .getByLabel('欧阳明 1101**********0001 TAG 来源', { exact: true })
      .selectOption('source0');
    await page.getByRole('button', { name: '更新预览', exact: true }).click();
    await page.getByRole('button', { name: '确认导入有效档案' }).click();
    await page.getByText(/导入完成/).waitFor();
    assert.deepEqual(writes.find(x => x.path === '/api/import/execute').body.decisions, {
      'g0:tag': 'source0',
    });
    await page
      .getByRole('dialog')
      .getByRole('button', { name: '关闭', exact: true })
      .last()
      .click();
    await page.getByRole('button', { name: '关联历史订单', exact: true }).click();
    await page.getByRole('button', { name: '生成／重新生成预览' }).click();
    await page.getByLabel('选择订单 W7000000009').check();
    assert.equal(writes.filter(x => x.path === '/api/import/associations/execute').length, 0);
    await page.getByRole('button', { name: '确认关联选中 1 条' }).click();
    await page.getByText('已补齐 1 条订单的空关联。').waitFor();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: '关闭', exact: true })
      .last()
      .click();
    await page.locator('tbody input[type="checkbox"]').first().check();
    await Promise.all([
      page.waitForRequest(request => request.url().includes('/api/recipients/export')),
      page.getByRole('button', { name: '导出录入信息' }).click(),
    ]);
    assert(
      requests.some(
        request =>
          request.path === '/api/recipients/export' &&
          request.query.includeSensitive === 'true' &&
          request.query.ids === '1'
      )
    );
    await page.goto('http://127.0.0.1:5173/apple-ids');
    await page.getByText('唯一备注', { exact: true }).waitFor();
    await page.getByRole('button', { name: '编辑 Apple ID 1' }).click();
    await page.getByLabel('答案 1', { exact: true }).waitFor();
    await page.waitForFunction(() =>
      [...document.querySelectorAll('input')].some(input => input.value === '答案一')
    );
    await page.getByLabel('答案 1', { exact: true }).fill('修改答案');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.equal(
      writes.find(x => x.path === '/api/apple-ids/1').body.security_qa.answer1,
      '修改答案'
    );
    for (const width of [1440, 375]) {
      await page.setViewportSize({ width, height: 900 });
      for (const route of ['recipients', 'apple-ids']) {
        await page.goto(`http://127.0.0.1:5173/${route}`);
        await page
          .getByRole('button', {
            name: route === 'recipients' ? '添加取机人' : '添加 Apple ID',
            exact: true,
          })
          .click();
        assert.equal(await page.getByLabel('使用状态').inputValue(), '未使用');
        const box = await page.getByRole('dialog').boundingBox();
        assert(box.x >= 0 && box.x + box.width <= width);
        if (route === 'apple-ids')
          await page.screenshot({
            path: `/tmp/profile-management-form-${width}.png`,
            fullPage: true,
          });
        if (route === 'apple-ids')
          assert.equal(await page.getByLabel('国家 *').inputValue(), '中国');
        await page.getByRole('button', { name: '取消', exact: true }).click();
      }
    }
    assert.deepEqual(errors, []);
    process.stdout.write(
      'PASS: 完整编辑/复姓/换绑预期值、导入先预览裁定、历史关联确认、敏感勾选导出、密保回显、默认状态、桌面与375px弹窗\n'
    );
    await context.close();
  } finally {
    await browser.close();
  }
})().catch(error => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
