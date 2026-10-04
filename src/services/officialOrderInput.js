const { decrypt } = require('../utils/fieldEncryption');
const { fault, hash, validateSample } = require('./officialOrderSupport');

const MAX_ORDER_ID = 2147483647;
const INPUT_ERROR_CODES = new Set([
  'ORDER_ID_INVALID',
  'ORDER_NOT_FOUND',
  'ACCOUNT_ID_MISSING',
  'ACCOUNT_REFERENCE_CONFLICT',
  'ORDER_ACCOUNT_AMBIGUOUS',
  'ACCOUNT_MARKED_INVALID',
  'ORDER_CREDENTIALS_MISSING',
  'CREDENTIAL_DECRYPT_FAILED',
  'CREDENTIAL_SNAPSHOT_MISMATCH',
  'INPUT_INVALID',
  'LINK_IDENTITY_MISMATCH',
  'DESTINATION_DENIED',
]);

function normalizeAccount(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function readPassword(value, decryptValue) {
  if (typeof value !== 'string' || !value) throw fault('ORDER_CREDENTIALS_MISSING');
  let password;
  try {
    password = decryptValue(value);
  } catch (_error) {
    throw fault('CREDENTIAL_DECRYPT_FAILED');
  }
  if (typeof password !== 'string' || !password) throw fault('ORDER_CREDENTIALS_MISSING');
  return password;
}

/** 根据订单快照与候选账号构造私密输入；不推断或变更账号身份。 */
function buildOfficialOrderInput(row, decryptValue = decrypt) {
  if (!row) throw fault('ORDER_NOT_FOUND');
  const account = normalizeAccount(row.apple_id);
  if (!account) throw fault('ACCOUNT_ID_MISSING');
  const candidates = row.account_candidates || [];
  const matches = candidates.filter(candidate => normalizeAccount(candidate.apple_id) === account);
  if (row.apple_id_ref !== null && row.apple_id_ref !== undefined) {
    const referenced = candidates.find(candidate => candidate.id === row.apple_id_ref);
    if (!referenced || normalizeAccount(referenced.apple_id) !== account)
      throw fault('ACCOUNT_REFERENCE_CONFLICT');
  }
  if (matches.length > 1) throw fault('ORDER_ACCOUNT_AMBIGUOUS');
  const registryAccount = matches[0];
  if (registryAccount?.status === '异常') throw fault('ACCOUNT_MARKED_INVALID');
  const password = readPassword(
    registryAccount ? registryAccount.password : row.apple_password,
    decryptValue
  );
  let snapshotPasswordMatches = null;
  if (registryAccount && row.apple_password) {
    snapshotPasswordMatches = readPassword(row.apple_password, decryptValue) === password;
    if (!snapshotPasswordMatches) throw fault('CREDENTIAL_SNAPSHOT_MISMATCH');
  }
  return validateSample({
    id: row.id,
    orderNumber: row.order_number,
    url: row.order_url,
    email: row.apple_id.trim(),
    password,
    beforeRowHash: row.row_hash,
    accountHash: hash(account),
    snapshotPasswordMatches,
    credentialSource: registryAccount ? 'accountRegistry' : 'orderSnapshot',
  });
}

/** 已连接客户端上的单订单只读事务；外部标识只通过参数绑定进入 SQL。 */
async function readOfficialOrderInput(client, rawOrderId) {
  let started = false;
  try {
    const id = Number(rawOrderId);
    if (!/^[1-9]\d*$/.test(String(rawOrderId)) || !Number.isSafeInteger(id) || id > MAX_ORDER_ID)
      throw fault('ORDER_ID_INVALID');
    await client.query('BEGIN READ ONLY');
    started = true;
    await client.query("SET LOCAL statement_timeout='8s'");
    const { rows } = await client.query(
      `SELECT o.id,o.order_number,o.order_url,o.apple_id,o.apple_password,o.apple_id_ref,
        md5(to_jsonb(o)::text) AS row_hash,
        (SELECT COALESCE(json_agg(candidate),'[]'::json) FROM (
          SELECT a.id,a.apple_id,a.password,a.status FROM apple_ids a
          WHERE a.id=o.apple_id_ref OR lower(btrim(a.apple_id))=lower(btrim(o.apple_id))
          ORDER BY a.id LIMIT 3
        ) candidate) AS account_candidates
       FROM orders o WHERE o.id=$1`,
      [id]
    );
    return buildOfficialOrderInput(rows[0]);
  } catch (error) {
    error.component = 'officialOrderInput';
    throw error;
  } finally {
    if (started) await client.query('ROLLBACK');
  }
}

/** 只向外传递固定输入错误码；屏蔽原始数据库或解密异常。 */
function officialInputErrorCode(error) {
  return INPUT_ERROR_CODES.has(error?.code) ? error.code : 'ORDER_INPUT_READ_FAILED';
}

module.exports = { buildOfficialOrderInput, readOfficialOrderInput, officialInputErrorCode };
