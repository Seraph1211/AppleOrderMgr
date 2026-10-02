const inventoryFailure = require('../utils/inventoryFailure');
const { randomUUID } = require('crypto');
const { Op } = require('sequelize');
const policy = require('./inventoryPolicy');

/** 持久化库存轮次与样本事务；驱动网络由 Worker 注入。 */
class InventoryCollector {
  constructor(service, owner = randomUUID()) {
    this.s = service;
    this.owner = owner;
  }
  /** 获取单一任务租约并保留错过的计划轮次。 */
  async claim() {
    try {
      await this.s.catalog();
      return await this.s.locked(async ({ transaction, state, settings, now }) => {
        try {
          state.workerHeartbeat = now;
          if (!settings.config.enabled || state.catalogLease > now) return null;
          if (state.leaseUntil > now && state.leaseOwner !== this.owner) return null;
          const products = (await this.s.rows('InventoryProduct', { transaction })).filter(
            x => x.enabled && x.supported
          );
          const stores = (await this.s.rows('InventoryStore', { transaction })).filter(
            x => x.enabled
          );
          if (!products.length || !stores.length) {
            state.lastError = 'EMPTY_ENABLED_SCOPE';
            return null;
          }
          const interval = settings.config.intervalSeconds * 1000;
          if (!state.nextRoundAt) state.nextRoundAt = now;
          const due = state.nextRoundAt;
          if (due <= now) {
            const count = Math.floor((now - due) / interval) + 1;
            // 一条压缩错过区间保存实际轮次数，避免长时间停机造成数十万条写入。
            if (count > 1) {
              const missed = this.s.newRound(
                products,
                stores,
                settings.config.intervalSeconds,
                due
              );
              Object.assign(missed, {
                status: 'missed',
                plannedCount: count - 1,
                finishedAt: now,
                failed: missed.expected,
                error: 'SCHEDULE_MISSED',
                tasks: [],
              });
              await this.s.put('InventoryRound', [missed], transaction);
            }
            const plannedAt = due + (count - 1) * interval;
            const round = this.s.newRound(
              products,
              stores,
              settings.config.intervalSeconds,
              plannedAt
            );
            // 每个计划槽都入账；繁忙时标为错过，不挤压成追赶请求。
            if (state.activeRound)
              Object.assign(round, {
                status: 'missed',
                finishedAt: now,
                failed: round.expected,
                error: 'PREVIOUS_ROUND_BUSY',
                tasks: [],
              });
            await this.s.put('InventoryRound', [round], transaction);
            state.nextRoundAt = plannedAt + interval;
          }
          let round = state.activeRound
            ? (
              await this.s.rows('InventoryRound', {
                transaction,
                where: { id: state.activeRound },
              })
            )[0]
            : null;
          if (round && now > round.plannedAt + round.intervalSeconds * 1000) {
            await this.finishRound(round, { transaction, state, now });
            return null;
          }
          if (!round) {
            const queued = await this.s.rows('InventoryRound', {
              transaction,
              where: { 'body.status': 'queued' },
              order: [['createdAt', 'ASC']],
            });
            const expired = queued.filter(r => now > r.plannedAt + r.intervalSeconds * 1000);
            await this.s.put(
              'InventoryRound',
              expired.map(r => ({
                ...r,
                status: 'missed',
                failed: r.expected,
                finishedAt: now,
                error: 'QUEUED_ROUND_EXPIRED',
              })),
              transaction
            );
            const waiting = queued.filter(r => now <= r.plannedAt + r.intervalSeconds * 1000);
            // 自动与手动交替，手动最多两个排队，防止任何一方饿死。
            round = waiting.find(x => x.source !== state.lastSource) || waiting[0];
            if (!round) return null;
            Object.assign(round, { status: 'running', startedAt: now });
            state.activeRound = round.id;
            state.lastSource = round.source;
          }
          if (round.tasks.some(t => t.status === 'running')) {
            for (const task of round.tasks.filter(t => t.status === 'running')) {
              task.status = 'failed';
              task.error = 'INTERRUPTED_ATTEMPT_UNKNOWN';
            }
          }
          const taskIndex = round.tasks.findIndex(
            t => t.status === 'pending' && (!t.notBefore || t.notBefore <= now)
          );
          if (taskIndex < 0) {
            if (!round.tasks.some(t => t.status === 'pending'))
              await this.finishRound(round, { transaction, state, now });
            else await this.s.put('InventoryRound', [round], transaction);
            return null;
          }
          const task = round.tasks[taskIndex];
          task.status = 'running';
          task.claimedAt = now;
          state.leaseOwner = this.owner;
          state.leaseUntil = now + 90000;
          await this.s.put('InventoryRound', [round], transaction);
          return {
            roundId: round.id,
            taskIndex,
            task: { ...task },
            config: settings.config,
            claimedAt: now,
          };
        } catch (error) {
          throw inventoryFailure(error);
        }
      });
    } catch (error) {
      throw inventoryFailure(error);
    }
  }
  /** 将一次有界结果应用到固定轮次；过期拥有者不能提交。 */
  async settle(claim, result) {
    try {
      return await this.s.locked(async context => {
        try {
          const { transaction, state, settings, now } = context;
          if (
            state.activeRound !== claim.roundId ||
            state.leaseOwner !== this.owner ||
            state.leaseUntil < now
          )
            return { ignored: true };
          const round = (
            await this.s.rows('InventoryRound', { transaction, where: { id: claim.roundId } })
          )[0];
          const task = round.tasks[claim.taskIndex];
          if (task.status !== 'running' || task.claimedAt !== claim.claimedAt)
            return { ignored: true };
          const actual = Boolean(result.id);
          if (actual) task.attempts += 1;
          const valid = ['INVENTORY_VALID', 'PARTIAL_RESPONSE'].includes(result.outcome);
          const productMap = new Map(round.products.map(p => [p.sku, p]));
          const storeMap = new Map(round.stores.map(s => [s.storeCode, s]));
          const data =
            valid && Array.isArray(result.evidence)
              ? result.evidence.filter(r => task.skus.includes(r.sku) && storeMap.has(r.storeCode))
              : [];
          const inconsistent = data.some(
            row =>
              (row.status !== 'unknown' && !policy.validProductRow(row, productMap.get(row.sku))) ||
              row.storeName.trim().replace(/^Apple\s*/, '') !==
                storeMap
                  .get(row.storeCode)
                  .storeName.trim()
                  .replace(/^Apple\s*/, '')
          );
          if (inconsistent) {
            result = { ...result, outcome: 'CATALOG_MISMATCH' };
            state.lastError = result.outcome;
          }
          if (valid && !inconsistent) await this.applyRows(round, data, context);
          const success = valid && !inconsistent && data.length > 0;
          if (!success || result.outcome === 'PARTIAL_RESPONSE') {
            state.lastError = result.outcome;
            const oldRows = await this.s.rows('InventorySnapshot', {
              transaction,
              where: { 'body.sku': { [Op.in]: task.skus } },
            });
            const old = new Map(oldRows.map(r => [r.id, r]));
            const good = new Set(
              data
                .filter(r => r.status !== 'unknown' && !inconsistent)
                .map(r => `${r.sku}|${r.storeCode}`)
            );
            const failures = [];
            for (const sku of task.skus)
              for (const store of round.stores) {
                const id = `${sku}|${store.storeCode}`;
                if (good.has(id)) continue;
                const product = productMap.get(sku);
                failures.push({
                  sku,
                  storeCode: store.storeCode,
                  title: product.title,
                  model: product.model,
                  capacity: product.capacity,
                  color: product.color,
                  city: store.city,
                  storeName: store.storeName,
                  observedAt: null,
                  expiresAt: null,
                  ...old.get(id),
                  id,
                  interrupted: true,
                  error: result.outcome,
                  lastAttemptAt: now,
                });
              }
            await this.s.put('InventorySnapshot', failures, transaction);
          }
          const retryable = [
            'REQUEST_TIMEOUT',
            'TRANSPORT_UNKNOWN',
            'UPSTREAM_ERROR',
            'RESPONSE_READ_FAILED',
          ].includes(result.outcome);
          const blocked = !actual && !success;
          if (
            blocked &&
            ['TARGET_COOLDOWN', 'REQUEST_IN_FLIGHT'].includes(result.outcome) &&
            now < round.plannedAt + round.intervalSeconds * 1000
          ) {
            task.status = 'pending';
            task.notBefore = Math.max(now + 1000, result.until || 0);
          } else if (
            retryable &&
            task.attempts < 3 &&
            round.retries < Math.floor(round.tasks.length * 0.2)
          ) {
            task.status = 'pending';
            task.notBefore = now + 5000;
            round.retries += 1;
          } else {
            task.status = success ? 'complete' : 'failed';
            task.error = success ? null : result.outcome;
          }
          // 保护暂停不留无限期队列；剩余范围记为未完成。
          if (blocked && task.status === 'failed')
            for (const other of round.tasks.filter(t => t.status === 'pending')) {
              other.status = 'failed';
              other.error = result.outcome;
            }
          if (
            [
              'TARGET_RATE_LIMITED',
              'TARGET_REJECTED',
              'TARGET_CHALLENGE',
              'INVALID_RESPONSE',
              'CATALOG_MISMATCH',
            ].includes(result.outcome)
          ) {
            const interrupted = await this.s.rows('InventorySnapshot', { transaction });
            await this.s.put(
              'InventorySnapshot',
              interrupted.map(row => ({ ...row, interrupted: true, hardInterrupted: true })),
              transaction
            );
            state.lastRiskAt = now;
            state.riskFreeSince = null;
            state.rampReady = false;
            state.completeStreak = 0;
          }
          state.leaseUntil = 0;
          if (round.tasks.every(t => ['complete', 'failed'].includes(t.status)))
            await this.finishRound(round, context);
          else await this.s.put('InventoryRound', [round], transaction);
          // Settings participates in the transaction via service.locked.
          return {
            applied: true,
            pause: inconsistent ? 'CATALOG_MISMATCH' : null,
            enabled: settings.config.enabled,
          };
        } catch (error) {
          throw inventoryFailure(error);
        }
      });
    } catch (error) {
      throw inventoryFailure(error);
    }
  }
  /** 快照、检测、事件、通知、统计一次事务提交。 */
  async applyRows(round, data, context) {
    try {
      const { transaction, settings, state, now } = context;
      const products = new Map(round.products.map(p => [p.sku, p]));
      const stores = new Map(round.stores.map(s => [s.storeCode, s]));
      const currentProducts = new Set(
        (await this.s.rows('InventoryProduct', { transaction }))
          .filter(x => x.enabled)
          .map(x => x.sku)
      );
      const currentStores = new Set(
        (await this.s.rows('InventoryStore', { transaction }))
          .filter(x => x.enabled)
          .map(x => x.storeCode)
      );
      const ids = data.map(r => `${r.sku}|${r.storeCode}`);
      const previous = new Map(
        (
          await this.s.rows('InventorySnapshot', { transaction, where: { id: { [Op.in]: ids } } })
        ).map(r => [r.id, r])
      );
      const existing = new Set(
        (
          await this.s.rows('InventorySample', { transaction, where: { 'body.roundId': round.id } })
        ).map(r => r.id)
      );
      const snapshots = [];
      const samples = [];
      const events = [];
      const deliveries = [];
      for (const result of data) {
        const key = `${result.sku}|${result.storeCode}`;
        const sampleId = `${round.id}|${key}`;
        if (existing.has(sampleId) || !['in_stock', 'out_of_stock'].includes(result.status))
          continue;
        const product = products.get(result.sku);
        const store = stores.get(result.storeCode);
        const dimensions = {
          sku: result.sku,
          storeCode: result.storeCode,
          title: product.title,
          model: product.model,
          capacity: product.capacity,
          color: product.color,
          city: store.city,
          storeName: store.storeName,
          status: result.status,
          quote: result.quote,
          source: round.source,
          roundId: round.id,
        };
        const { snapshot, kind } = policy.transition(
          previous.get(key),
          dimensions,
          now,
          round.intervalSeconds
        );
        if (
          !settings.config.enabled ||
          !currentProducts.has(result.sku) ||
          !currentStores.has(result.storeCode)
        ) {
          snapshot.interrupted = true;
          snapshot.hardInterrupted = true;
        }
        snapshots.push({ id: key, ...snapshot });
        samples.push({ id: sampleId, ...snapshot });
        existing.add(sampleId);
        if (kind) {
          const event = { id: sampleId, ...snapshot, kind };
          events.push(event);
          if (
            settings.config.enabled &&
            settings.config.notificationsEnabled &&
            !snapshot.interrupted &&
            now >= (settings.notificationSince || Infinity) &&
            policy.matches(snapshot, policy.parseFilters(settings.config.notificationFilters))
          ) {
            deliveries.push({
              id: sampleId,
              kind,
              roundId: round.id,
              ttlMs: settings.config.notificationTtlSeconds * 1000,
              status: 'pending',
              destinationId: settings.destinationId,
              eventIds: [sampleId],
              rows: [event],
              notBefore: Math.floor(now / 10000) * 10000 + 10000,
              expiresAt:
                (kind === 'first' ? round.plannedAt + round.intervalSeconds * 1000 : now) +
                settings.config.notificationTtlSeconds * 1000,
              attempts: 0,
            });
          }
        }
      }
      round.completed += samples.length;
      await this.s.put('InventorySnapshot', snapshots, transaction);
      await this.s.put('InventorySample', samples, transaction);
      await this.s.put('InventoryEvent', events, transaction);
      await this.s.put('InventoryDelivery', deliveries, transaction);
      await this.aggregate(samples, events, [], context);
      if (samples.length) {
        state.lastSuccessAt = now;
        state.lastError = null;
      }
    } catch (error) {
      throw inventoryFailure(error);
    }
  }
  /** 小时聚合与明细同事务；失败不伪装成零库存。 */
  async aggregate(samples, events, expected, { transaction, now }) {
    try {
      const increments = new Map();
      const add = (row, field, amount = 1) => {
        const bucket = Math.floor((row.observedAt || now) / 3600000) * 3600000;
        const id = `${bucket}|${row.sku}|${row.storeCode}|${row.source}`;
        if (!increments.has(id))
          increments.set(id, {
            id,
            sku: row.sku,
            storeCode: row.storeCode,
            title: row.title,
            city: row.city,
            storeName: row.storeName,
            model: row.model,
            capacity: row.capacity,
            color: row.color,
            source: row.source,
            bucket,
            detections: 0,
            arrivals: 0,
            first: 0,
            recovery: 0,
            successes: 0,
            failures: 0,
            expected: 0,
          });
        increments.get(id)[field] += amount;
      };
      for (const row of samples) {
        add(row, 'successes');
        if (row.status === 'in_stock') add(row, 'detections');
      }
      for (const row of events) add(row, row.kind === 'arrival' ? 'arrivals' : row.kind);
      for (const row of expected) {
        add(row, 'expected');
        if (row.failed) add(row, 'failures');
      }
      if (!increments.size) return;
      const old = new Map(
        (
          await this.s.rows('InventoryHourly', {
            transaction,
            where: { id: { [Op.in]: [...increments.keys()] } },
          })
        ).map(r => [r.id, r])
      );
      await this.s.put(
        'InventoryHourly',
        [...increments.values()].map(row => {
          const prev = old.get(row.id);
          if (prev)
            for (const f of [
              'detections',
              'arrivals',
              'first',
              'recovery',
              'successes',
              'failures',
              'expected',
            ])
              row[f] += prev[f] || 0;
          return row;
        }),
        transaction
      );
    } catch (error) {
      throw inventoryFailure(error);
    }
  }
  /** 完成全量覆盖审计；不存在的门店响应保持失败。 */
  async finishRound(round, context) {
    try {
      const { transaction, state, now } = context;
      const samples = await this.s.rows('InventorySample', {
        transaction,
        where: { 'body.roundId': round.id },
      });
      const got = new Set(samples.map(r => `${r.sku}|${r.storeCode}`));
      const expected = [];
      const missing = [];
      const old = new Map(
        (await this.s.rows('InventorySnapshot', { transaction })).map(r => [r.id, r])
      );
      for (const product of round.products)
        for (const store of round.stores) {
          const key = `${product.sku}|${store.storeCode}`;
          const row = {
            sku: product.sku,
            title: product.title,
            model: product.model,
            capacity: product.capacity,
            color: product.color,
            storeCode: store.storeCode,
            city: store.city,
            storeName: store.storeName,
            source: round.source,
            observedAt: round.plannedAt,
            failed: !got.has(key),
          };
          expected.push(row);
          if (!got.has(key))
            missing.push({
              ...row,
              observedAt: null,
              expiresAt: null,
              ...old.get(key),
              id: key,
              interrupted: true,
              error: 'ROUND_COVERAGE_MISSING',
              lastAttemptAt: now,
            });
        }
      await this.s.put('InventorySnapshot', missing, transaction);
      await this.aggregate([], [], expected, context);
      Object.assign(round, {
        completed: got.size,
        failed: round.expected - got.size,
        status: got.size === round.expected ? 'complete' : 'partial',
        finishedAt: now,
      });
      await this.s.put('InventoryRound', [round], transaction);
      const initial = await this.s.rows('InventoryDelivery', {
        transaction,
        where: { 'body.roundId': round.id, 'body.kind': 'first', 'body.status': 'pending' },
      });
      await this.s.put(
        'InventoryDelivery',
        initial.map(row => ({
          ...row,
          notBefore: Math.ceil(now / 10000) * 10000,
          expiresAt: now + (row.ttlMs || 120000),
        })),
        transaction
      );
      state.activeRound = null;
      state.leaseUntil = 0;
      state.leaseOwner = null;
      state.completeStreak = round.status === 'complete' ? (state.completeStreak || 0) + 1 : 0;
      if (!state.riskFreeSince) state.riskFreeSince = now;
      state.rampReady =
        state.completeStreak >= 3 &&
        now - Math.max(state.lastRiskAt || 0, state.riskFreeSince) >= 1800000;
      if (round.status !== 'complete') state.lastError = 'ROUND_COVERAGE_MISSING';
    } catch (error) {
      throw inventoryFailure(error);
    }
  }
}
module.exports = InventoryCollector;
