/* eslint-env node, browser */
/* eslint-disable camelcase, no-magic-numbers -- 合成接口遵循订单契约，屏宽为验收边界 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright-core');
const BASE = process.env.ORDERS_UI_BASE_URL || 'http://127.0.0.1:5173';
const OUTPUT = process.env.ORDERS_UI_OUTPUT || '.taste-skill/overlays';

/** 仅使用合成响应验证订单所有二级界面、权限及嵌套弹层，禁止访问真实业务服务。 */
async function main() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  fs.mkdirSync(OUTPUT, { recursive: true });
  const errors = [];
  const writes = [];
  let readOnly = false;
  let failMail = false;
  let failDetail = false;
  let failForward = true;
  let failNotes = true;
  let failPayment = true;
  let photoAvailable = false;
  let progressAvailable = false;
  let payerVersion = 1;
  let serials = [];
  const order = {
    id: 101,
    order_number: 'W1027000001',
    recipient_name: '张某',
    recipient_email: 'demo@example.test',
    recipient_tag: '深圳 验收组',
    recipient_tag_state: 'present',
    recipient_tag_source: 'aos',
    products: [{ name: 'iPhone 18 Pro 银色 256G', quantity: 2 }],
    official_order_status: 'PROCESSING',
    display_order_status: 'ready_for_pickup',
    order_date: '2026-10-27T06:20:00Z',
    notes: '合成备注',
    payer_name: '原付款人',
    payer_version: 1,
    email_pickup_info: {
      storeName: 'Apple 深圳益田假日广场',
      pickupDate: '2026-10-29',
      startTime: '10:00',
      endTime: '10:30',
      appointmentMode: 'fixed',
    },
  };
  const mail = {
    id: 'mail-1',
    subject: '你的订单已准备就绪',
    from: 'Apple <sender@example.test>',
    to: 'demo@example.test',
    date: '2026-10-29T01:20:00Z',
    receivedAt: '2026-10-29T01:22:00Z',
    attachments: [],
    text: '合成纯文本取货通知',
    html: '<html><body><h1>合成取货通知</h1><p>请按预约时间到店。</p></body></html>',
    lifecycle: {
      orderStatus: 'ready_for_pickup',
      paymentStatus: 'unknown',
      templateType: 'ready_info',
      authenticityStatus: 'verified',
      parsedAt: '2026-10-29T01:23:00Z',
      pickupInfo: order.email_pickup_info,
    },
  };
  try {
    const context = await browser.newContext();
    await context.addInitScript(() => {
      if (window.top === window) localStorage.setItem('token', 'synthetic-order-overlays');
    });
    await context.route('**/*', async route => {
      try {
        const request = route.request();
        const url = new URL(request.url());
        if (!url.pathname.startsWith('/api/')) {
          if (url.origin === BASE || url.protocol === 'data:') await route.continue();
          else await route.abort();
          return;
        }
        const path = url.pathname;
        let data;
        const fail = message =>
          route.fulfill({ status: 503, json: { success: false, error: { message } } });
        if (request.method() !== 'GET')
          writes.push({ path, method: request.method(), body: request.postDataJSON() });
        if (path === '/api/auth/me') {
          let permissions = ['orders.read', 'order_mail.read'];
          if (!readOnly)
            permissions = [
              'orders.read',
              'orders.edit',
              'orders.payer.edit',
              'orders.export',
              'order_mail.read',
              'order_mail.manage',
              'order_mail.forward',
              'pickups.read',
              'ingestion.read',
            ];
          data = {
            id: 1,
            username: '界面验收',
            role: readOnly ? 'operator' : 'admin',
            permissions,
            availableHome: '/orders',
          };
        } else if (path === '/api/system/auto-refresh') data = { isRunning: false };
        else if (path === '/api/orders/filter-options')
          data = { productOptions: [], recipientTags: [], stores: [], payers: [] };
        else if (path === '/api/orders') data = { orders: [order], total: 1 };
        else if (path === '/api/orders/101' && request.method() === 'PUT') {
          const body = request.postDataJSON();
          if ('notes' in body && failNotes) {
            failNotes = false;
            return await fail('合成备注保存失败');
          }
          if ('notes' in body) order.notes = body.notes;
          if ('paymentScreenshot' in body && failPayment) {
            failPayment = false;
            return await fail('合成付款保存失败');
          }
          if ('paymentScreenshot' in body) order.payment_screenshot = body.paymentScreenshot;
          data = order;
        } else if (path === '/api/orders/101') {
          if (failDetail) {
            failDetail = false;
            return await fail('合成详情读取失败');
          }
          data = { ...order, recipient_phone: '138****0001' };
        } else if (path === '/api/orders/101/payer') {
          order.payer_name = request.postDataJSON().payerName;
          payerVersion += 1;
          order.payer_version = payerVersion;
          data = { payerVersion };
        } else if (path === '/api/orders/101/devices' && request.method() === 'POST') {
          serials = [{ id: 1, serialNumber: request.postDataJSON().serialBarcode }];
          data = { device: serials[0] };
        } else if (path === '/api/orders/101/devices') data = { items: serials };
        else if (path === '/api/orders/101/link') data = { orderUrl: null };
        else if (path === '/api/order-ingestion/orders/101/sources') data = { items: [], total: 0 };
        else if (path === '/api/pickups') {
          const evidence = [];
          if (photoAvailable)
            evidence.push({
              id: 'photo-1',
              kind: 'pickup',
              contentType: 'image/png',
              originalName: '合成照片.png',
            });
          data = { items: [{ orderId: 101, orderNumber: order.order_number, evidence }], total: 1 };
        } else if (path === '/api/pickups/101/evidence/photo-1')
          data = {
            url:
              'data:image/png;base64,' +
              'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk' +
              '+A8AAQUBAScY42YAAAAASUVORK5CYII=',
          };
        else if (path === '/api/orders/official-refresh/batches')
          data = progressAvailable ? [{ id: 'batch-1', total: 2, createdAt: mail.date }] : [];
        else if (path === '/api/orders/official-refresh/batches/batch-1')
          data = {
            id: 'batch-1',
            total: 2,
            limit: 20,
            workerOnline: true,
            counts: { succeeded: 1, failed: 1, cancelled: 0, queued: 0, running: 0 },
            jobs: [
              {
                id: 1,
                orderId: 101,
                orderNumber: order.order_number,
                state: 'succeeded',
                officialStatus: 'PROCESSING',
                observedAt: mail.date,
              },
              {
                id: 2,
                orderId: 102,
                orderNumber: 'W1027000002',
                state: 'failed',
                errorCode: 'HTTP_541',
              },
            ],
          };
        else if (path === '/api/orders/101/emails') {
          if (failMail) {
            failMail = false;
            return await fail('合成邮件读取失败');
          }
          data = { items: [mail], total: 1, page: 1, limit: 20, sync: { status: 'ready' } };
        } else if (path.endsWith('/forwards')) data = [];
        else if (path.endsWith('/forward-batch')) {
          if (failForward) {
            failForward = false;
            return await fail('合成转发失败');
          }
          data = {
            items: [
              {
                id: 1,
                recipient: 'team@example.test',
                status: 'queued',
                actorUserId: 1,
                createdAt: mail.date,
              },
            ],
          };
        } else if (path.endsWith('/lifecycle/review')) data = { version: 2 };
        else if (path.endsWith('/lifecycle/replay')) data = { mode: 'queued', queued: 1 };
        else if (path === '/api/orders/101/emails/mail-1') data = mail;
        else if (path === '/api/mail-contacts')
          data = {
            items: [{ id: 1, name: '取货组', email: 'team@example.test' }],
            total: 1,
            page: 1,
            limit: 20,
          };
        else throw new Error(`未覆盖请求 ${path}`);
        await route.fulfill({ json: { success: true, data } });
      } catch (error) {
        errors.push(error.message);
        await route.abort();
      }
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(8000);
    const openDetail = () =>
      page.getByRole('button', { name: '查看', exact: true }).first().click();
    const dialog = name => page.getByRole('dialog', { name, exact: true });
    const close = async name => {
      const panels = page.locator('.order-overlay-panel');
      const scope = (await panels.count()) ? panels.last() : page;
      await scope.getByRole('button', { name, exact: true }).click();
    };
    const shot = name => page.screenshot({ path: `${OUTPUT}/${name}.png` });
    const assertFit = async label => {
      const focus = await page.evaluate(() => {
        const element = document.activeElement;
        if (!element.matches('input,textarea,select,button,a')) return null;
        const css = getComputedStyle(element);
        return {
          shadow: css.boxShadow,
          outline: css.outlineStyle === 'none' ? 0 : parseFloat(css.outlineWidth),
          textInput: element.matches('input:not([type="checkbox"]),textarea,select'),
        };
      });
      if (focus) {
        assert.equal(focus.shadow, 'none', `${label} 不应叠加焦点阴影`);
        assert(
          focus.outline <= (focus.textInput ? 0 : 1),
          `${label} 焦点轮廓应轻量且保留键盘反馈: ${JSON.stringify(focus)}`
        );
      }
      const result = await page
        .locator('.order-overlay-panel')
        .last()
        .evaluate(panel => ({
          top: panel.getBoundingClientRect().top,
          bottom: panel.getBoundingClientRect().bottom,
          viewport: innerHeight,
          overflow: panel.scrollWidth - panel.clientWidth,
          pageOverflow: document.documentElement.scrollWidth - innerWidth,
        }));
      assert(result.top >= -1 && result.bottom <= result.viewport + 1, `${label} 弹层超出上下边界`);
      assert(result.overflow <= 1 && result.pageOverflow <= 1, `${label} 页面或弹层横向溢出`);
    };
    for (const width of [1440, 768, 390, 320]) {
      await page.setViewportSize({ width, height: width < 640 ? 740 : 900 });
      await page.goto(`${BASE}/orders`);
      await openDetail();
      await dialog('订单详情').getByText('138****0001').waitFor();
      await assertFit(`详情 ${width}`);
      await shot(`详情-${width}`);
      assert.equal(
        await dialog('订单详情').getByRole('button', { name: '保存付款信息' }).count(),
        0
      );
      await close('付款信息');
      await assertFit(`付款 ${width}`);
      await shot(`付款-${width}`);
      assert.equal(
        await dialog('订单详情').getByRole('button', { name: '保存付款信息' }).isEnabled(),
        false
      );
      await close('取货照片');
      await dialog('订单详情').getByText('暂无取货照片').waitFor();
      await close('来源记录');
      await dialog('订单详情').getByText('没有可确认的历史来源记录').waitFor();
      await close('订单概览');
      await close('修改备注');
      await dialog('修改备注').getByLabel('订单备注', { exact: true }).waitFor();
      await assertFit(`备注 ${width}`);
      await shot(`备注-${width}`);
      await close('关闭修改备注弹窗');
      assert.equal(await dialog('订单详情').isVisible(), true, '关闭备注保留底层详情');
      assert.equal(
        await page.evaluate(() => document.activeElement.textContent.trim()),
        '修改备注'
      );
      await close('关闭订单详情');
      await page.getByRole('button', { name: '列设置', exact: true }).click();
      await assertFit(`列设置 ${width}`);
      await shot(`列设置-${width}`);
      await page.getByRole('button', { name: '下移订单号', exact: true }).click();
      await close('取消');
      await page.getByRole('button', { name: '全选本页', exact: true }).click();
      await close('导出选中订单');
      await assertFit(`导出 ${width}`);
      await shot(`导出-${width}`);
      await close('关闭导出字段选择');
      await page
        .getByRole('button', { name: `订单邮件 ${order.order_number}`, exact: true })
        .click();
      await dialog('订单邮件').getByRole('button', { name: '查看邮件', exact: true }).waitFor();
      await assertFit(`邮件列表 ${width}`);
      await shot(`邮件列表-${width}`);
      await close('查看邮件');
      await page
        .frameLocator('iframe[title="邮件原始排版预览"]')
        .getByText('合成取货通知')
        .waitFor();
      await assertFit(`邮件正文 ${width}`);
      await shot(`邮件正文-${width}`);
      await close('转发与记录');
      await page.getByRole('textbox', { name: '搜索转发联系人' }).fill('取货');
      await page.getByRole('checkbox', { name: /取货组/ }).click();
      await page.getByRole('heading', { name: '转发这封邮件' }).click();
      await assertFit(`转发 ${width}`);
      await shot(`转发-${width}`);
      await close('转发邮件');
      await dialog('确认转发邮件').waitFor();
      await assertFit(`转发确认 ${width}`);
      await shot(`转发确认-${width}`);
      await close('取消');
      await close('解析与核定');
      await page.getByText('人工核定当前邮件', { exact: true }).waitFor();
      await assertFit(`人工核定 ${width}`);
      await shot(`人工核定-${width}`);
      await close('返回邮件列表');
      await close('关闭订单邮件');
      await close('官网更新进度');
      await dialog('官网更新进度')
        .getByText(/暂无官网更新任务/)
        .waitFor();
      await assertFit(`更新进度 ${width}`);
      await shot(`官网进度-${width}`);
      await close('关闭官网更新进度');
    }
    // 嵌套焦点、保存失败保留草稿、幂等重试和只读权限。
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole('button', { name: '列设置', exact: true }).click();
    await close('下移订单号');
    await close('保存');
    assert.equal((await page.getByRole('columnheader').allTextContents())[1].trim(), '商品');
    await page.reload();
    await page.getByRole('button', { name: '查看', exact: true }).first().waitFor();
    assert.equal(
      (await page.getByRole('columnheader').allTextContents())[1].trim(),
      '商品',
      '新排序刷新后保留'
    );
    await page.getByRole('button', { name: '列设置', exact: true }).click();
    await close('恢复默认');
    progressAvailable = true;
    await close('官网更新进度');
    await dialog('官网更新进度').getByRole('progressbar').waitFor();
    assert.equal(await dialog('官网更新进度').getByRole('progressbar').getAttribute('value'), '2');
    await dialog('官网更新进度').getByText('查看逐单结果', { exact: true }).click();
    await dialog('官网更新进度').getByText('官网限制访问', { exact: true }).waitFor();
    await shot('官网进度-逐单结果');
    await close('关闭官网更新进度');
    photoAvailable = true;
    failDetail = true;
    await openDetail();
    await dialog('订单详情').getByRole('alert').filter({ hasText: '合成详情读取失败' }).waitFor();
    await close('重新读取详情');
    await dialog('订单详情').getByText('138****0001').waitFor();
    await close('补录序列号');
    await dialog('订单详情')
      .getByRole('textbox', { name: '序列号', exact: true })
      .fill('ABC1234567');
    await close('保存序列号');
    await dialog('订单详情').getByText('ABC1234567', { exact: true }).waitFor();
    await close('取货照片');
    await close('查看照片 合成照片.png');
    await page.getByRole('dialog', { name: '取货照片', exact: true }).getByRole('img').waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await dialog('订单详情').isVisible(), true, 'Esc仅关闭上层照片');
    await close('订单概览');
    await close('修改备注');
    await dialog('修改备注').getByRole('button', { name: '关闭修改备注弹窗' }).focus();
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(() => document.activeElement.textContent.trim()), '保存备注');
    await page.keyboard.press('Tab');
    assert.equal(
      await page.evaluate(() => document.activeElement.getAttribute('aria-label')),
      '关闭修改备注弹窗'
    );
    await dialog('修改备注').getByLabel('订单备注', { exact: true }).fill('新的合成备注');
    await close('保存备注');
    await dialog('修改备注').getByRole('alert').waitFor();
    assert.equal(
      await dialog('修改备注').getByLabel('订单备注', { exact: true }).inputValue(),
      '新的合成备注'
    );
    await close('保存备注');
    await dialog('修改备注').waitFor({ state: 'hidden' });
    await close('付款信息');
    await dialog('订单详情').getByLabel('付款人', { exact: true }).fill('新付款人');
    await dialog('订单详情')
      .locator('input[type="file"]')
      .setInputFiles({
        name: '合成付款凭证.png',
        mimeType: 'image/png',
        buffer: Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk' +
            '+A8AAQUBAScY42YAAAAASUVORK5CYII=',
          'base64'
        ),
      });
    await dialog('订单详情').getByAltText('付款截图 1', { exact: true }).waitFor();
    await close('关闭订单详情');
    await dialog('放弃未保存的付款修改？').waitFor();
    await close('继续编辑');
    assert.equal(
      await dialog('订单详情').getByLabel('付款人', { exact: true }).inputValue(),
      '新付款人'
    );
    await close('保存付款信息');
    await dialog('保存失败').waitFor();
    await close('确定');
    assert.equal(
      await dialog('订单详情').getByLabel('付款人', { exact: true }).inputValue(),
      '新付款人'
    );
    await close('保存付款信息');
    await dialog('保存成功').waitFor();
    await close('确定');
    await close('关闭订单详情');
    failMail = true;
    await page.getByRole('button', { name: `订单邮件 ${order.order_number}`, exact: true }).click();
    await dialog('订单邮件').getByRole('alert').waitFor();
    await close('重新加载');
    await close('查看邮件');
    await close('转发与记录');
    await page.getByRole('textbox', { name: '搜索转发联系人' }).click();
    await page.getByRole('checkbox', { name: /取货组/ }).click();
    await page.getByRole('heading', { name: '转发这封邮件' }).click();
    await close('转发邮件');
    const beforeSend = writes.filter(item => item.path.endsWith('/forward-batch')).length;
    assert.equal(beforeSend, 0, '确认之前不能提交转发');
    await close('确认并转发');
    await page.getByText(/合成转发失败/).waitFor();
    await close('重试原请求');
    await page.getByText('已提交 1 个转发任务，可在下方分别查看发送结果。').waitFor();
    const sends = writes.filter(item => item.path.endsWith('/forward-batch'));
    assert.equal(sends.length, 2);
    assert.deepEqual(sends[0].body, sends[1].body, '转发失败重试复用完整请求及幂等键');
    await close('解析与核定');
    await dialog('订单邮件').getByLabel('核定依据').fill('按合成官方邮件核定取货状态');
    await close('保存核定');
    await dialog('订单邮件').getByRole('status').filter({ hasText: '人工核定已追加' }).waitFor();
    assert.equal(writes.filter(item => item.path.endsWith('/lifecycle/review')).length, 1);
    await close('关闭订单邮件');
    readOnly = true;
    await page.goto(`${BASE}/orders`);
    await openDetail();
    await close('付款信息');
    assert.equal(await dialog('订单详情').getByRole('button', { name: '保存付款信息' }).count(), 0);
    assert.equal(await dialog('订单详情').getByRole('button', { name: '添加付款截图' }).count(), 0);
    assert.equal(await dialog('订单详情').getByRole('button', { name: '来源记录' }).count(), 0);
    await close('关闭订单详情');
    await page.getByRole('button', { name: `订单邮件 ${order.order_number}`, exact: true }).click();
    await close('查看邮件');
    await close('解析与核定');
    assert.equal(await page.getByRole('button', { name: '保存核定', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: '转发与记录', exact: true }).count(), 0);
    assert.deepEqual(errors, []);
    fs.writeFileSync(
      `${OUTPUT}/交互验证.json`,
      JSON.stringify({ widths: [1440, 768, 390, 320], writes, errors }, null, 2)
    );
    process.stdout.write(
      'PASS: 订单全部弹层四宽度、嵌套焦点、保存草稿与错误重试、转发二次确认与幂等重试、只读权限\n'
    );
  } finally {
    await browser.close();
  }
}
main().catch(error => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
