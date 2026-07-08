# 技术决策记录

本文档记录 Apple Order Manager 项目中的关键技术决策、设计原则和架构选型。

---

## 1. 订单快照模式设计 🎯

### 决策背景
邮件到达时，Apple ID 和收件人的基础数据可能尚未导入系统，传统的严格外键关联会导致订单创建失败。

### 最终方案：快照模式 + 自动匹配

#### 核心原则
- ✅ **快照存储**：orders 表存储下单时的完整数据副本
- ✅ **自动匹配**：邮件到达后自动匹配 apple_ids 和 recipients 表
- ✅ **数据自包含**：前端展示直接读取快照字段，无需 JOIN
- ✅ **外键可空**：允许未匹配时仍能创建订单

#### 表结构设计

```sql
CREATE TABLE orders (
  -- 基础信息
  id SERIAL PRIMARY KEY,
  order_number VARCHAR(50) UNIQUE NOT NULL,
  
  -- Apple ID（快照 + 外键）
  apple_id_ref INT,  -- 外键，nullable
  apple_id VARCHAR(255),  -- 快照：邮件解析
  apple_password VARCHAR(255),  -- 快照：自动匹配填充
  
  -- 收件人（快照 + 外键）
  recipient_ref INT,  -- 外键，nullable
  recipient_name VARCHAR(100),  -- 快照：邮件解析
  recipient_id_card VARCHAR(18),  -- 快照：自动匹配填充
  recipient_email VARCHAR(255),  -- 快照：自动匹配填充
  recipient_phone VARCHAR(20),  -- 快照：自动匹配填充
  recipient_address TEXT,  -- 快照：自动匹配填充
  
  -- 外键约束
  FOREIGN KEY (apple_id_ref) REFERENCES apple_ids(id) ON DELETE SET NULL,
  FOREIGN KEY (recipient_ref) REFERENCES recipients(id) ON DELETE SET NULL
);
```

#### 业务流程

```
邮件到达
  ↓
解析邮件（提取 Apple ID / 收件人姓名 / 身份证后四位）
  ↓
自动匹配 apple_ids 表
  ↓ 找到                    ↓ 未找到
apple_id_ref = 1          apple_id_ref = NULL
apple_password = 填充     apple_password = NULL
  ↓
自动匹配 recipients 表
  ↓ 找到                    ↓ 未找到
recipient_ref = 1         recipient_ref = NULL
recipient_id_card = 填充  recipient_id_card = NULL
recipient_email = 填充    recipient_email = NULL
recipient_phone = 填充    recipient_phone = NULL
recipient_address = 填充  recipient_address = NULL
  ↓
创建订单（事务）
  ↓
保存成功（不会丢失订单）
```

### 优势
1. **容错性强**：基础数据缺失时不会丢单
2. **性能优异**：查询订单无需 JOIN
3. **数据完整**：保留下单时的完整信息
4. **灵活扩展**：后续可手动关联基础数据

### 权衡
- ⚠️ 数据冗余：快照字段占用额外存储空间
- ⚠️ 同步复杂度：基础数据变更时需考虑是否更新快照

### 适用场景
✅ 适用于本项目：邮件先于基础数据到达的场景  
❌ 不适用：强一致性要求的场景

---

## 2. 数据权威性规则 📊

### 决策背景
订单数据来自两个来源：邮件和 Apple 网站。两个来源的数据可能不一致，需要明确权威性规则。

### 权威性分配表

| 字段 | 权威来源 | 原因 | 更新策略 |
|------|---------|------|---------|
| **Apple ID** | ✅ 邮件（唯一） | 网站不显示 | 不更新 |
| **收件人姓名** | ✅ 邮件（唯一） | 网站不显示 | 不更新 |
| **products[].quantity** | ✅ 邮件 | 网站对取消订单显示 0 | 不更新 |
| **products[].status** | ✅ 网站 | 实时状态 | 爬虫更新 |
| **products[].imageUrl** | ✅ 网站 | 邮件无图片 | 爬虫更新 |
| **order_status** | ✅ 网站 | 实时状态 | 爬虫更新 |
| **pickup_store** | ✅ 网站 | 实时信息 | 爬虫更新 |

### 数据合并策略

```javascript
// 爬虫更新订单时的合并逻辑
updateData.products = order.products.map(emailProduct => {
  const crawledProduct = crawledData.products.find(p => p.model === emailProduct.model);
  
  if (crawledProduct) {
    return {
      ...emailProduct,
      quantity: emailProduct.quantity,  // 保留邮件数量（权威）
      status: crawledProduct.status,    // 使用网站状态（权威）
      imageUrl: crawledProduct.imageUrl // 使用网站图片（权威）
    };
  }
  
  return emailProduct;  // 网站无此商品，保留邮件数据
});
```

### 决策依据
1. **Apple ID / 收件人**：网站不显示，只能从邮件获取
2. **商品数量**：网站对已取消订单显示 0，邮件保留原始数量
3. **状态 / 图片**：网站是实时数据源，邮件是历史快照

---

## 3. 邮件处理方案：标志位 + 选择性标记已读 📧

### 决策背景
初始方案使用 3 秒防抖，在高频邮件场景下会导致最差 5 分钟+的延迟。

### 最终方案

#### 核心机制

**1. isProcessing 标志位（并发控制）**
```javascript
let isProcessing = false;

async function onNewMail() {
  if (isProcessing) {
    return;  // 直接返回，不排队
  }
  
  isProcessing = true;
  try {
    await processUnseenEmails();
  } finally {
    isProcessing = false;
    
    // 处理完后立即检查是否有新未读邮件
    const unseenCount = await getUnseenCount();
    if (unseenCount > 0) {
      await onNewMail();  // 递归处理
    }
  }
}
```

**2. 选择性标记已读**

| 邮件类型 | 处理后操作 | 原因 |
|---------|-----------|------|
| 订单邮件（成功） | ✅ 标记已读 | 避免重复搜索，性能最优 |
| 订单邮件（失败） | ❌ 保持未读 | 下次重试处理 |
| 非订单邮件 | ❌ 保持未读 | 不干预用户邮箱 |

**3. 三种触发场景**

| 触发方式 | 搜索条件 | 频率 | 目的 |
|---------|---------|------|------|
| IDLE 实时 | `['UNSEEN']` | 秒级 | 实时处理 |
| 定时回溯 | `['SINCE', 30分钟前]` | 每 10 分钟 | 容错补漏 |
| 服务启动 | `['SINCE', 24小时前]` | 每次启动 | 补漏 |

### 性能对比

| 场景 | 防抖方案 | 标志位方案 |
|------|---------|-----------|
| 首封邮件延迟 | 3 秒 | **0 秒** ✅ |
| 100 封邮件（1 分钟内） | 5 分钟+ ❌ | **40-60 秒** ✅ |
| 已处理邮件 | 每次搜索+去重 | **自动过滤** ✅ |
| 实现复杂度 | 中 | **低** ✅ |

### 用户前提
- ✅ 订单邮件到达时未读（服务会自动标记已读）
- ✅ 专用邮箱（避免其他客户端干扰）
- ⚠️ 容忍 10 分钟补漏窗口（极端情况）

---

## 4. 爬虫反爬虫策略 🕷️

### 决策背景
Apple 网站有严格的反爬虫机制，频繁请求会触发 HTTP 541 风控。

### 技术选型

#### 爬虫库：axios + cheerio（而非 Puppeteer）

**原因**：
- ✅ 订单数据在 HTML 的 `<script>` 标签中，无需 JS 执行
- ✅ 性能开销小（无需启动浏览器）
- ✅ 内存占用低

### 反爬虫策略

#### 1. 请求延迟
- **延迟范围**：5-10 秒随机
- **单 IP 频率**：<10 requests/minute

```javascript
const delay = Math.floor(Math.random() * 5000) + 5000;  // 5-10s
await sleep(delay);
```

#### 2. 代理池轮换
- **代理池**：快代理（¥50-200/月）
- **轮换策略**：轮询
- **失效处理**：标记为坏，1 小时后自动恢复

```javascript
const proxy = proxyManager.getNextProxy();
if (!proxy) {
  throw new Error('无可用代理');
}
```

#### 3. HTTP 541 风控处理
```javascript
if (error.response?.status === 541) {
  logger.warn('触发风控，切换代理');
  proxyManager.markProxyAsBad(lastProxy);
  await proxyManager.refresh();  // 刷新代理池
  // 重试
}
```

#### 4. 重试机制
- **最大重试**：3 次
- **重试延迟**：指数退避（1s, 2s, 4s）

### 批量爬取策略

**顺序处理（而非并发）**：
```javascript
for (const orderId of orderIds) {
  await crawlAndUpdateOrder(orderId);
  await sleep(getRandomDelay());  // 请求间隔
}
```

**原因**：
- ✅ 避免触发风控
- ✅ 代理池资源复用
- ⚠️ 牺牲速度换稳定性

---

## 5. 姓名拆分策略 👤

### 决策背景
邮件中只有完整姓名（如"张三"），需要拆分为 `last_name` 和 `first_name` 以匹配 recipients 表。

### 拆分规则

```javascript
// 中文姓名：最后一个字作为名，前面的字作为姓
const fullName = '冉念';
const lastName = fullName.substring(0, fullName.length - 1);  // '冉'
const firstName = fullName.substring(fullName.length - 1);     // '念'
```

### 限制和边界情况

| 场景 | 处理 | 示例 |
|------|------|------|
| 单字姓 + 单字名 | ✅ 正确 | 张三 → 张/三 |
| 单字姓 + 双字名 | ✅ 正确 | 李明明 → 李/明明 |
| 复姓 + 单字名 | ⚠️ 错误 | 欧阳娜 → 欧阳/娜（需手动调整） |
| 单字名（无姓） | ❌ 错误 | 三 → ''/三 |

### 改进方向
- 引入常见复姓列表（欧阳、司马、上官等）
- 提供手动修正接口

---

## 6. JSONB vs 分字段存储 🗄️

### 决策对比

| 字段类型 | 选择 | 原因 |
|---------|------|------|
| **products** | ✅ JSONB | 数量不定，结构灵活 |
| **security_qa** | ✅ JSONB | 固定 3 个问答对，无需查询 |
| **address** | ✅ 分字段 | 需要按省市区统计和筛选 |
| **name** | ✅ 分字段 | 需要按姓氏/名字查询 |

### JSONB 优势
- ✅ 灵活存储可变数量的元素
- ✅ 支持 GIN 索引，查询性能好
- ✅ PostgreSQL 原生支持

### 分字段优势
- ✅ 传统 SQL 查询友好
- ✅ 索引简单
- ✅ 数据完整性约束强

---

## 7. 事务处理策略 🔒

### 原则
所有涉及多表操作的业务逻辑必须使用事务。

### 应用场景

#### 1. 邮件创建订单
```javascript
const transaction = await sequelize.transaction();
try {
  // 1. 查找/创建 Apple ID
  // 2. 查找/创建 Recipient
  // 3. 创建 Order
  // 4. 创建 EmailLog
  await transaction.commit();
} catch (error) {
  await transaction.rollback();
  throw error;
}
```

#### 2. 爬虫更新订单
```javascript
const transaction = await sequelize.transaction();
try {
  // 1. 更新 Order
  // 2. 创建 CrawlLog
  await transaction.commit();
} catch (error) {
  await transaction.rollback();
  throw error;
}
```

### 隔离级别
- **默认**：READ COMMITTED（PostgreSQL 默认）
- **适用场景**：本项目的并发度较低，默认隔离级别足够

---

## 8. 错误处理与日志记录 📝

### 日志框架：Winston

**选择原因**：
- ✅ 结构化日志（JSON 格式）
- ✅ 多输出目标（文件、控制台）
- ✅ 自动日志轮转
- ✅ 日志级别控制

### 日志级别使用规范

| 级别 | 场景 | 示例 |
|------|------|------|
| **error** | 系统级错误 | 数据库连接失败、API 调用失败 |
| **warn** | 业务异常 | 代理失效、HTTP 541、未匹配到基础数据 |
| **info** | 正常业务 | 邮件解析成功、订单创建成功 |
| **debug** | 详细流程 | 仅开发环境，详细执行步骤 |

### 错误响应统一格式

```json
{
  "success": false,
  "error": {
    "code": "ORDER_NOT_FOUND",
    "message": "订单不存在",
    "details": {
      "orderNumber": "W123456789"
    }
  }
}
```

---

## 9. API 响应格式规范 📡

### 成功响应

```json
{
  "success": true,
  "data": { ... }
}
```

### 分页响应

```json
{
  "success": true,
  "data": {
    "items": [ ... ],
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 100,
      "pages": 5
    }
  }
}
```

### 字段命名：snake_case

**原因**：
- ✅ 与数据库字段保持一致
- ✅ API 设计文档已采用 snake_case
- ✅ 避免转换开销

---

## 决策变更记录

| 日期 | 决策点 | 旧方案 | 新方案 | 原因 |
|------|-------|--------|--------|------|
| 2026-07-08 | 订单数据存储 | 严格外键 | 快照模式 | 邮件先于基础数据到达 |
| 2026-07-07 | 邮件处理 | 3秒防抖 | isProcessing 标志位 | 避免高频场景延迟 |
| 2026-07-07 | 爬虫库 | Puppeteer | axios + cheerio | 数据在 script 标签，无需 JS 执行 |

---

**最后更新**：2026-07-08  
**维护人**：Seraph
