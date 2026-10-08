const crypto = require('crypto');
const { Client } = require('pg');

const MAX_SAMPLES = 20;
const MAX_ORDER_ID = 2147483647;

/** 精确读取已选订单链接及账号摘要，绝不查询或解密密码；stdout 仅可写入私密文件。 */
async function readLinkInputs(client, ids) {
  let started = false;
  try {
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      ids.length > MAX_SAMPLES ||
      new Set(ids).size !== ids.length ||
      ids.some(id => !Number.isSafeInteger(id) || id < 1 || id > MAX_ORDER_ID)
    ) {
      throw new Error('ORDER_IDS_INVALID');
    }
    await client.query('BEGIN READ ONLY');
    started = true;
    await client.query("SET LOCAL statement_timeout='8s'");
    const { rows } = await client.query(
      `SELECT o.id,o.order_number AS "orderNumber",o.order_url AS url,
         lower(btrim(o.apple_id)) AS account,md5(to_jsonb(o)::text) AS "rowHash"
       FROM orders o WHERE o.id=ANY($1::int[]) ORDER BY o.id`,
      [ids]
    );
    if (rows.length !== ids.length) throw new Error('ORDER_NOT_FOUND');
    return {
      capturedAt: new Date().toISOString(),
      samples: rows.map(row => ({
        id: row.id,
        orderNumber: row.orderNumber,
        url: row.url,
        accountHash: crypto
          .createHash('sha256')
          .update(row.account || `guest-order:${row.orderNumber}`)
          .digest('hex'),
        beforeRowHash: row.rowHash,
      })),
    };
  } catch (error) {
    error.component = 'officialOrderLinkInput';
    throw error;
  } finally {
    if (started) await client.query('ROLLBACK');
  }
}

/** 服务器 API 容器的只读输入入口；不加载模型或启动 Worker。 */
async function main() {
  let client;
  try {
    const value = process.env.OFFICIAL_ORDER_IDS || '';
    if (!/^[1-9]\d*(?:,[1-9]\d*)*$/.test(value)) throw new Error('ORDER_IDS_INVALID');
    client = new Client({
      host: process.env.DB_HOST,
      port: process.env.DB_PORT,
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      connectionTimeoutMillis: 10000,
    });
    await client.connect();
    process.stdout.write(
      JSON.stringify(await readLinkInputs(client, value.split(',').map(Number)))
    );
  } catch (error) {
    const code = ['ORDER_IDS_INVALID', 'ORDER_NOT_FOUND'].includes(error.message)
      ? error.message
      : 'LINK_INPUT_READ_FAILED';
    process.stderr.write(`${JSON.stringify({ outcome: code, stage: 'input' })}\n`);
    process.exitCode = 1;
  } finally {
    if (client) await client.end().catch(() => {});
  }
}

if (require.main === module || process.argv[1] === '-') main();
module.exports = { readLinkInputs };
