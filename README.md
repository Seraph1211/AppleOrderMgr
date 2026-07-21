# Apple Order Manager

Apple 订单管理系统 - 自动化监控邮件并同步 Apple 订单状态

## 项目简介

通过 NULL AOS Helper（第三方代购服务）下单 Apple 产品后，系统自动监控邮件、解析订单信息、爬取 Apple 官网订单详情，并同步订单状态到数据库。

**核心工作流程**：
```
邮件到达 → 解析订单信息 → 存储到 PostgreSQL → 爬取 Apple 网站详情 → 定期更新订单状态
```

## 技术栈

- **后端**：Node.js + Express.js
- **数据库**：PostgreSQL 14+ + Sequelize ORM
- **邮件监控**：IMAP IDLE（实时监控，<10s 响应）
- **爬虫**：axios + cheerio（无需 Puppeteer）
- **测试**：Jest

## 快速开始

### 环境要求

- Node.js 14+
- PostgreSQL 14+
- 邮箱 IMAP 访问权限
- （生产环境）代理池服务（推荐：快代理）

### 安装依赖

```bash
npm install
```

### 配置环境变量

复制 `.env.example` 为 `.env` 并填写配置：

```bash
# 数据库
DATABASE_URL=postgresql://user:password@localhost:5432/apple_orders

# 邮件监控
IMAP_HOST=imap.qq.com
IMAP_PORT=993
IMAP_USER=your_email@qq.com
IMAP_PASSWORD=your_password

# JWT 认证配置
JWT_SECRET=your_jwt_secret_key_at_least_32_characters_long
JWT_EXPIRES_IN=7d

# 登录安全配置
MAX_LOGIN_ATTEMPTS=5
LOCK_DURATION_MINUTES=15

# 代理池（可选，生产环境推荐）
PROXY_API_URL=https://api.kdlapi.com/...
PROXY_API_KEY=your_key_here

# 日志级别
LOG_LEVEL=info

# API 服务器
PORT=3000
```

**重要配置说明**：

- `JWT_SECRET`：JWT 密钥，**生产环境必须配置**，建议使用长度 ≥ 32 位的随机字符串
- `JWT_EXPIRES_IN`：Token 有效期，默认 7 天
- `MAX_LOGIN_ATTEMPTS`：最大登录失败次数，默认 5 次
- `LOCK_DURATION_MINUTES`：账号锁定时长，默认 15 分钟

### 初始化数据库

```bash
# 运行迁移
npx sequelize-cli db:migrate

# 创建默认管理员账号（首次部署必须执行）
npm run db:seed:admin

# （可选）填充测试数据
npx sequelize-cli db:seed:all
```

**默认管理员账号**：
- 用户名：`admin`
- 密码：`admin123`
- ⚠️ **首次登录后必须修改密码**

### 运行项目

```bash
# 开发模式（带自动重载）
npm run dev

# 生产模式
npm start
```

### 运行测试

```bash
# 运行所有测试
npm test

# 运行测试并查看覆盖率
npm test -- --coverage

# 监听模式
npm run test:watch
```

## 项目结构

```
.
├── crawler/              # 爬虫模块
│   └── order_parser.js   # Apple 订单页面解析
├── docs/                 # 项目文档
│   ├── 01-项目概述.md
│   ├── 02-邮件解析方案.md
│   ├── 03-订单爬虫方案.md
│   ├── 04-数据库设计方案.md    # (legacy)
│   ├── 05-API接口设计方案.md
│   ├── 06-CODING_STANDARDS.md  # 📘 编码规范
│   ├── DATABASE_SCHEMA.md      # ✅ 数据库表设计权威规范
│   └── DEVELOPMENT_PROGRESS.md # 开发进度记录
├── models/               # Sequelize 数据模型
│   ├── AppleId.js
│   ├── Order.js
│   ├── Recipient.js
│   ├── EmailLog.js
│   └── CrawlLog.js
├── services/             # 业务服务
│   └── emailParser.js    # 邮件解析服务
├── src/                  # API 路由和控制器
├── test/                 # 测试文件
├── utils/                # 工具函数
└── logs/                 # 日志文件

```

## 核心功能

### 1. 邮件监控与解析
- IMAP IDLE 实时监控（<10s 响应）
- 解析 NULL AOS Helper 邮件（Base64 编码）
- 提取 13 个字段：Apple ID、订单号、产品列表、收件人信息等
- 支持多产品订单（产品用 `@` 分隔）

### 2. 订单爬虫
- 爬取 Apple 官网订单详情
- 提取 11 个字段：订单状态、产品图片、取货门店、物流信息等
- 反爬虫策略：代理池 + 5-10s 延迟 + 请求重试

### 3. 数据管理
- 5 张核心数据表：`apple_ids`、`recipients`、`orders`、`email_logs`、`crawl_logs`
- JSONB 存储产品数组（支持可变数量产品）
- Sequelize ORM 事务处理
- **完整表设计**：查看 [DATABASE_SCHEMA.md](./docs/DATABASE_SCHEMA.md)

## 开发规范

**⚠️ 重要：所有代码提交前必须遵循编码规范！**

完整编码规范请查看：[📘 docs/06-CODING_STANDARDS.md](./docs/06-CODING_STANDARDS.md)

### 快速检查清单

- [ ] 使用小驼峰命名变量和函数
- [ ] 所有异步函数有 try-catch 错误处理
- [ ] 使用 `logger` 而非 `console.log`
- [ ] 数据库操作使用事务（多表修改）
- [ ] 爬虫请求有 5-10 秒延迟
- [ ] 外部输入进行验证
- [ ] 核心功能有单元测试
- [ ] 代码通过 `npm run lint` 检查

### 代码质量工具

```bash
# 检查代码规范
npm run lint

# 自动修复代码规范问题
npm run lint:fix

# 格式化代码
npm run format

# 运行测试
npm test
```

## 文档

详细技术文档位于 `docs/` 目录：

1. [项目概述](./docs/01-项目概述.md) - 系统架构和核心流程
2. [邮件解析方案](./docs/02-邮件解析方案.md) - 邮件监控和数据提取（13个字段）
3. [订单爬虫方案](./docs/03-订单爬虫方案.md) - 爬虫策略和数据集成（11个字段）
4. [数据库设计方案](./docs/04-数据库设计方案.md) - 表结构和关系设计（legacy）
5. [API接口设计方案](./docs/05-API接口设计方案.md) - RESTful API 端点
6. [📘 编码规范](./docs/06-CODING_STANDARDS.md) - **必读！所有开发者必须遵循**
7. [✅ 数据库表设计规范](./docs/DATABASE_SCHEMA.md) - **权威规范！所有模型定义必须遵循**
8. [开发进度](./docs/DEVELOPMENT_PROGRESS.md) - 开发进度和阶段记录

## 开发路线

- [x] **Phase 0**：需求分析和技术方案设计
- [ ] **Phase 1**（2周）：邮件监控 + 解析器 + 爬虫 + 基础 API
- [ ] **Phase 2**（1周）：前端界面（React + Ant Design）
- [ ] **Phase 3**（1周）：部署（Docker + PM2 + Nginx）

当前状态：**Phase 0 完成，准备进入 Phase 1 开发**

## 关键注意事项

### 反爬虫策略
- **必须使用代理池**：推荐快代理（¥50-200/月）
- **请求延迟**：5-10 秒随机延迟
- **频率控制**：<10 请求/分钟/IP
- **错误处理**：HTTP 541 = 风控触发 → 切换代理

### 数据权威性
| 字段 | 数据源 | 说明 |
|------|--------|------|
| 产品数量 | 邮件 | Apple 网站取消订单后显示 0 |
| 订单状态 | Apple 网站 | 实时状态 |
| Apple ID | 邮件 | 网站不显示 |
| 收件人信息 | 邮件 | 网站不显示 |
| 产品图片 | Apple 网站 | 邮件无图片 |

## 许可证

MIT

## 作者

Seraph

---

**开发提示**：开始编码前，请先阅读 [编码规范](./docs/06-CODING_STANDARDS.md)！
