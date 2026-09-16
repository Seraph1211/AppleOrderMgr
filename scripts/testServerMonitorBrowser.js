/* global localStorage, document */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');
const logger = require('../src/utils/logger');
/** 独立浏览器合成监控交互；所有API均拦截，不接触业务数据。 */
async function main() {
  let browser;
  let context;
  try {
    if (!process.env.MONITOR_BROWSER_WS && !process.env.MONITOR_BROWSER_EXECUTABLE)
      throw new Error('需要专用临时浏览器地址或可执行文件');
    browser = process.env.MONITOR_BROWSER_EXECUTABLE
      ? await chromium.launch({
        executablePath: process.env.MONITOR_BROWSER_EXECUTABLE,
        headless: true,
      })
      : await chromium.connectOverCDP(process.env.MONITOR_BROWSER_WS, {
        headers: { Host: '127.0.0.1' },
      });
    fs.mkdirSync(path.resolve('coverage'), { recursive: true });
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
    let removedOnly = false;
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const deviceId = '11111111-1111-4111-8111-111111111111';
    const instanceId = '22222222-2222-4222-8222-222222222222';
    const localId = '33333333-3333-4333-8333-333333333333';
    const ruleId = '44444444-4444-4444-8444-444444444444';
    const now = new Date().toISOString();
    let notificationSettings = {
      enabled: true,
      sendRecovery: true,
      recipients: ['ops@example.test'],
      version: 1,
      updatedAt: now,
      smtp: { configured: true, reusedFromOrderMailbox: true, sender: 'op***@example.test' },
    };
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
    const removed = {
      ...instance,
      id: 'removed-instance',
      localId: 'removed-local',
      active: false,
      actionable: false,
      state: 'removed',
      label: '旧实例',
    };
    const offline = {
      ...instance,
      id: 'offline-instance',
      localId: 'offline-local',
      fresh: false,
      actionable: false,
      state: 'offline',
      label: '离线实例',
      alerts: [],
    };
    const invalid = {
      ...instance,
      id: 'invalid-instance',
      localId: 'invalid-local',
      actionable: false,
      state: 'invalid',
      label: '解析异常实例',
      alerts: [],
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
              instances: empty
                ? []
                : removedOnly
                  ? [removed]
                  : [instance, removed, offline, invalid],
              rules: empty ? [] : rules,
              notificationSettings,
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
          else if (url.pathname.endsWith('/notifications/settings')) {
            const body = route.request().postDataJSON();
            assert.equal(body.enabled, false);
            assert.equal(body.expectedVersion, notificationSettings.version);
            notificationSettings = {
              ...notificationSettings,
              ...body,
              version: notificationSettings.version + 1,
              updatedAt: new Date().toISOString(),
            };
            data = notificationSettings;
          } else if (url.pathname.endsWith('/notifications/history')) data = { rows: [], count: 0 };
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
      path: path.resolve('coverage/monitor-traffic-desktop.png'),
      fullPage: true,
      animations: 'disabled',
    });
    await page.getByRole('tab', { name: '实例监控', exact: true }).click();
    assert.equal(await page.getByText('旧实例', { exact: true }).count(), 0);
    await page.getByText('离线实例', { exact: true }).waitFor();
    await page.getByText('解析异常实例', { exact: true }).waitFor();
    await page.getByText('1 个实例待核实', { exact: false }).waitFor();
    await page.getByLabel('显示已移除实例').check();
    await page.getByRole('button', { name: '查看历史', exact: true }).click();
    await page.getByText('该实例已移除，仅供查看历史', { exact: false }).waitFor();
    assert.equal(await page.getByRole('button', { name: '提交操作' }).count(), 0);
    await page.getByLabel('显示已移除实例').uncheck();
    assert.equal(await page.getByText('旧实例', { exact: true }).count(), 0);
    await page
      .getByRole('row')
      .filter({ hasText: '抢购实例一' })
      .getByRole('button', { name: '查看 / 处理' })
      .click();
    await page.getByLabel('处理备注').fill('检查代理连接');
    await page.getByRole('button', { name: '提交操作' }).click();
    await page.getByText('静默剩余', { exact: false }).waitFor();
    assert.equal(actions, 1);
    await page.getByRole('tab', { name: '告警规则', exact: true }).click();
    await page.getByRole('button', { name: '新增规则' }).click();
    await page.getByLabel('规则名称', { exact: true }).fill('连接异常测试');
    await page.getByLabel('关键词（每行一个，最多20个）', { exact: true }).fill('连接失败');
    assert.equal(
      await page.getByLabel('规则适用实例').locator('option', { hasText: '旧实例' }).count(),
      0
    );
    await page.getByLabel('日志样例试匹配（测试输入不保存）').fill('连接失败\n正常');
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
    await page.getByRole('tab', { name: '通知设置', exact: true }).click();
    await page.getByText('已保存状态：邮件通知已启用', { exact: false }).waitFor();
    await page.getByLabel('启用邮件通知', { exact: true }).uncheck();
    await page.getByText('有未保存的修改', { exact: false }).waitFor();
    assert.equal(await page.getByRole('button', { name: '发送测试邮件' }).isDisabled(), true);
    await page.getByRole('button', { name: '保存设置', exact: true }).click();
    await page.getByText('已保存状态：邮件通知已关闭', { exact: false }).waitFor();
    await page.getByRole('button', { name: '刷新状态' }).click();
    assert.equal(notificationSettings.enabled, false);
    assert.equal(await page.getByLabel('启用邮件通知', { exact: true }).isChecked(), false);
    assert.equal(await page.getByText('有未保存的修改', { exact: false }).count(), 0);
    fail = true;
    await page.getByRole('button', { name: '刷新状态' }).click();
    await page.getByRole('alert').filter({ hasText: '合成监控读取失败' }).waitFor();
    fail = false;
    await page.getByRole('button', { name: '刷新状态' }).click();
    await page.setViewportSize({ width: 375, height: 812 });
    await page.getByRole('tab', { name: '实例监控', exact: true }).click();
    await page.getByRole('button', { name: '查看 / 处理' }).first().waitFor();
    await page.screenshot({
      path: path.resolve('coverage/monitor-instances-mobile.png'),
      fullPage: true,
      animations: 'disabled',
    });
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1
      )
    );
    removedOnly = true;
    await page.getByRole('button', { name: '刷新状态' }).click();
    await page.getByText('暂无数据', { exact: true }).waitFor();
    await page.getByLabel('显示已移除实例').check();
    await page.getByText('旧实例', { exact: true }).waitFor();
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
