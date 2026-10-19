import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const testChannels = [
  {
    channel: 'email',
    enabled: false,
    version: 1,
    targetVersion: 1,
    policyVersion: 1,
    targetName: 'synthetic@example.invalid',
    configured: true,
    sendRecovery: true,
    recipients: ['synthetic@example.invalid'],
    smtp: { sender: 'synthetic@example.invalid', configured: true, reusedFromOrderMailbox: false },
    policy: {
      warningWindowMinutes: 3,
      infoEnabled: false,
      recoveryMinutes: 2,
      criticalReminderMinutes: [15, 30, 60],
      warningReminderMinutes: 60,
      dailySummaryEnabled: false,
    },
    pausedReason: null,
    enabledAt: null,
    lastTest: null,
    lastAcceptedAt: null,
    updatedAt: null,
  },
  {
    channel: 'wecom',
    enabled: false,
    version: 1,
    targetVersion: 1,
    policyVersion: 1,
    targetName: '合成测试群',
    configured: true,
    sendRecovery: true,
    policy: {
      warningWindowMinutes: 3,
      infoEnabled: false,
      recoveryMinutes: 2,
      criticalReminderMinutes: [15, 30, 60],
      warningReminderMinutes: 60,
      dailySummaryEnabled: false,
    },
    pausedReason: null,
    enabledAt: null,
    lastTest: null,
    lastAcceptedAt: null,
    updatedAt: null,
  },
];

const testDeliveries = [
  {
    id: 'delivery-synthetic-unknown',
    channel: 'wecom',
    targetName: '合成测试群',
    targetVersion: 1,
    category: 'alert',
    severity: 'critical',
    status: 'unknown',
    notBefore: '2026-10-19T02:00:00.000Z',
    attempts: 1,
    errorCode: 'RESULT_UNKNOWN',
    lastError: '合成回执未知',
    sentAt: null,
    createdAt: '2026-10-19T02:00:00.000Z',
    version: 2,
    eventCount: 1,
    eventIds: ['22222222-2222-4222-8222-222222222222'],
    waitReason: null,
    recipientResults: [],
  },
  {
    id: 'delivery-synthetic-pending',
    channel: 'email',
    targetName: 'synthetic@example.invalid',
    targetVersion: 1,
    category: 'summary',
    severity: 'warning',
    status: 'pending',
    notBefore: '2026-10-19T03:00:00.000Z',
    attempts: 0,
    errorCode: null,
    lastError: null,
    sentAt: null,
    createdAt: '2026-10-19T03:00:00.000Z',
    version: 1,
    eventCount: 2,
    eventIds: ['22222222-2222-4222-8222-222222222222'],
    waitReason: '等待合成窗口',
    recipientResults: [],
  },
];

function json(response, body, status = 200) {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(body));
}

function syntheticApi() {
  return {
    name: 'monitor-notifications-ui-synthetic-api',
    transformIndexHtml(html) {
      return html.replace(
        '<head>',
        '<head><script>localStorage.setItem("token", location.search.includes("readOnly=1") ? "monitor-notifications-ui-test-readonly" : "monitor-notifications-ui-test");</script>'
      );
    },
    configureServer(server) {
      server.middlewares.use('/api', (request, response, next) => {
        const url = new URL(request.url || '/', 'http://127.0.0.1:5188');
        const isReadOnly = request.headers.authorization?.includes('test-readonly');
        if (request.url.startsWith('/auth/me')) {
          const permissions = isReadOnly
            ? ['monitor.notifications.read']
            : [
                'monitor.manage',
                'monitor.notifications.read',
                'monitor.notifications.configure',
                'monitor.notifications.retry',
              ];
          return json(response, {
            success: true,
            data: {
              id: 1,
              role: 'user',
              permissions,
              permissionsVersion: 1,
              availableHome: '/server-monitor',
              username: 'synthetic-ui',
            },
          });
        }
        if (request.url === '/server-monitor/notifications/channels' && request.method === 'GET') {
          return json(response, { success: true, data: { channels: testChannels } });
        }
        if (request.url.startsWith('/server-monitor/overview')) {
          return json(response, { success: true, data: { devices: [], instances: [], rules: [], revision: 1 } });
        }
        if (request.url.startsWith('/server-monitor/traffic')) {
          return json(response, { success: true, data: { rows: [] } });
        }
        if (request.url.startsWith('/server-monitor/notifications/health')) {
          return json(response, {
            success: true,
            data: {
              channels: ['email', 'wecom'].map(channel => ({
                channel,
                state: channel === 'email' ? 'backlog' : 'healthy',
                heartbeatAt: '2026-10-19T04:00:00.000Z',
                staleAfterSeconds: 90,
                heartbeatStale: false,
                lastAcceptedAt: null,
                pausedReason: null,
                pendingCount: channel === 'email' ? 1 : 0,
                overdueCount: 0,
                oldestDueAt: channel === 'email' ? '2026-10-19T03:00:00.000Z' : null,
                failedCount: 0,
                unknownCount: channel === 'wecom' ? 1 : 0,
              })),
              coverage: { healthEvents: false, noNewLogs: false, externalWatchdog: false },
            },
          });
        }
        if (request.url.startsWith('/server-monitor/notifications/deliveries/')) {
          const id = request.url.split('/').pop();
          const delivery = testDeliveries.find(item => item.id === id);
          if (!delivery) return json(response, { success: false, error: { code: 'NOT_FOUND', message: '无合成投递' } }, 404);
          return json(response, {
            success: true,
            data: {
              ...delivery,
              events: [{
                eventId: '22222222-2222-4222-8222-222222222222',
                category: 'alert',
                at: '2026-10-19T01:59:00.000Z',
                instanceLabel: '合成实例 A',
                ruleName: '合成登录告警',
                hitCount: 3,
                originalUnknown: true,
              }],
              relatedDeliveries: testDeliveries,
            },
          });
        }
        if (request.url.startsWith('/server-monitor/notifications/deliveries')) {
          const params = new URLSearchParams(request.url.split('?')[1] || '');
          const filtered = testDeliveries.filter(item =>
            (!params.get('channel') || item.channel === params.get('channel')) &&
            (!params.get('status') || item.status === params.get('status')) &&
            (!params.get('eventId') || item.eventIds.includes(params.get('eventId')))
          );
          return json(response, { success: true, data: { rows: filtered, nextCursor: null } });
        }
        if (request.url.startsWith('/server-monitor/notifications/channels/') && request.method === 'PUT') {
          return json(response, { success: true, data: { ...testChannels.find(item => request.url.includes(item.channel)), version: 2 } });
        }
        if (request.url.includes('/test') || request.url.includes('/current-summary')) {
          return json(response, { success: true, data: { deliveryId: 'delivery-synthetic-new', status: 'pending', eventCount: 2, preview: { text: '合成异常摘要：仅用于界面验收。', eventCount: 2 } } });
        }
        if (request.url.includes('/retry') || request.url.includes('/cancel')) {
          return json(response, { success: true, data: { status: 'pending' } });
        }
        return next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), syntheticApi()],
  server: { host: '127.0.0.1', port: 5188, strictPort: true },
});
