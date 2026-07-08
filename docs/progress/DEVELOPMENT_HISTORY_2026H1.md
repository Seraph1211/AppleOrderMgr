# Apple Order Manager 开发历史归档（2026 上半年）

本文档归档 2026-07-06 至 2026-07-07 期间的详细开发记录。

**归档说明**：
- 当前进度请查看：`docs/DEVELOPMENT_PROGRESS.md`
- 技术决策请查看：`docs/progress/TECHNICAL_DECISIONS.md`

---

## 📊 Milestone 1: 基础设施搭建 ✅ (2026-07-06)

### 完成时间
2026-07-06

### 完成内容

#### 1.1 目录结构创建
- ✅ 创建项目标准目录结构
  - `src/` - 源代码目录
  - `src/models/` - 数据库模型
  - `src/routes/` - API 路由
  - `src/controllers/` - 业务控制器
  - `src/services/` - 业务服务层
  - `src/utils/` - 工具函数
  - `config/` - 配置文件
  - `logs/` - 日志文件
  - `test/` - 测试文件

#### 1.2 核心工具模块实现

##### ✅ Logger 工具 (`src/utils/logger.js`)
**功能**：基于 Winston 的结构化日志系统

**特性**：
- 支持多级别日志：error、warn、info、debug
- 结构化 JSON 日志格式，便于查询和分析
- 日志文件自动分割（error.log、combined.log）
- 文件大小限制（5MB/文件）和自动轮转（最多保留 5/10 个文件）
- 开发环境自动输出到控制台
- 生产环境仅写入文件

##### ✅ Config 配置管理器 (`src/utils/config.js`)
**功能**：统一管理环境变量和应用配置

**配置项分类**：
1. 应用配置（环境、端口、日志级别）
2. 数据库配置（连接信息、连接池）
3. IMAP 邮件配置（服务器、认证）
4. 爬虫配置（延迟、重试、超时）
5. 代理池配置（API、刷新间隔）
6. 定时任务配置（订单同步、代理刷新）

##### ✅ ProxyManager 代理池管理器 (`src/utils/proxyManager.js`)
**功能**：管理爬虫代理池，支持代理轮换、健康检查、自动刷新

**核心功能**：
- 代理加载（从 API 获取）
- 代理轮换（轮询策略）
- 健康管理（标记失效代理，自动恢复）
- 状态监控（总数、可用数、坏代理数）
- 自动刷新（定时从 API 重新加载）

##### ✅ Helpers 通用工具函数 (`src/utils/helpers.js`)
**功能**：提供项目中常用的工具函数

**函数分类**：
- 异步控制：sleep、retryWithBackoff
- 验证函数：isValidOrderNumber、isValidEmail
- 字符串处理：removeControlCharacters、decodeHTMLEntities、stripHTMLTags
- 数据处理：safeJSONParse、deepClone
- 其他工具：formatBytes、generateRandomString

---

## 📊 Milestone 1.1: 数据库设计调整 ✅ (2026-07-06)

### 完成内容

根据实际业务表（人头信息表、AppleID表、宽表）调整数据库设计，生成最终版 `DATABASE_SCHEMA.md`

#### 1. apple_ids 表优化 ✅
**新增字段**：
- `password` VARCHAR(255) - 密码（明文存储）
- `security_qa` JSONB - 密保问答（3个问题+答案）
- `country` VARCHAR(50) - 国家地区
- `is_modified` BOOLEAN - 是否已修改国家及手机
- `status` VARCHAR(20) - 使用状态

#### 2. recipients 表大幅优化 ✅
**字段拆分**：
- `name` → `last_name` + `first_name`

**新增身份信息**：
- `id_card_number` VARCHAR(18) - 完整身份证号
- `id_card_last4` VARCHAR(4) - 身份证后四位（冗余，自动提取）
- `email` VARCHAR(255) - 下单邮箱

**新增地址信息**：
- `province` / `city` / `district` / `street_address` - 地址拆分存储

**新增绑定字段（宽表功能）**：
- `bound_apple_id` VARCHAR(255) - 绑定的 Apple ID（冗余）
- `bound_apple_password` VARCHAR(255) - 绑定的密码（冗余）
- `apple_id_ref` INT - 关联 apple_ids.id（外键）

**唯一约束调整**：
- 从 `UNIQUE(name, id_card_last4)` 改为 `UNIQUE(id_card_number)`

#### 3. 触发器机制 ✅
**自动同步触发器**：
```sql
-- 1. 提取身份证后四位
CREATE TRIGGER trigger_recipients_id_card_last4
BEFORE INSERT OR UPDATE ON recipients
EXECUTE FUNCTION auto_extract_id_card_last4();

-- 2. 同步绑定的 Apple ID 信息
CREATE TRIGGER trigger_sync_bound_apple_id
BEFORE INSERT OR UPDATE OF apple_id_ref ON recipients
EXECUTE FUNCTION sync_bound_apple_id_info();

-- 3. Apple ID 密码修改时同步到 recipients
CREATE TRIGGER trigger_sync_password_to_recipients
AFTER UPDATE ON apple_ids
EXECUTE FUNCTION sync_apple_password_to_recipients();
```

---

## 📊 Milestone 1.2: 数据库模型和迁移文件完善 ✅ (2026-07-06)

### 完成内容

#### 1. EmailLog 和 CrawlLog 修复 ✅

**新增字段**：
- EmailLog: `raw_content` TEXT - 原始邮件内容（Base64编码）
- CrawlLog: `raw_html` TEXT - 原始网页HTML内容

**业务价值**：
- 保存原始数据源，便于调试
- 支持重新解析功能
- 提供数据审计能力

#### 2. AppleId 模型字段类型调整 ✅

| 字段 | 修改前 | 修改后 | 原因 |
|------|--------|--------|------|
| `apple_id` | STRING(100) | STRING(255) | 符合 Schema 规范 |
| `password` | STRING(100), nullable | STRING(255), NOT NULL | 密码为必填 |
| `nickname` | STRING(100) | STRING(255) | 统一长度标准 |
| `security_qa` | TEXT + JSON 序列化 | JSONB（原生） | PostgreSQL 原生支持，性能更好 |
| `country` | STRING(10) | STRING(50) | 支持完整国家名称 |

---

## 📊 Milestone 1.3: 数据库迁移测试 ✅ (2026-07-07)

### 完成内容

#### 1. 环境配置 ✅
- 配置 `.env` 文件
- 数据库用户：`seraph`（MacOS 本地用户）
- 移除密码配置（本地 PostgreSQL 无需密码）

#### 2. 迁移执行 ✅
执行了 5 个迁移文件：
1. `20260706000001-create-apple-ids.js`
2. `20260706000002-create-recipients.js`
3. `20260706000003-create-orders.js`
4. `20260706000004-create-email-logs.js`
5. `20260706000005-create-crawl-logs.js`

**迁移结果**：
- 5 张业务表创建成功
- 所有索引创建成功
- 所有外键约束创建成功
- 所有触发器创建成功

#### 3. 表结构验证 ✅
- ✅ apple_ids: 10 字段，4 索引
- ✅ recipients: 19 字段，8 索引，1 触发器
- ✅ orders: 20 字段，11 索引，2 外键
- ✅ email_logs: 16 字段，10 索引
- ✅ crawl_logs: 15 字段，9 索引

---

## 📊 Milestone 3: 邮件服务开发 ✅ (2026-07-07)

### 完成内容

#### 1. 邮件解析器 (`src/services/emailParser.js`) ✅

**核心功能**：
- 解析 NULL AOS Helper 订单通知邮件
- 支持单商品和多商品订单（@ 分隔符）
- 提取 13 个关键字段
- Base64 编码处理
- HTML 实体解码
- 处理邮件换行符导致的文本截断问题

**提取的字段**：
1. Apple ID、订单号、订单链接、预订时间
2. 产品型号、名称、数量（支持多个）
3. 收件人姓名、身份证后四位
4. 付款方式、订单标签
5. 邮件主题、发件人

**关键技术点**：
```javascript
// 处理换行符防止文本截断
cleanText = cleanText.replace(/\n+/g, ' ').replace(/\s+/g, ' ');

// 支持多商品解析
const productItems = productsSection.split('@');
const productRegex = /([A-Z0-9\/]+)\s*-\s*(.+?)\s+x\s+(\d+)$/;
```

#### 2. 邮件监听服务 (`src/services/emailService.js`) ✅

**核心功能**：
- IMAP IDLE 长连接监听
- 实时接收新邮件通知
- 自动处理未读邮件
- 邮件过滤（只处理订单邮件）
- 自动标记为已读
- 连接断开自动重连（30秒延迟）
- 完整的错误处理和日志记录

#### 3. 订单服务 (`src/services/orderService.js`) ✅

**核心功能**：
- 从邮件数据创建订单
- 自动创建或匹配 Apple ID
- 自动创建或匹配收件人
- 事务处理保证数据一致性
- 创建邮件处理日志

#### 4. 单元测试 (`test_email_parser.js`) ✅
- 测试 1：单商品订单解析 ✅
- 测试 2：多商品订单解析 ✅

---

## 📊 Milestone 4: 订单爬虫服务开发 ✅ (2026-07-07)

### 完成内容

#### 1. 爬虫服务 (`src/services/crawlerService.js`) ✅

**核心功能**：
- 从 Apple 订单页面 HTML 提取 JSON 数据
- 解析订单状态、商品信息、取货门店
- 集成代理池（可选）
- 反爬虫策略：5-10 秒随机延迟 + 最多 3 次重试
- HTTP 541 风控检测，自动切换代理
- 数据库事务：爬取结果写入 orders 和 crawl_logs

**导出函数**：
- `fetchOrderPage()` - HTTP 请求获取页面
- `extractOrderJson()` - 从 `<script>` 提取 JSON
- `parseOrderData()` - 解析结构化数据
- `fetchWithRetry()` - 带重试和代理切换
- `crawlAndUpdateOrder()` - 爬取并更新订单（含事务）
- `crawlMultipleOrders()` - 批量爬取

**关键技术点**：
```javascript
// 控制字符清理
const cleaned = scriptContent.trim()
  .replace(/[\x00-\x1F\x7F]/g, '')
  .replace(/\n/g, ' ');

// 产品数据合并策略（邮件数量权威，网站状态权威）
updateData.products = order.products.map(emailProduct => {
  const crawledProduct = crawledData.products.find(p => p.model === emailProduct.model);
  return crawledProduct 
    ? { ...emailProduct, quantity: emailProduct.quantity, status: crawledProduct.status }
    : emailProduct;
});
```

#### 2. 测试脚本 (`test_crawler.js`) ✅
- 测试 3：数据库更新流程 ✅ **通过**
- 验证项：AppleId/Recipient/Order 创建、事务回滚

---

## 📊 Milestone 5: API 接口开发 ✅ (2026-07-07)

### 完成内容

#### 1. Express 服务器搭建 ✅

**`src/app.js`**：
- JSON body 解析（limit 1mb）
- CORS 配置
- `requestLogger` HTTP 访问日志
- `errorHandler` 统一错误处理
- 404 兜底
- 优雅关闭（SIGINT/SIGTERM）

**中间件**：
- `requestLogger` - 计算耗时，记录 method/url/status
- `errorHandler` - 识别 ApiError/Sequelize 错误，开发模式附带 stack

#### 2. API 路由实现 ✅

**订单模块** (`src/controllers/orderController.js`)：
- `listOrders` - 分页列表 + 多条件筛选
- `getOrderDetail` - 订单详情（含关联）
- `refreshOrder` - 单条订单刷新
- `batchRefresh` - 批量刷新

**Apple ID 模块** (`src/controllers/appleIdController.js`)：
- CRUD 全套接口
- 密码字段脱敏（响应中删除）
- 聚合计数（order_count / recipient_count）

**收件人模块** (`src/controllers/recipientController.js`)：
- CRUD 全套接口
- 分页 + 多条件筛选
- 聚合计数（order_count）

**统计分析模块** (`src/controllers/statsController.js`)：
- `getOverview` - 概览统计（6 个状态分布）
- `getAppleIdStats` - Apple ID 聚合
- `getRecipientStats` - 收件人聚合
- `getProductStats` - 产品统计（JSONB 数组展开）

#### 3. 工具与响应封装 ✅
- `ApiError` - 自定义错误类型
- `apiResponse` - 统一响应格式
- `asyncHandler` - Promise 错误传递

---

## 📊 Milestone 5.1: Lint 修复与 API 冒烟测试 ✅ (2026-07-07)

### 完成内容

#### 1. ESLint error 修复 ✅
- 移除未使用变量和 import
- 修复正则表达式转义
- 修复 `hasOwnProperty` 直接访问
- 为 migrations 增加 snake_case override
- 增加 `.eslintignore`

**验证结果**：
```bash
npx eslint src --ext .js --quiet
# 通过，无输出
```

#### 2. API 服务启动验证 ✅

**健康检查**：
```bash
curl http://localhost:3000/api/health
```

**结果**：
```json
{
  "success": true,
  "data": {
    "service": "apple-order-manager",
    "status": "healthy",
    "db": "ok"
  }
}
```

#### 3. 核心接口冒烟测试 ✅
- `GET /api/health` ✅
- `GET /api/orders` ✅
- `GET /api/apple-ids` ✅
- `GET /api/recipients` ✅
- `GET /api/stats/overview` ✅

---

## 📊 Milestone 5.2: 数据库同步触发器补齐 ✅ (2026-07-07)

### 完成内容

#### 1. 新增触发器迁移 ✅

**新增文件**：
- `migrations/20260707000001-add-recipient-apple-sync-triggers.js`

**新增触发器函数**：
- `sync_bound_apple_id_info()` - recipients.apple_id_ref 变更时同步
- `sync_apple_password_to_recipients()` - apple_ids 更新时反向同步

**触发器**：
```sql
CREATE TRIGGER trigger_sync_bound_apple_id
BEFORE INSERT OR UPDATE OF apple_id_ref ON recipients
FOR EACH ROW
EXECUTE FUNCTION sync_bound_apple_id_info();

CREATE TRIGGER trigger_sync_password_to_recipients
AFTER UPDATE OF apple_id, password ON apple_ids
FOR EACH ROW
EXECUTE FUNCTION sync_apple_password_to_recipients();
```

#### 2. 验证结果 ✅
- 迁移执行成功
- 触发器同步冒烟测试通过
- ESLint 检查通过

---

## 📊 Milestone 3.1: 邮件处理方案优化 ✅ (2026-07-07)

### 完成内容

#### 1. 方案讨论与确定 ✅

**最终确定方案**：
- ✅ IMAP IDLE 触发时搜索 `['UNSEEN']` 未读邮件
- ✅ 取消防抖机制，改用 `isProcessing` 标志位
- ✅ 订单邮件处理成功后标记为已读
- ✅ 非订单邮件和失败邮件保持未读
- ✅ 定时回溯：每 10 分钟回溯 30 分钟
- ✅ 服务启动：回溯 24 小时

#### 2. 核心机制设计 ✅

**并发控制（isProcessing 标志位）**：
```
IDLE 触发 → 检查 isProcessing 
  ↓
YES → 直接返回
NO  → isProcessing = true → 处理
  ↓
处理完成 → isProcessing = false → 检查未读
```

**选择性标记已读策略**：
- 订单邮件（成功）→ ✅ 标记已读
- 订单邮件（失败）→ ❌ 保持未读（支持重试）
- 非订单邮件 → ❌ 保持未读（不干预用户）

#### 3. 性能指标 ✅
- 单封邮件响应：2-5 秒 ✅
- 100 封邮件首封：立即响应 ✅
- 100 封邮件末封：40-60 秒 ✅

---

## 技术决策记录

### 1. 日志系统
- **选择**：Winston
- **原因**：结构化日志、多输出目标、自动轮转

### 2. 配置管理
- **选择**：集中式配置 + 环境变量
- **原因**：避免配置散落、敏感信息保护

### 3. 代理池设计
- **选择**：单例模式 + 轮询策略 + 自动恢复
- **原因**：Apple 网站反爬虫机制严格

### 4. 爬虫库选择
- **选择**：axios + cheerio（而非 Puppeteer）
- **原因**：订单数据在 `<script>` 标签中，无需 JS 执行

### 5. 数据权威性
- **邮件权威**：Apple ID、收件人信息、产品数量
- **网站权威**：订单状态、产品状态、产品图片

### 6. 邮件处理方案
- **选择**：标志位 + 选择性标记已读
- **原因**：避免防抖导致的长延迟，性能最优

---

**归档时间**：2026-07-08  
**归档人**：Seraph  
**状态**：已完成归档
