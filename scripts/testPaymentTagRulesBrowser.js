/* global localStorage */
const assert = require('node:assert/strict');
const logger = require('../src/utils/logger');

/**
 * 专用浏览器及合成 API 验证 TAG 配置，不访问真实业务 API。
 * @returns {Promise<void>} 验收结果
 */
async function main() {
  let browser;
  let context;
  try {
    if (!process.env.PAYMENT_BROWSER_WS) throw new Error('需要专用临时浏览器地址');
    browser = await require('playwright-core').chromium.connectOverCDP(
      process.env.PAYMENT_BROWSER_WS,
      { headers: { Host: '127.0.0.1' } }
    );
    context = await browser.newContext({
      serviceWorkers: 'block',
      viewport: { width: 1440, height: 1000 },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    let rules = [];
    let ruleId = 0;
    let conflict = false;
    let loadFailure = false;
    let canConfigure = true;
    const errors = [];
    const writes = [];
    const staff = [1, 2, 3].map(id => ({
      id,
      username: `payer_${id}`,
      nickname: `付款员${id}`,
      status: 'active',
      hasExecutionPermissions: id !== 3,
      autoAssignEnabled: id !== 2,
      maxActiveTasks: 10,
      activeCount: 0,
      remainingCapacity: 10,
      version: 0,
    }));
    page.on('pageerror', error => errors.push(error.message));
    await context.addInitScript(() => localStorage.setItem('token', 'synthetic-tag-token'));
    await context.route('**/*', async route => {
      try {
        const url = new URL(route.request().url());
        if (!url.pathname.startsWith('/api/')) {
          if (url.origin === 'http://127.0.0.1:5173') await route.continue();
          else await route.abort();
          return;
        }
        const method = route.request().method();
        let data;
        let status = 200;
        const fail = async (code, message, statusCode) => {
          try {
            await route.fulfill({
              status: statusCode,
              contentType: 'application/json',
              body: JSON.stringify({ success: false, error: { code, message } }),
            });
          } catch (error) {
            errors.push(error.message);
          }
        };
        if (url.pathname === '/api/auth/me')
          data = {
            id: 1,
            username: 'synthetic_admin',
            role: 'admin',
            permissions: [
              'payment_dispatch.read',
              ...(canConfigure ? ['payment_dispatch.configure'] : []),
            ],
            availableHome: '/payment-dispatch',
          };
        else if (url.pathname === '/api/payment-dispatch/overview')
          data = { settings: { enabled: true, mode: 'auto', version: 0 }, staff };
        else if (url.pathname === '/api/payment-dispatch/tasks')
          data = {
            items: [
              {
                id: 1,
                orderId: 1,
                orderNumber: 'W0000000001',
                recipientTag: '渠道A',
                products: [{ name: '合成手机', quantity: 1 }],
                processingStatus: 'pending',
                officialOrderStatus: 'payment_due',
                autoAssignment: {
                  ruleId: 1,
                  ruleName: '渠道A专属',
                  reasonCode: 'RULE_CAPACITY_FULL',
                  reason: '指定账号容量不足，等待释放容量',
                },
              },
            ],
            recipientTagOptions: ['渠道A'],
            pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
            serverTime: new Date().toISOString(),
          };
        else if (url.pathname.startsWith('/api/payment-dispatch/tag-rules')) {
          if (loadFailure && method === 'GET') {
            await fail('TEST_LOAD_FAILURE', '合成规则加载失败', 500);
            return;
          }
          if (method === 'GET')
            data = { items: rules, tagOptions: ['渠道A', '渠道B', '渠道A-其他'] };
          else {
            const body = route.request().postDataJSON();
            writes.push({ method, body });
            if (conflict) {
              conflict = false;
              await fail(
                'CONCURRENT_MODIFICATION',
                '规则已被其他管理员修改，请重新加载后再编辑',
                409
              );
              return;
            }
            if (method === 'POST') {
              data = { ...body, id: ++ruleId, version: 0 };
              rules.push(data);
              status = 201;
            } else {
              const id = Number(url.pathname.split('/').at(-1));
              if (method === 'DELETE') {
                rules = rules.filter(rule => rule.id !== id);
                data = { id };
              } else {
                data = { ...body, id, version: body.expectedVersion + 1 };
                rules = rules.map(rule => (rule.id === id ? data : rule));
              }
            }
          }
        } else {
          await fail('UNEXPECTED_API', '合成测试拦截了未预期 API', 400);
          return;
        }
        await route.fulfill({
          status,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data }),
        });
      } catch (error) {
        errors.push(error.message);
        await route.abort();
      }
    });
    await page.goto('http://127.0.0.1:5173/payment-dispatch');
    await page.getByText('指定账号容量不足，等待释放容量', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'TAG 分配规则', exact: true }).click();
    const modal = page.getByRole('dialog', { name: 'TAG 分配规则' });
    await modal.getByText('暂无 TAG 分配规则，当前沿用默认分配方式').waitFor();
    await modal.getByRole('button', { name: '新增规则' }).click();
    await modal.getByLabel('规则名称', { exact: true }).fill('渠道专属付款');
    await modal.getByRole('button', { name: '选择规则 TAG' }).click();
    await modal.getByRole('option', { name: '渠道A', exact: true }).click();
    await modal.getByRole('option', { name: '渠道B', exact: true }).click();
    await modal.getByRole('button', { name: '选择规则 TAG' }).click();
    await modal.getByLabel('手工输入 TAG').fill('未来渠道');
    await modal.getByRole('button', { name: '添加 TAG' }).click();
    await modal.getByLabel('选择账号 payer_1', { exact: true }).check();
    await modal.getByLabel('选择账号 payer_2', { exact: true }).check();
    assert.equal(await modal.getByLabel('选择账号 payer_3', { exact: true }).isDisabled(), true);
    await page.screenshot({ path: '/tmp/tag-rules-desktop.png', fullPage: true });
    await modal.getByRole('button', { name: '保存规则', exact: true }).click();
    await modal.getByText('规则已保存，将在下一次自动调度时生效').waitFor();
    assert.deepEqual(rules[0].recipientTags, ['渠道A', '渠道B', '未来渠道']);
    assert.deepEqual(rules[0].assigneeUserIds, [1, 2]);

    await modal.getByRole('button', { name: '编辑', exact: true }).click();
    await modal.getByLabel('启用规则', { exact: true }).uncheck();
    conflict = true;
    await modal.getByRole('button', { name: '保存规则', exact: true }).click();
    await modal
      .getByRole('alert')
      .getByText('规则已被其他管理员修改，请重新加载后再编辑', { exact: false })
      .waitFor();
    assert.equal(await modal.getByLabel('启用规则', { exact: true }).isChecked(), false);
    await modal.getByRole('button', { name: '重新加载规则' }).click();
    await modal.getByRole('button', { name: '编辑', exact: true }).click();
    assert.equal(await modal.getByLabel('启用规则', { exact: true }).isChecked(), true);
    await modal.getByLabel('启用规则', { exact: true }).uncheck();
    await modal.getByRole('button', { name: '保存规则', exact: true }).click();
    await modal.getByText('停用', { exact: true }).waitFor();
    assert.equal(rules[0].version, 1);

    await page.setViewportSize({ width: 430, height: 932 });
    await modal.getByRole('button', { name: '编辑', exact: true }).click();
    for (const width of [375, 768, 1024, 430]) {
      await page.setViewportSize({ width, height: 932 });
      const bounds = await modal.boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width);
      await modal.getByRole('button', { name: '保存规则', exact: true }).scrollIntoViewIfNeeded();
      assert.equal(await modal.getByRole('button', { name: '保存规则', exact: true }).isVisible(), true);
    }
    await page.screenshot({ path: '/tmp/tag-rules-mobile.png' });
    await modal.getByRole('button', { name: '取消编辑' }).click();
    await modal.getByRole('button', { name: '删除', exact: true }).click();
    assert.equal(rules.length, 1);
    await modal.getByRole('button', { name: '取消删除' }).click();
    assert.equal(rules.length, 1);
    await modal.getByRole('button', { name: '删除', exact: true }).click();
    await modal.getByRole('button', { name: '确认删除' }).click();
    await modal.getByText('暂无 TAG 分配规则，当前沿用默认分配方式').waitFor();
    assert.equal(rules.length, 0);
    await modal.getByRole('button', { name: '关闭 TAG 分配规则' }).click();

    loadFailure = true;
    await page.getByRole('button', { name: 'TAG 分配规则', exact: true }).click();
    await modal.getByText('合成规则加载失败', { exact: false }).waitFor();
    loadFailure = false;
    await modal.getByRole('button', { name: '重新加载规则' }).click();
    await modal.getByText('暂无 TAG 分配规则，当前沿用默认分配方式').waitFor();
    await page.keyboard.press('Escape');
    await modal.waitFor({ state: 'hidden' });
    canConfigure = false;
    await page.reload();
    await page.getByRole('heading', { name: '任务队列' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'TAG 分配规则', exact: true }).count(), 0);
    assert.deepEqual(errors, []);
    logger.info('TAG 规则合成浏览器验收通过', {
      writes: writes.length,
      scenarios:
        '多TAG多账号、新增、停用、冲突保留与重载、删除确认、错误重试、等待原因、配置权限、桌面及430px布局',
    });
  } catch (error) {
    logger.error('TAG 规则浏览器验收失败', { error: error.message });
    process.exitCode = 1;
  } finally {
    if (context) await context.close();
    if (browser) await browser.close();
  }
}
main();
