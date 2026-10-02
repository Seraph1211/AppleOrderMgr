const { randomUUID, randomInt } = require('crypto');
const { QueryTypes } = require('sequelize');
const { reserveBudget, settleBudget } = require('./inventoryValidationPolicy');
const { reserveProduction, settleProduction } = require('./inventoryGuardPolicy');
const { DEFAULT_CONFIG } = require('./inventoryPolicy');

/** 跨进程验证请求闸门，预占计数和请求证据必须原子提交。 */
class InventoryValidationGate {
  constructor(sequelize, options = {}) {
    this.db = sequelize;
    this.production = Boolean(options.production);
  }

  /** 锁住唯一状态行并使用数据库时钟。 */
  async locked(work) {
    try {
      return await this.db.transaction(async transaction => {
        try {
          const rows = await this.db.query(
            "SELECT body, clock_timestamp() AS now FROM inventory_validation_state WHERE id = 'inventory-validation' FOR UPDATE",
            { type: QueryTypes.SELECT, transaction }
          );
          if (rows.length !== 1) throw new Error('VALIDATION_MIGRATION_REQUIRED');
          return await work(rows[0].body, new Date(rows[0].now).getTime(), transaction);
        } catch (error) {
          throw new Error('VALIDATION_STORAGE_FAILED', { cause: error });
        }
      });
    } catch (error) {
      throw new Error('VALIDATION_STORAGE_FAILED', { cause: error });
    }
  }

  /** 保存整个受锁定状态，不重置预算。 */
  async save(state, transaction) {
    try {
      await this.db.query(
        "UPDATE inventory_validation_state SET body = CAST(:body AS jsonb), updated_at = clock_timestamp() WHERE id = 'inventory-validation'",
        { replacements: { body: JSON.stringify(state) }, transaction }
      );
    } catch (error) {
      throw new Error('VALIDATION_STORAGE_FAILED', { cause: error });
    }
  }

  /** 每次网络请求前调用；未返回 id 就不得发起请求。 */
  async reserve(purpose, egress, context) {
    try {
      const id = randomUUID();
      return await this.locked(async (original, now, transaction) => {
        try {
          let result;
          if (this.production) {
            const [setting] = await this.db.query(
              "SELECT body FROM inventory_settings WHERE id = 'main'",
              { type: QueryTypes.SELECT, transaction }
            );
            result = reserveProduction(original, now, id, randomInt(151), egress, purpose, {
              ...DEFAULT_CONFIG,
              ...setting?.body.config,
            });
          } else {
            result = reserveBudget(original, now, id, randomInt(151), egress);
          }
          if (!result.state) return result;
          await this.save(result.state, transaction);
          await this.db.query(
            'INSERT INTO inventory_validation_attempts (id, purpose, egress, context, started_at) VALUES (:id, :purpose, :egress, CAST(:context AS jsonb), clock_timestamp())',
            { replacements: { id, purpose, egress, context: JSON.stringify(context) }, transaction }
          );
          return { id };
        } catch (error) {
          throw new Error('VALIDATION_STORAGE_FAILED', { cause: error });
        }
      });
    } catch (error) {
      throw new Error('VALIDATION_STORAGE_FAILED', { cause: error });
    }
  }

  /** 保存脱敏结果与保护状态；网络失败仍消耗预算。 */
  async finish(result) {
    try {
      await this.locked(async (original, now, transaction) => {
        try {
          const [finished] = await this.db.query(
            'UPDATE inventory_validation_attempts SET finished_at = clock_timestamp(), outcome = :outcome, http_status = :status, duration_ms = :durationMs, response_bytes = :bytes, summary = CAST(:summary AS jsonb) WHERE id = :id AND finished_at IS NULL RETURNING id, purpose',
            {
              replacements: {
                id: result.id,
                outcome: result.outcome,
                status: result.status || null,
                durationMs: result.durationMs,
                bytes: result.bytes || 0,
                summary: JSON.stringify(result.summary || {}),
              },
              transaction,
            }
          );
          if (finished.length) {
            const settle = this.production ? settleProduction : settleBudget;
            await this.save(
              settle(original, { ...result, purpose: finished[0].purpose }, now),
              transaction
            );
          }
        } catch (error) {
          throw new Error('VALIDATION_STORAGE_FAILED', { cause: error });
        }
      });
    } catch (error) {
      throw new Error('VALIDATION_STORAGE_FAILED', { cause: error });
    }
  }
}
module.exports = InventoryValidationGate;
