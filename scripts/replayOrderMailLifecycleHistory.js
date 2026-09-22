#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { Op } = require('sequelize');
const projectRoot = process.cwd();
const { sequelize, Order, OrderMailMessage, OrderMailProcessingJob, OrderMailEvent } = require(
  path.join(projectRoot, 'src/models')
);
const { getOrderMailConfig } = require(path.join(projectRoot, 'src/services/orderMailConfig'));
const { enqueueLifecycleJob, aggregateOrderLifecycle } = require(
  path.join(projectRoot, 'src/services/orderMailLifecycleService')
);

const JSON_INDENT = 2;
const COMMAND_INDEX = 2;
const BATCH_SIZE = 100;
const TERMINAL_JOB_STATUSES = [
  'parsed',
  'applied',
  'applied_pending_payment',
  'waiting_order',
  'needs_review',
  'ignored',
  'failed',
];
function optionValue(name) {
  const prefix = `--${name}=`;
  const option = process.argv.find(value => value.startsWith(prefix));
  return option ? option.slice(prefix.length) : null;
}

function countBy(items, readValue) {
  return items.reduce((counts, item) => {
    const value = readValue(item) || 'unknown';
    counts[value] = (counts[value] || 0) + 1;
    return counts;
  }, {});
}

function assertShadowMode() {
  const config = getOrderMailConfig();
  if (!config.lifecycle.parseEnabled) throw new Error('历史回放要求解析开关开启');
  if (config.lifecycle.applyEnabled || config.lifecycle.paymentTaskApplyEnabled) {
    throw new Error('历史回放只允许影子模式，订单应用和付款任务联动必须关闭');
  }
}

/** 幂等登记全部仍保留原文的历史邮件；活动任务复用，终态任务重新排队。 */
async function enqueueHistory() {
  if (!process.argv.includes('--confirm-shadow-enqueue')) {
    throw new Error('登记历史任务必须显式传入 --confirm-shadow-enqueue');
  }
  assertShadowMode();
  const messages = await OrderMailMessage.findAll({
    attributes: ['id'],
    where: { rawContent: { [Op.ne]: null } },
    order: [['createdAt', 'ASC']],
    raw: true,
  });
  let created = 0;
  let reset = 0;
  let active = 0;
  for (let start = 0; start < messages.length; start += BATCH_SIZE) {
    const batch = messages.slice(start, start + BATCH_SIZE);
    await sequelize.transaction(async transaction => {
      const jobs = await OrderMailProcessingJob.findAll({
        where: { messageId: { [Op.in]: batch.map(message => message.id) } },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      const jobByMessage = new Map(jobs.map(job => [job.messageId, job]));
      for (const message of batch) {
        const job = jobByMessage.get(message.id);
        if (!job) {
          await enqueueLifecycleJob(message.id, transaction);
          created += 1;
        } else if (['pending', 'processing'].includes(job.status)) {
          active += 1;
        } else {
          await job.update(
            {
              status: 'pending',
              attempts: 0,
              notBefore: new Date(),
              leaseExpiresAt: null,
              lastErrorCode: null,
              completedAt: null,
            },
            { transaction }
          );
          reset += 1;
        }
      }
    });
  }
  return { mode: 'enqueue', messages: messages.length, created, reset, active };
}

function proposedPickupInfo(aggregate) {
  if (!aggregate.pickupInfo) return null;
  return {
    storeName: aggregate.pickupInfo.storeName || null,
    pickupDate: aggregate.pickupInfo.pickupDate || null,
    startTime: aggregate.pickupInfo.startTime || null,
    endTime: aggregate.pickupInfo.endTime || null,
    appointmentMode: aggregate.pickupInfo.appointmentMode || null,
  };
}

/** 生成不含邮件正文、联系人和订单号的逐订单影子差异报告。 */
async function buildReport() {
  assertShadowMode();
  const [orders, events, jobs, messageCount, expiredContentCount] = await Promise.all([
    Order.findAll({
      attributes: [
        'id',
        'orderNumber',
        'products',
        'emailOrderStatus',
        'emailPaymentStatus',
        'emailStatusNeedsReview',
        'emailStatusReviewReasons',
        'emailPickupInfo',
      ],
      order: [['id', 'ASC']],
    }),
    OrderMailEvent.findAll({
      where: { supersededAt: null },
      include: [
        {
          model: OrderMailMessage,
          as: 'message',
          attributes: ['id', 'orderNumber', 'emailDate', 'receivedAt', 'createdAt'],
        },
      ],
      order: [
        ['orderId', 'ASC'],
        ['messageId', 'ASC'],
        ['revision', 'ASC'],
      ],
    }),
    OrderMailProcessingJob.findAll({ attributes: ['status', 'lastErrorCode'], raw: true }),
    OrderMailMessage.count(),
    OrderMailMessage.count({ where: { rawContent: null } }),
  ]);
  const eventsByOrder = new Map();
  for (const event of events) {
    if (!event.orderId) continue;
    const current = eventsByOrder.get(event.orderId) || [];
    current.push(event);
    eventsByOrder.set(event.orderId, current);
  }
  const items = [];
  for (const order of orders) {
    const orderEvents = eventsByOrder.get(order.id) || [];
    if (!orderEvents.length) continue;
    const aggregate = aggregateOrderLifecycle(order, orderEvents);
    const pickupInfo = proposedPickupInfo(aggregate);
    const currentPickupInfo = order.emailPickupInfo
      ? {
        storeName: order.emailPickupInfo.storeName || null,
        pickupDate: order.emailPickupInfo.pickupDate || null,
        startTime: order.emailPickupInfo.startTime || null,
        endTime: order.emailPickupInfo.endTime || null,
        appointmentMode: order.emailPickupInfo.appointmentMode || null,
      }
      : null;
    const changes = [];
    if (order.emailOrderStatus !== aggregate.orderStatus) changes.push('orderStatus');
    if (order.emailPaymentStatus !== aggregate.paymentStatus) changes.push('paymentStatus');
    if (Boolean(order.emailStatusNeedsReview) !== aggregate.needsReview)
      changes.push('needsReview');
    if (JSON.stringify(currentPickupInfo) !== JSON.stringify(pickupInfo))
      changes.push('pickupInfo');
    items.push({
      orderId: order.id,
      eventCount: orderEvents.length,
      applicableEventCount: aggregate.applicable.length,
      current: {
        orderStatus: order.emailOrderStatus,
        paymentStatus: order.emailPaymentStatus,
        needsReview: order.emailStatusNeedsReview,
      },
      proposed: {
        orderStatus: aggregate.orderStatus,
        paymentStatus: aggregate.paymentStatus,
        needsReview: aggregate.needsReview,
        reviewReasons: aggregate.reviewReasons,
        pickupInfo,
      },
      changes,
      eligibleForApplication: aggregate.applicable.length > 0 && !aggregate.needsReview,
    });
  }
  const activeJobCount = jobs.filter(job => !TERMINAL_JOB_STATUSES.includes(job.status)).length;
  const failedJobs = jobs.filter(job => job.status === 'failed');
  const missingOrderEvents = events.filter(event => !event.orderId);
  const report = {
    generatedAt: new Date().toISOString(),
    mode: 'shadow',
    flags: { parse: true, apply: false, paymentTaskApply: false },
    totals: {
      messages: messageCount,
      contentExpired: expiredContentCount,
      jobs: jobs.length,
      activeJobs: activeJobCount,
      events: events.length,
      ordersWithEvents: items.length,
      ordersWithChanges: items.filter(item => item.changes.length > 0).length,
      eligibleForApplication: items.filter(item => item.eligibleForApplication).length,
      needsReview: items.filter(item => item.proposed.needsReview).length,
      ordersWithOrderNumberMismatch: items.filter(item =>
        item.proposed.reviewReasons.includes('ORDER_NUMBER_MISMATCH')
      ).length,
      eventsWithoutSystemOrder: missingOrderEvents.length,
      failedJobs: failedJobs.length,
    },
    jobStatuses: countBy(jobs, job => job.status),
    jobErrors: countBy(failedJobs, job => job.lastErrorCode),
    proposedOrderStatuses: countBy(items, item => item.proposed.orderStatus),
    proposedPaymentStatuses: countBy(items, item => item.proposed.paymentStatus),
    templateTypes: countBy(events, event => event.templateType),
    authenticityStatuses: countBy(events, event => event.authenticityStatus),
    reviewReasons: countBy(
      items.flatMap(item => item.proposed.reviewReasons),
      reason => reason
    ),
    items,
  };
  return report;
}

async function main() {
  try {
    await sequelize.authenticate();
    const command = process.argv[COMMAND_INDEX] || 'report';
    const result = command === 'enqueue' ? await enqueueHistory() : await buildReport();
    const serialized = `${JSON.stringify(result, null, JSON_INDENT)}\n`;
    const output = optionValue('output');
    if (output) {
      fs.writeFileSync(output, serialized, { encoding: 'utf8', mode: 0o600 });
      process.stdout.write(`${JSON.stringify({ output, totals: result.totals || result })}\n`);
    } else {
      process.stdout.write(serialized);
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  } finally {
    await sequelize.close();
  }
}

main();
