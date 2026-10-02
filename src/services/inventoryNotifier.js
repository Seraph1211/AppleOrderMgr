const inventoryFailure = require('../utils/inventoryFailure');
const { randomUUID } = require('crypto');
const { Op, QueryTypes } = require('sequelize');
const ApiError = require('../utils/ApiError');
const { decrypt } = require('../utils/fieldEncryption');
const { sendText } = require('./wecomTransport');
const { isSilent, displayStatus } = require('./inventoryPolicy');
const TITLES = {
  arrival: 'iPhone 到货提醒',
  first: '初始库存摘要',
  recovery: '恢复后检测到有货',
  health: '库存监控运行提醒',
  test: '库存机器人合成测试',
};

/** 库存专用投递链路，与订单通知完全分离。 */
class InventoryNotifier {
  constructor(service, transport = sendText) {
    this.s = service;
    this.transport = transport;
  }
  /** 明确操作才排队合成测试。 */
  async test(actor) {
    try {
      return await this.s.locked(async ({ transaction, settings, now }) => {
        try {
          if (!settings.webhookCipher) throw ApiError.badRequest('请先保存库存群 Webhook');
          const id = randomUUID();
          await this.s.put(
            'InventoryDelivery',
            [
              {
                id,
                kind: 'test',
                status: 'pending',
                destinationId: settings.destinationId,
                content: '这是合成测试消息，不代表真实库存。请核对目标群。',
                notBefore: now,
                expiresAt: now + 120000,
                attempts: 0,
                actor,
              },
            ],
            transaction
          );
          return { id, status: 'pending' };
        } catch (error) {
          throw inventoryFailure(error);
        }
      });
    } catch (error) {
      throw inventoryFailure(error);
    }
  }
  /** 按保护状态变化合并提醒，稳定状态不刷屏。 */
  async health(health) {
    try {
      return await this.s.locked(async ({ transaction, state, settings, now }) => {
        try {
          const previous = state.notifiedHealth || 'normal';
          if (previous === health.state) return;
          state.notifiedHealth = health.state;
          if (!settings.config.notificationsEnabled) return;
          const message = `状态：${health.state}\n影响：已启用库存范围\n原因：${health.reason || '保护状态变化'}\n最近成功：${health.lastSuccessAt ? new Date(health.lastSuccessAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '尚无'}\n冷却截止：${health.cooldownUntil ? new Date(health.cooldownUntil).toISOString() : '无'}\n请在库存运行健康页查看下一步。`;
          await this.s.put(
            'InventoryDelivery',
            [
              {
                id: randomUUID(),
                kind: 'health',
                status: 'pending',
                destinationId: settings.destinationId,
                content: message,
                notBefore: now + 10000,
                expiresAt: now + 120000,
                attempts: 0,
              },
            ],
            transaction
          );
        } catch (error) {
          throw inventoryFailure(error);
        }
      });
    } catch (error) {
      throw inventoryFailure(error);
    }
  }
  /** 原子复核、合并、限速并占用发送；不在事务内访问企微。 */
  async claim() {
    try {
      return await this.s.locked(async ({ transaction, state, settings, now }) => {
        try {
          const interrupted = await this.s.rows('InventoryDelivery', {
            transaction,
            where: { 'body.status': 'sending' },
          });
          await this.s.put(
            'InventoryDelivery',
            interrupted
              .filter(r => r.claimedAt < now - 20000)
              .map(r => ({ ...r, status: 'unknown', errorCode: 'WORKER_INTERRUPTED' })),
            transaction
          );
          if (state.sendLease > now) return null;
          const queue = await this.s.rows('InventoryDelivery', {
            transaction,
            where: { 'body.status': 'pending' },
            order: [['createdAt', 'ASC']],
            limit: 500,
          });
          const snapshots = new Map(
            (await this.s.rows('InventorySnapshot', { transaction })).map(r => [r.id, r])
          );
          const products = new Set(
            (await this.s.rows('InventoryProduct', { transaction }))
              .filter(r => r.enabled)
              .map(r => r.sku)
          );
          const stores = new Set(
            (await this.s.rows('InventoryStore', { transaction }))
              .filter(r => r.enabled)
              .map(r => r.storeCode)
          );
          const roundIds = [
            ...new Set(
              queue
                .filter(r => r.kind === 'first')
                .map(r => r.rows?.[0]?.roundId)
                .filter(Boolean)
            ),
          ];
          const rounds = new Map(
            (roundIds.length
              ? await this.s.rows('InventoryRound', {
                transaction,
                where: { id: { [Op.in]: roundIds } },
              })
              : []
            ).map(r => [r.id, r])
          );
          const [guard] = await this.s.db.query(
            "SELECT body FROM inventory_validation_state WHERE id = 'inventory-validation'",
            { type: QueryTypes.SELECT, transaction }
          );
          const guardPaused = Boolean(
            guard?.body.pausedReason || guard?.body.cooldownUntil > now || guard?.body.recovering
          );
          const skipped = [];
          const eligible = [];
          for (const item of queue) {
            let reason = null;
            if (item.destinationId !== settings.destinationId || !settings.webhookCipher)
              reason = 'DESTINATION_CHANGED';
            else if (item.expiresAt <= now) reason = 'EXPIRED';
            else if (item.kind !== 'test' && !settings.config.notificationsEnabled)
              reason = 'NOTIFICATIONS_DISABLED';
            else if (
              item.rows?.some(
                row =>
                  displayStatus(
                    snapshots.get(`${row.sku}|${row.storeCode}`),
                    {
                      enabled: products.has(row.sku) && stores.has(row.storeCode),
                      paused: !settings.config.enabled || guardPaused,
                    },
                    now
                  ) !== 'in_stock'
              )
            )
              reason = 'INVENTORY_NO_LONGER_CURRENT';
            if (reason) {
              skipped.push({ ...item, status: 'skipped', errorCode: reason });
              continue;
            }
            if (item.notBefore > now || (item.kind !== 'test' && isSilent(settings.config, now)))
              continue;
            if (item.kind === 'first') {
              const round = rounds.get(item.rows[0].roundId);
              if (round && ['queued', 'running'].includes(round.status)) continue;
              item.partial = round?.status !== 'complete';
            }
            eligible.push(item);
          }
          await this.s.put('InventoryDelivery', skipped, transaction);
          const rate = (state.notificationRate || []).filter(r => r.at > now - 60000);
          state.notificationRate = rate;
          if (
            rate.filter(r => r.destinationId === settings.destinationId).length >= 18 ||
            !eligible.length
          )
            return null;
          const first = eligible[0];
          const batch = [];
          let content = `【${TITLES[first.kind]}】\n`;
          if (first.rows?.length)
            content += `城市：${first.rows[0].city}\n门店：Apple ${first.rows[0].storeName}\n`;
          for (const item of eligible) {
            if (
              item.kind !== first.kind ||
              (item.rows &&
                (item.rows[0].city !== first.rows?.[0].city ||
                  item.rows[0].storeCode !== first.rows?.[0].storeCode)) ||
              (!item.rows && batch.length)
            )
              continue;
            const line = item.rows
              ? item.rows
                .map(
                  r =>
                    `${r.model} · ${r.capacity} · ${r.color}：${r.quote || '检测到可取货'}（${new Date(r.observedAt).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}）`
                )
                .join('\n')
              : item.content;
            if (Buffer.byteLength(content + line, 'utf8') > 1600) break;
            content += `${line}\n`;
            batch.push(item);
          }
          if (first.partial) content += '本轮覆盖未完整，仅汇总当前有效结果。\n';
          const base = process.env.INVENTORY_PUBLIC_URL;
          if (base && /^https:\/\/[^\s?#]+$/.test(base))
            content += `详情（需登录）：${base.replace(/\/$/, '')}/inventory-monitor\n`;
          if (!batch.length) {
            await this.s.put(
              'InventoryDelivery',
              [{ ...first, status: 'failed', errorCode: 'TEXT_TOO_LONG' }],
              transaction
            );
            return null;
          }
          const batchId = randomUUID();
          await this.s.put(
            'InventoryDelivery',
            batch.map(r => ({
              ...r,
              status: 'sending',
              batchId,
              claimedAt: now,
              attempts: r.attempts + 1,
            })),
            transaction
          );
          rate.push({ at: now, destinationId: settings.destinationId });
          state.sendLease = now + 20000;
          return {
            ids: batch.map(r => r.id),
            batchId,
            webhookCipher: settings.webhookCipher,
            destinationId: settings.destinationId,
            content,
          };
        } catch (error) {
          throw inventoryFailure(error);
        }
      });
    } catch (error) {
      throw inventoryFailure(error);
    }
  }
  /** 已预占一次发送；超时/丢失回执一律未知，不能盲目重发。 */
  async tick() {
    try {
      const claim = await this.claim();
      if (!claim) return null;
      let result;
      try {
        result = await this.transport(decrypt(claim.webhookCipher), claim.content);
      } catch (_error) {
        result = { status: 'unknown', errorCode: 'TRANSPORT_UNKNOWN' };
      }
      return await this.s.locked(async ({ transaction, state, settings, now }) => {
        try {
          const rows = await this.s.rows('InventoryDelivery', {
            transaction,
            where: { id: { [Op.in]: claim.ids } },
          });
          const next = rows
            .filter(r => r.batchId === claim.batchId && r.status === 'sending')
            .map(r => {
              const retry =
                result.status === 'pending' &&
                r.attempts < 3 &&
                now + (result.retryMs || 10000) < r.expiresAt;
              return {
                ...r,
                status: retry ? 'pending' : result.status === 'pending' ? 'failed' : result.status,
                errorCode: result.errorCode || null,
                notBefore: retry ? now + (result.retryMs || 10000) : r.notBefore,
                sentAt: result.status === 'accepted' ? now : null,
              };
            });
          await this.s.put('InventoryDelivery', next, transaction);
          state.sendLease = 0;
          if (
            result.status === 'accepted' &&
            next.some(r => r.kind === 'test') &&
            settings.destinationId === claim.destinationId
          )
            settings.testedDestination = claim.destinationId;
          if (result.pause && settings.destinationId === claim.destinationId) {
            settings.config.notificationsEnabled = false;
            settings.version += 1;
          }
          return { count: next.length, status: result.status };
        } catch (error) {
          throw inventoryFailure(error);
        }
      });
    } catch (_error) {
      throw new Error('INVENTORY_NOTIFICATION_FAILED');
    }
  }
}
module.exports = InventoryNotifier;
