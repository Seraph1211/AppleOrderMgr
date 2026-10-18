const { randomUUID } = require('crypto');
const { Op, QueryTypes } = require('sequelize');
const policy = require('./aosSignalPolicy');
const inventoryFailure = require('../utils/inventoryFailure');

/** 接收事务仅写脱敏队列，不获取库存全局锁。 @param {Object[]} rows 实际新增日志 @param {Object} transaction 日志事务 @returns {Promise<number>} 入队数 */
async function enqueue(rows, transaction) {
  try {
    const candidates = rows.filter(row => policy.parseEntries(row, Date.now()).length);
    if (!candidates.length) return 0;
    const { sequelize, AosSignalInbox } = require('../models');
    const [{ now }] = await sequelize.query('SELECT clock_timestamp() AS now', {
      type: QueryTypes.SELECT,
      transaction,
    });
    const receivedAt = +new Date(now);
    const entries = candidates.flatMap(row => policy.parseEntries(row, receivedAt));
    await sequelize.query(
      `WITH expired AS (
        SELECT id FROM aos_signal_inbox WHERE created_at < :before
        ORDER BY created_at,id LIMIT 1000 FOR UPDATE SKIP LOCKED
      ) DELETE FROM aos_signal_inbox target USING expired WHERE target.id=expired.id`,
      { replacements: { before: new Date(receivedAt - policy.WINDOW_MS) }, transaction }
    );
    if (entries.length)
      await AosSignalInbox.bulkCreate(
        entries.map(({ id, ...body }) => ({ id, body })),
        {
          transaction,
          ignoreDuplicates: true,
        }
      );
    return entries.length;
  } catch (error) {
    throw new Error('AOS_SIGNAL_ENQUEUE_FAILED', { cause: error });
  }
}

/** 单例库存锁内消费有界队列；原日志接收与网络投递均在锁外。 */
class AosSignalService {
  constructor(service) {
    this.s = service;
  }

  /** 生成单条概览，保存全部分组明细供投递历史查询。 */
  async queue(groups, context, immediate, from, to) {
    try {
      if (!Object.keys(groups).length) return;
      const { transaction, settings, now } = context;
      await this.s.put(
        'InventoryDelivery',
        [
          {
            id: randomUUID(),
            kind: 'aos_signal',
            status: 'pending',
            destinationId: settings.destinationId,
            aosSignalsSince: settings.aosSignalsSince,
            aosGroups: groups,
            windowFrom: Math.min(...Object.values(groups).map(row => row.firstAt)),
            windowTo: Math.max(...Object.values(groups).map(row => row.lastAt)),
            receivedWindowFrom: from,
            receivedWindowTo: to,
            content: policy.content(groups, immediate),
            notBefore: now,
            expiresAt: now + policy.WINDOW_MS,
            attempts: 0,
          },
        ],
        transaction
      );
    } catch (error) {
      throw inventoryFailure(error);
    }
  }

  /** 固定三分钟窗口：首条不进入汇总，空窗口结束本轮。 */
  async advance(context, at) {
    try {
      const { state, now } = context;
      const window = state.aosSignals;
      if (!window || at < window.until) return;
      if (Object.keys(window.groups).length && now - window.until <= policy.WINDOW_MS)
        await this.queue(window.groups, context, false, window.from, window.until);
      if (!Object.keys(window.groups).length || at >= window.until + policy.WINDOW_MS)
        state.aosSignals = null;
      else
        state.aosSignals = {
          from: window.until,
          until: window.until + policy.WINDOW_MS,
          groups: {},
        };
    } catch (error) {
      throw inventoryFailure(error);
    }
  }

  /** 从设备与实例档案读取展示名，不按客户端文本猜服务器。 */
  async sources(entries, transaction) {
    try {
      if (!entries.length) return new Map();
      const ids = [...new Set(entries.map(row => row.deviceId))];
      const [devices, instances, states] = await Promise.all([
        this.s.m.AosDevice.findAll({
          where: { id: { [Op.in]: ids } },
          attributes: ['id', 'name', 'enabled'],
          transaction,
        }),
        this.s.m.MonitorInstance.findAll({
          where: { deviceId: { [Op.in]: ids } },
          attributes: ['deviceId', 'localId', 'label'],
          transaction,
        }),
        this.s.m.MonitorLogState.findAll({
          where: { deviceId: { [Op.in]: ids } },
          attributes: ['deviceId', 'localId', 'label'],
          transaction,
        }),
      ]);
      const byDevice = new Map(devices.map(row => [row.id, row]));
      const byInstance = new Map(
        [...states, ...instances].map(row => [`${row.deviceId}:${row.localId}`, row.label])
      );
      return new Map(
        entries.map(row => {
          const key = `${row.deviceId}:${row.localId}`;
          const device = byDevice.get(row.deviceId);
          const number = device?.name.match(/^US\s*Server\s*No\.?\s*(\d+)$/i)?.[1];
          return [
            key,
            {
              key,
              server: number ? `US${number.padStart(2, '0')}` : device?.name || '未知',
              instance: byInstance.get(key) || '未知',
              enabled: Boolean(device?.enabled),
            },
          ];
        })
      );
    } catch (error) {
      throw inventoryFailure(error);
    }
  }

  /** 每次最多1000个事件；删除、上下文、窗口和投递在同一事务提交。 */
  async tick() {
    try {
      return await this.s.locked(async context => {
        try {
          const { transaction, state, settings, now } = context;
          state.aosSignals = state.aosSignals ? structuredClone(state.aosSignals) : null;
          const queue = await this.s.m.AosSignalInbox.findAll({
            order: [
              ['createdAt', 'ASC'],
              ['id', 'ASC'],
            ],
            limit: 1000,
            transaction,
          });
          const entries = queue.map(row => ({ id: row.id, ...row.body }));
          const keys = [...new Set(entries.map(row => row.taskKey))];
          const contexts = new Map(
            (keys.length
              ? await this.s.m.AosSignalContext.findAll({
                where: { id: { [Op.in]: keys } },
                transaction,
              })
              : []
            ).map(row => [row.id, row.body])
          );
          const sources = await this.sources(entries, transaction);
          for (const key of keys) {
            const taskEntries = entries.filter(row => row.taskKey === key);
            const first = taskEntries[0];
            contexts.set(
              key,
              policy.mergeContext(
                contexts.get(key),
                taskEntries,
                sources.get(`${first.deviceId}:${first.localId}`),
                now
              )
            );
          }
          if (keys.length)
            await this.s.m.AosSignalContext.bulkCreate(
              keys.map(id => ({ id, body: contexts.get(id) })),
              {
                updateOnDuplicate: ['body', 'updatedAt'],
                transaction,
              }
            );
          const enabled =
            settings.config.aosSignalsEnabled &&
            settings.webhookCipher &&
            settings.testedDestination === settings.destinationId;
          if (!enabled) state.aosSignals = null;
          const anchors = entries
            .filter(row => row.kind === 'anchor')
            .sort((a, b) => a.receivedAt - b.receivedAt || a.byteOffset - b.byteOffset);
          for (const anchor of anchors) {
            if (
              !enabled ||
              !settings.aosSignalsSince ||
              anchor.loggedAt < settings.aosSignalsSince ||
              anchor.receivedAt < settings.aosSignalsSince ||
              anchor.receivedAt - anchor.loggedAt > policy.WINDOW_MS ||
              now - anchor.receivedAt > policy.WINDOW_MS ||
              anchor.loggedAt > anchor.receivedAt
            )
              continue;
            const task = contexts.get(anchor.taskKey);
            if (!task?.source?.enabled) continue;
            await this.advance(context, anchor.receivedAt);
            const item = policy.observation(task, anchor);
            if (!state.aosSignals) {
              await this.queue(
                policy.addGroup({}, item),
                context,
                true,
                anchor.receivedAt,
                anchor.receivedAt
              );
              state.aosSignals = {
                from: anchor.receivedAt,
                until: anchor.receivedAt + policy.WINDOW_MS,
                groups: {},
              };
            } else policy.addGroup(state.aosSignals.groups, item);
          }
          if (enabled) await this.advance(context, now);
          if (queue.length)
            await this.s.m.AosSignalInbox.destroy({
              where: { id: { [Op.in]: queue.map(row => row.id) } },
              transaction,
            });
          const expired = await this.s.m.AosSignalContext.findAll({
            where: { updatedAt: { [Op.lt]: new Date(now - policy.CONTEXT_MS) } },
            attributes: ['id'],
            limit: 500,
            transaction,
          });
          if (expired.length)
            await this.s.m.AosSignalContext.destroy({
              where: { id: { [Op.in]: expired.map(row => row.id) } },
              transaction,
            });
          return { consumed: queue.length, anchors: anchors.length };
        } catch (error) {
          throw inventoryFailure(error);
        }
      });
    } catch (error) {
      throw inventoryFailure(error);
    }
  }
}

module.exports = AosSignalService;
module.exports.enqueue = enqueue;
