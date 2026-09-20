const { dkimVerify } = require('mailauth/lib/dkim/verify');

const APPLE_SIGNING_DOMAINS = Object.freeze(['apple.com', 'apple.com.cn']);

/** 判断域名是否等于或属于允许域的子域。 */
function domainMatches(domain, allowed) {
  const normalized = String(domain || '').toLowerCase();
  return allowed.some(value => normalized === value || normalized.endsWith(`.${value}`));
}

/**
 * 对原始 MIME 执行服务端 DKIM 验证；仅签名存在或 From 白名单不算通过。
 * @param {Buffer} rawBuffer 原始 MIME
 * @param {Object} parsed mailparser 结果
 * @param {Object} options 验证依赖与域名范围
 * @returns {Promise<Object>} 受控认证结论
 */
async function verifyOrderMailAuthenticity(
  rawBuffer,
  parsed,
  { senderDomains = APPLE_SIGNING_DOMAINS, verifier = dkimVerify } = {}
) {
  const fromAddresses = parsed.from?.value || [];
  const fromDomain = String(fromAddresses[0]?.address || '')
    .toLowerCase()
    .split('@')[1];
  if (
    fromAddresses.length !== 1 ||
    !domainMatches(fromDomain, senderDomains) ||
    !domainMatches(fromDomain, APPLE_SIGNING_DOMAINS)
  ) {
    return { status: 'failed', reason: 'SENDER_NOT_ALLOWED', evidence: {} };
  }

  let verified;
  try {
    verified = await verifier(rawBuffer);
  } catch (error) {
    const temporary = ['ETIMEOUT', 'ESERVFAIL', 'EREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(
      error.code
    );
    return {
      status: temporary ? 'temporary_failure' : 'failed',
      reason: temporary ? 'DKIM_TEMPORARY' : 'DKIM_VERIFY_FAILED',
      evidence: {},
    };
  }

  const results = Array.isArray(verified?.results) ? verified.results : [];
  const passed = results.find(
    result =>
      result.status?.result === 'pass' &&
      result.signatureTimeValid !== false &&
      !result.status?.underSized &&
      domainMatches(result.signingDomain, senderDomains) &&
      domainMatches(result.signingDomain, APPLE_SIGNING_DOMAINS)
  );
  if (passed) {
    return {
      status: 'verified',
      reason: null,
      evidence: {
        method: 'dkim',
        signingDomain: passed.signingDomain,
        selector: passed.selector,
        algorithm: passed.algo,
      },
    };
  }
  const temporary = results.some(result => ['temperror', 'policy'].includes(result.status?.result));
  return {
    status: temporary ? 'temporary_failure' : 'failed',
    reason: temporary ? 'DKIM_TEMPORARY' : 'DKIM_NOT_VERIFIED',
    evidence: {},
  };
}

module.exports = { APPLE_SIGNING_DOMAINS, domainMatches, verifyOrderMailAuthenticity };
