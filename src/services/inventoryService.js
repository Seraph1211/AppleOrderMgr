const inventoryFailure = require('../utils/inventoryFailure');
const { randomUUID } = require('crypto');
const { Op, QueryTypes, literal } = require('sequelize');
const ApiError = require('../utils/ApiError');
const { encrypt } = require('../utils/fieldEncryption');
const { validateWebhook } = require('./wecomTransport');
const policy = require('./inventoryPolicy');
const seed = require('../data/inventoryCatalog.json');

/** 库存持久化服务；所有状态转换由同一行锁串行化，网络调用在事务外。 */
class InventoryService {
  constructor(models = require('../models')) {
    this.m = models;
    this.db = models.sequelize;
  }
  /** 在数据库时钟和运行行锁下原子修改。 */
  async locked(work) {
    try {
      return await this.db.transaction(async transaction => {
        try {
          const runtime = await this.m.InventoryRuntime.findByPk('main', {
            transaction,
            lock: transaction.LOCK.UPDATE,
          });
          if (!runtime) throw ApiError.internal('库存迁移尚未执行');
          const [{ now }] = await this.db.query('SELECT clock_timestamp() AS now', {
            type: QueryTypes.SELECT,
            transaction,
          });
          const setting = await this.m.InventorySetting.findByPk('main', { transaction });
          const state = { ...runtime.body };
          const settings = {
            ...setting.body,
            config: { ...policy.DEFAULT_CONFIG, ...setting.body.config },
          };
          const result = await work({ transaction, state, settings, now: new Date(now).getTime() });
          await runtime.update({ body: state }, { transaction });
          await setting.update({ body: settings }, { transaction });
          return result;
        } catch (error) {
          throw inventoryFailure(error);
        }
      });
    } catch (error) {
      if (error instanceof ApiError) throw inventoryFailure(error);
      throw ApiError.internal('库存数据库操作失败', undefined, 'INVENTORY_STORAGE_FAILED');
    }
  }
  /** 读取白名单模型的业务记录。 */
  async rows(name, options = {}) {
    try {
      const scopedOptions =
        name === 'InventoryProduct'
          ? {
            ...options,
            where: {
              [Op.and]: [
                options.where || {},
                { 'body.model': { [Op.in]: policy.MONITORED_MODELS } },
              ],
            },
          }
          : options;
      return (await this.m[name].findAll(scopedOptions)).map(row => ({ id: row.id, ...row.body }));
    } catch (_error) {
      throw ApiError.internal('库存数据读取失败');
    }
  }
  /** 批量保存，调用方必须传事务。 */
  async put(name, rows, transaction) {
    try {
      const scopedRows =
        name === 'InventoryProduct'
          ? rows.filter(row => policy.MONITORED_MODELS.includes(row.model))
          : rows;
      if (!scopedRows.length) return;
      await this.m[name].bulkCreate(
        scopedRows.map(({ id, ...body }) => ({ id, body })),
        { transaction, updateOnDuplicate: ['body', 'updatedAt'] }
      );
    } catch (_error) {
      throw ApiError.internal('库存数据保存失败');
    }
  }
  /** 首次装入公开目录，默认待启用；重复调用不覆盖用户设置。 */
  async catalog() {
    try {
      return await this.locked(async ({ state, transaction, now }) => {
        try {
          if (!state.seeded) {
            await this.put(
              'InventoryProduct',
              seed.products.map(p => ({
                id: p.sku,
                ...policy.productDetails(p),
                enabled: false,
                supported: true,
                discoveredAt: now,
                lastSeenAt: Date.parse(seed.observedAt),
                sourceUrl: `https://www.apple.com.cn/shop/buy-iphone/${p.family.replace(/_/g, '-')}`,
              })),
              transaction
            );
            await this.put(
              'InventoryStore',
              seed.stores.map(s => ({
                id: s.storeCode,
                ...s,
                enabled: false,
                discoveredAt: now,
                lastSeenAt: Date.parse(seed.observedAt),
                sourceUrl: 'https://www.apple.com.cn/retail/storelist/',
              })),
              transaction
            );
            state.seeded = true;
          }
          return {
            products: await this.rows('InventoryProduct', { transaction, order: [['id', 'ASC']] }),
            stores: await this.rows('InventoryStore', { transaction, order: [['id', 'ASC']] }),
          };
        } catch (error) {
          throw inventoryFailure(error);
        }
      });
    } catch (error) {
      throw inventoryFailure(error);
    }
  }
  /** 用户可见的监控范围白名单；不返回管理配置、代理或通知信息。 */
  async scope() {
    try {
      const [catalog, settings, health] = await Promise.all([
        this.catalog(),
        this.getSettings(),
        this.health(),
      ]);
      const products = catalog.products
        .filter(row => row.enabled && row.supported)
        .map(({ sku, model, capacity, color }) => ({ sku, model, capacity, color }));
      const stores = catalog.stores
        .filter(row => row.enabled)
        .map(({ storeCode, city, storeName }) => ({ storeCode, city, storeName }));
      const state = !settings.config.enabled
        ? 'disabled'
        : !products.length || !stores.length
          ? 'empty'
          : !health.workerHeartbeat || Date.now() - health.workerHeartbeat > 120000
            ? 'offline'
            : health.state;
      return {
        products,
        stores,
        combinations: products.length * stores.length,
        enabled: settings.config.enabled,
        state,
        lastSuccessAt: health.lastSuccessAt,
      };
    } catch (error) {
      throw inventoryFailure(error);
    }
  }
  /** 批量启停目录，不修改个人过滤。 */
  async setCatalog(input, actor) {
    try {
      if (!input || typeof input !== 'object') throw ApiError.badRequest('目录修改无效');
      if (
        !['products', 'stores'].includes(input.kind) ||
        typeof input.enabled !== 'boolean' ||
        !Array.isArray(input.ids) ||
        !input.ids.length ||
        input.ids.length > 200 ||
        input.ids.some(x => typeof x !== 'string')
      )
        throw ApiError.badRequest('目录修改无效');
      return await this.locked(async ({ transaction, state }) => {
        try {
          const name = input.kind === 'products' ? 'InventoryProduct' : 'InventoryStore';
          const rows = await this.rows(name, {
            transaction,
            where: { id: { [Op.in]: [...new Set(input.ids)] } },
          });
          if (rows.length !== new Set(input.ids).size) throw ApiError.badRequest('目录项不存在');
          await this.put(
            name,
            rows.map(row => ({ ...row, enabled: input.enabled, updatedBy: actor })),
            transaction
          );
          const field = input.kind === 'products' ? 'sku' : 'storeCode';
          const snapshots = await this.rows('InventorySnapshot', {
            transaction,
            where: { [`body.${field}`]: { [Op.in]: input.ids } },
          });
          await this.put(
            'InventorySnapshot',
            snapshots.map(row => ({ ...row, interrupted: true, hardInterrupted: true })),
            transaction
          );
          state.scopeChanged = true;
          return { count: rows.length };
        } catch (error) {
          throw inventoryFailure(error);
        }
      });
    } catch (error) {
      throw inventoryFailure(error);
    }
  }
  /** 设置返回仅包含允许公开的字段。 */
  settingsDto(settings) {
    return {
      version: settings.version,
      config: settings.config,
      hasWebhook: Boolean(settings.webhookCipher),
      webhookTested:
        settings.testedDestination === settings.destinationId && Boolean(settings.destinationId),
      destinationId: settings.destinationId || null,
    };
  }
  /** 获取脱敏配置。 */
  async getSettings() {
    try {
      return await this.locked(context => {
        try {
          return this.settingsDto(context.settings);
        } catch (error) {
          throw inventoryFailure(error);
        }
      });
    } catch (error) {
      throw inventoryFailure(error);
    }
  }
  /** 乐观版本控制配置，通知从此刻开始且不回放。 */
  async saveSettings(input, actor) {
    try {
      if (!input || typeof input !== 'object') throw ApiError.badRequest('设置无效');
      const config = policy.validateConfig(input.config);
      const webhook =
        input.webhook === undefined
          ? undefined
          : input.webhook === ''
            ? ''
            : validateWebhook(input.webhook);
      return await this.locked(async ({ transaction, settings, state, now }) => {
        try {
          if (input.version !== settings.version)
            throw ApiError.conflict('设置已被修改，请刷新后重试');
          if (
            config.intervalSeconds < 300 &&
            (!state.rampReady || (state.lastRiskAt || 0) > now - 1800000)
          )
            throw ApiError.badRequest('提速需至少三个完整轮次且三十分钟无风险');
          if (webhook !== undefined) {
            settings.webhookCipher = webhook ? encrypt(webhook) : null;
            settings.destinationId = randomUUID();
            settings.testedDestination = null;
          }
          if (
            config.notificationsEnabled &&
            (!settings.webhookCipher || settings.testedDestination !== settings.destinationId)
          )
            throw ApiError.badRequest('请先保存 Webhook 并成功发送合成测试，再开启提醒');
          if (config.notificationsEnabled && !settings.config.notificationsEnabled)
            settings.notificationSince = now;
          if (config.enabled !== settings.config.enabled) {
            const rows = await this.rows('InventorySnapshot', { transaction });
            await this.put(
              'InventorySnapshot',
              rows.map(row => ({ ...row, interrupted: true, hardInterrupted: true })),
              transaction
            );
            if (config.enabled) state.nextRoundAt = now;
            else if (state.activeRound) {
              const rounds = await this.rows('InventoryRound', {
                transaction,
                where: { id: state.activeRound },
              });
              if (rounds.length) {
                const active = rounds[0];
                const completed = await this.m.InventorySample.count({
                  transaction,
                  where: { 'body.roundId': active.id },
                });
                await this.put(
                  'InventoryRound',
                  [
                    {
                      ...active,
                      status: 'partial',
                      completed,
                      failed: active.expected - completed,
                      finishedAt: now,
                      error: 'MONITOR_DISABLED',
                    },
                  ],
                  transaction
                );
              }
              state.activeRound = null;
              state.leaseUntil = 0;
              state.leaseOwner = null;
            }
          }
          settings.config = config;
          settings.version += 1;
          settings.updatedBy = actor;
          return this.settingsDto(settings);
        } catch (error) {
          throw inventoryFailure(error);
        }
      });
    } catch (error) {
      throw inventoryFailure(error);
    }
  }
  /** 范围内的最新快照与缺失组合。 */
  async latest(query = {}) {
    try {
      const filters = policy.parseFilters(query);
      const catalog = await this.catalog();
      const settings = await this.getSettings();
      const snapshots = new Map((await this.rows('InventorySnapshot')).map(row => [row.id, row]));
      const health = await this.health();
      const now = Date.now();
      const rows = [];
      for (const product of catalog.products)
        for (const store of catalog.stores) {
          const dimensions = {
            ...product,
            ...store,
            sku: product.sku,
            storeCode: store.storeCode,
            title: product.title,
          };
          if (!policy.matches(dimensions, filters)) continue;
          const old = snapshots.get(`${product.sku}|${store.storeCode}`);
          const status = policy.displayStatus(
            old,
            {
              enabled: product.enabled && store.enabled,
              supported: product.supported,
              paused: !settings.config.enabled || health.paused,
            },
            now
          );
          rows.push({
            ...dimensions,
            ...old,
            id: `${product.sku}|${store.storeCode}`,
            displayStatus: status,
            lastStatus: old?.status || null,
          });
        }
      const summary = {
        combinations: rows.length,
        inStock: rows.filter(r => r.displayStatus === 'in_stock').length,
        fresh: rows.filter(r => ['in_stock', 'out_of_stock'].includes(r.displayStatus)).length,
        currentStores: new Set(
          rows.filter(r => r.displayStatus === 'in_stock').map(r => r.storeCode)
        ).size,
      };
      const selected =
        query.onlyInStock === 'true' || query.onlyInStock === true
          ? rows.filter(r => r.displayStatus === 'in_stock')
          : rows;
      return { ...this.paginate(selected, query), summary, asOf: now };
    } catch (error) {
      throw inventoryFailure(error);
    }
  }
  /** 有界分页。 */
  paginate(rows, query) {
    const { page, pageSize } = this.page(query);
    return {
      items: rows.slice((page - 1) * pageSize, page * pageSize),
      total: rows.length,
      page,
      pageSize,
    };
  }
  /** 校验分页参数。 */
  page(query) {
    const page = Number(query.page || 1);
    const pageSize = Number(query.pageSize || 50);
    if (
      !Number.isInteger(page) ||
      page < 1 ||
      page > 100000 ||
      !Number.isInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > 200
    )
      throw ApiError.badRequest('分页参数无效');
    return { page, pageSize };
  }
  /** 排队手动查询；同范围去重，不直接访问 Apple。 */
  async refresh(query, actor) {
    try {
      const filters = policy.parseFilters(query);
      return await this.locked(async ({ transaction, settings, state, now }) => {
        try {
          if (!settings.config.enabled) throw ApiError.badRequest('请先启用全局监控');
          const products = (await this.rows('InventoryProduct', { transaction })).filter(
            p =>
              p.enabled &&
              p.supported &&
              policy.matches(
                p,
                Object.fromEntries(
                  Object.entries(filters).filter(([k]) => !['city', 'storeCode'].includes(k))
                )
              )
          );
          const stores = (await this.rows('InventoryStore', { transaction })).filter(
            s =>
              s.enabled &&
              policy.matches(
                s,
                Object.fromEntries(
                  Object.entries(filters).filter(([k]) => ['city', 'storeCode'].includes(k))
                )
              )
          );
          if (!products.length || !stores.length)
            throw ApiError.badRequest('筛选范围内没有已启用组合');
          const queued = await this.rows('InventoryRound', {
            transaction,
            where: { 'body.status': { [Op.in]: ['queued', 'running'] } },
          });
          const same = queued.find(
            r =>
              products.every(p => r.products.some(x => x.sku === p.sku)) &&
              stores.every(s => r.stores.some(x => x.storeCode === s.storeCode))
          );
          if (same) return { id: same.id, coalesced: true };
          if (queued.filter(r => r.source === 'manual').length >= 2)
            throw ApiError.conflict('手动队列已满，请等待现有轮次');
          const round = this.newRound(
            products,
            stores,
            settings.config.intervalSeconds,
            now,
            'manual'
          );
          round.actor = actor;
          await this.put('InventoryRound', [round], transaction);
          state.lastManualAt = now;
          return { id: round.id, coalesced: false };
        } catch (error) {
          throw inventoryFailure(error);
        }
      });
    } catch (error) {
      throw inventoryFailure(error);
    }
  }
  /** 固定范围轮次。 */
  newRound(products, stores, intervalSeconds, now, source = 'auto') {
    return {
      id: source === 'auto' ? `auto:${now}` : randomUUID(),
      source,
      plannedAt: now,
      status: 'queued',
      products,
      stores,
      intervalSeconds,
      tasks: policy.buildTasks(products, stores),
      expected: products.length * stores.length,
      completed: 0,
      failed: 0,
      retries: 0,
    };
  }
  /** 历史筛选，时间必须含时区，默认北京时间今天。 */
  historyQuery(query, now = Date.now()) {
    const defaultFrom = Math.floor((now + 28800000) / 86400000) * 86400000 - 28800000;
    const time = (value, fallback) => {
      if (value === undefined || value === '') return fallback;
      if (typeof value !== 'string' || !/(?:Z|[+-]\d\d:\d\d)$/.test(value))
        throw ApiError.badRequest('时间必须带时区');
      const n = Date.parse(value);
      if (!Number.isFinite(n)) throw ApiError.badRequest('时间无效');
      return n;
    };
    const from = time(query.from, defaultFrom);
    const to = time(query.to, now);
    if (from >= to || to - from > 730 * 86400000) throw ApiError.badRequest('时间范围无效');
    const metric = query.metric || 'arrivals';
    const source = query.source || 'all';
    if (
      !['all', 'arrivals', 'detections', 'first', 'recovery'].includes(metric) ||
      !['auto', 'manual', 'all'].includes(source)
    )
      throw ApiError.badRequest('统计口径无效');
    const where = { createdAt: { [Op.gte]: new Date(from), [Op.lt]: new Date(to) } };
    if (query.hour !== undefined && query.hour !== '') {
      const hour = Number(query.hour);
      if (!Number.isInteger(hour) || hour < 0 || hour > 23)
        throw ApiError.badRequest('小时筛选无效');
      where[Op.and] = literal(
        `EXTRACT(HOUR FROM to_timestamp((body->>'observedAt')::bigint / 1000.0) AT TIME ZONE 'Asia/Shanghai') = ${hour}`
      );
    }
    for (const [key, values] of Object.entries(policy.parseFilters(query)))
      where[`body.${key}`] = { [Op.in]: values };
    if (source !== 'all') where['body.source'] = source;
    if (metric === 'detections') where['body.status'] = 'in_stock';
    if (metric !== 'all' && metric !== 'detections')
      where['body.kind'] = metric === 'arrivals' ? 'arrival' : metric;
    return {
      from,
      to,
      metric,
      source,
      where,
      model: metric === 'detections' || metric === 'all' ? 'InventorySample' : 'InventoryEvent',
    };
  }
  /** 分页历史或有界导出。 */
  async history(query = {}, exporting = false) {
    try {
      const parsed = this.historyQuery(query);
      const { page, pageSize } = this.page(query);
      const settings = await this.getSettings();
      const retainedFrom =
        Date.now() -
        (parsed.model === 'InventorySample'
          ? settings.config.samplesDays
          : settings.config.eventsDays) *
          86400000;
      const detailsPartiallyExpired = parsed.from < retainedFrom;
      if (exporting && detailsPartiallyExpired)
        throw ApiError.badRequest('部分时段明细已超保留期，请调整导出起始时间');
      const total = await this.m[parsed.model].count({ where: parsed.where });
      if (exporting && total > 50000) throw ApiError.badRequest('超过五万条，请缩小导出范围');
      const items = await this.rows(parsed.model, {
        where: parsed.where,
        order: [
          ['createdAt', 'DESC'],
          ['id', 'ASC'],
        ],
        limit: exporting ? 50000 : pageSize,
        offset: exporting ? 0 : (page - 1) * pageSize,
      });
      return {
        items,
        total,
        page,
        pageSize,
        from: parsed.from,
        to: parsed.to,
        retainedFrom,
        detailsPartiallyExpired,
      };
    } catch (error) {
      throw inventoryFailure(error);
    }
  }
  /** 分页运转与通知记录。 */
  async list(name, query = {}) {
    try {
      if (!['InventoryRound', 'InventoryDelivery'].includes(name))
        throw ApiError.badRequest('记录类型无效');
      const { page, pageSize } = this.page(query);
      const total = await this.m[name].count();
      const items = await this.rows(name, {
        order: [['createdAt', 'DESC']],
        limit: pageSize,
        offset: (page - 1) * pageSize,
      });
      return {
        total,
        page,
        pageSize,
        items: items.map(r =>
          name === 'InventoryRound'
            ? {
              id: r.id,
              source: r.source,
              status: r.status,
              plannedAt: r.plannedAt,
              startedAt: r.startedAt,
              finishedAt: r.finishedAt,
              expected: r.expected,
              completed: r.completed,
              failed: r.failed,
              pending: Math.max(0, r.expected - r.completed - r.failed),
              retries: r.retries,
              error: r.error,
              plannedCount: r.plannedCount || 1,
              products: r.products.length,
              stores: r.stores.length,
            }
            : r
        ),
      };
    } catch (error) {
      throw inventoryFailure(error);
    }
  }
  /** 固定轮次覆盖矩阵；明细过期后只给已保存汇总。 */
  async roundDetail(id, query = {}) {
    try {
      if (typeof id !== 'string' || id.length > 200) throw ApiError.badRequest('轮次编号无效');
      const [round] = await this.rows('InventoryRound', { where: { id } });
      if (!round) throw ApiError.notFound('轮次不存在');
      const settings = await this.getSettings();
      const detailAvailable = round.plannedAt > Date.now() - settings.config.samplesDays * 86400000;
      const samples = detailAvailable
        ? await this.rows('InventorySample', { where: { 'body.roundId': id } })
        : [];
      const found = new Map(samples.map(r => [`${r.sku}|${r.storeCode}`, r]));
      const filters = policy.parseFilters(query);
      const matrix = [];
      if (detailAvailable)
        for (const product of round.products)
          for (const store of round.stores) {
            const key = `${product.sku}|${store.storeCode}`;
            const sample = found.get(key);
            const dimensions = {
              sku: product.sku,
              model: product.model,
              capacity: product.capacity,
              color: product.color,
              city: store.city,
              storeName: store.storeName,
              storeCode: store.storeCode,
            };
            if (!policy.matches(dimensions, filters)) continue;
            matrix.push({
              ...dimensions,
              id: key,
              status: sample
                ? 'complete'
                : ['queued', 'running'].includes(round.status)
                  ? 'pending'
                  : 'failed',
              stockStatus: sample?.status || null,
              observedAt: sample?.observedAt || null,
            });
          }
      return {
        ...this.paginate(matrix, query),
        id,
        detailAvailable,
        expected: round.expected,
        completed: round.completed,
        failed: round.failed,
        plannedCount: round.plannedCount || 1,
        tasks: round.tasks,
        plannedAt: round.plannedAt,
      };
    } catch (error) {
      throw inventoryFailure(error);
    }
  }
  /** 健康信息不包含代理地址或加密凭据。 */
  async health() {
    try {
      const runtime = (await this.m.InventoryRuntime.findByPk('main'))?.body || {};
      const [gate] = await this.db.query(
        "SELECT body FROM inventory_validation_state WHERE id = 'inventory-validation'",
        { type: QueryTypes.SELECT }
      );
      const b = gate?.body || {};
      const now = Date.now();
      const paused = Boolean(b.pausedReason || (b.cooldownUntil || 0) > now);
      const [pendingNotifications, sendingNotifications, queuedRounds, latestRounds] =
        await Promise.all([
          this.m.InventoryDelivery.count({ where: { 'body.status': 'pending' } }),
          this.m.InventoryDelivery.count({ where: { 'body.status': 'sending' } }),
          this.m.InventoryRound.count({ where: { 'body.status': 'queued' } }),
          this.rows('InventoryRound', {
            where: { 'body.status': { [Op.in]: ['complete', 'partial'] } },
            order: [['updatedAt', 'DESC']],
            limit: 1,
          }),
        ]);
      const lastRound = latestRounds[0];
      return {
        state: b.pausedReason
          ? 'manual_required'
          : b.cooldownUntil > now
            ? 'cooldown'
            : b.recovering
              ? 'recovering'
              : runtime.lastError
                ? 'degraded'
                : 'normal',
        paused,
        queue: { pendingNotifications, sendingNotifications, queuedRounds },
        lastRound: lastRound
          ? {
            status: lastRound.status,
            completed: lastRound.completed,
            expected: lastRound.expected,
            durationMs: lastRound.finishedAt - lastRound.startedAt,
          }
          : null,
        taskRps: 1,
        globalRps: 5,
        reason: b.pausedReason || runtime.lastError || null,
        cooldownUntil: b.cooldownUntil || null,
        riskRatio: b.recent?.length ? b.recent.filter(r => r.risk).length / b.recent.length : 0,
        hourCount: b.hour === Math.floor(now / 3600000) ? b.hourCount : 0,
        dayCount: b.day === Math.floor(now / 86400000) ? b.dayCount : 0,
        dailyBytes: b.day === Math.floor(now / 86400000) ? b.byteCount || 0 : 0,
        proxyExtractions: b.day === Math.floor(now / 86400000) ? b.proxyCount || 0 : 0,
        lastSuccessAt: runtime.lastSuccessAt || null,
        nextRoundAt: runtime.nextRoundAt || null,
        activeRound: runtime.activeRound || null,
        workerHeartbeat: runtime.workerHeartbeat || null,
        catalogAt: runtime.catalogAt || null,
        catalogError: runtime.catalogError || null,
        catalogRequested: Boolean(runtime.catalogRequested),
        rampReady: Boolean(runtime.rampReady),
      };
    } catch (_error) {
      throw ApiError.internal('库存健康状态读取失败');
    }
  }
  /** 排队目录核对，失败保持原有目录。 */
  async refreshCatalog() {
    try {
      return await this.locked(({ state }) => {
        try {
          state.catalogRequested = true;
          return { queued: true };
        } catch (error) {
          throw inventoryFailure(error);
        }
      });
    } catch (error) {
      throw inventoryFailure(error);
    }
  }
}
module.exports = InventoryService;
