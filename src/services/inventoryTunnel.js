const { randomUUID } = require('crypto');
const { encrypt, decrypt } = require('../utils/fieldEncryption');
const {
  rotateTunnel,
  tunnelFingerprint,
  settleProviderFailure,
} = require('./inventoryTunnelPolicy');
const { requestOnce } = require('./inventoryValidationClient');

const MAX_ROTATIONS = 3;
const PROBE_LEASE_MS = 45000;

/** 将已知保护原因传给调度，不携带凭据或网络异常。 */
function blocked(outcome, until) {
  const error = new Error('TUNNEL_NOT_READY');
  error.inventoryOutcome = outcome;
  error.until = until || null;
  throw error;
}

/** 持久化隧道会话及实际出口验证；供应商风险身份保持不变。 */
class InventoryTunnel {
  constructor(gate) {
    this.gate = gate;
  }

  /** 在数据库锁内领取唯一候选探测，重启复用候选，不重复申请。 */
  async claim(proxy) {
    try {
      return await this.gate.locked(async (body, now, transaction) => {
        try {
          if (body.pausedReason) return { blocked: body.pausedReason };
          if (body.pausedEgress?.[proxy.label]) return { blocked: body.pausedEgress[proxy.label] };
          if (proxy.tunnel.expiresAt !== null && proxy.tunnel.expiresAt <= now) {
            body.pausedReason = 'PROXY_PACKAGE_EXPIRED';
            await this.gate.save(body, transaction);
            return { blocked: body.pausedReason };
          }
          if (body.cooldownUntil > now)
            return { blocked: 'TARGET_COOLDOWN', until: body.cooldownUntil };
          if (body.providerCooldownUntil > now)
            return { blocked: 'PROXY_PROVIDER_COOLDOWN', until: body.providerCooldownUntil };
          const configHash = tunnelFingerprint(proxy);
          let tunnel = body.tunnel?.label === proxy.label ? { ...body.tunnel } : {};
          const resumeEpoch = body.resumedAt || 0;
          if (tunnel.token && tunnel.resumeEpoch === undefined) {
            tunnel.resumeEpoch = resumeEpoch;
            body.tunnel = tunnel;
            await this.gate.save(body, transaction);
          }
          if (tunnel.token && resumeEpoch > tunnel.resumeEpoch)
            tunnel = { ...tunnel, verified: false, expiresAt: 0, rotationAttempts: 0 };
          const rejected = tunnel.rejectedHashes || [];
          const needsAlternate = body.requiredAlternateEgress === proxy.label;
          if (
            tunnel.configHash === configHash &&
            tunnel.verified &&
            tunnel.expiresAt > now + 30000 &&
            (!needsAlternate || !rejected.includes(tunnel.exitHash))
          )
            return { proxy: { label: proxy.label, url: decrypt(tunnel.cipher) } };
          const active = Object.values(body.requestLeases || {}).filter(x => x.until > now);
          const busy = Math.max(body.leaseUntil || 0, ...active.map(x => x.until));
          if (busy > now) return { blocked: 'REQUEST_IN_FLIGHT', until: busy };
          if (
            tunnel.configHash !== configHash ||
            tunnel.verified ||
            !tunnel.token ||
            tunnel.expiresAt <= now
          ) {
            // 旧版本没有实际出口摘要，先测原会话，禁止通过改名直接绕过。
            const baseline = needsAlternate && !rejected.length && !tunnel.exitHash;
            if (!baseline && (tunnel.rotationAttempts || 0) >= MAX_ROTATIONS) {
              body.pausedReason = 'RECOVERY_EXHAUSTED';
              await this.gate.save(body, transaction);
              return { blocked: body.pausedReason };
            }
            tunnel = {
              label: proxy.label,
              configHash,
              token: randomUUID(),
              cipher: encrypt(rotateTunnel(proxy.url)),
              expiresAt: Math.min(
                proxy.tunnel.expiresAt ?? Infinity,
                now + proxy.tunnel.stickySeconds * 1000
              ),
              packageExpiresAt: proxy.tunnel.expiresAt,
              resumeEpoch,
              baseline,
              verified: false,
              exitHash: null,
              rejectedHashes: rejected,
              rotationAttempts: (tunnel.rotationAttempts || 0) + (baseline ? 0 : 1),
              probeUntil: 0,
            };
          }
          if (tunnel.probeUntil > now)
            return { blocked: 'REQUEST_IN_FLIGHT', until: tunnel.probeUntil };
          tunnel.probeUntil = now + PROBE_LEASE_MS;
          body.tunnel = tunnel;
          await this.gate.save(body, transaction);
          return { ...tunnel, epoch: Math.max(body.recoveryEpoch || 0, resumeEpoch) };
        } catch (_error) {
          throw new Error('TUNNEL_STATE_FAILED');
        }
      });
    } catch (_error) {
      throw new Error('TUNNEL_STATE_FAILED');
    }
  }

  /** 令牌匹配才应用回显结果；仅实际库存成功能解除恢复。 */
  async settle(claim, result) {
    try {
      return await this.gate.locked(async (body, now, transaction) => {
        try {
          const tunnel = body.tunnel;
          if (!tunnel || tunnel.token !== claim.token) return { blocked: 'REQUEST_IN_FLIGHT' };
          tunnel.probeUntil = 0;
          if (body.pausedEgress?.[tunnel.label])
            return { blocked: body.pausedEgress[tunnel.label] };
          if (
            body.pausedReason ||
            (tunnel.packageExpiresAt !== null && tunnel.packageExpiresAt <= now)
          ) {
            if (!body.pausedReason) body.pausedReason = 'PROXY_PACKAGE_EXPIRED';
            await this.gate.save(body, transaction);
            return { blocked: body.pausedReason };
          }
          if (tunnel.expiresAt <= now) {
            await this.gate.save(body, transaction);
            return { blocked: 'REQUEST_IN_FLIGHT' };
          }
          if (Math.max(body.recoveryEpoch || 0, body.resumedAt || 0) !== claim.epoch) {
            await this.gate.save(body, transaction);
            return { blocked: 'REQUEST_IN_FLIGHT' };
          }
          if (!result.id && !result.uncertain) {
            await this.gate.save(body, transaction);
            return { blocked: result.outcome, until: result.until };
          }
          const hash = result.summary?.egressHash;
          if (
            result.outcome === 'PROXY_CONNECTED' &&
            /^[a-f0-9]{64}$/.test(hash || '') &&
            claim.baseline
          ) {
            tunnel.rejectedHashes = [...new Set([...tunnel.rejectedHashes, hash])].slice(-20);
            tunnel.expiresAt = 0;
            await this.gate.save(body, transaction);
            return { blocked: 'REQUEST_IN_FLIGHT', until: now + 1000 };
          }
          if (
            result.outcome === 'PROXY_CONNECTED' &&
            /^[a-f0-9]{64}$/.test(hash || '') &&
            !tunnel.rejectedHashes.includes(hash)
          ) {
            tunnel.exitHash = hash;
            tunnel.verified = true;
            if (!body.recovering) tunnel.rotationAttempts = 0;
            await this.gate.save(body, transaction);
            return { proxy: { label: tunnel.label, url: decrypt(tunnel.cipher) } };
          }
          tunnel.expiresAt = 0;
          if (['PROXY_AUTH_FAILED', 'PROXY_CONNECT_REJECTED'].includes(result.outcome)) {
            body.pausedEgress = { ...body.pausedEgress, [tunnel.label]: result.outcome };
            await this.gate.save(body, transaction);
            return { blocked: result.outcome };
          }
          if (result.outcome !== 'PROXY_CONNECTED') {
            const next = settleProviderFailure(body, now, tunnel.label);
            await this.gate.save(next, transaction);
            return {
              blocked: next.pausedEgress?.[tunnel.label] || 'PROXY_PROVIDER_COOLDOWN',
              until: next.providerCooldownUntil,
            };
          }
          body.recovering = true;
          body.recoverySuccesses = 0;
          body.recoveryFailures = (body.recoveryFailures || 0) + 1;
          body.recoveryEpoch = now;
          body.cooldownUntil = Math.max(
            body.cooldownUntil || 0,
            now + (body.recoveryFailures === 1 ? 1200000 : 2400000)
          );
          if (body.recoveryFailures >= MAX_ROTATIONS) body.pausedReason = 'RECOVERY_EXHAUSTED';
          await this.gate.save(body, transaction);
          return {
            blocked: body.pausedReason || 'TARGET_COOLDOWN',
            until: body.cooldownUntil,
          };
        } catch (_error) {
          throw new Error('TUNNEL_STATE_FAILED');
        }
      });
    } catch (_error) {
      throw new Error('TUNNEL_STATE_FAILED');
    }
  }

  /** 获取经实际出口验证的隧道，探测请求也经过持久化预算。 */
  async select(proxy) {
    try {
      const claim = await this.claim(proxy);
      if (claim.blocked) blocked(claim.blocked, claim.until);
      if (claim.proxy) return claim.proxy;
      let result;
      try {
        result = await requestOnce({
          purpose: 'egress',
          context: {},
          proxy: { label: proxy.label, url: decrypt(claim.cipher) },
          gate: this.gate,
        });
      } catch (_error) {
        // 不退还请求预算；未知结果计入有限失败，不能无限重复探测。
        result = { outcome: 'TRANSPORT_UNKNOWN', uncertain: true };
      }
      const selected = await this.settle(claim, result);
      if (selected.blocked) blocked(selected.blocked, selected.until);
      return selected.proxy;
    } catch (error) {
      if (error.inventoryOutcome) throw error;
      throw new Error('TUNNEL_STATE_FAILED');
    }
  }
}

module.exports = InventoryTunnel;
