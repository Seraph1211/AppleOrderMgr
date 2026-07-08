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
- [ ] **代理池配置** - 配置快代理 API

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
   - IMAP 账号未配置（需要 QQ/163 邮箱授权码）
   - 测试订单号未配置（需要真实 Apple 订单）

---

## 🔥 最近完成的工作

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
| **6. 前端 Excel 导入** | 🔴 | - | **当前阻塞项** |
| **7. 真实数据联调** | 🟡 | - | IMAP / 爬虫 / 端到端验证 |

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
