/* eslint-disable camelcase */
/**
 * 管理员邮件处理 API。
 * @module controllers/emailProcessingController
 */

const { Op, literal } = require('sequelize');

const { EmailLog, Order, User } = require('../models');
const { EMAIL_PROCESSING_STATUSES } = require('../constants/business');
const ApiError = require('../utils/ApiError');
const { paginatedResponse, parsePositiveInt, successResponse } = require('../utils/apiResponse');
const logger = require('../utils/logger');
const emailProcessingService = require('../services/emailProcessingService');
const { EmailProcessingError, EMAIL_ERROR_CODES } = require('../services/emailErrors');

function toApiError(error) {
  if (!(error instanceof EmailProcessingError)) {
    return error;
  }
  if (error.code === EMAIL_ERROR_CODES.CONCURRENT_MODIFICATION) {
    return ApiError.conflict(error.message, undefined, error.code);
  }
  if (error.code === EMAIL_ERROR_CODES.INVALID_STATE) {
    return ApiError.conflict(error.message, undefined, error.code);
  }
  return ApiError.badRequest(error.message, undefined, error.code);
}

function serializeRecord(record, includeDetails = false) {
  const plain = record.toJSON();
  const result = {
    id: plain.id,
    status: plain.status,
    received_at: plain.receivedAt,
    email_subject: plain.emailSubject,
    email_from: plain.emailFrom,
    email_date: plain.emailDate,
    message_id: plain.messageId,
    authentication_results: plain.authenticationResults,
    order_id: plain.orderId,
    order_number: plain.orderNumber,
    error_code: plain.errorCode,
    error_message: plain.errorMessage,
    retry_count: plain.retryCount,
    next_retry_at: plain.nextRetryAt,
    imap_ack_status: plain.imapAckStatus,
    resolution_type: plain.resolutionType,
    resolution_reason: plain.resolutionReason,
    resolved_at: plain.resolvedAt,
    resolved_by: plain.resolvedBy,
    resolver_username: plain.resolver?.username || null,
    version: plain.version,
    retention_expires_at: plain.retentionExpiresAt,
    has_raw_mime: Boolean(plain.rawContent),
    recommended_action:
      plain.status === 'retry_wait'
        ? 'retry_wait'
        : plain.status === 'manual_review'
          ? plain.parsedData
            ? 'review_and_ingest'
            : 'reparse'
          : plain.orderId
            ? 'view_order'
            : 'none',
  };
  if (includeDetails) {
    result.mailbox_identity_hash = plain.mailboxIdentityHash;
    result.uid_validity = plain.uidValidity;
    result.email_uid = plain.emailUid;
    result.mime_sha256 = plain.mimeSha256;
    result.raw_mime = plain.rawContent
      ? Buffer.from(plain.rawContent, 'base64').toString('utf8')
      : null;
    result.parsed_data = plain.parsedData;
    result.manual_draft = plain.manualDraft;
    result.final_data = plain.finalData;
    result.attempt_history = plain.attemptHistory;
    result.audit_history = plain.auditHistory;
    result.order = plain.order
      ? { id: plain.order.id, order_number: plain.order.orderNumber }
      : null;
  }
  return result;
}

async function loadRecord(id) {
  const record = await EmailLog.findByPk(id, {
    include: [
      { model: Order, as: 'order', attributes: ['id', 'orderNumber'] },
      { model: User, as: 'resolver', paranoid: false, attributes: ['id', 'username'] },
    ],
  });
  if (!record) {
    throw ApiError.notFound('邮件处理记录不存在');
  }
  return record;
}

/**
 * GET /api/email-processing
 */
async function listRecords(req, res) {
  try {
    const page = parsePositiveInt(req.query.page, { defaultValue: 1, min: 1, max: 100000 });
    const limit = parsePositiveInt(req.query.limit, { defaultValue: 20, min: 1, max: 100 });
    const where = {};

    if (req.query.status) {
      if (!EMAIL_PROCESSING_STATUSES.includes(req.query.status)) {
        throw ApiError.badRequest('邮件处理状态无效');
      }
      where.status = req.query.status;
    } else {
      where.status = 'manual_review';
    }
    if (req.query.error_code) {
      where.errorCode = String(req.query.error_code).trim();
    }
    if (req.query.order_number) {
      where.orderNumber = { [Op.iLike]: `%${String(req.query.order_number).trim()}%` };
    }
    if (req.query.date_from || req.query.date_to) {
      where.receivedAt = {};
      if (req.query.date_from) {
        const from = new Date(req.query.date_from);
        if (Number.isNaN(from.getTime())) throw ApiError.badRequest('date_from 无效');
        where.receivedAt[Op.gte] = from;
      }
      if (req.query.date_to) {
        const to = new Date(req.query.date_to);
        if (Number.isNaN(to.getTime())) throw ApiError.badRequest('date_to 无效');
        where.receivedAt[Op.lte] = to;
      }
    }

    const { count, rows } = await EmailLog.findAndCountAll({
      where,
      include: [{ model: User, as: 'resolver', paranoid: false, attributes: ['id', 'username'] }],
      order: [
        [
          literal(`CASE "EmailLog"."status"
            WHEN 'manual_review' THEN 0
            WHEN 'retry_wait' THEN 1
            ELSE 2 END`),
          'ASC',
        ],
        ['receivedAt', 'DESC'],
      ],
      limit,
      offset: (page - 1) * limit,
      distinct: true,
    });
    return res.json(
      paginatedResponse(
        rows.map(row => serializeRecord(row)),
        count,
        page,
        limit
      )
    );
  } catch (error) {
    if (error instanceof ApiError) throw error;
    logger.error('查询邮件处理列表失败', { errorCode: error.code || 'DATABASE_ERROR' });
    throw ApiError.database('查询邮件处理列表失败');
  }
}

/**
 * GET /api/email-processing/metrics
 */
async function getMetrics(_req, res) {
  try {
    return res.json(successResponse(await emailProcessingService.getMetrics()));
  } catch (error) {
    logger.error('查询邮件处理指标失败', { errorCode: error.code || 'DATABASE_ERROR' });
    throw ApiError.database('查询邮件处理指标失败');
  }
}

/**
 * GET /api/email-processing/:id
 */
async function getRecord(req, res) {
  let record = await loadRecord(req.params.id);
  await emailProcessingService.recordAuditAction(record.id, 'view_full_detail', req.user.id, {
    result: 'succeeded',
  });
  record = await loadRecord(req.params.id);
  const serialized = serializeRecord(record, true);
  const candidateOrderNumber = record.manualDraft?.orderNumber || record.parsedData?.orderNumber;
  if (candidateOrderNumber) {
    const duplicate = await Order.findOne({
      where: { orderNumber: candidateOrderNumber },
      attributes: ['id', 'orderNumber'],
    });
    serialized.duplicate_order = duplicate
      ? { id: duplicate.id, order_number: duplicate.orderNumber }
      : null;
  }
  return res.json(successResponse(serialized));
}

/**
 * POST /api/email-processing/:id/reparse
 */
async function reparseRecord(req, res) {
  try {
    const record = await loadRecord(req.params.id);
    const preview = await emailProcessingService.reparsePreview(record);
    await emailProcessingService.recordAuditAction(record.id, 'reparse_preview', req.user.id, {
      result: 'succeeded',
    });
    const duplicate = await Order.findOne({
      where: { orderNumber: preview.orderNumber },
      attributes: ['id', 'orderNumber'],
    });
    await record.reload();
    return res.json(
      successResponse({
        preview,
        version: record.version,
        duplicate_order: duplicate
          ? { id: duplicate.id, order_number: duplicate.orderNumber }
          : null,
      })
    );
  } catch (error) {
    throw toApiError(error);
  }
}

/**
 * PUT /api/email-processing/:id/draft
 */
async function saveDraft(req, res) {
  try {
    const record = await loadRecord(req.params.id);
    const updated = await emailProcessingService.saveManualDraft(
      record,
      req.body.draft,
      req.body.version
    );
    await emailProcessingService.recordAuditAction(record.id, 'save_manual_draft', req.user.id, {
      result: 'succeeded',
    });
    return res.json(successResponse({ draft: updated.manualDraft, version: updated.version }));
  } catch (error) {
    throw toApiError(error);
  }
}

/**
 * POST /api/email-processing/:id/ingest
 */
async function ingestRecord(req, res) {
  try {
    const record = await loadRecord(req.params.id);
    const order = await emailProcessingService.ingestManualDraft(
      record,
      req.body.draft,
      req.body.version,
      req.user.id
    );
    await emailProcessingService.recordAuditAction(record.id, 'ingest_manual_draft', req.user.id, {
      result: 'succeeded',
      orderId: order.id,
    });
    await record.reload();
    return res.json(
      successResponse({
        order: { id: order.id, order_number: order.orderNumber },
        email_status: record.status,
        version: record.version,
      })
    );
  } catch (error) {
    throw toApiError(error);
  }
}

/**
 * POST /api/email-processing/batch-reparse
 */
async function batchReparse(req, res) {
  const ids = [...new Set((req.body.ids || []).map(Number).filter(Number.isInteger))];
  if (ids.length === 0 || ids.length > 50) {
    throw ApiError.badRequest('ids 必须包含 1 至 50 个邮件记录 ID');
  }
  const records = await EmailLog.findAll({ where: { id: ids } });
  const recordsById = new Map(records.map(record => [record.id, record]));
  const results = [];
  for (const id of ids) {
    const record = recordsById.get(id);
    if (!record) {
      results.push({ id, success: false, error_code: 'NOT_FOUND' });
      continue;
    }
    try {
      const preview = await emailProcessingService.reparsePreview(record);
      await emailProcessingService.recordAuditAction(
        record.id,
        'batch_reparse_preview',
        req.user.id,
        {
          result: 'succeeded',
        }
      );
      await record.reload();
      results.push({ id: record.id, success: true, preview, version: record.version });
    } catch (error) {
      results.push({ id: record.id, success: false, error_code: error.code || 'UNKNOWN' });
    }
  }
  return res.json(successResponse({ results }));
}

/**
 * POST /api/email-processing/:id/resolve
 */
async function resolveRecord(req, res) {
  try {
    const record = await loadRecord(req.params.id);
    const updated = await emailProcessingService.resolveRecord(record, req.body, req.user.id);
    await emailProcessingService.recordAuditAction(record.id, 'resolve_record', req.user.id, {
      result: 'succeeded',
      resolutionType: updated.resolutionType,
      orderId: updated.orderId,
    });
    return res.json(successResponse(serializeRecord(updated)));
  } catch (error) {
    throw toApiError(error);
  }
}

module.exports = {
  listRecords,
  getMetrics,
  getRecord,
  reparseRecord,
  saveDraft,
  ingestRecord,
  batchReparse,
  resolveRecord,
};
