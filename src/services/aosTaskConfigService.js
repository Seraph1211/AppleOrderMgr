const { randomUUID } = require('crypto');
const { Op } = require('sequelize');
const defaultModels = require('../models');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const policy = require('./aosTaskConfigPolicy');

const PREVIEW_TTL_MS = 15 * 60000;
const VERSION_LIMIT = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const plain = row => (row?.toJSON ? row.toJSON() : row);
const conflict = () => new ApiError(409, 'TASK_CONFIG_CHANGED', '任务配置已更新，请刷新后重新预览');
const uuid = value => {
  if (typeof value !== 'string' || !UUID.test(value))
    throw ApiError.badRequest('实例或版本标识无效');
  return value;
};
const validActor = actorId => {
  if (!Number.isSafeInteger(actorId) || actorId <= 0) throw ApiError.badRequest('操作用户无效');
};
const revisionOf = body => {
  if (!Number.isSafeInteger(body?.expectedRevision) || body.expectedRevision < 0)
    throw ApiError.badRequest('缺少有效配置修订号');
  return body.expectedRevision;
};
const versionDto = (row, details = true) => {
  if (!row) return null;
  const value = { ...plain(row) };
  delete value.contentHash;
  delete value.instanceId;
  if (!details) {
    delete value.rows;
    delete value.aggregates;
  }
  return value;
};
function instanceDto(instance, device, head, version) {
  return {
    instanceId: instance.id,
    deviceId: instance.deviceId,
    localId: instance.localId,
    serverName: device?.name || '未知服务器',
    instanceName: instance.label,
    active: Boolean(instance.active && device?.enabled),
    revision: head?.revision || 0,
    status: !head?.currentVersionId ? 'missing' : head.invalidatedAt ? 'invalidated' : 'active',
    currentVersionId: head?.currentVersionId || null,
    currentVersionNumber: version?.number || null,
    taskCount: version?.taskCount || 0,
    cityCount: version?.cityCount || 0,
    specCount: version?.specCount || 0,
    effectiveAt: version?.effectiveAt || null,
    lastConfirmedAt: head?.lastConfirmedAt || null,
    updatedAt: head?.updatedAt || null,
  };
}
function effectiveTime(value, current, now) {
  if (
    value != null &&
    (typeof value !== 'string' ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(value))
  )
    throw ApiError.badRequest('生效时间必须是含时区的 ISO 时间');
  if (value != null) {
    const [year, month, day] = value.slice(0, 10).split('-').map(Number);
    const [hour, minute, second = '0'] = value.slice(11).split(/[:Z+-]/);
    if (
      month < 1 ||
      month > 12 ||
      day < 1 ||
      day > new Date(Date.UTC(year, month, 0)).getUTCDate() ||
      Number(hour) > 23 ||
      Number(minute) > 59 ||
      Number(second) >= 60
    )
      throw ApiError.badRequest('生效时间包含无效日期或时刻');
  }
  const time = value == null ? now : new Date(value);
  if (!Number.isFinite(+time) || +time > +now)
    throw ApiError.badRequest('生效时间无效或晚于当前时间');
  const lower = current?.effectiveTo || current?.effectiveAt;
  if (lower && +time <= +new Date(lower))
    throw ApiError.badRequest('新版本生效时间必须晚于上一版本边界');
  return time;
}

/** 创建任务配置服务；注入模型用于独立数据库验收。 @param {Object} models 模型集合 @returns {Object} 服务方法 */
function createService(models = defaultModels) {
  const {
    sequelize,
    MonitorInstance: Instance,
    AosDevice: Device,
    AosTaskConfig: Head,
    AosTaskConfigVersion: Version,
    AosTaskConfigPreview: Preview,
  } = models;
  function guarded(work) {
    return async function taskConfigOperation(...args) {
      try {
        return await work(...args);
      } catch (error) {
        logger.debug('任务配置操作未完成', { errorCode: error.code || error.name });
        throw error;
      }
    };
  }
  const load = async (instanceId, transaction, writable = false) => {
    const instance = await Instance.findByPk(uuid(instanceId), {
      transaction,
      ...(writable ? { lock: transaction.LOCK.UPDATE } : {}),
    });
    if (!instance) throw ApiError.notFound('实例不存在');
    const device = await Device.findByPk(instance.deviceId, {
      attributes: ['id', 'name', 'enabled'],
      transaction,
    });
    if (writable && (!instance.active || !device?.enabled))
      throw new ApiError(409, 'TASK_INSTANCE_INACTIVE', '实例或服务器已停用，不能更新配置');
    const head = await Head.findByPk(instanceId, { transaction });
    const version = head?.currentVersionId
      ? await Version.findByPk(head.currentVersionId, { transaction })
      : null;
    return { instance, device, head, version };
  };
  const dto = state => ({
    instance: instanceDto(state.instance, state.device, state.head, state.version),
    currentVersion: versionDto(state.version),
  });
  const ensureHead = async (state, transaction) => {
    if (!state.head)
      state.head = await Head.create(
        { instanceId: state.instance.id, revision: 0 },
        { transaction }
      );
    return state.head;
  };
  const apply = async (state, payload, actorId, body, source, restoredFromId, transaction) => {
    validActor(actorId);
    const head = await ensureHead(state, transaction);
    if (head.revision !== revisionOf(body)) throw conflict();
    const now = new Date();
    const time = effectiveTime(body.effectiveAt, state.version, now);
    if (
      source === 'import' &&
      state.version?.contentHash === payload.contentHash &&
      !head.invalidatedAt
    ) {
      await head.update(
        { revision: head.revision + 1, lastConfirmedAt: now, lastActorId: actorId },
        { transaction }
      );
      return { ...dto(state), unchanged: true };
    }
    if (state.version && !state.version.effectiveTo)
      await state.version.update({ effectiveTo: time }, { transaction });
    const aggregates = policy.aggregate(payload.rows);
    const version = await Version.create(
      {
        id: randomUUID(),
        instanceId: state.instance.id,
        number: (state.version?.number || 0) + 1,
        effectiveAt: time,
        actorId,
        source,
        restoredFromId: restoredFromId || null,
        contentHash: payload.contentHash,
        rows: payload.rows,
        aggregates,
        taskCount: payload.rows.length,
        cityCount: new Set(aggregates.map(row => row.city)).size,
        specCount: new Set(
          aggregates.map(row => policy.digest([row.model, row.color, row.capacity]))
        ).size,
        blankLineCount: payload.blankLineCount,
      },
      { transaction }
    );
    await head.update(
      {
        revision: head.revision + 1,
        currentVersionId: version.id,
        lastConfirmedAt: now,
        invalidatedAt: null,
        lastActorId: actorId,
      },
      { transaction }
    );
    state.version = version;
    return { ...dto(state), unchanged: false };
  };
  return {
    list: guarded(async () => {
      const instances = await Instance.findAll({
        order: [
          ['label', 'ASC'],
          ['id', 'ASC'],
        ],
        limit: 1001,
      });
      if (instances.length > 1000)
        throw new ApiError(
          422,
          'TASK_INSTANCE_LIMIT',
          '实例数量超过1000，暂不支持完整展示；未返回部分统计，请联系管理员处理'
        );
      if (!instances.length) return { items: [] };
      const instanceIds = instances.map(row => row.id);
      const deviceIds = [...new Set(instances.map(row => row.deviceId))];
      const [devices, heads] = await Promise.all([
        Device.findAll({
          where: { id: { [Op.in]: deviceIds } },
          attributes: ['id', 'name', 'enabled'],
        }),
        Head.findAll({ where: { instanceId: { [Op.in]: instanceIds } } }),
      ]);
      const ids = heads.map(head => head.currentVersionId).filter(Boolean);
      let versions = [];
      if (ids.length)
        versions = await Version.findAll({
          where: { id: { [Op.in]: ids } },
          attributes: { exclude: ['rows', 'aggregates'] },
        });
      const deviceMap = new Map(devices.map(row => [row.id, row]));
      const headMap = new Map(heads.map(row => [row.instanceId, row]));
      const versionMap = new Map(versions.map(row => [row.id, row]));
      return {
        items: instances.map(instance =>
          instanceDto(
            instance,
            deviceMap.get(instance.deviceId),
            headMap.get(instance.id),
            versionMap.get(headMap.get(instance.id)?.currentVersionId)
          )
        ),
      };
    }),
    detail: guarded(async instanceId => dto(await load(instanceId))),
    versions: guarded(async instanceId => {
      await load(instanceId);
      const items = await Version.findAll({
        where: { instanceId },
        order: [['number', 'DESC']],
        limit: VERSION_LIMIT,
        attributes: { exclude: ['rows', 'aggregates'] },
      });
      return { items: items.map(row => versionDto(row, false)), limit: VERSION_LIMIT };
    }),
    version: guarded(async (instanceId, versionId) => {
      await load(instanceId);
      const version = await Version.findOne({ where: { id: uuid(versionId), instanceId } });
      if (!version) throw ApiError.notFound('配置版本不存在');
      return { version: versionDto(version) };
    }),
    preview: guarded(async (actorId, instanceId, body) => {
      validActor(actorId);
      const parsed = policy.parse(body?.text);
      return await sequelize.transaction(async transaction => {
        const state = await load(instanceId, transaction, true);
        const expectedRevision = state.head?.revision || 0;
        const expiresAt = new Date(Date.now() + PREVIEW_TTL_MS);
        const result = { ...parsed };
        delete result.rows;
        delete result.contentHash;
        const diff = policy.differences(state.version?.aggregates || [], parsed.aggregates);
        if (!parsed.valid)
          return { ...result, diff, previewId: null, expectedRevision, expiresAt: null };
        const old = await Preview.findAll({
          where: { [Op.or]: [{ expiresAt: { [Op.lt]: new Date() } }, { instanceId, actorId }] },
          attributes: ['id'],
          limit: 1000,
          transaction,
        });
        if (old.length)
          await Preview.destroy({
            where: { id: { [Op.in]: old.map(row => row.id) } },
            transaction,
          });
        const preview = await Preview.create(
          { id: randomUUID(), instanceId, actorId, expectedRevision, expiresAt, payload: parsed },
          { transaction }
        );
        return { ...result, diff, previewId: preview.id, expectedRevision, expiresAt };
      });
    }),
    activate: guarded((actorId, instanceId, body) =>
      sequelize.transaction(async transaction => {
        const state = await load(instanceId, transaction, true);
        const preview = await Preview.findOne({
          where: { id: uuid(body?.previewId), instanceId, actorId },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (!preview || +new Date(preview.expiresAt) <= Date.now())
          throw new ApiError(409, 'TASK_PREVIEW_EXPIRED', '预览已失效，请重新解析配置');
        if (
          preview.expectedRevision !== revisionOf(body) ||
          (state.head?.revision || 0) !== body.expectedRevision
        )
          throw conflict();
        const result = await apply(
          state,
          preview.payload,
          actorId,
          body,
          'import',
          null,
          transaction
        );
        await preview.destroy({ transaction });
        return result;
      })
    ),
    confirm: guarded((actorId, instanceId, body) =>
      sequelize.transaction(async transaction => {
        validActor(actorId);
        const state = await load(instanceId, transaction, true);
        if ((state.head?.revision || 0) !== revisionOf(body)) throw conflict();
        if (!state.version || state.head.invalidatedAt)
          throw ApiError.badRequest('请先导入并启用有效配置');
        await state.head.update(
          { revision: state.head.revision + 1, lastConfirmedAt: new Date(), lastActorId: actorId },
          { transaction }
        );
        return dto(state);
      })
    ),
    invalidate: guarded((actorId, instanceId, body) =>
      sequelize.transaction(async transaction => {
        validActor(actorId);
        const state = await load(instanceId, transaction, true);
        if ((state.head?.revision || 0) !== revisionOf(body)) throw conflict();
        if (!state.version) throw ApiError.badRequest('该实例尚未导入任务配置');
        if (!state.head.invalidatedAt) {
          const now = new Date();
          await state.version.update({ effectiveTo: now }, { transaction });
          await state.head.update(
            { revision: state.head.revision + 1, invalidatedAt: now, lastActorId: actorId },
            { transaction }
          );
        }
        return dto(state);
      })
    ),
    restore: guarded((actorId, instanceId, body) =>
      sequelize.transaction(async transaction => {
        const state = await load(instanceId, transaction, true);
        const version = await Version.findOne({
          where: { id: uuid(body?.versionId), instanceId },
          transaction,
        });
        if (!version) throw ApiError.notFound('配置版本不存在');
        return apply(state, plain(version), actorId, body, 'restore', version.id, transaction);
      })
    ),
  };
}

module.exports = { createService, ...createService() };
