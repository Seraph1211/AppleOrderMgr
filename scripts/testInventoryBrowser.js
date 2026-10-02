/* global localStorage, document, navigator, window */
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
    const output = path.resolve('test-artifacts/inventory');
    fs.mkdirSync(output, { recursive: true });
    for (const viewport of [
      { width: 1440, height: 1000 },
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
        id: 'MG724CH/A',
        sku: 'MG724CH/A',
        title: 'iPhone 17 512GB Black',
        model: 'iPhone 17',
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
        id: 'MG724CH/A|R320',
        displayStatus: 'in_stock',
        status: 'in_stock',
        lastStatus: 'in_stock',
        quote: '今天可取货',
        source: 'auto',
        observedAt: Date.now(),
        lastAttemptAt: Date.now(),
      };
      const deliver = [];
      await page.route('**/*', async route => {
        try {
          const url = new URL(route.request().url());
          if (!url.pathname.startsWith('/api/')) {
            if (url.origin === 'http://127.0.0.1:5317') await route.continue();
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
              permissions: [],
              availableHome: '/profile',
            };
          else if (url.pathname.startsWith('/api/inventory/')) {
            if (!allowed) {
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
              data = { products: [product], stores: [store] };
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
            } else if (action === 'latest')
              data = {
                items: [row],
                total: 51,
                page: +(url.searchParams.get('page') || 1),
                pageSize: 50,
                summary: { combinations: 51, inStock: 1, currentStores: 1, fresh: 50 },
              };
            else if (action === 'health')
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
            else if (action === 'history')
              data = { items: [{ ...row, kind: 'arrival' }], total: 1, page: 1, pageSize: 50 };
            else if (action === 'history/export') {
              exported += 1;
              await route.fulfill({ contentType: 'text/csv', body: 'SKU,城市\nMG724CH/A,北京' });
              return;
            } else if (action === 'analysis')
              data = {
                metric: 'arrivals',
                bucketMinutes: +(url.searchParams.get('bucketMinutes') || 60),
                detailAvailable: true,
                notice: '观测次数，不代表销量；灰色为缺口。',
                coverage: { complete: 1, planned: 2, ratio: 0.5 },
                hours: [{ key: '14', count: 1 }],
                configurations: [{ key: 'iPhone 17 · 512GB · 黑色', count: 1 }],
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
      await page.goto('http://127.0.0.1:5317/inventory-monitor');
      await page.getByRole('region', { name: '全国库存列表' }).getByText('今天可取货').waitFor();
      const click = async locator => {
        try {
          if (viewport.width === 375) await locator.tap();
          else await locator.click();
        } catch (error) {
          throw new Error('交互失败', { cause: error });
        }
      };
      await click(page.getByRole('checkbox', { name: '全选本页库存' }));
      await click(page.getByRole('button', { name: '复制选中 (1)' }));
      assert.match(await page.evaluate(() => navigator.clipboard.readText()), /MG724|iPhone 17/);
      await click(page.getByRole('button', { name: '检查当前筛选' }));
      await page.getByRole('status').filter({ hasText: '统一查询队列' }).waitFor();
      assert.equal(checked, 1);
      await click(page.getByRole('button', { name: '城市', exact: true }));
      await click(page.getByRole('checkbox', { name: '北京', exact: true }));
      await click(page.getByRole('button', { name: '关闭城市' }));
      await click(page.getByRole('button', { name: '应用筛选' }));
      await click(page.getByRole('button', { name: '下一页' }));
      await page.getByText('第 2 页', { exact: false }).waitFor();
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({
        path: path.join(output, `库存-${viewport.width}x${viewport.height}.png`),
        fullPage: true,
      });
      await click(page.getByRole('button', { name: '监控管理', exact: true }));
      await page.getByRole('region', { name: '监控目录' }).waitFor();
      await click(page.getByRole('checkbox', { name: '全选目录' }));
      await click(page.getByRole('button', { name: '停用所选' }));
      await page.getByRole('status').filter({ hasText: '停用' }).waitFor();
      assert.equal(product.enabled, false);
      await click(page.getByRole('checkbox', { name: '全选目录' }));
      await click(page.getByRole('button', { name: '启用所选' }));
      await page.getByRole('status').filter({ hasText: '启用' }).waitFor();
      await click(page.getByRole('button', { name: '40 / 49 · 查看覆盖' }));
      await page.getByRole('dialog').waitFor();
      await click(page.getByRole('button', { name: '关闭覆盖矩阵' }));
      await click(page.getByRole('button', { name: '历史记录', exact: true }));
      await page.getByRole('region', { name: '库存历史' }).getByText('到货变化').waitFor();
      await click(page.getByRole('button', { name: '导出', exact: true }));
      await page.getByRole('status').filter({ hasText: '导出' }).waitFor();
      assert.equal(exported, 1);
      await click(page.getByRole('button', { name: '分析统计', exact: true }));
      await page.getByText('北京时间小时分布', { exact: true }).waitFor();
      await page.getByLabel('热力图间隔', { exact: true }).selectOption('10');
      await page.screenshot({
        path: path.join(output, `分析-${viewport.width}x${viewport.height}.png`),
        fullPage: true,
      });
      await click(
        page.getByRole('region', { name: '城市榜单' }).getByRole('button', { name: '查看记录' })
      );
      await page.getByRole('region', { name: '库存历史' }).waitFor();
      await click(page.getByRole('button', { name: '通知与健康', exact: true }));
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
      await click(page.getByRole('button', { name: '全国库存', exact: true }));
      await page.getByRole('alert').waitFor();
      fail = false;
      await click(page.getByRole('button', { name: '重试加载' }));
      await page.getByRole('region', { name: '全国库存列表' }).getByText('今天可取货').waitFor();
      allowed = false;
      await page.reload();
      await page.waitForURL('**/profile');
      assert.equal(await page.getByRole('heading', { name: '库存监控', exact: true }).count(), 0);
      assert.deepEqual(errors, []);
      await context.close();
      logger.info('库存浏览器合成交互通过', { viewport });
    }
  } catch (error) {
    logger.error('库存浏览器验收失败', { message: error.message, cause: error.cause?.message });
    process.exitCode = 1;
  } finally {
    await browser?.close();
  }
}
main();
