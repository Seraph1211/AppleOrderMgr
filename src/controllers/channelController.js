/**
 * 渠道控制器
 * @module controllers/channelController
 * @description 基于 recipients.tag 和 orders.tag 实现渠道管理功能
 */

const { Op, fn, col, literal } = require('sequelize');
const { Order, Recipient, AppleId, sequelize } = require('../models');
const logger = require('../utils/logger');
const ApiError = require('../utils/ApiError');
const { paginatedResponse, parsePositiveInt } = require('../utils/apiResponse');

/**
 * 获取渠道列表（动态聚合统计）
 * @route GET /api/channels
 * @returns {Object} 渠道列表及统计数据
 */
exports.getChannels = async (req, res, next) => {
  try {
    logger.info('获取渠道列表');

    // 从 orders 表聚合渠道数据
    const channels = await Order.findAll({
      attributes: [
        'tag',
        [fn('COUNT', col('id')), 'totalOrders'],
        [
          fn(
            'COUNT',
            literal('CASE WHEN status IN (\'completed\', \'ready_for_pickup\') THEN 1 END')
          ),
          'paidOrders',
        ],
        [
          fn('COUNT', literal('CASE WHEN status = \'completed\' THEN 1 END')),
          'deliveredOrders',
        ],
      ],
      where: {
        tag: {
          [Op.ne]: null,
          [Op.ne]: '',
        },
      },
      group: ['tag'],
      raw: true,
    });

    // 格式化数据
    const formattedChannels = channels.map((channel, index) => {
      const totalOrders = parseInt(channel.totalOrders, 10);
      const paidOrders = parseInt(channel.paidOrders, 10);
      const deliveredOrders = parseInt(channel.deliveredOrders, 10);

      // TODO: 后续需要在订单表添加真实金额字段，当前使用模拟数据
      // 模拟计算：假设每个订单平均金额8000元
      const avgOrderAmount = 8000;
      const totalAmount = totalOrders * avgOrderAmount;
      const paidAmount = paidOrders * avgOrderAmount;
      const deliveredAmount = deliveredOrders * avgOrderAmount;

      return {
        id: index + 1, // 虚拟ID，用于前端展示
        tag: channel.tag,
        channelName: channel.tag,
        totalOrders,
        paidOrders,
        deliveredOrders,
        totalAmount,
        paidAmount,
        deliveredAmount,
      };
    });

    // 按订单数量降序排序
    formattedChannels.sort((a, b) => b.totalOrders - a.totalOrders);

    logger.info('渠道列表获取成功', { count: formattedChannels.length });

    res.json({
      success: true,
      data: {
        channels: formattedChannels,
        total: formattedChannels.length,
      },
    });
  } catch (error) {
    logger.error('获取渠道列表失败', { error: error.message, stack: error.stack });
    next(ApiError.internal('获取渠道列表失败', { error: error.message }));
  }
};

/**
 * 获取渠道详细统计
 * @route GET /api/channels/:tag/stats
 * @param {string} tag - 渠道标签
 * @returns {Object} 渠道详细统计数据
 */
exports.getChannelStats = async (req, res, next) => {
  try {
    const { tag } = req.params;

    if (!tag) {
      return next(ApiError.badRequest('渠道标签不能为空'));
    }

    logger.info('获取渠道详细统计', { tag });

    // 查询渠道订单统计
    const stats = await Order.findOne({
      attributes: [
        [fn('COUNT', col('id')), 'totalOrders'],
        [fn('COUNT', literal('CASE WHEN status = \'pending\' THEN 1 END')), 'pendingOrders'],
        [fn('COUNT', literal('CASE WHEN status = \'processing\' THEN 1 END')), 'processingOrders'],
        [fn('COUNT', literal('CASE WHEN status = \'shipped\' THEN 1 END')), 'shippedOrders'],
        [fn('COUNT', literal('CASE WHEN status = \'ready_for_pickup\' THEN 1 END')), 'readyOrders'],
        [fn('COUNT', literal('CASE WHEN status = \'completed\' THEN 1 END')), 'completedOrders'],
        [fn('COUNT', literal('CASE WHEN status = \'cancelled\' THEN 1 END')), 'cancelledOrders'],
      ],
      where: { tag },
      raw: true,
    });

    // 查询渠道关联的取机人数量
    const recipientCount = await Recipient.count({
      where: { tag },
    });

    logger.info('渠道统计获取成功', { tag, stats });

    res.json({
      success: true,
      data: {
        tag,
        channelName: tag,
        totalOrders: parseInt(stats.totalOrders, 10),
        pendingOrders: parseInt(stats.pendingOrders, 10),
        processingOrders: parseInt(stats.processingOrders, 10),
        shippedOrders: parseInt(stats.shippedOrders, 10),
        readyOrders: parseInt(stats.readyOrders, 10),
        completedOrders: parseInt(stats.completedOrders, 10),
        cancelledOrders: parseInt(stats.cancelledOrders, 10),
        recipientCount,
      },
    });
  } catch (error) {
    logger.error('获取渠道统计失败', { tag: req.params.tag, error: error.message, stack: error.stack });
    next(ApiError.internal('获取渠道统计失败', { error: error.message }));
  }
};

/**
 * 获取渠道订单列表
 * @route GET /api/channels/:tag/orders
 * @param {string} tag - 渠道标签
 * @query {number} page - 页码（默认1）
 * @query {number} pageSize - 每页数量（默认20）
 * @query {string} status - 订单状态筛选
 * @query {string} search - 搜索关键词（订单号、取机人）
 * @returns {Object} 渠道订单列表
 */
exports.getChannelOrders = async (req, res, next) => {
  try {
    const { tag } = req.params;
    const DEFAULT_PAGE = 1;
    const DEFAULT_PAGE_SIZE = 20;

    const {
      page = DEFAULT_PAGE,
      pageSize = DEFAULT_PAGE_SIZE,
      status,
      search,
    } = req.query;

    if (!tag) {
      return next(ApiError.badRequest('渠道标签不能为空'));
    }

    const pageNum = parsePositiveInt(page, {
      defaultValue: DEFAULT_PAGE,
      min: 1,
      max: 10000,
    });
    const pageSizeNum = parsePositiveInt(pageSize, {
      defaultValue: DEFAULT_PAGE_SIZE,
      min: 1,
      max: 100,
    });
    const offset = (pageNum - 1) * pageSizeNum;

    logger.info('获取渠道订单列表', { tag, page: pageNum, pageSize: pageSizeNum, status, search });

    // 构建查询条件
    const whereClause = { tag };

    // 状态筛选
    if (status) {
      whereClause.status = status;
    }

    // 搜索关键词
    if (search) {
      whereClause[Op.or] = [
        { orderNumber: { [Op.iLike]: `%${search}%` } },
        { recipientName: { [Op.iLike]: `%${search}%` } },
      ];
    }

    // 查询订单
    const { count, rows: orders } = await Order.findAndCountAll({
      where: whereClause,
      include: [
        {
          model: AppleId,
          as: 'appleAccount',
          attributes: ['id', 'appleId'],
        },
        {
          model: Recipient,
          as: 'recipient',
          attributes: ['id', 'lastName', 'firstName', 'phone'],
        },
      ],
      order: [['orderDate', 'DESC']],
      limit: pageSizeNum,
      offset,
    });

    // 序列化订单数据
    const formattedOrders = orders.map((order) => {
      const plain = order.toJSON();
      return {
        id: plain.id,
        orderNumber: plain.orderNumber,
        appleId: plain.appleAccount?.appleId || plain.appleId,
        recipientName: plain.recipient
          ? `${plain.recipient.lastName}${plain.recipient.firstName}`
          : plain.recipientName,
        recipientPhone: plain.recipient?.phone || plain.recipientPhone,
        products: plain.products,
        status: plain.status,
        pickupStore: plain.pickupStore,
        pickupTimeSlot: plain.pickupTimeSlot,
        orderUrl: plain.orderUrl,
        paymentMethod: plain.paymentMethod,
        orderDate: plain.orderDate,
        tag: plain.tag,
        createdAt: plain.createdAt,
      };
    });

    logger.info('渠道订单列表获取成功', { tag, total: count });

    res.json(paginatedResponse(formattedOrders, count, pageNum, pageSizeNum));
  } catch (error) {
    logger.error('获取渠道订单列表失败', { tag: req.params.tag, error: error.message, stack: error.stack });
    next(ApiError.internal('获取渠道订单列表失败', { error: error.message }));
  }
};

/**
 * 修改渠道名称（级联更新）
 * @route PUT /api/channels/:tag
 * @param {string} tag - 原渠道标签
 * @body {string} newTag - 新渠道标签
 * @returns {Object} 更新结果
 */
exports.updateChannelName = async (req, res, next) => {
  const transaction = await sequelize.transaction();

  try {
    const { tag } = req.params;
    const { newTag } = req.body;

    if (!tag) {
      await transaction.rollback();
      return next(ApiError.badRequest('原渠道标签不能为空'));
    }

    if (!newTag || newTag.trim() === '') {
      await transaction.rollback();
      return next(ApiError.badRequest('新渠道标签不能为空'));
    }

    if (tag === newTag) {
      await transaction.rollback();
      return next(ApiError.badRequest('新渠道标签与原标签相同'));
    }

    logger.info('开始修改渠道名称', { oldTag: tag, newTag });

    // 检查原渠道是否存在
    const orderCount = await Order.count({
      where: { tag },
      transaction,
    });

    if (orderCount === 0) {
      await transaction.rollback();
      return next(ApiError.notFound('渠道不存在或没有订单数据'));
    }

    // 检查新渠道名称是否已存在
    const existingOrderCount = await Order.count({
      where: { tag: newTag },
      transaction,
    });

    if (existingOrderCount > 0) {
      await transaction.rollback();
      return next(ApiError.badRequest('新渠道名称已存在，无法重命名'));
    }

    // 级联更新 orders 表
    const [ordersUpdated] = await Order.update(
      { tag: newTag },
      {
        where: { tag },
        transaction,
      }
    );

    // 级联更新 recipients 表
    const [recipientsUpdated] = await Recipient.update(
      { tag: newTag },
      {
        where: { tag },
        transaction,
      }
    );

    await transaction.commit();

    logger.info('渠道名称修改成功', {
      oldTag: tag,
      newTag,
      ordersUpdated,
      recipientsUpdated,
    });

    res.json({
      success: true,
      data: {
        oldTag: tag,
        newTag,
        ordersUpdated,
        recipientsUpdated,
      },
      message: '渠道名称修改成功',
    });
  } catch (error) {
    await transaction.rollback();
    logger.error('修改渠道名称失败', {
      oldTag: req.params.tag,
      newTag: req.body.newTag,
      error: error.message,
      stack: error.stack,
    });
    next(ApiError.internal('修改渠道名称失败', { error: error.message }));
  }
};
