/* global localStorage, document */
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const logger = require('../src/utils/logger');
/** 独立浏览器合成监控交互；所有API均拦截，不接触业务数据。 */
async function main() {
  let browser;
  let context;
  try {
    if (!process.env.MONITOR_BROWSER_WS) throw new Error('需要专用临时浏览器地址');
    browser = await chromium.connectOverCDP(process.env.MONITOR_BROWSER_WS, {
      headers: { Host: '127.0.0.1' },
    });
    context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      serviceWorkers: 'block',
    });
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    let empty = false;
    let allowed = true;
    let fail = false;
    let conflict = false;
    let actions = 0;
    let saves = 0;
    let monitoredReads = 0;
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const deviceId = '11111111-1111-4111-8111-111111111111';
    const instanceId = '22222222-2222-4222-8222-222222222222';
    const localId = '33333333-3333-4333-8333-333333333333';
    const ruleId = '44444444-4444-4444-8444-444444444444';
    const now = new Date().toISOString();
    let rules = [
      {
        id: ruleId,
        version: 1,
        config: {
          name: '没有可用代理',
          enabled: true,
          mode: 'any',
          keywords: ['没有可用的代理'],
          excludes: [],
          windowMinutes: 10,
          threshold: 5,
          severity: 'warning',
          deviceIds: [],
          directoryIds: [],
        },
      },
    ];
    let instance = {
      id: instanceId,
      deviceId,
      localId,
      label: '抢购实例一',
      active: true,
      fresh: true,
      state: 'ready',
      actionable: true,
      muted: false,
      observedAt: now,
      version: 1,
      handling: {},
      snapshot: {
        revision: 'v1',
        state: 'ready',
        files: ['Log20260915_8880.txt'],
        results: [
          {
            ruleId,
            count: 8,
            samples: [{ at: now, file: 'Log20260915_8880.txt', keywords: ['没有可用的代理'] }],
          },
        ],
      },
      alerts: [{ id: 'alert', ruleName: '没有可用代理', hitCount: 8 }],
    };
    await page.route('**/*', async route => {
      try {
        const url = new URL(route.request().url());
        if (!url.pathname.startsWith('/api/')) {
          if (url.origin === 'http://127.0.0.1:5173') await route.continue();
          else await route.abort();
          return;
        }
        let data;
        if (url.pathname === '/api/auth/me')
          data = {
            id: 9,
            username: 'monitor-tester',
            nickname: '监控测试用户',
            role: 'operator',
            permissions: allowed ? ['monitor.manage'] : [],
            availableHome: allowed ? '/server-monitor' : '/profile',
          };
        else if (url.pathname.startsWith('/api/server-monitor')) {
          monitoredReads++;
          if (fail) {
            await route.fulfill({
              status: 503,
              json: { success: false, error: { message: '合成监控读取失败' } },
            });
            return;
          }
          if (url.pathname.endsWith('/overview'))
            data = {
              revision: 'v1',
              devices: [{ id: deviceId, name: '测试服务器01', enabled: true }],
              instances: empty ? [] : [instance],
              rules: empty ? [] : rules,
            };
          else if (url.pathname.endsWith('/traffic'))
            data = {
              rows: empty
                ? []
                : [
                  {
                    deviceId,
                    day: '2026-09-15',
                    hour: '04:00',
                    receivedBytes: 12000000000,
                    sentBytes: 1000000000,
                    collectorReceivedBytes: 10000,
                    collectorSentBytes: 5000,
                    coveredSeconds: 3000,
                    gapSeconds: 60,
                  },
                ],
            };
          else if (url.pathname.endsWith('/history'))
            data = {
              alerts: {
                rows: [
                  {
                    id: 'historical',
                    ruleName: '代理告警',
                    status: 'recovered',
                    hitCount: 0,
                    firstSeenAt: now,
                    lastSeenAt: now,
                    recoveredAt: now,
                  },
                ],
                count: 1,
              },
              actions: { rows: [], count: 0 },
            };
          else if (url.pathname.endsWith('/actions')) {
            const body = route.request().postDataJSON();
            assert.equal(body.minutes, 30);
            assert.equal(body.action, 'start');
            assert.equal(body.note, '检查代理连接');
            actions++;
            instance = {
              ...instance,
              muted: true,
              actionable: false,
              version: 2,
              handling: {
                status: 'processing',
                actorId: 9,
                until: new Date(Date.now() + 1800000).toISOString(),
              },
            };
            data = instance;
          } else if (url.pathname.endsWith('/rules/test')) {
            const body = route.request().postDataJSON();
            assert.deepEqual(body.rule.keywords, ['连接失败']);
            data = { count: 1, lines: [1] };
          } else if (url.pathname.includes('/rules')) {
            if (conflict) {
              await route.fulfill({
                status: 409,
                json: { success: false, error: { message: '内容已更新，请刷新后重试' } },
              });
              return;
            }
            const body = route.request().postDataJSON();
            rules = [...rules, { id: 'new-rule', version: 1, config: body.config }];
            saves++;
            data = rules.at(-1);
          } else throw new Error('未配置监控接口');
        } else throw new Error(`非预期API ${url.pathname}`);
        await route.fulfill({ json: { success: true, data } });
      } catch (error) {
        errors.push(error.message);
        await route.abort();
      }
    });
    await context.addInitScript(() => localStorage.setItem('token', 'synthetic-monitor-token'));
    await page.goto('http://127.0.0.1:5173/server-monitor');
    await page.getByRole('heading', { name: '服务器监控', exact: true }).waitFor();
    await page.getByText('总计 13.000 GB', { exact: false }).waitFor();
    await page.screenshot({
      path: '/app/coverage/monitor-traffic-desktop.png',
      fullPage: true,
      animations: 'disabled',
    });
    await page.getByRole('button', { name: '实例监控', exact: true }).click();
    await page.getByRole('button', { name: '查看 / 处理' }).click();
    await page.getByLabel('处理备注').fill('检查代理连接');
    await page.getByRole('button', { name: '提交操作' }).click();
    await page.getByText('静默剩余', { exact: false }).waitFor();
    assert.equal(actions, 1);
    await page.getByRole('button', { name: '告警规则', exact: true }).click();
    await page.getByRole('button', { name: '新增规则' }).click();
    await page.getByLabel('规则名称', { exact: true }).fill('连接异常测试');
    await page.getByLabel('关键词（每行一个，最多20个）', { exact: true }).fill('连接失败');
    await page.getByLabel('脱敏样例试匹配（仅测试文本条件，不保存正文）').fill('连接失败\n正常');
    await page.getByRole('button', { name: '试匹配', exact: true }).click();
    await page.getByText('命中 1 行', { exact: false }).waitFor();
    conflict = true;
    await page.getByRole('button', { name: '保存规则' }).click();
    await page.getByRole('alert').filter({ hasText: '内容已更新' }).waitFor();
    assert.equal(saves, 0);
    conflict = false;
    await page.getByRole('button', { name: '保存规则' }).click();
    await page.getByText('规则已保存', { exact: false }).waitFor();
    assert.equal(saves, 1);
    fail = true;
    await page.getByRole('button', { name: '刷新状态' }).click();
    await page.getByRole('alert').filter({ hasText: '合成监控读取失败' }).waitFor();
    fail = false;
    await page.getByRole('button', { name: '刷新状态' }).click();
    await page.setViewportSize({ width: 375, height: 812 });
    await page.getByRole('button', { name: '实例监控', exact: true }).click();
    await page.getByRole('button', { name: '查看 / 处理' }).waitFor();
    await page.screenshot({
      path: '/app/coverage/monitor-instances-mobile.png',
      fullPage: true,
      animations: 'disabled',
    });
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1
      )
    );
    empty = true;
    await page.reload();
    await page.getByText('暂无数据', { exact: true }).waitFor();
    await page.getByText('所选日期无流量样本', { exact: false }).waitFor();
    allowed = false;
    const before = monitoredReads;
    await page.reload();
    await page.waitForURL('**/profile');
    assert.equal(monitoredReads, before);
    assert.deepEqual(errors, []);
    logger.info('服务器监控浏览器合成交互通过', {
      actions,
      saves,
      checks: '桌面流量、实例静默、规则试匹配/冲突/保存、错误状态、375px布局、权限撤销',
    });
  } finally {
    if (context) await context.close();
    if (browser) await browser.close();
  }
}
main().catch(error => {
  logger.error('服务器监控浏览器验收失败', { error: error.message });
  process.exitCode = 1;
});
