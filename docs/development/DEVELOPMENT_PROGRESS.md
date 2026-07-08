# Apple Order Manager 开发进度

> **当前阶段**：Phase 1 - 核心功能开发  
> **最后更新**：2026-07-08  
> **项目状态**：✅ 后端核心完成，🔴 等待前端 Excel 导入功能

---

## 📍 当前状态概览

### Phase 进度
- **Phase 1（核心功能开发）**：90% 完成
  - ✅ 数据库层（含快照模式）
  - ✅ 邮件监听和解析服务
  - ✅ 订单爬虫服务
  - ✅ RESTful API（14 个端点）
  - 🔴 前端 Excel 导入功能（阻塞项）

### 待办清单（按优先级）

#### 🔴 P0 - 阻塞项（必须完成才能继续）
- [ ] **前端 Excel 导入功能** - 导入 Apple IDs 和 recipients 基础数据
  - [ ] 设计 Excel 模板格式
  - [ ] 实现文件上传接口
  - [ ] 实现 Excel 解析（xlsx 库）
  - [ ] 实现数据校验（邮箱/身份证/手机）
  - [ ] 实现导入预览
  - [ ] 实现批量导入（findOrCreate）
  - [ ] 实现错误反馈

#### 🟡 P1 - 重要（完成前端导入后）
- [ ] **真实邮件链路验证** - 配置 IMAP，测试邮件→解析→入库→查询
- [ ] **真实订单爬取验证** - 配置真实订单号，验证 `parseOrderData` 字段路径
- [x] **代理池配置** - ✅ 已完成快代理私密代理配置（2026-07-08）

#### 🟢 P2 - 优化（有空再做）
- [ ] Jest 标准测试补齐
- [ ] 邮件方案优化实施（标志位+选择性已读）
- [ ] ESLint warnings 清理

### 阻塞问题
1. **前端 Excel 导入功能缺失** 🔴
   - 影响：无法导入真实的 Apple IDs 和 recipients 数据
   - 后果：邮件到达时无法自动匹配，订单外键为 NULL
   - 解决方案：优先开发前端上传页面

2. **真实凭证未配置** 🟡
   - ~~代理池配置~~（✅ 已完成）
   - IMAP 账号已配置（18874504636@163.com）
   - 测试订单号未配置（需要真实 Apple 订单）

---

## 🔥 最近完成的工作

### Milestone 5.6: 订单号验证修复完成 ✅ (2026-07-08)

**核心成果**：修复订单号验证规则，支持 10 位数字订单号；完善商品型号提取逻辑。

#### 1. 问题发现
- ❌ **订单号验证错误**：旧规则只支持 W + 9 位数字，实际订单号是 W + 10 位
  - 错误示例：`W1779769040`（10 位）被拒绝
  - 错误正则：`/^W\d{9}$/`
- ❌ **商品型号缺失**：Apple 官网订单 JSON 中不包含 `partNumber` 等型号字段
  - 实际字段：`productName`、`quantity`、`imageUrl`
  - 缺失字段：`partNumber`、`sku`、`modelNumber`

#### 2. 修复内容

**任务 1：订单号验证修复**
```javascript
// SCHEMA.md - 更新文档说明
order_number: VARCHAR(50) // Apple订单号（W+10位数字）

// Order.js - 更新验证正则
validate: {
  is: {
    args: /^W\d{10}$/,  // 改为 10 位
    msg: '订单号必须是W开头后跟10位数字'
  }
}
```

**任务 2：商品型号提取优化**
```javascript
// crawlerService.js - 添加说明和降级逻辑
// ⚠️ Apple 官网订单详情页不包含型号字段
// 型号只能从邮件中的商品字符串提取（格式：MG714CH/A-商品名）
// 这里将 model 留空，由邮件解析器填充

let model = itemDetails.partNumber ||
           itemDetails.sku ||
           itemDetails.productId ||
           itemDetails.modelNumber || '';
```

#### 3. 测试验证
```bash
✅ 订单号 W1779769040 验证通过
✅ 真实订单爬取成功
✅ 提取字段：订单号、下单日期、订单状态、商品名称、数量、图片
⚠️  商品型号为空（符合预期，由邮件解析器提供）
```

#### 4. 级联更新（遵循文件变更规则）
- ✅ `docs/database/SCHEMA.md` - 权威文档先更新
- ✅ `src/models/Order.js` - 模型验证规则
- ✅ `src/services/crawlerService.js` - 型号提取逻辑
- ✅ `docs/development/DEVELOPMENT_PROGRESS.md` - 本文档

#### 5. 技术发现
- **Apple JSON 结构限制**：官网订单详情页的 JSON 不包含商品型号
- **数据来源分工**：
  - 邮件解析：Apple ID、取机人、商品型号、商品数量（权威）
  - 官网爬取：订单状态、商品图片、取货门店、配送信息（权威）
- **设计合理性验证**：快照模式设计正确，邮件数据和爬虫数据互补

#### 6. 代理消耗
- 本次测试消耗：6 个代理（3 初始 + 3 刷新）
- 当前剩余：**505 个** / 1000 个

**影响**：订单号验证不再阻塞真实订单处理，可以正常创建和爬取订单。

---

### Milestone 5.5: 代理池策略优化完成 ✅ (2026-07-08)

**核心成果**：优化代理池使用策略，实现智能刷新和累计失败废弃机制。

#### 1. 策略优化
- ✅ **环境区分**：开发环境每次 3 个，生产环境每次 10 个
- ✅ **使用范围**：严格限制在爬虫服务，其他服务禁止使用
- ✅ **失败策略**：累计失败 2 次永久废弃，永不恢复
- ✅ **刷新策略**：智能刷新，可用 < 30% 或 = 0 时才刷新
- ✅ **特殊处理**：HTTP 541 风控立即永久废弃

#### 2. 代码实现
```javascript
// 新增方法
proxyManager.recordProxyFailure(proxy)   // 累计失败计数
proxyManager.recordProxySuccess(proxy)   // 记录成功（不重置）
proxyManager.needsRefresh()              // 智能判断是否需要刷新

// 爬虫服务强制检查
if (!config.proxy.enabled) {
  throw new Error('爬虫服务必须启用代理池');
}
```

#### 3. 配置更新
```bash
# 新增配置项
PROXY_MAX_FAIL_COUNT=2           # 最大失败次数
PROXY_REFRESH_THRESHOLD=0.3      # 刷新阈值（30%）

# 开发环境：默认关闭，按需启用
PROXY_ENABLED=false
PROXY_NUM_PER_REQUEST=3

# 生产环境：自动启用
PROXY_ENABLED=true
PROXY_NUM_PER_REQUEST=10
```

#### 4. 代理消耗优化
**优化前**（全量定时刷新）：
- 开发环境：10 个/次，4 分钟刷新 → 160 个/小时 💸
- 1000 个可用约 6 小时

**优化后**（智能刷新）：
- 开发环境：3 个/次，10 分钟检查，仅需要时刷新 → 3-12 个/小时 ✅
- 1000 个可用约 58-234 小时（提升 10-40 倍）

#### 5. 已更新文件
- ✅ `src/utils/proxyManager.js` - 新增失败计数、智能刷新逻辑
- ✅ `src/utils/config.js` - 新增 maxFailCount、refreshThreshold 配置
- ✅ `src/services/crawlerService.js` - 强制检查代理、累计失败处理
- ✅ `.env` / `.env.example` - 更新配置说明
- ✅ `docs/development/PROXY_USAGE_GUIDE.md` - 完整策略文档

#### 6. 当前代理状态
- 总数量：1000 个
- 已使用：297 个
- 剩余：**703 个** ✅
- 策略版本：v2.0

**参考文档**：`docs/development/PROXY_USAGE_GUIDE.md`

---

### Milestone 5.4: 快代理私密代理池配置完成 ✅ (2026-07-08)

**核心成果**：成功配置快代理私密代理池，爬虫服务可以正常访问 Apple 官网。

#### 1. 代理池配置
- ✅ API 配置：使用快代理私密代理 API（`f_auth=1` 返回账密格式）
- ✅ 认证方式：账密模式（`ip:port:username:password`）
- ✅ 代理数量：1000 个私密代理，每次提取 10 个
- ✅ 自动刷新：每 4 分钟刷新（代理有效期 1-5 分钟）

#### 2. 测试结果
```
✅ 代理池初始化成功（10 个代理）
✅ 成功访问 Apple 官网（HTTP 200）
✅ 响应时间正常（1384ms）
✅ 内容验证通过
✅ 代理轮换机制正常
```

#### 3. 配置文件
```bash
# .env
PROXY_ENABLED=true
PROXY_API_URL=https://dps.kdlapi.com/api/getdps/?secret_id=xxx&signature=xxx&num=10&format=json&sep=1&dedup=1&f_auth=1
PROXY_SECRET_ID=oqulxixc9oevt458bjye
PROXY_SECRET_KEY=3dam61gsqj2envaoz55fl25zusoxs935
```

#### 4. 已实现功能
- ✅ `proxyManager.js` 支持快代理账密格式
- ✅ 自动解析 `ip:port:username:password` 格式
- ✅ 风控检测（HTTP 541）自动切换代理
- ✅ 坏代理标记与自动恢复
- ✅ 测试脚本：`test/test_proxy.js` 和 `test/test_proxy_apple.js`

#### 5. 关键技术点
- **账密格式**：必须添加 `f_auth=1` 参数，否则只返回 `ip:port`
- **有效期管理**：代理有效期 1-5 分钟，需要高频刷新
- **剩余配额**：剩余 925 个代理（共 1000 个）

**下一步**：配置真实订单号，验证完整爬虫流程。

---

### Milestone 5.3: 订单快照模式完成 ✅ (2026-07-08)

**核心成果**：实现了订单表快照模式，允许邮件数据与基础数据池自动匹配。

#### 1. 设计原则
- ✅ **快照存储**：orders 表存储下单时的完整数据副本
- ✅ **自动匹配**：邮件到达时自动匹配 apple_ids 和 recipients 表
- ✅ **数据自包含**：前端展示直接读取快照字段，无需 JOIN
- ✅ **外键可空**：未匹配时仍能创建订单，不丢单

#### 2. 快照字段（已通过迁移创建）
```sql
-- Apple ID 快照
apple_id_ref INT,              -- 外键（nullable）
apple_id VARCHAR(255),         -- 快照：邮件解析
apple_password VARCHAR(255),   -- 快照：自动匹配填充

-- 收件人快照
recipient_ref INT,             -- 外键（nullable）
recipient_name VARCHAR(100),   -- 快照：邮件解析
recipient_id_card VARCHAR(18), -- 快照：自动匹配填充
recipient_email VARCHAR(255),  -- 快照：自动匹配填充
recipient_phone VARCHAR(20),   -- 快照：自动匹配填充
recipient_address TEXT,        -- 快照：自动匹配填充
```

#### 3. 自动匹配逻辑（已实现）
```javascript
// orderService.js - saveOrderFromEmail()
// 1. 查找 apple_ids 表
const appleAccount = await AppleId.findOne({ 
  where: { appleId: emailData.appleId } 
});
if (appleAccount) {
  // 填充外键 + 快照
  appleData.appleIdRef = appleAccount.id;
  appleData.applePassword = appleAccount.password;
}

// 2. 查找 recipients 表（姓名 + 身份证后四位）
const recipient = await Recipient.findOne({
  where: {
    lastName: emailData.recipient.name.substring(0, 1),
    firstName: emailData.recipient.name.substring(1),
    idCardLast4: emailData.recipient.idLast4
  }
});
if (recipient) {
  // 填充外键 + 所有快照字段
  recipientData.recipientRef = recipient.id;
  recipientData.recipientIdCard = recipient.idCardNumber;
  // ... 其他字段
}

// 3. 创建订单（事务）
await Order.create({ ...appleData, ...recipientData, ... }, { transaction });
```

#### 4. 数据权威性规则

| 字段 | 权威来源 | 原因 |
|------|---------|------|
| products[].quantity | ✅ 邮件 | Apple 网站对取消订单显示 0 |
| products[].status | ✅ 网站 | 实时状态 |
| products[].imageUrl | ✅ 网站 | 邮件中无图片 |
| apple_id | ✅ 邮件（唯一） | 网站不显示 |
| recipient_name | ✅ 邮件（唯一） | 网站不显示 |

#### 5. 已完成的工作
- ✅ DATABASE_SCHEMA.md 快照模式设计
- ✅ 迁移脚本执行（所有快照字段已创建）
- ✅ Order 模型定义更新
- ✅ orderService.js 自动匹配逻辑实现
- ✅ 业务流程验证（匹配/未匹配两种场景）

**参考文档**：
- 详细设计：`docs/progress/TECHNICAL_DECISIONS.md` - 第 1 节
- 历史记录：`docs/progress/DEVELOPMENT_HISTORY_2026H1.md`

---

### Milestone 5.2: 数据库同步触发器补齐 ✅ (2026-07-07)

**核心成果**：补齐 recipients 宽表冗余字段与 apple_ids 主表之间的数据同步触发器。

#### 完成内容
- ✅ 新增迁移：`20260707000001-add-recipient-apple-sync-triggers.js`
- ✅ 新增触发器函数：
  - `sync_bound_apple_id_info()` - recipients.apple_id_ref 变更时同步
  - `sync_apple_password_to_recipients()` - apple_ids 更新时反向同步
- ✅ 触发器同步冒烟测试通过
- ✅ DATABASE_SCHEMA.md 文档同步更新

**业务价值**：业务代码只需维护 `apple_id_ref`，数据库自动同步 `bound_apple_id` 和 `bound_apple_password`。

---

## 📋 所有里程碑总览

| Milestone | 状态 | 完成时间 | 关键产出 |
|-----------|------|---------|---------|
| **1. 基础设施搭建** | ✅ | 2026-07-06 | Logger / Config / ProxyManager / Helpers |
| **1.1 数据库设计调整** | ✅ | 2026-07-06 | apple_ids / recipients 表优化，触发器设计 |
| **1.2 模型和迁移完善** | ✅ | 2026-07-06 | 5 个 Sequelize 模型，6 个迁移文件 |
| **1.3 数据库迁移测试** | ✅ | 2026-07-07 | 迁移执行成功，表结构验证通过 |
| **2. 数据库层** | ✅ | 2026-07-07 | 完整表结构、外键、触发器、索引 |
| **3. 邮件服务** | ✅ | 2026-07-07 | IMAP 监听、邮件解析、订单服务、单元测试 |
| **3.1 邮件方案优化** | ✅ | 2026-07-07 | 标志位方案、选择性标记已读（待实施） |
| **4. 爬虫服务** | ✅ | 2026-07-07 | axios+cheerio、代理池、反爬虫、测试通过 |
| **5. API 接口** | ✅ | 2026-07-07 | Express、4 模块 14 端点、统一错误处理 |
| **5.1 Lint 和冒烟测试** | ✅ | 2026-07-07 | ESLint error 清零、API 健康检查通过 |
| **5.2 数据库同步触发器** | ✅ | 2026-07-07 | recipients 宽表同步触发器 |
| **5.3 订单快照模式** | ✅ | 2026-07-08 | 快照字段、自动匹配逻辑 |
| **5.4 快代理私密代理池** | ✅ | 2026-07-08 | 1000 个代理、账密认证、自动刷新 |
| **5.5 代理池策略优化** | ✅ | 2026-07-08 | 智能刷新、累计失败废弃、节省配额 |
| **6. 前端 Excel 导入** | 🔴 | - | **当前阻塞项** |
| **7. 真实数据联调** | 🟡 | - | 订单爬取 / 端到端验证 |

---

## 🔗 相关文档

### 核心文档
- 📘 **数据库设计**：`docs/DATABASE_SCHEMA.md` - 官方数据库设计规范（v2.0）
- 📗 **技术决策**：`docs/progress/TECHNICAL_DECISIONS.md` - 关键技术决策记录
- 📙 **开发规范**：`docs/06-CODING_STANDARDS.md` - 编码规范（必读）
- 📕 **API 设计**：`docs/05-API接口设计方案.md` - RESTful API 规范

### 历史归档
- 📚 **开发历史**：`docs/progress/DEVELOPMENT_HISTORY_2026H1.md` - Milestone 1-5.1 详细记录

### 其他文档
- `docs/01-项目概述.md` - 系统架构
- `docs/02-邮件解析方案.md` - 邮件解析能力（13 字段）
- `docs/03-订单爬虫方案.md` - 爬虫策略
- `CLAUDE.md` - Claude Code 工作指南

---

## 📊 技术栈总览

### 后端
- **框架**：Node.js + Express.js
- **数据库**：PostgreSQL 14+ + Sequelize ORM
- **邮件**：node-imap + mailparser
- **爬虫**：axios + cheerio
- **日志**：Winston
- **测试**：Jest（待补齐）

### 前端（待开发）
- **框架**：React
- **UI**：Ant Design
- **状态管理**：待定（Context / Redux）

### 运维
- **容器**：Docker（Phase 3）
- **进程管理**：PM2（Phase 3）
- **反向代理**：Nginx（Phase 3）

---

## 🎯 下一步行动计划

### 本周重点
1. **开发前端 Excel 导入页面** 🔴
   - 上传组件 + 模板下载
   - Excel 解析（xlsx）
   - 数据校验和预览
   - 批量导入 API

2. **真实数据导入测试** 🔴
   - 通过前端导入真实 Apple IDs
   - 通过前端导入真实 recipients
   - 验证数据导入正确性

3. **配置真实邮件链路** 🟡
   - 配置 QQ/163 邮箱 IMAP
   - 启动邮件监听服务
   - 发送测试订单邮件
   - 验证邮件→解析→入库→查询

### 中期计划
- 配置真实订单爬取
- 前端订单管理页面
- 前端统计分析页面
- Jest 标准测试补齐

### 长期计划（Phase 2-3）
- 前端完整开发（2 周）
- Docker 部署（1 周）
- 生产环境上线

---

## 💡 开发备忘

### 重要约定
1. **DATABASE_SCHEMA.md 是唯一权威** - 所有数据库相关开发必须遵循
2. **06-CODING_STANDARDS.md 是强制规范** - 代码提交前必须检查
3. **真实数据导入走前端** - CLI 脚本仅用于开发测试

### 常用命令
```bash
# 启动 API 服务
npm start

# 运行数据库迁移
npm run db:migrate

# 代码检查
npm run lint

# 格式化代码
npm run format

# 运行测试（待补齐）
npm test
```

### 环境变量配置
参考 `.env.example`，关键配置：
- `DATABASE_URL` - PostgreSQL 连接
- `IMAP_*` - 邮件监听（未配置）
- `PROXY_*` - 代理池（未配置）
- `TEST_*` - 测试订单号（未配置）

---

**维护人**：Seraph  
**最后更新**：2026-07-08
