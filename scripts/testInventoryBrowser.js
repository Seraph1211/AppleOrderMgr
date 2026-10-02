/* global localStorage, document, navigator, window, getComputedStyle */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { DEFAULT_CONFIG } = require('../src/services/inventoryPolicy');
const logger = require('../src/utils/logger');
/** 专用临时浏览器验证，所有 API 均合成拦截，不启动真实采集或通知。 */
async function main() {
  let browser;
  try {
    if (!process.env.INVENTORY_BROWSER_EXECUTABLE) throw new Error('需要专用浏览器可执行文件');
    browser = await chromium.launch({
      executablePath: process.env.INVENTORY_BROWSER_EXECUTABLE,
      headless: true,
    });
    const baseUrl = process.env.INVENTORY_BROWSER_BASE_URL || 'http://127.0.0.1:5317';
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(baseUrl)) throw new Error('合成验收仅允许本机服务');
    const output = path.resolve(process.env.INVENTORY_BROWSER_OUTPUT || 'test-artifacts/inventory');
    fs.mkdirSync(output, { recursive: true });
    for (const viewport of [
      { width: 1440, height: 1000 },
      { width: 1024, height: 768 },
      { width: 768, height: 1024 },
      { width: 375, height: 667 },
      { width: 375, height: 500 },
    ]) {
      const context = await browser.newContext({
        viewport,
        isMobile: viewport.width === 375,
        hasTouch: viewport.width === 375,
        permissions: ['clipboard-read', 'clipboard-write'],
        serviceWorkers: 'block',
      });
      const page = await context.newPage();
      page.setDefaultTimeout(12000);
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      let allowed = true;
      let readAllowed = false;
      const forbiddenReads = [];
      let historyQuery;
      let fail = false;
      let checked = 0;
      let saved = 0;
      let exported = 0;
      let settings = {
        version: 1,
        config: { ...DEFAULT_CONFIG, enabled: true },
        hasWebhook: false,
        webhookTested: false,
      };
      const product = {
        id: 'TEST18PROCH/A',
        sku: 'TEST18PROCH/A',
        title: 'iPhone 18 Pro 512GB Black',
        model: 'iPhone 18 Pro',
        capacity: '512GB',
        color: '黑色',
        enabled: true,
        supported: true,
      };
      const store = {
        id: 'R320',
        storeCode: 'R320',
        storeName: '三里屯',
        city: '北京',
        enabled: true,
      };
      const row = {
        ...product,
        ...store,
        id: 'TEST18PROCH/A|R320',
        displayStatus: 'in_stock',
        status: 'in_stock',
        lastStatus: 'in_stock',
        quote: '今天可取货',
        source: 'auto',
        observedAt: Date.now(),
        lastAttemptAt: Date.now(),
      };
      const deliver = [];
      let latestQuery;
      await page.route('**/*', async route => {
        try {
          const url = new URL(route.request().url());
          if (!url.pathname.startsWith('/api/')) {
            if (url.origin === baseUrl) await route.continue();
            else await route.abort();
            return;
          }
          let data = {};
          if (url.pathname === '/api/auth/me')
            data = {
              id: 9,
              username: 'inventory-test',
              nickname: '库存测试',
              role: allowed ? 'admin' : 'operator',
              permissions: allowed || readAllowed ? ['inventory.read'] : [],
              availableHome: '/profile',
            };
          else if (url.pathname.startsWith('/api/inventory/')) {
            if (
              !allowed &&
              !(
                readAllowed &&
                route.request().method() === 'GET' &&
                ['catalog', 'scope', 'latest', 'history', 'history/export', 'analysis'].includes(
                  url.pathname.slice('/api/inventory/'.length)
                )
              )
            ) {
              forbiddenReads.push(url.pathname);
              await route.fulfill({
                status: 403,
                json: { success: false, error: { message: '仅管理员可访问' } },
              });
              return;
            }
            const action = url.pathname.slice('/api/inventory/'.length);
            const method = route.request().method();
            if (fail && action === 'latest') {
              await route.fulfill({
                status: 503,
                json: { success: false, error: { message: '合成读取失败' } },
              });
              return;
            }
            if (action === 'catalog' && method === 'GET')
              data = {
                products: [product],
                stores: [
                  store,
                  ...Array.from({ length: 48 }, (_, index) => ({
                    ...store,
                    id: `R${index}`,
                    storeCode: `R${index}`,
                    storeName: `测试直营店 ${String(index).padStart(2, '0')} 综合购物中心`,
                  })),
                ],
              };
            else if (action === 'scope')
              data = {
                products: product.enabled ? [product] : [],
                stores: store.enabled ? [store] : [],
                combinations: product.enabled && store.enabled ? 1 : 0,
                enabled: settings.config.enabled,
                state: 'normal',
                lastSuccessAt: row.observedAt,
              };
            else if (action === 'catalog') {
              const body = route.request().postDataJSON();
              (body.kind === 'products' ? product : store).enabled = body.enabled;
              data = { count: 1 };
            } else if (action === 'settings' && method === 'GET') data = settings;
            else if (action === 'settings') {
              const body = route.request().postDataJSON();
              saved += 1;
              settings = {
                ...settings,
                version: settings.version + 1,
                config: body.config,
                hasWebhook: settings.hasWebhook || Boolean(body.webhook),
              };
              data = settings;
            } else if (action === 'latest') {
              latestQuery = Object.fromEntries(url.searchParams);
              data = {
                items: [
                  row,
                  {
                    ...row,
                    id: 'second',
                    model: 'iPhone 18 Pro Max',
                    color: '深空黑色',
                    storeName: '北京朝阳大悦城',
                    storeCode: 'R479',
                    displayStatus: 'stale',
                    quote: '上次可取货',
                  },
                  {
                    ...row,
                    id: 'third',
                    color: '银色',
                    storeName: '王府井',
                    storeCode: 'R448',
                    displayStatus: 'error',
                    error: '网络暂时不可用，请稍后查看',
                    quote: '',
                  },
                ],
                total: 51,
                page: +(url.searchParams.get('page') || 1),
                pageSize: 50,
                summary: { combinations: 51, inStock: 1, currentStores: 1, fresh: 50 },
              };
            } else if (action === 'health')
              data = {
                state: 'normal',
                paused: false,
                hourCount: 20,
                dayCount: 100,
                lastSuccessAt: row.observedAt,
                nextRoundAt: Date.now() + 300000,
                workerHeartbeat: Date.now(),
              };
            else if (action === 'refresh') {
              checked += 1;
              data = { id: 'test-round', coalesced: false };
            } else if (action === 'rounds')
              data = {
                items: [
                  {
                    id: 'round',
                    plannedAt: Date.now(),
                    startedAt: Date.now() - 12000,
                    finishedAt: Date.now(),
                    source: 'auto',
                    status: 'partial',
                    completed: 40,
                    expected: 49,
                    failed: 9,
                    pending: 0,
                    retries: 1,
                  },
                ],
                total: 1,
                page: 1,
                pageSize: 50,
              };
            else if (action.startsWith('rounds/'))
              data = {
                items: [{ ...row, status: 'complete', stockStatus: 'in_stock' }],
                total: 1,
                page: 1,
                pageSize: 50,
                expected: 49,
                completed: 40,
                failed: 9,
                plannedAt: Date.now(),
                detailAvailable: true,
                tasks: [],
              };
            else if (action === 'history') {
              historyQuery = Object.fromEntries(url.searchParams);
              data = { items: [{ ...row, kind: 'arrival' }], total: 1, page: 1, pageSize: 50 };
            } else if (action === 'history/export') {
              exported += 1;
              await route.fulfill({
                contentType: 'text/csv',
                body: 'SKU,城市\nTEST18PROCH/A,北京',
              });
              return;
            } else if (action === 'analysis')
              data = {
                metric: 'arrivals',
                bucketMinutes: +(url.searchParams.get('bucketMinutes') || 60),
                detailAvailable: true,
                notice: '观测次数，不代表销量；灰色为缺口。',
                coverage: { complete: 1, planned: 2, ratio: 0.5 },
                hours: [{ key: '14', count: 1 }],
                configurations: [{ key: 'iPhone 18 Pro · 512GB · 黑色', count: 1 }],
                cities: [{ key: '北京', count: 1 }],
                stores: [{ key: '北京 · 三里屯', count: 1 }],
                heatmap: [
                  {
                    key: String(Math.floor(Date.now() / 3600000) * 3600000),
                    count: 1,
                    gap: false,
                    complete: 1,
                    planned: 1,
                  },
                  {
                    key: String(Math.floor(Date.now() / 3600000) * 3600000 - 3600000),
                    count: null,
                    gap: true,
                    complete: 0,
                    planned: 1,
                  },
                ],
              };
            else if (action === 'notifications/test') {
              settings.webhookTested = true;
              deliver.push({
                id: 'test-delivery',
                kind: 'test',
                status: 'accepted',
                attempts: 1,
                sentAt: Date.now(),
              });
              data = { queued: true };
            } else if (action === 'deliveries')
              data = { items: deliver, total: deliver.length, page: 1, pageSize: 50 };
            else if (['resume', 'catalog/refresh'].includes(action)) data = { queued: true };
            else throw new Error(`未处理合成路径 ${action}`);
          }
          await route.fulfill({ json: { success: true, data } });
        } catch (error) {
          errors.push(error.message);
          await route.abort();
        }
      });
      await context.addInitScript(() => localStorage.setItem('token', 'synthetic-inventory-token'));
      await page.goto(`${baseUrl}/inventory-monitor`);
      await page
        .getByRole('region', { name: '全国库存列表' })
        .locator('.inventory-status:visible')
        .filter({ hasText: /^有货$/ })
        .waitFor();
      const click = async locator => {
        try {
          if (viewport.width === 375) await locator.tap();
          else await locator.click();
        } catch (error) {
          throw new Error('交互失败', { cause: error });
        }
      };
      const menu = async name => {
        try {
          const group = ['监控管理', '通知与健康'].includes(name) ? '监控管理' : '库存监控';
          if (
            !(await page
              .getByRole('navigation', { name: '库存视图' })
              .getByRole('button', { name, exact: true })
              .count())
          ) {
            if (viewport.width < 1024)
              await click(page.getByRole('button', { name: '打开导航', exact: true }));
            await click(
              page
                .getByRole('navigation', { name: '主导航' })
                .getByRole('link', { name: group, exact: true })
            );
          }
          await click(
            page
              .getByRole('navigation', { name: '库存视图' })
              .getByRole('button', { name, exact: true })
          );
        } catch (error) {
          throw new Error('菜单导航失败', { cause: error });
        }
      };
      const scope = page.getByRole('region', { name: '已启用监控范围' });
      assert.equal(
        await page.getByRole('navigation', { name: '库存视图' }).getByRole('button').count(),
        3
      );
      assert.equal(await page.getByRole('link', { name: '历史记录', exact: true }).count(), 0);
      await scope.getByText('1 个商品配置 × 1 家门店，共 1 个组合').waitFor();
      await click(scope.locator('summary').first());
      await scope
        .getByRole('list', { name: '已启用商品明细' })
        .getByText('TEST18PROCH/A', { exact: true })
        .waitFor();
      await click(scope.locator('summary').last());
      await scope
        .getByRole('list', { name: '已启用门店明细' })
        .getByText('R320', { exact: true })
        .waitFor();
      await click(page.getByRole('checkbox', { name: '全选本页库存' }));
      await click(page.getByRole('button', { name: '复制选中 (3)' }));
      assert.match(
        await page.evaluate(() => navigator.clipboard.readText()),
        /TEST18PRO|iPhone 18 Pro/
      );
      await click(page.getByRole('button', { name: '检查当前筛选' }));
      await page.getByRole('status').filter({ hasText: '统一查询队列' }).waitFor();
      assert.equal(checked, 1);
      const assertNoOverflow = async () => {
        try {
          assert.equal(
            await page.evaluate(
              () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
            ),
            false,
            '页面不应横向溢出'
          );
        } catch (error) {
          throw new Error('响应式边界失败', { cause: error });
        }
      };
      await assertNoOverflow();
      if (viewport.width === 375) {
        const list = page.getByRole('region', { name: '全国库存列表' });
        assert.ok((await list.locator('.inventory-list-heading label').boundingBox()).height >= 44);
        const details = list.locator('summary').first();
        await click(details);
        await list.getByText('今天可取货', { exact: true }).locator('visible=true').waitFor();
        await click(details);
        assert.equal(
          await page.getByRole('button', { name: '城市', exact: true }).isVisible(),
          false
        );
        await click(page.getByRole('button', { name: '商品与门店筛选', exact: true }));
      }
      await click(page.getByRole('button', { name: '城市', exact: true }));
      await page.getByLabel('搜索城市', { exact: true }).fill('不存在的城市');
      await page.getByText('没有匹配的选项', { exact: true }).waitFor();
      await page.getByLabel('搜索城市', { exact: true }).fill('');
      if (viewport.width === 375) {
        const dialog = page.getByRole('dialog', { name: '城市', exact: true });
        await dialog.waitFor();
        assert.ok(await dialog.getByRole('button', { name: '完成', exact: true }).isVisible());
        assert.equal(
          await page
            .getByLabel('搜索城市', { exact: true })
            .evaluate(el => getComputedStyle(el).fontSize),
          '16px'
        );
      }
      await click(page.getByRole('checkbox', { name: '北京', exact: true }));
      await click(page.getByRole('button', { name: '完成 (1)' }));
      if (viewport.width === 375) {
        await click(page.getByRole('button', { name: '门店', exact: true }));
        const sheet = page.getByRole('dialog', { name: '门店', exact: true });
        await sheet.waitFor();
        await click(
          sheet.getByRole('checkbox', { name: '北京 · 测试直营店 47 综合购物中心', exact: true })
        );
        const complete = sheet.getByRole('button', { name: '完成 (1)' });
        const bounds = await complete.boundingBox();
        assert.ok(
          bounds.y >= 0 && bounds.y + bounds.height <= viewport.height,
          '短屏完成按钮应在视口内'
        );
        assert.equal(await sheet.evaluate(el => el.contains(document.activeElement)), true);
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({
          path: path.join(output, `筛选弹层-${viewport.width}x${viewport.height}.png`),
        });
        await click(sheet.getByRole('button', { name: '清空选择', exact: true }));
        await click(sheet.getByRole('button', { name: '完成', exact: true }));
      }
      await click(page.getByRole('button', { name: '应用筛选' }));
      await page.waitForFunction(() => !document.querySelector('[role=alert]'));
      assert.equal(latestQuery.cities, '北京');
      await click(page.getByRole('button', { name: '下一页' }));
      await page.getByText('第 2 页', { exact: false }).waitFor();
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({
        path: path.join(output, `库存-${viewport.width}x${viewport.height}.png`),
        fullPage: true,
      });
      const inventoryList = page.getByRole('region', { name: '全国库存列表' });
      if (viewport.width === 375) await click(inventoryList.locator('summary').first());
      await click(
        inventoryList
          .getByRole('button', { name: '查看记录', exact: true })
          .locator('visible=true')
          .first()
      );
      await page.getByRole('region', { name: '库存历史' }).waitFor();
      await page.waitForURL('**/inventory-monitor?tab=history');
      assert.equal(historyQuery.skus, product.sku);
      assert.equal(historyQuery.stores, store.storeCode);
      assert.equal(historyQuery.metric, 'all');
      assert.deepEqual(errors, [], '精确 SKU 历史跳转不能崩溃');
      await menu('监控管理');
      await page.getByRole('region', { name: '监控目录' }).waitFor();
      assert.equal(
        await page.getByRole('navigation', { name: '库存视图' }).getByRole('button').count(),
        2
      );
      await click(page.getByRole('checkbox', { name: '全选目录' }));
      await click(page.getByRole('button', { name: '停用所选' }));
      await page.getByRole('status').filter({ hasText: '停用' }).waitFor();
      assert.equal(product.enabled, false);
      await click(page.getByRole('checkbox', { name: '全选目录' }));
      await click(page.getByRole('button', { name: '启用所选' }));
      await page.getByRole('status').filter({ hasText: '启用' }).waitFor();
      if (viewport.width === 375)
        await click(
          page.getByRole('region', { name: '数据表格', exact: true }).locator('summary').first()
        );
      await assertNoOverflow();
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({
        path: path.join(output, `管理-${viewport.width}x${viewport.height}.png`),
        fullPage: true,
      });
      await click(page.getByRole('button', { name: '40 / 49 · 查看覆盖' }));
      await page.getByRole('dialog').waitFor();
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({
        path: path.join(output, `覆盖-${viewport.width}x${viewport.height}.png`),
      });
      await click(page.getByRole('button', { name: '关闭固定轮次覆盖矩阵' }));
      await menu('历史记录');
      await page
        .getByRole('region', { name: '库存历史' })
        .getByText('到货变化')
        .locator('visible=true')
        .waitFor();
      await click(page.getByRole('button', { name: '导出', exact: true }));
      await page.getByRole('status').filter({ hasText: '导出' }).waitFor();
      assert.equal(exported, 1);
      await menu('统计分析');
      await page.getByText('北京时间小时分布', { exact: true }).waitFor();
      if (viewport.width === 375)
        await click(page.getByRole('button', { name: '时间与统计口径', exact: true }));
      await page.getByLabel('热力图间隔', { exact: true }).selectOption('10');
      await assertNoOverflow();
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({
        path: path.join(output, `分析-${viewport.width}x${viewport.height}.png`),
        fullPage: true,
      });
      await click(
        page.getByRole('region', { name: '城市榜单' }).getByRole('button', { name: '查看记录' })
      );
      await page.getByRole('region', { name: '库存历史' }).waitFor();
      await menu('通知与健康');
      await page.getByLabel('群名称', { exact: true }).fill('合成库存群');
      await page
        .getByLabel('Webhook（加密保存，不回显）')
        .fill('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=synthetic_123');
      await click(page.getByRole('button', { name: '保存通知设置' }));
      await page.getByRole('status').filter({ hasText: '设置已保存' }).waitFor();
      assert.equal(saved, 1);
      await click(page.getByRole('button', { name: '发送合成测试' }));
      await click(page.getByRole('button', { name: '刷新测试状态' }));
      await page.getByText('测试接口已接受', { exact: true }).waitFor();
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({
        path: path.join(output, `通知-${viewport.width}x${viewport.height}.png`),
        fullPage: true,
      });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
        ),
        false,
        '页面不应横向溢出'
      );
      fail = true;
      await menu('全国库存');
      await page.getByRole('alert').waitFor();
      fail = false;
      await click(page.getByRole('button', { name: '重试加载' }));
      await page
        .getByRole('region', { name: '全国库存列表' })
        .locator('.inventory-status:visible')
        .filter({ hasText: /^有货$/ })
        .waitFor();
      if (viewport.width === 375)
        await click(page.getByRole('button', { name: '商品与门店筛选', exact: true }));
      await click(page.getByRole('button', { name: '重置选择' }));
      await page.waitForTimeout(100);
      assert.equal(latestQuery.cities, undefined);
      if (!(await page.getByRole('button', { name: '型号', exact: true }).isVisible()))
        await click(page.getByRole('button', { name: '商品与门店筛选', exact: true }));
      await click(page.getByRole('button', { name: '型号', exact: true }));
      await page.keyboard.press('Escape');
      assert.equal(await page.getByLabel('搜索型号').count(), 0);
      assert.equal(
        await page
          .getByRole('button', { name: '型号', exact: true })
          .evaluate(el => el === document.activeElement),
        true
      );
      allowed = false;
      readAllowed = true;
      await page.reload();
      await page.getByRole('heading', { name: '库存监控', exact: true, level: 1 }).waitFor();
      assert.equal(await page.getByRole('button', { name: '检查当前筛选' }).count(), 0);
      assert.equal(await page.getByRole('link', { name: '监控管理', exact: true }).count(), 0);
      assert.equal(await page.getByRole('link', { name: '通知与健康', exact: true }).count(), 0);
      await menu('历史记录');
      await page.getByRole('region', { name: '库存历史' }).waitFor();
      await menu('统计分析');
      await page.getByText('北京时间小时分布', { exact: true }).waitFor();
      for (const suffix of ['/manage', '/settings', '?tab=settings', '?tab=manage']) {
        await page.goto(`${baseUrl}/inventory-monitor${suffix}`);
        await page.waitForURL('**/profile');
      }
      assert.deepEqual(forbiddenReads, [], '普通用户不能请求管理数据');
      readAllowed = false;
      await page.goto(`${baseUrl}/inventory-monitor`);
      await page.waitForURL('**/profile');
      assert.equal(await page.getByRole('heading', { name: '库存监控', exact: true }).count(), 0);
      assert.deepEqual(errors, []);
      await context.close();
      logger.info('库存浏览器合成交互通过', { viewport });
    }
  } catch (error) {
    logger.error('库存浏览器验收失败', {
      message: error.message,
      cause: error.cause?.message,
      stack: error.stack,
    });
    process.exitCode = 1;
  } finally {
    await browser?.close();
  }
}
main();
