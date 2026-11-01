/* eslint-env node */
// 仅本机隔离验收入口，不挂入正式 app，不提供生产认证或采集器。
const { randomUUID, createHash } = require('crypto');
const express = require('express');
const { sequelize, AosDevice, MonitorInstance } = require('../../src/models');
const logs = require('../../src/services/monitorLogService');
const policy = require('../../src/services/monitorLogPolicy');
const logger = require('../../src/utils/logger');
const { PERMISSIONS } = require('../../src/constants/business');

/** 使用专用库、合成资源与正式只读／标签路由启动验收服务。 */
async function main() {
  if (sequelize.config.database !== 'aos_log_test_ui' || process.env.DATABASE_URL)
    throw new Error('只允许日志UI专用隔离数据库');
  await sequelize.query(
    'TRUNCATE monitor_log_entries, monitor_log_states, monitor_resource_tags, aos_devices CASCADE'
  );
  const deviceId = randomUUID();
  const localId = randomUUID();
  const otherLocalId = randomUUID();
  await AosDevice.bulkCreate([
    {
      id: deviceId,
      name: 'US01',
      credentialHash: createHash('sha256').update(deviceId).digest('hex'),
    },
    { id: randomUUID(), name: 'US10', credentialHash: '1'.repeat(64), enabled: false },
    { id: randomUUID(), name: 'US02', credentialHash: '2'.repeat(64) },
  ]);
  await MonitorInstance.bulkCreate([
    { id: randomUUID(), deviceId, localId, label: 'AOS 实例 01', active: true },
    { id: randomUUID(), deviceId, localId: otherLocalId, label: 'AOS 实例 02', active: false },
  ]);
  const today = policy.retention().today;
  const date = offset => new Date(Date.parse(today) + offset * 86400000).toISOString().slice(0, 10);
  const rows = [];
  for (const offset of [-9, -8, -7, -1, 0]) {
    const day = date(offset);
    const fileId = randomUUID();
    for (let index = 0; index < 430; index++) {
      const at = new Date(Date.parse(`${day}T00:00:00+08:00`) + index * Math.min(200000, Math.floor((Date.now() - Date.parse(`${day}T00:00:00+08:00`) - 2000) / 430))).toISOString();
      const account = index % 9 ? '001' : '128';
      const xml = index % 17 === 0;
      rows.push({
        id: randomUUID(),
        localId,
        fileId,
        fileName: `Log${day.replaceAll('-', '')}_acceptance.txt`,
        businessDate: day,
        loggedAt: index === 2 ? null : at,
        contextAt: index === 2 ? at : undefined,
        accountNumber: index === 2 ? null : account,
        lineNumber: 2000 + index,
        partIndex: 0,
        byteOffset: index * 1000,
        message: xml
          ? `<StoreInventory>\n    <Store code="RTEST" available="false" />\n</StoreInventory>\n`
          : `${at.replace('T', ' ')} [合成][${account}] 继续监控店铺：仅供隔离验收。${index === 3 ? '<script>window.LOG_EXECUTED=true</script>' : ''}\n`,
        parseState: index === 2 ? 'unparsed' : xml ? 'continuation' : 'parsed',
        rawBase64: null,
      });
    }
  }
  for (let index = 0; index < rows.length; index += 200)
    await logs.receive(deviceId, { entries: rows.slice(index, index + 200) });
  await logs.receiveStates(deviceId, {
    observedAt: new Date().toISOString(),
    instances: [
      {
        localId,
        label: 'AOS 实例 01',
        state: 'ready',
        dates: [-9, -8, -7, -1, 0].map(date),
        fileCount: 5,
        totalBytes: 500000,
        scannedBytes: 500000,
        pending: 0,
        issues: 1,
        expired: 0,
      },
    ],
  });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = {
      id: 1,
      username: '隔离验收',
      role: 'operator',
      permissions:
        req.get('authorization') === 'Bearer synthetic-log-reader'
          ? [PERMISSIONS.MONITOR_LOGS_READ]
          : Object.values(PERMISSIONS),
      availableHome: '/server-monitor/logs',
    };
    next();
  });
  app.get('/api/auth/me', (req, res) => res.json({ success: true, data: req.user }));
  app.get('/test/catalog', (_req, res) => res.json({ deviceId, localId, otherLocalId, today }));
  app.use('/api/server-monitor', require('../../src/routes/serverMonitor'));
  app.use(require('../../src/middleware/errorHandler'));
  app.listen(3095, '0.0.0.0', () =>
    logger.info('日志UI隔离服务已启动', { port: 3095, entries: rows.length })
  );
}
main().catch(error => {
  logger.error('日志UI隔离服务失败', { error: error.message });
  process.exitCode = 1;
});
