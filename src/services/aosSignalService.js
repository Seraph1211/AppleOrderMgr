const { randomUUID } = require('crypto');
const { isDeepStrictEqual } = require('util');
const { Op, QueryTypes } = require('sequelize');
const policy = require('./aosSignalPolicy');
const inventoryFailure = require('../utils/inventoryFailure');
const accountConfigs = require('./aosAccountConfigService');
const accountRatios = require('./aosAccountRatioService');

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
  async queue(groups, context, immediate, from, to, association, accountTracker) {
    try {
      if (!Object.keys(groups).length) return;
      const { transaction, settings, now } = context;
      const ratioEnabled = Boolean(this.s.m.AosTaskConfigVersion || this.s.m.AosAccountRegistry);
      const aosAccountRatio =
        ratioEnabled && !immediate
          ? await accountRatios.evaluate(accountTracker, this.s.m, transaction)
          : null;
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
            aosImmediate: immediate,
            ...(ratioEnabled ? { aosAccountTracker: accountTracker || null, aosAccountRatio } : {}),
            ...(association ? { aosAssociation: association } : {}),
            // 完整首次不等待；若出站前晚到边界使门店失效，仍使用原接收时间截止。
            ...(immediate ? { aosContextDeadline: from + policy.LOCATION_WAIT_MS } : {}),
            windowFrom: Math.min(...Object.values(groups).map(row => row.firstAt)),
            windowTo: Math.max(...Object.values(groups).map(row => row.lastAt)),
            receivedWindowFrom: from,
            receivedWindowTo: to,
            content: policy.content(groups, immediate, aosAccountRatio),
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

  /** 固定三分钟窗口：首次命中计入首窗，空窗口结束本轮。 */
  async advance(context, at) {
    try {
      const { state, now } = context;
      const window = state.aosSignals;
      if (!window || at < window.until) return;
      if (Object.keys(window.groups).length && now - window.until <= policy.WINDOW_MS)
        await this.queue(
          window.groups,
          context,
          false,
          window.from,
          window.until,
          window.association,
          window.accountTracker
        );
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

  /** 锁内批量复核尚未出站的引用；同时纳入已提交但尚未被tick消费的晚到上下文。 */
  async reconcile(context, deliveries) {
    try {
      const { transaction, state } = context;
      if (state.aosSignals) policy.ensureAssociation(state.aosSignals);
      const pending =
        deliveries ||
        (await this.s.rows('InventoryDelivery', {
          transaction,
          where: { 'body.kind': 'aos_signal', 'body.status': 'pending' },
          order: [['createdAt', 'ASC']],
          limit: 500,
        }));
      if (this.s.m.AosTaskConfigVersion) {
        const upgraded = [];
        for (const row of pending) {
          if (
            row.kind === 'aos_signal' &&
            row.status === 'pending' &&
            !row.aosImmediate &&
            row.aosGroups &&
            row.aosAccountRatio?.version !== 2
          ) {
            row.aosAccountRatio = await accountRatios.evaluate(
              row.aosAccountTracker,
              this.s.m,
              transaction
            );
            row.content = policy.content(row.aosGroups, false, row.aosAccountRatio);
            upgraded.push(row);
          }
        }
        if (upgraded.length) await this.s.put('InventoryDelivery', upgraded, transaction);
      }
      const candidates = pending.filter(
        row => row.kind === 'aos_signal' && row.status === 'pending' && row.aosAssociation
      );
      const associations = [
        state.aosSignals?.association,
        ...candidates.map(row => row.aosAssociation),
      ].filter(Boolean);
      const keys = [
        ...new Set(
          associations.flatMap(value => value.refs.map(reference => reference.anchor.taskKey))
        ),
      ];
      if (!keys.length) return pending;
      const [stored, inbox] = await Promise.all([
        this.s.m.AosSignalContext.findAll({
          where: { id: { [Op.in]: keys } },
          transaction,
        }),
        this.s.m.AosSignalInbox.findAll({
          where: { 'body.taskKey': { [Op.in]: keys } },
          order: [
            ['createdAt', 'ASC'],
            ['id', 'ASC'],
          ],
          limit: 1000,
          transaction,
        }),
      ]);
      const contexts = new Map(stored.map(row => [row.id, row.body]));
      const additions = new Map();
      for (const row of inbox) {
        const entry = { id: row.id, ...row.body };
        if (!additions.has(entry.taskKey)) additions.set(entry.taskKey, []);
        additions.get(entry.taskKey).push(entry);
      }
      for (const [key, entries] of additions) {
        const previous = contexts.get(key);
        // 未有设备档案的任务仍等正常tick建档，不能从客户端推测来源。
        // 复核临时合并最多1000条inbox，不能先按100条截尾而丢掉本次晚到的旧偏移。
        if (previous)
          contexts.set(key, {
            ...previous,
            events: [...(previous.events || []), ...entries.filter(row => row.kind !== 'anchor')],
          });
      }
      if (state.aosSignals?.association) {
        state.aosSignals = {
          ...state.aosSignals,
          ...policy.refreshAssociation(state.aosSignals.association, contexts),
        };
      }
      const updated = candidates.map(row => {
        const { association, groups } = policy.refreshAssociation(row.aosAssociation, contexts);
        return {
          ...row,
          aosAssociation: association,
          aosGroups: groups,
          content: policy.content(groups, row.aosImmediate),
          windowFrom: Math.min(...Object.values(groups).map(group => group.firstAt)),
          windowTo: Math.max(...Object.values(groups).map(group => group.lastAt)),
        };
      });
      if (this.s.m.AosTaskConfigVersion || this.s.m.AosAccountRegistry) {
        if (state.aosSignals?.accountTracker)
          state.aosSignals.accountTracker = accountRatios.refresh(
            state.aosSignals.accountTracker,
            state.aosSignals.association
          );
        for (const row of updated) {
          row.aosAccountTracker = accountRatios.refresh(row.aosAccountTracker, row.aosAssociation);
          row.aosAccountRatio = row.aosImmediate
            ? null
            : await accountRatios.evaluate(row.aosAccountTracker, this.s.m, transaction);
          row.content = policy.content(row.aosGroups, row.aosImmediate, row.aosAccountRatio);
        }
      }
      // JSONB忽略键顺序和undefined；无变化的待发消息不重复写入updated_at。
      const changed = updated.filter(
        (row, index) =>
          !isDeepStrictEqual(
            JSON.parse(JSON.stringify(row)),
            JSON.parse(JSON.stringify(candidates[index]))
          )
      );
      await this.s.put('InventoryDelivery', changed, transaction);
      const byId = new Map(updated.map(row => [row.id, row]));
      return pending.map(row => byId.get(row.id) || row);
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
          return [
            key,
            {
              key,
              server: policy.serverName(device?.name),
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
          if (
            (this.s.m.AosTaskConfigVersion || this.s.m.AosAccountRegistry) &&
            state.aosSignals &&
            Object.keys(state.aosSignals.groups || {}).length &&
            !state.aosSignals.accountTracker
          )
            state.aosSignals.accountTracker = {
              version: 1,
              refs: [],
              snapshots: {},
              incomplete: 'LEGACY_WINDOW_WITHOUT_ACCOUNT_TRACKER',
            };
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
          let storedContexts = [];
          if (keys.length)
            storedContexts = await this.s.m.AosSignalContext.findAll({
              where: { id: { [Op.in]: keys } },
              transaction,
            });
          const contexts = new Map(storedContexts.map(row => [row.id, row.body]));
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
          if (enabled) await this.reconcile(context);
          const anchors = (
            await accountConfigs.attachAccounts(
              this.s.m,
              entries.filter(row => row.kind === 'anchor'),
              transaction
            )
          ).sort((a, b) => a.receivedAt - b.receivedAt || a.byteOffset - b.byteOffset);
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
              const first = policy.addAssociation({ groups: {} }, anchor, item, task);
              if (this.s.m.AosTaskConfigVersion || this.s.m.AosAccountRegistry)
                first.accountTracker = accountRatios.add(null, anchor, item);
              await this.queue(
                first.groups,
                context,
                true,
                anchor.receivedAt,
                anchor.receivedAt,
                first.association,
                first.accountTracker
              );
              // 首次投递保留独立快照，后续命中和晚到上下文只更新各自关联。
              state.aosSignals = {
                ...structuredClone(first),
                from: anchor.receivedAt,
                until: anchor.receivedAt + policy.WINDOW_MS,
              };
            } else {
              policy.addAssociation(state.aosSignals, anchor, item, task);
              if (this.s.m.AosTaskConfigVersion || this.s.m.AosAccountRegistry)
                state.aosSignals.accountTracker = accountRatios.add(
                  state.aosSignals.accountTracker,
                  anchor,
                  item
                );
            }
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
