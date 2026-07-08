# CLAUDE.md

此文件为 Claude Code (claude.ai/code) 在本仓库中工作时提供指导。

## 项目概述

Apple 订单管理系统 - 自动化监控邮件并同步通过 NULL AOS Helper（第三方预约服务）下单的 Apple 产品订单。

**核心工作流**: 邮件到达 → 解析订单信息 → 存储到 PostgreSQL → 爬取 Apple 官网获取详情 → 定期更新订单状态

## 系统架构

### 三层系统架构

1. **邮件层** (`services/emailParser.js`)
   - 使用 IMAP IDLE 实现实时监控（<10秒响应）
   - 解析 NULL AOS Helper 邮件（Base64 编码）
   - 提取：Apple ID、订单号、商品、取机人信息、付款方式
   - **多商品支持**：商品之间用 `@` 符号分隔

2. **爬虫层** (`crawler/order_parser.js`)
   - 使用 axios + cheerio 爬取 Apple 订单页面
   - 从 `<script>` 标签中提取 JSON（无需执行 JavaScript）
   - **反爬策略**：代理池 + 5-10秒请求延迟
   - 获取：订单状态、商品图片、取货门店、配送信息

3. **API 层** (计划中，位于 `src/`)
   - Express.js RESTful API
   - 通过 Sequelize ORM 操作 PostgreSQL
   - 管理：Apple ID、取机人、订单

### 数据流

```
邮件到达 → emailParser (提取字段) → 数据库 (初始插入)
   ↓
触发爬虫 → order_parser (补充数据) → 数据库 (更新)
   ↓
定时任务 → 重新爬取状态更新 → 数据库 (同步)
```

## 关键设计决策

### 多商品订单格式

**邮件格式**:
```
型号1-产品1 x 数量1@型号2-产品2 x 数量2/取机人/身份证后四位/付款方式/-/-/标签
```

示例:
```
MG714CH/A-iPhone 17 鼠尾草绿色 256G x 2@HNPW2ZM/A-Belkin挂绳 x 1/冉念/5904/支付宝/-/-/水果惠
```

**解析规则**: 用 `@` 分隔商品；取机人信息在最后一个商品之后。

### 数据权威性

| 字段 | 数据来源 | 权威性 | 原因 |
|------|---------|-------|------|
| 商品数量 | 邮件 | **权威** | Apple 官网取消订单后显示为 0 |
| 订单状态 | 官网 | **权威** | 实时状态 |
| Apple ID | 邮件 | 唯一来源 | 官网无此信息 |
| 取机人信息 | 邮件 | 唯一来源 | 官网无此信息 |
| 商品图片 | 官网 | 唯一来源 | 邮件无图片 |

### 反爬策略

- **IP 轮换**: 使用代理池（推荐快代理，¥50-200/月）
- **请求延迟**: 请求间隔 5-10 秒
- **频率阈值**: 每个 IP 每分钟 <10 次请求
- **错误处理**: HTTP 541 = 触发风控 → 切换代理

## 开发命令

```bash
# 安装依赖
npm install

# 开发模式（带热重载）
npm run dev

# 生产模式
npm start

# 测试邮件解析器
node test/test_parser.js

# 测试爬虫
node test/test_crawler.js
```

## 数据库设计

**⚠️ 权威文档: `docs/database/SCHEMA.md` 是官方数据库设计规范**

所有数据库相关开发必须遵循 `docs/database/SCHEMA.md`:
- Sequelize 模型定义
- 迁移文件
- 表结构查询
- 索引优化

5 个核心表:
- `apple_ids`: Apple 账号管理
- `recipients`: 取机人管理  
- `orders`: 订单主表（JSONB 存储商品数组）
- `email_logs`: 邮件处理历史
- `crawl_logs`: 爬虫执行日志

**JSONB 存储**: 商品以 JSON 数组形式存储，支持每个订单包含不同数量的商品。

**快速参考**: 查看 `docs/database/SCHEMA.md` 获取完整的表定义、字段类型、索引、关系和查询示例。

## 关键实现要点

### 邮件解析 (`services/emailParser.js`)

- 邮件内容是 **Base64 编码的 UTF-8**
- 必须处理 HTML 实体（`&nbsp;`, `<br />`）
- 订单链接格式: `https://www.apple.com.cn/xc/cn/vieworder/{W订单号}/{邮箱}`
- 多商品: 使用正则表达式配合 `@` 分隔，从最后一段提取取机人信息

### 订单爬取 (`crawler/order_parser.js`)

- **无需 Puppeteer**: 数据在 HTML `<script>` 标签中，非动态渲染
- **JSON 提取**: 查找包含 `orderItem-` 关键字的 script 标签
- **控制字符处理**: JSON.parse 之前先移除 `\x00-\x1F\x7F`
- **商品迭代**: 遍历 `orderItems.c[]` 数组，然后访问每个 `orderItem-XXXXXXX` 键
- **降级方案**: 如果 JSON 提取失败，直接解析 HTML 获取关键字段

### 代理配置

设置环境变量:
```bash
PROXY_API_URL=https://api.kdlapi.com/...
PROXY_API_KEY=your_key_here
```

在爬虫服务中实现轮换，而不是在请求级别。

## 文档

`docs/` 目录下有完整的技术文档（按类别组织）:

### 设计文档 (`docs/design/`)
- `architecture.md`: 系统架构和概述
- `email-parser.md`: 邮件解析 + 数据提取能力（13 个字段）
- `order-crawler.md`: 爬虫策略 + 数据整合（11 个字段）
- `api-design.md`: RESTful 接口设计
- `email-processing.md`: IMAP 监控和邮件处理流程

### 数据库文档 (`docs/database/`)
- **`SCHEMA.md`**: ✅ **官方数据库设计规范**（所有模型必须遵循此文档）
- `snapshot-matching.md`: 订单快照和自动匹配机制

### 开发文档 (`docs/development/`)
- **`CODING_STANDARDS.md`**: ✅ **编码规范和最佳实践**（强制遵守）
- `DEVELOPMENT_PROGRESS.md`: 开发进度跟踪
- `NOTIFICATION_GUIDE.md`: 通知机制指南
- `history/`: 历史记录和技术决策

**编码前请先阅读** - 这些文档包含详细的正则表达式模式、错误处理策略和测试用例。

## 开发阶段（来自文档）

1. **第一阶段**（2周）: 邮件监控 + 解析器 + 爬虫 + 基础 API
2. **第二阶段**（1周）: 前端（React + Ant Design）
3. **第三阶段**（1周）: 部署（Docker + PM2 + Nginx）

当前状态: **第 0 阶段 - 文档完成，准备开始实现**

## 开发进度跟踪

**强制要求**: 完成每个开发阶段后，必须更新进度文档（`docs/development/DEVELOPMENT_PROGRESS.md`），包含:

- **当前阶段**: 刚刚完成的阶段/步骤
- **已完成功能**: 已实现功能/模块的详细列表
- **关键实现笔记**: 重要的技术决策、权衡或注意事项
- **下一步计划**: 接下来需要完成的工作
- **阻塞问题**: 任何未解决的问题或依赖

此文档是开发进度的唯一真相来源，有助于在开发会话之间保持连续性。

## 环境配置

所需服务:
- PostgreSQL 14+（本地或云端）
- 代理服务 API（用于生产环境爬虫）
- IMAP 邮箱账号（QQ/163/Gmail）

所需环境变量:
- `DATABASE_URL`: PostgreSQL 连接字符串
- `IMAP_HOST`, `IMAP_USER`, `IMAP_PASSWORD`: 邮件监控
- `PROXY_API_URL`, `PROXY_API_KEY`: 代理池
- `PORT`: API 服务器端口（默认 3000）

---

## ⚠️ 编码规范 - 强制要求

**所有代码必须遵循 `docs/development/CODING_STANDARDS.md` 中定义的编码规范**

这是**阻塞性要求**。任何违反这些规范的代码都将被拒绝。

### 关键规则（必须遵守）

1. **命名规范**
   - 变量/函数: `camelCase`（例如 `parseEmail`, `orderNumber`）
   - 类/模型: `PascalCase`（例如 `EmailParser`, `Order`）
   - 常量: `UPPER_SNAKE_CASE`（例如 `MAX_RETRY`, `REQUEST_DELAY`）
   - 文件: `camelCase` 或 `kebab-case`（新文件使用 `camelCase`，遗留的 `order_parser.js` 是例外）

2. **错误处理**
   - 所有 async 函数必须有 try-catch
   - 记录错误时带上下文: `logger.error('message', { orderNumber, error })`
   - 使用结构化日志（Winston），永远不要用 `console.log`

3. **数据库操作**
   - 多表操作使用事务
   - 避免 N+1 查询（使用 `include` 进行预加载）
   - 在数据库操作前验证所有外部输入

4. **爬虫反爬**
   - 必须在请求之间有 5-10 秒延迟
   - 必须使用代理池轮换
   - 处理 HTTP 541 错误（风控）并切换代理
   - 包含重试逻辑，最多 3 次尝试

5. **代码质量**
   - 提交前运行 `npm run lint`
   - 运行 `npm run format` 自动修复格式问题
   - 为核心业务逻辑编写单元测试（目标 >70% 覆盖率）
   - 为所有导出的函数添加 JSDoc 注释

### 编写代码前快速检查

实现任何功能时，请验证:
- [ ] 阅读 `docs/development/CODING_STANDARDS.md` 了解详细规则
- [ ] 理解本项目的特定编码模式
- [ ] 使用 `logger` 而不是 `console.log`
- [ ] 添加 try-catch 错误处理
- [ ] 数据库操作使用事务
- [ ] 遵循命名规范（变量/函数使用 camelCase）
- [ ] 为导出的函数添加 JSDoc 注释
- [ ] 为业务逻辑编写单元测试

### 示例: 正确的代码模式

```javascript
const logger = require('../utils/logger');
const { Order, AppleId, sequelize } = require('../models');

/**
 * 保存订单及关联数据
 * @param {Object} orderData - 订单数据对象
 * @returns {Promise<Object>} 创建的订单对象
 * @throws {Error} 当数据验证失败或数据库操作失败时
 */
async function saveOrderWithRelations(orderData) {
  const transaction = await sequelize.transaction();
  
  try {
    // 验证输入
    if (!orderData.orderNumber || !/^W\d{9}$/.test(orderData.orderNumber)) {
      throw new Error('订单号格式无效');
    }
    
    // 创建关联数据
    const [appleId] = await AppleId.findOrCreate({
      where: { email: orderData.appleId },
      defaults: { email: orderData.appleId },
      transaction
    });
    
    // 创建订单
    const order = await Order.create({
      orderNumber: orderData.orderNumber,
      appleIdId: appleId.id,
      products: orderData.products,
      status: 'pending'
    }, { transaction });
    
    await transaction.commit();
    
    logger.info('订单保存成功', { 
      orderNumber: order.orderNumber,
      productCount: order.products.length 
    });
    
    return order;
    
  } catch (error) {
    await transaction.rollback();
    logger.error('订单保存失败', {
      orderNumber: orderData.orderNumber,
      error: error.message,
      stack: error.stack
    });
    throw error;
  }
}

module.exports = { saveOrderWithRelations };
```

### 错误示例（不要这样做）

```javascript
// ❌ 错误: 没有错误处理、使用 console.log、使用 snake_case 命名
function save_order(order_data) {
  console.log('saving order');
  const order = Order.create(order_data);  // 没有 await，没有 try-catch
  return order;
}

// ❌ 错误: 没有事务、没有验证、日志记录不规范
async function saveOrder(data) {
  const order = await Order.create(data);
  console.log('done');
  return order;
}
```

### 提交代码前

运行这些命令确保代码质量:

```bash
# 检查编码规范
npm run lint

# 自动修复格式问题
npm run lint:fix
npm run format

# 运行测试
npm test

# 所有检查必须通过才能 git commit
```

**记住**: 编码规范文档（`docs/development/CODING_STANDARDS.md`）是真相来源。有疑问时，请参考它！

---

## 🔄 文件变更级联规则

当修改某个文件时，必须遵循级联更新规则，确保文档与代码的一致性。

### 规则 1: 数据库表结构变更

**触发条件**: 修改数据库表字段、添加/删除字段、修改字段类型/约束

**必须更新的文件（按顺序）**:

1. **`docs/database/SCHEMA.md`** ⚠️ 权威文档 - **先更新这个**
   - 更新表定义、字段说明、约束、索引
   - 更新查询示例（如果受影响）

2. **Sequelize Model 文件** (`src/models/*.js`)
   - 更新模型定义，与 SCHEMA.md 保持一致
   - 更新字段验证规则

3. **Migration 迁移文件** (`migrations/*.js`)
   - 创建新的迁移文件
   - 包含 up 和 down 方法

4. **API 接口文档** (`docs/design/api-design.md`)
   - 如果字段在 API 中暴露，更新请求/响应示例
   - 更新字段说明

5. **API Controller** (`src/controllers/*.js`)
   - 如果接口需要处理新字段，更新控制器逻辑
   - 添加字段验证

6. **前端类型定义** (`frontend/src/types/*.ts` - 如果有前端)
   - 更新 TypeScript 接口定义

7. **测试用例** (`test/**/*.js`)
   - 添加新字段的单元测试
   - 更新集成测试

8. **`docs/development/DEVELOPMENT_PROGRESS.md`**
   - 记录变更内容、原因、影响范围

**验证清单**:
```bash
# 1. 运行迁移
npm run db:migrate

# 2. 运行测试
npm test

# 3. 检查代码规范
npm run lint

# 4. 验证文档一致性
# 手动对比 SCHEMA.md 与 Model 定义
```

### 规则 2: API 接口变更

**触发条件**: 添加/修改/删除 API 接口、修改请求/响应格式

**必须更新的文件**:

1. **`docs/design/api-design.md`** - **先更新文档**
   - 更新接口定义、参数说明、响应示例

2. **API Router** (`src/routes/*.js`)
   - 添加/修改路由定义

3. **API Controller** (`src/controllers/*.js`)
   - 实现业务逻辑

4. **API 测试** (`test/api/*.js`)
   - 添加接口测试用例

5. **前端 API 调用** (`frontend/src/api/*.ts` - 如果有)
   - 更新 API 调用代码

6. **`docs/development/DEVELOPMENT_PROGRESS.md`**
   - 记录 API 变更

### 规则 3: 业务逻辑变更

**触发条件**: 修改邮件解析规则、爬虫逻辑、数据处理流程

**必须更新的文件**:

1. **技术方案文档** (`docs/design/email-parser.md` 或 `order-crawler.md`)
   - 更新解析规则、正则表达式、处理流程

2. **实现代码** (`services/*.js` 或 `crawler/*.js`)
   - 修改业务逻辑

3. **测试用例** (`test/**/*.js`)
   - 更新测试用例和测试数据

4. **`docs/development/DEVELOPMENT_PROGRESS.md`**
   - 记录逻辑变更原因

### 规则 4: 编码规范变更

**触发条件**: 修改编码规范、ESLint 规则、命名约定

**必须更新的文件**:

1. **`docs/development/CODING_STANDARDS.md`** ⚠️ 权威文档
   - 更新规范说明

2. **配置文件** (`.eslintrc.json`, `.prettierrc`)
   - 更新工具配置

3. **CLAUDE.md**
   - 同步更新编码规范章节的示例

4. **现有代码**
   - 逐步重构以符合新规范（创建任务清单）

### 强制执行机制

#### 1. Pre-commit Hook

创建 `.husky/pre-commit` 检查文件一致性：

```bash
#!/bin/sh
# 检查 SCHEMA.md 是否比 Model 文件新
# 如果修改了 Model 但未更新 SCHEMA.md，阻止提交

SCHEMA_MODIFIED=$(git diff --cached --name-only | grep "docs/database/SCHEMA.md")
MODEL_MODIFIED=$(git diff --cached --name-only | grep "src/models/")

if [ -n "$MODEL_MODIFIED" ] && [ -z "$SCHEMA_MODIFIED" ]; then
  echo "❌ 错误: 修改了 Model 文件但未更新 docs/database/SCHEMA.md"
  echo "请先更新权威文档 SCHEMA.md，然后再提交代码"
  exit 1
fi
```

#### 2. Pull Request 模板

创建 `.github/pull_request_template.md`：

```markdown
## 变更类型
- [ ] 数据库表结构变更
- [ ] API 接口变更
- [ ] 业务逻辑变更
- [ ] 编码规范变更

## 级联更新检查清单

### 如果是数据库变更
- [ ] 已更新 `docs/database/SCHEMA.md`
- [ ] 已更新 Sequelize Model
- [ ] 已创建 Migration 文件
- [ ] 已更新 API 文档（如需要）
- [ ] 已更新测试用例
- [ ] 已更新 DEVELOPMENT_PROGRESS.md

### 如果是 API 变更
- [ ] 已更新 `docs/design/api-design.md`
- [ ] 已实现 Controller 逻辑
- [ ] 已添加 API 测试
- [ ] 已更新 DEVELOPMENT_PROGRESS.md

## 测试结果
- [ ] 所有测试通过 (`npm test`)
- [ ] 代码规范检查通过 (`npm run lint`)
- [ ] 本地验证通过
```

#### 3. CI/CD 检查

在 GitHub Actions 中添加文档一致性检查：

```yaml
# .github/workflows/doc-consistency.yml
name: 文档一致性检查

on: [pull_request]

jobs:
  check-consistency:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      
      - name: 检查 Model 与 SCHEMA.md 一致性
        run: |
          # 提取 SCHEMA.md 中的表定义
          # 对比 src/models/ 中的 Model 定义
          # 如果不一致，失败并输出差异
          node scripts/check-schema-consistency.js
```

### 变更影响分析表

| 变更类型 | 影响文件数 | 优先级 | 验证方法 |
|---------|-----------|-------|----------|
| 数据库表结构 | 6-8 个 | 🔴 高 | 运行迁移 + 测试 |
| API 接口 | 4-6 个 | 🟡 中 | API 测试 |
| 业务逻辑 | 3-4 个 | 🟡 中 | 单元测试 |
| 文档更新 | 1-2 个 | 🟢 低 | 人工审查 |

### 最佳实践

1. **先文档，后代码**
   - 修改任何权威文档（SCHEMA.md, CODING_STANDARDS.md）前，先讨论并达成一致
   - 文档更新后，再开始写代码

2. **小步提交**
   - 每次 commit 只包含一个逻辑变更
   - 便于回滚和追溯

3. **使用 DEVELOPMENT_PROGRESS.md**
   - 每次开发会话结束前，更新进度文档
   - 记录"为什么这样改"，不只是"改了什么"

4. **定期审查**
   - 每周检查文档与代码的一致性
   - 使用脚本自动化检查（见上方 CI/CD 示例）
