# Apple 订单管理系统 - 文档导航

## 📚 文档结构

```
docs/
├── README.md                           # 本文件（文档导航）
│
├── design/                             # 🎨 设计文档（架构与方案）
│   ├── architecture.md                 # 系统架构设计
│   ├── email-parser.md                 # 邮件解析方案
│   ├── order-crawler.md                # 订单爬虫方案
│   ├── api-design.md                   # API 接口设计
│   └── email-processing.md             # 邮件处理方案
│
├── database/                           # 🗄️ 数据库文档
│   ├── SCHEMA.md                       # ⚠️ 权威：数据库设计规范
│   └── snapshot-matching.md            # 订单快照与自动匹配机制
│
├── development/                        # 🛠️ 开发文档
│   ├── CODING_STANDARDS.md             # ⚠️ 权威：编码规范
│   ├── DEVELOPMENT_PROGRESS.md         # 开发进度跟踪
│   ├── NOTIFICATION_GUIDE.md           # 通知机制指南
│   └── history/                        # 📜 历史记录归档
│       ├── 2026H1.md                   # 2026上半年开发历史
│       └── technical-decisions.md      # 技术决策记录
│
└── deprecated/                         # 🗑️ 已废弃文档
    └── 04-数据库设计方案.md             # 已被 database/SCHEMA.md 取代
```

---

## 🎯 快速导航

### 📖 按角色查找

#### 新成员入门
1. **必读**: [系统架构](design/architecture.md) → 了解整体设计
2. **数据流**: [邮件解析](design/email-parser.md) + [订单爬虫](design/order-crawler.md) → 了解数据来源
3. **开发规范**: [编码规范](development/CODING_STANDARDS.md) → 了解代码要求

#### 前端开发者
- 📋 [API 接口设计](design/api-design.md) - RESTful API 规范
- 🗄️ [数据库设计](database/SCHEMA.md) - 了解数据结构
- 📧 [邮件解析方案](design/email-parser.md) - 了解字段来源

#### 后端开发者
- 🎨 [系统架构](design/architecture.md) - 三层架构设计
- 📧 [邮件解析](design/email-parser.md) - 数据提取能力（13个字段）
- 🕷️ [订单爬虫](design/order-crawler.md) - 反爬策略 + 数据整合（11个字段）
- 🗄️ [数据库设计](database/SCHEMA.md) - ⚠️ 权威规范
- ⚙️ [编码规范](development/CODING_STANDARDS.md) - ⚠️ 必须遵守

#### 产品/测试
- 🎨 [系统架构](design/architecture.md) - 业务流程
- 📋 [API 接口设计](design/api-design.md) - 功能接口
- 📧 [邮件解析方案](design/email-parser.md) - 可提取字段清单
- 🕷️ [订单爬虫方案](design/order-crawler.md) - 数据能力边界

---

## 📑 核心文档说明

### 🎨 设计文档 (design/)

#### [architecture.md](design/architecture.md)
- 项目背景与需求
- 系统架构设计（邮件层 + 爬虫层 + API层）
- 技术栈选型
- 开发阶段规划

#### [email-parser.md](design/email-parser.md)
- 邮件格式分析（NULL AOS Helper）
- 字段提取规则（正则表达式）
- 多商品订单解析（`@` 分隔符规则）
- **数据提取能力清单**：13 个字段

#### [order-crawler.md](design/order-crawler.md)
- Apple 官网页面分析
- 反爬策略（代理池 + 请求延迟）
- 数据提取实现（JSON 提取）
- **数据提取能力清单**：11 个字段
- **与邮件数据整合策略**

#### [api-design.md](design/api-design.md)
- RESTful API 设计
- 请求/响应格式
- 错误处理规范
- 接口实现示例

#### [email-processing.md](design/email-processing.md)
- IMAP IDLE 实时监控
- 邮件处理流程
- 错误处理与重试机制

### 🗄️ 数据库文档 (database/)

#### [SCHEMA.md](database/SCHEMA.md) ⚠️ **权威文档**
- 完整的数据库设计规范
- 5 张核心表定义（apple_ids, recipients, orders, email_logs, crawl_logs）
- 字段类型、索引、关系
- Sequelize 模型定义参考
- 查询示例

#### [snapshot-matching.md](database/snapshot-matching.md)
- 订单数据快照机制
- 自动匹配逻辑
- 数据一致性保障

### 🛠️ 开发文档 (development/)

#### [CODING_STANDARDS.md](development/CODING_STANDARDS.md) ⚠️ **权威文档**
- 命名规范（camelCase/PascalCase/UPPER_SNAKE_CASE）
- 错误处理规范（try-catch + 结构化日志）
- 数据库操作规范（事务 + 防 N+1）
- 爬虫反爬规范（代理池 + 延迟）
- 代码质量检查（lint + format + test）

#### [DEVELOPMENT_PROGRESS.md](development/DEVELOPMENT_PROGRESS.md)
- 当前开发进度跟踪
- 已完成功能清单
- 下一步计划
- 阻塞问题记录

#### [NOTIFICATION_GUIDE.md](development/NOTIFICATION_GUIDE.md)
- 系统通知机制说明
- 通知类型与触发条件
- 通知渠道配置

#### history/ - 历史记录归档
- `2026H1.md` - 2026上半年开发历史
- `technical-decisions.md` - 重要技术决策记录

---

## ⚠️ 权威文档说明

标记为 **⚠️ 权威** 的文档是该领域的单一真相来源（Single Source of Truth）：

1. **[database/SCHEMA.md](database/SCHEMA.md)** - 所有数据库相关开发必须遵循此文档
2. **[development/CODING_STANDARDS.md](development/CODING_STANDARDS.md)** - 所有代码必须符合此规范

开发过程中如遇冲突，**以权威文档为准**。

---

## 📝 核心要点速查

### 邮件格式
```
型号1-产品1 x 数量1@型号2-产品2 x 数量2/取机人/身份证后四位/付款方式/-/-/标签
```

**示例**:
```
MG714CH/A-iPhone 17 鼠尾草绿色 256G x 2@HNPW2ZM/A-Belkin挂绳 x 1/冉念/5904/支付宝/-/-/水果惠
```

### 订单链接格式
```
https://www.apple.com.cn/xc/cn/vieworder/{订单号}/{邮箱}
```

### 订单状态枚举
- `submitted` - 已提交
- `processing` - 处理中
- `ready` - 准备就绪可取货
- `shipped` - 已发货
- `delivered` - 已送达
- `cancelled` - 已取消
- `pickup_cancelled` - 取货已取消

### 数据权威性
| 字段 | 数据来源 | 权威性 | 原因 |
|------|---------|--------|------|
| 商品数量 | 邮件 | ✅ 权威 | Apple 官网取消订单后显示为 0 |
| 订单状态 | Apple 官网 | ✅ 权威 | 实时状态 |
| Apple ID | 邮件 | 唯一来源 | 官网无此信息 |
| 取机人信息 | 邮件 | 唯一来源 | 官网无此信息 |
| 商品图片 | Apple 官网 | 唯一来源 | 邮件无图片 |

---

## 🚀 快速开始

### 1. 环境准备
```bash
# 安装依赖
npm install

# 配置环境变量
cp .env.example .env
```

### 2. 数据库初始化
参考根目录的 [DATABASE_SETUP.md](../DATABASE_SETUP.md)

```bash
# 创建数据库
psql -U postgres -c "CREATE DATABASE apple_orders"

# 执行迁移
npm run db:migrate
```

### 3. 启动服务
```bash
# 开发模式（带热重载）
npm run dev

# 生产模式
npm start

# 测试邮件解析器
node test_parser.js

# 测试爬虫
node test_crawler.js
```

---

## 🔄 文档更新记录

| 日期 | 版本 | 更新内容 | 维护人 |
|------|------|---------|-------|
| 2026-07-06 | v1.0 | 初始版本，完成核心设计文档 | Kiro |
| 2026-07-06 | v2.0 | 文档优化：合并冗余内容 | Kiro |
| 2026-07-08 | v3.0 | 目录结构重构：按文档类型分层（design/database/development） | Kiro |

---

## 💡 文档维护规范

### 更新规则
1. 修改文档后，在本文件"更新记录"中添加条目
2. 更新权威文档需格外谨慎，必须验证影响范围
3. 废弃的文档移入 `deprecated/` 目录，不要直接删除

### 命名规范
- 使用英文 kebab-case：`email-parser.md`
- 权威文档使用大写：`SCHEMA.md`, `CODING_STANDARDS.md`
- 历史记录使用年份：`2026H1.md`

### 目录组织原则
- `design/` - 架构与技术方案，面向设计阶段
- `database/` - 数据库相关文档，包含权威规范
- `development/` - 开发过程文档，包含规范与进度
- `deprecated/` - 归档废弃文档，保留历史参考

---

## 📞 联系方式

- **项目路径**: `/Users/seraph/GitHouse/AppleOrderMgr`
- **文档维护**: Kiro
- **创建日期**: 2026-07-06
- **最后更新**: 2026-07-08

---

**📊 统计信息**
- 设计文档: 5 个
- 数据库文档: 2 个（含 1 个权威）
- 开发文档: 3 个（含 1 个权威）+ 2 个历史记录
- 废弃文档: 1 个
