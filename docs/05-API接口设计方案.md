# API 接口设计方案

## 一、技术栈

- **框架**: Express.js
- **中间件**: CORS, body-parser, morgan (日志)
- **认证**: JWT (可选，看后续需求)
- **文档**: Swagger / OpenAPI (可选)

---

## 二、接口概览

### 2.1 模块划分

| 模块 | 路由前缀 | 说明 |
|------|---------|------|
| Apple ID 管理 | `/api/apple-ids` | Apple ID 的增删改查 |
| 取机人管理 | `/api/recipients` | 取机人的增删改查 |
| 订单管理 | `/api/orders` | 订单查询、筛选、统计 |
| 系统配置 | `/api/config` | 邮箱配置、代理配置 |
| 统计分析 | `/api/stats` | 订单统计、状态分布 |

---

## 三、详细接口设计

### 3.1 Apple ID 管理

#### 3.1.1 获取所有 Apple ID

**请求**:
```
GET /api/apple-ids
```

**响应**:
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "apple_id": "tzvcantetc8k@hotmail.com",
      "nickname": "主账号",
      "created_at": "2025-10-08T12:00:00Z",
      "order_count": 15
    },
    {
      "id": 2,
      "apple_id": "test123@gmail.com",
      "nickname": "测试账号",
      "created_at": "2025-10-09T12:00:00Z",
      "order_count": 3
    }
  ]
}
```

#### 3.1.2 创建 Apple ID

**请求**:
```
POST /api/apple-ids
Content-Type: application/json

{
  "apple_id": "new_account@gmail.com",
  "nickname": "备用账号"
}
```

**响应**:
```json
{
  "success": true,
  "data": {
    "id": 3,
    "apple_id": "new_account@gmail.com",
    "nickname": "备用账号",
    "created_at": "2025-10-10T12:00:00Z"
  }
}
```

#### 3.1.3 更新 Apple ID

**请求**:
```
PUT /api/apple-ids/:id
Content-Type: application/json

{
  "nickname": "新的备注名"
}
```

#### 3.1.4 删除 Apple ID

**请求**:
```
DELETE /api/apple-ids/:id
```

**响应**:
```json
{
  "success": true,
  "message": "Apple ID 已删除"
}
```

---

### 3.2 取机人管理

#### 3.2.1 获取所有取机人

**请求**:
```
GET /api/recipients?page=1&limit=20&tag=天津
```

**查询参数**:
- `page`: 页码（默认 1）
- `limit`: 每页数量（默认 20）
- `tag`: 按标签筛选（可选）
- `keyword`: 按姓名搜索（可选）

**响应**:
```json
{
  "success": true,
  "data": {
    "total": 50,
    "page": 1,
    "limit": 20,
    "recipients": [
      {
        "id": 1,
        "name": "李浩",
        "id_card_last4": "603X",
        "tag": "天津",
        "order_count": 8,
        "created_at": "2025-10-08T12:00:00Z"
      }
    ]
  }
}
```

#### 3.2.2 创建取机人

**请求**:
```
POST /api/recipients
Content-Type: application/json

{
  "name": "张三",
  "id_card_last4": "1234",
  "phone": "13800138000",
  "tag": "北京",
  "notes": "VIP 客户"
}
```

#### 3.2.3 更新取机人

**请求**:
```
PUT /api/recipients/:id
Content-Type: application/json

{
  "phone": "13900139000",
  "notes": "更新备注"
}
```

#### 3.2.4 删除取机人

**请求**:
```
DELETE /api/recipients/:id
```

---

### 3.3 订单管理

#### 3.3.1 获取订单列表

**请求**:
```
GET /api/orders?page=1&limit=20&status=ready&apple_id=1&date_from=2025-10-01&date_to=2025-10-31
```

**查询参数**:
- `page`: 页码
- `limit`: 每页数量
- `status`: 订单状态筛选（submitted/ready/shipped/delivered/cancelled）
- `apple_id`: Apple ID 筛选
- `recipient_id`: 取机人筛选
- `date_from`: 开始日期
- `date_to`: 结束日期
- `keyword`: 关键词搜索（订单号、商品名称）

**响应**:
```json
{
  "success": true,
  "data": {
    "total": 150,
    "page": 1,
    "limit": 20,
    "orders": [
      {
        "id": 1,
        "order_number": "W177976887",
        "apple_id": "tzvcantetc8k@hotmail.com",
        "recipient_name": "李浩",
        "products": [
          {
            "name": "iPhone 17 Pro Max 1TB 星宇橙色",
            "quantity": 2,
            "status": "READY_FOR_PICKUP",
            "imageUrl": "https://..."
          }
        ],
        "status": "ready",
        "pickup_store": "Apple 重庆万象城",
        "payment_method": "支付宝",
        "order_date": "2025-10-08T12:21:58Z",
        "created_at": "2025-10-08T12:22:05Z",
        "updated_at": "2025-10-08T14:00:00Z"
      }
    ]
  }
}
```

#### 3.3.2 获取订单详情

**请求**:
```
GET /api/orders/:id
```

**响应**:
```json
{
  "success": true,
  "data": {
    "id": 1,
    "order_number": "W177976887",
    "apple_id": {
      "id": 1,
      "apple_id": "tzvcantetc8k@hotmail.com",
      "nickname": "主账号"
    },
    "recipient": {
      "id": 1,
      "name": "李浩",
      "id_card_last4": "603X",
      "tag": "天津"
    },
    "products": [
      {
        "modelId": "MG714CH/A",
        "name": "iPhone 17 Pro Max 1TB 星宇橙色",
        "quantity": 2,
        "status": "READY_FOR_PICKUP",
        "imageUrl": "https://..."
      }
    ],
    "status": "ready",
    "order_url": "https://www.apple.com.cn/xc/cn/vieworder/W177976887/...",
    "payment_method": "支付宝",
    "pickup_store": "Apple 重庆万象城",
    "store_directions_url": "http://www.apple.com/cn/retail/...",
    "order_date": "2025-10-08T12:21:58Z",
    "order_placed_date": "2025-10-08",
    "estimated_delivery": null,
    "actual_delivery": null,
    "created_at": "2025-10-08T12:22:05Z",
    "updated_at": "2025-10-08T14:00:00Z"
  }
}
```

#### 3.3.3 手动更新订单

**请求**:
```
POST /api/orders/:id/refresh
```

**说明**: 手动触发爬虫更新订单状态

**响应**:
```json
{
  "success": true,
  "message": "订单已更新",
  "data": {
    "order_number": "W177976887",
    "old_status": "ready",
    "new_status": "shipped"
  }
}
```

#### 3.3.4 批量更新订单

**请求**:
```
POST /api/orders/batch-refresh
Content-Type: application/json

{
  "status": "ready"  // 只更新状态为 ready 的订单
}
```

---

### 3.4 统计分析

#### 3.4.1 订单统计

**请求**:
```
GET /api/stats/overview
```

**响应**:
```json
{
  "success": true,
  "data": {
    "total_orders": 150,
    "total_products": 185,
    "status_distribution": {
      "submitted": 10,
      "processing": 20,
      "ready": 50,
      "shipped": 30,
      "delivered": 35,
      "cancelled": 5
    },
    "today_orders": 8,
    "this_week_orders": 45,
    "this_month_orders": 120
  }
}
```

#### 3.4.2 Apple ID 统计

**请求**:
```
GET /api/stats/apple-ids
```

**响应**:
```json
{
  "success": true,
  "data": [
    {
      "apple_id": "tzvcantetc8k@hotmail.com",
      "nickname": "主账号",
      "order_count": 85,
      "product_count": 102,
      "latest_order_date": "2025-10-10T10:00:00Z"
    }
  ]
}
```

#### 3.4.3 取机人统计

**请求**:
```
GET /api/stats/recipients
```

**响应**:
```json
{
  "success": true,
  "data": [
    {
      "name": "李浩",
      "tag": "天津",
      "order_count": 25,
      "product_count": 38,
      "latest_order_date": "2025-10-10T10:00:00Z"
    }
  ]
}
```

#### 3.4.4 商品统计

**请求**:
```
GET /api/stats/products?date_from=2025-10-01&date_to=2025-10-31
```

**响应**:
```json
{
  "success": true,
  "data": {
    "top_products": [
      {
        "name": "iPhone 17 Pro Max",
        "total_quantity": 85,
        "order_count": 45
      },
      {
        "name": "iPhone 17",
        "total_quantity": 60,
        "order_count": 38
      }
    ],
    "color_distribution": {
      "星宇橙色": 35,
      "鼠尾草绿色": 28,
      "钛金属": 22
    },
    "capacity_distribution": {
      "1TB": 50,
      "512GB": 25,
      "256GB": 10
    }
  }
}
```

---

### 3.5 系统配置

#### 3.5.1 获取邮箱配置

**请求**:
```
GET /api/config/email
```

**响应**:
```json
{
  "success": true,
  "data": {
    "email_host": "imap.qq.com",
    "email_port": 993,
    "email_user": "your_email@qq.com",
    "email_tls": true,
    "is_connected": true,
    "last_check": "2025-10-10T10:00:00Z"
  }
}
```

#### 3.5.2 测试邮箱连接

**请求**:
```
POST /api/config/email/test
```

**响应**:
```json
{
  "success": true,
  "message": "邮箱连接成功"
}
```

#### 3.5.3 获取代理配置

**请求**:
```
GET /api/config/proxy
```

**响应**:
```json
{
  "success": true,
  "data": {
    "proxy_enabled": true,
    "proxy_pool_size": 10,
    "current_proxy": "123.45.67.89:8080",
    "success_rate": 95.5
  }
}
```

---

## 四、错误响应格式

### 4.1 统一错误格式

```json
{
  "success": false,
  "error": {
    "code": "ORDER_NOT_FOUND",
    "message": "订单不存在",
    "details": {
      "order_number": "W123456789"
    }
  }
}
```

### 4.2 错误码定义

| 错误码 | HTTP 状态 | 说明 |
|-------|----------|------|
| `VALIDATION_ERROR` | 400 | 参数验证失败 |
| `NOT_FOUND` | 404 | 资源不存在 |
| `DUPLICATE_ENTRY` | 409 | 资源已存在 |
| `INTERNAL_ERROR` | 500 | 服务器内部错误 |
| `DATABASE_ERROR` | 500 | 数据库错误 |
| `CRAWLER_ERROR` | 500 | 爬虫执行失败 |

---

## 五、实现示例

### 5.1 订单列表接口实现

```javascript
const express = require('express');
const router = express.Router();
const { Order, AppleId, Recipient } = require('../models');
const { Op } = require('sequelize');

// GET /api/orders
router.get('/', async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      status,
      apple_id,
      recipient_id,
      date_from,
      date_to,
      keyword
    } = req.query;

    // 构建查询条件
    const where = {};

    if (status) {
      where.status = status;
    }

    if (apple_id) {
      where.apple_id_ref = apple_id;
    }

    if (recipient_id) {
      where.recipient_ref = recipient_id;
    }

    if (date_from || date_to) {
      where.order_date = {};
      if (date_from) {
        where.order_date[Op.gte] = new Date(date_from);
      }
      if (date_to) {
        where.order_date[Op.lte] = new Date(date_to);
      }
    }

    if (keyword) {
      where[Op.or] = [
        { order_number: { [Op.iLike]: `%${keyword}%` } },
        { products: { [Op.contains]: { name: keyword } } }
      ];
    }

    // 查询订单
    const { count, rows } = await Order.findAndCountAll({
      where,
      include: [
        { model: AppleId, as: 'apple_id', attributes: ['id', 'apple_id', 'nickname'] },
        { model: Recipient, as: 'recipient', attributes: ['id', 'name', 'tag'] }
      ],
      order: [['order_date', 'DESC']],
      limit: parseInt(limit),
      offset: (parseInt(page) - 1) * parseInt(limit)
    });

    res.json({
      success: true,
      data: {
        total: count,
        page: parseInt(page),
        limit: parseInt(limit),
        orders: rows
      }
    });

  } catch (error) {
    console.error('查询订单失败:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'DATABASE_ERROR',
        message: '查询订单失败',
        details: error.message
      }
    });
  }
});

module.exports = router;
```

### 5.2 手动刷新订单接口

```javascript
// POST /api/orders/:id/refresh
router.post('/:id/refresh', async (req, res) => {
  try {
    const order = await Order.findByPk(req.params.id);

    if (!order) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'ORDER_NOT_FOUND',
          message: '订单不存在'
        }
      });
    }

    // 调用爬虫服务
    const crawlerService = require('../services/crawlerService');
    const oldStatus = order.status;
    
    const result = await crawlerService.crawlAndUpdate(order.id);

    res.json({
      success: true,
      message: '订单已更新',
      data: {
        order_number: order.order_number,
        old_status: oldStatus,
        new_status: result.status
      }
    });

  } catch (error) {
    console.error('更新订单失败:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'CRAWLER_ERROR',
        message: '更新订单失败',
        details: error.message
      }
    });
  }
});
```

---

## 六、中间件

### 6.1 错误处理中间件

```javascript
// middleware/errorHandler.js
module.exports = (err, req, res, next) => {
  console.error('Error:', err);

  const statusCode = err.statusCode || 500;
  const response = {
    success: false,
    error: {
      code: err.code || 'INTERNAL_ERROR',
      message: err.message || '服务器内部错误'
    }
  };

  if (process.env.NODE_ENV === 'development') {
    response.error.stack = err.stack;
  }

  res.status(statusCode).json(response);
};
```

### 6.2 请求日志中间件

```javascript
// middleware/logger.js
const morgan = require('morgan');
const winston = require('winston');

const logger = winston.createLogger({
  format: winston.format.json(),
  transports: [
    new winston.transports.File({ filename: 'logs/access.log' })
  ]
});

module.exports = morgan('combined', {
  stream: {
    write: (message) => logger.info(message.trim())
  }
});
```

---

## 七、CORS 配置

```javascript
const cors = require('cors');

app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3001',
  credentials: true
}));
```

---

**文档版本**: v1.0  
**创建时间**: 2026-07-06  
**维护人**: Kiro
