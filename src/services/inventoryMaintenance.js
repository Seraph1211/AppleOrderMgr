const inventoryFailure = require('../utils/inventoryFailure');
const { Op } = require('sequelize');
const {
  parseDetailedProductCatalog,
  parseStoreCatalog,
  discoverProductPaths,
} = require('./inventoryValidationCatalog');

/** 目录发现和保留期维护，错误不下架既有配置。 */
class InventoryMaintenance {
  constructor(service, driver, gate) {
    this.s = service;
    this.driver = driver;
    this.gate = gate;
  }
  /** 人工恢复保留预算和未到期冷却，仅重置已核查阻断。 */
  async resume(actor) {
    try {
      await this.gate.locked(async (state, now, transaction) => {
        try {
          state.pausedReason = null;
          state.pausedEgress = {};
          state.requiredAlternateEgress = null;
          state.recovering = true;
          state.recoveryFailures = 0;
          state.recoverySuccesses = 0;
          state.resumedBy = actor;
          state.resumedAt = now;
          await this.gate.save(state, transaction);
        } catch (error) {
          throw inventoryFailure(error);
        }
      });
      return { queued: true, notice: '进入有限恢复探测；现有冷却和预算继续生效' };
    } catch (error) {
      throw inventoryFailure(error);
    }
  }
  /** 每日低优先级目录任务；与库存租约互斥，一次只发一个请求。 */
  async catalogTick() {
    try {
      const claim = await this.s.locked(({ state, settings, now }) => {
        try {
          if (
            !settings.config.enabled ||
            state.activeRound ||
            state.leaseUntil > now ||
            state.catalogLease > now
          )
            return null;
          if (!state.catalogJob && !state.catalogRequested && state.catalogAt > now - 86400000)
            return null;
          if (!state.catalogJob) {
            state.catalogJob = {
              paths: ['/shop/buy-iphone', '/retail/storelist/'],
              index: 0,
              products: [],
              stores: [],
            };
          }
          const job = state.catalogJob;
          state.catalogLease = now + 90000;
          return { index: job.index, path: job.paths[job.index], lease: state.catalogLease };
        } catch (error) {
          throw inventoryFailure(error);
        }
      });
      if (!claim) return false;
      const result = await this.driver.request('catalog', { path: claim.path });
      let parsed;
      let error = null;
      try {
        if (result.outcome !== 'CATALOG_RECEIVED') throw new Error('CATALOG_QUERY_FAILED');
        parsed =
          claim.index === 0
            ? discoverProductPaths(result.evidence)
            : claim.index === 1
              ? parseStoreCatalog(result.evidence)
              : parseDetailedProductCatalog(result.evidence);
      } catch (_error) {
        error = result.outcome === 'CATALOG_RECEIVED' ? 'CATALOG_PARSE_FAILED' : result.outcome;
      }
      await this.s.locked(async ({ transaction, state, now }) => {
        try {
          if (state.catalogLease !== claim.lease) return;
          state.catalogLease = 0;
          if (error) {
            state.catalogError = error;
            state.catalogJob = null;
            state.catalogRequested = false;
            state.catalogAt = now;
            return;
          }
          const job = state.catalogJob;
          if (claim.index === 0) job.paths.push(...parsed);
          else if (claim.index === 1) job.stores = parsed;
          else
            job.products.push(
              ...parsed.map(p => ({ ...p, sourceUrl: `https://www.apple.com.cn${claim.path}` }))
            );
          job.index += 1;
          if (job.index < job.paths.length) return;
          for (const [name, rows, key] of [
            ['InventoryProduct', job.products, 'sku'],
            ['InventoryStore', job.stores, 'storeCode'],
          ]) {
            const old = new Map((await this.s.rows(name, { transaction })).map(r => [r.id, r]));
            await this.s.put(
              name,
              rows.map(r => ({
                ...old.get(r[key]),
                ...r,
                id: r[key],
                enabled: old.get(r[key])?.enabled || false,
                supported: true,
                sourceUrl: r.sourceUrl || 'https://www.apple.com.cn/retail/storelist/',
                discoveredAt: old.get(r[key])?.discoveredAt || now,
                lastSeenAt: now,
              })),
              transaction
            );
          }
          state.catalogAt = now;
          state.catalogJob = null;
          state.catalogRequested = false;
          state.catalogError = null;
        } catch (failure) {
          throw inventoryFailure(failure);
        }
      });
      return true;
    } catch (_error) {
      throw new Error('INVENTORY_CATALOG_FAILED');
    }
  }
  /** 定期有界删除；统计在采样时已聚合，不依赖删除时临时计算。 */
  async retain() {
    try {
      return await this.s.locked(async ({ transaction, state, settings, now }) => {
        try {
          if (state.retentionAt > now - 3600000) return;
          const limits = {
            InventorySample: settings.config.samplesDays,
            InventoryEvent: settings.config.eventsDays,
            InventoryDelivery: settings.config.eventsDays,
            InventoryRound: settings.config.hourlyDays,
            InventoryHourly: settings.config.hourlyDays,
          };
          let more = false;
          for (const [name, days] of Object.entries(limits)) {
            const rows = await this.s.m[name].findAll({
              attributes: ['id'],
              where: { createdAt: { [Op.lt]: new Date(now - days * 86400000) } },
              order: [['createdAt', 'ASC']],
              limit: 5000,
              transaction,
            });
            if (rows.length)
              await this.s.m[name].destroy({
                where: { id: { [Op.in]: rows.map(r => r.id) } },
                transaction,
              });
            if (rows.length === 5000) more = true;
          }
          state.retentionAt = more ? now - 3590000 : now;
        } catch (error) {
          throw inventoryFailure(error);
        }
      });
    } catch (error) {
      throw inventoryFailure(error);
    }
  }
}
module.exports = InventoryMaintenance;
