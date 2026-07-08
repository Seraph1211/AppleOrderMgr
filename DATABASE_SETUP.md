# Apple Order Manager - 数据库使用指南

## 🚀 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

```bash
# 复制环境变量模板
cp .env.example .env

# 编辑 .env 文件，填入你的数据库配置
vim .env
```

### 3. 创建数据库

```bash
# 登录 PostgreSQL
psql -U postgres

# 创建数据库
CREATE DATABASE apple_order_mgr;

# 退出
\q
```

### 4. 运行数据库迁移

```bash
# 执行所有迁移文件，创建表结构
npm run db:migrate
```

### 5. （可选）初始化数据库

```bash
# 测试数据库连接并同步模型（仅开发环境）
npm run db:init
```

## 📦 数据库命令

### 迁移命令

```bash
# 执行所有待执行的迁移
npm run db:migrate

# 回滚最近一次迁移
npm run db:migrate:undo

# 重置数据库（清空所有表并重新迁移）
npm run db:reset
```

### 种子数据命令

```bash
# 运行所有种子数据
npm run db:seed
```

## 📊 数据库表结构

### 1. apple_ids - Apple账号表
- 存储 Apple 账号信息
- 字段：apple_id, password, nickname, security_qa, country, status

### 2. recipients - 收件人表
- 存储取机人完整信息
- 字段：姓名、身份证、地址、关联Apple账号
- 外键：apple_id_ref → apple_ids(id)

### 3. orders - 订单表
- 存储订单核心信息
- 字段：订单号、产品列表（JSONB）、状态、取货信息、时间
- 外键：apple_id_ref → apple_ids(id), recipient_ref → recipients(id)

### 4. email_logs - 邮件日志表
- 记录邮件处理历史
- 字段：email_uid, processed, error_message

### 5. crawl_logs - 爬虫日志表
- 记录爬虫执行日志
- 字段：order_id, proxy_ip, success, http_status
- 外键：order_id → orders(id)

## 🔍 查询示例

### 查询某个 Apple ID 的所有订单

```javascript
const { AppleId, Order } = require('./src/models');

const appleAccount = await AppleId.findOne({
  where: { apple_id: 'example@icloud.com' },
  include: [{
    model: Order,
    as: 'orders'
  }]
});
```

### 查询订单及其收件人信息

```javascript
const { Order, Recipient } = require('./src/models');

const order = await Order.findOne({
  where: { order_number: 'W177976887' },
  include: [{
    model: Recipient,
    as: 'recipient'
  }]
});
```

### 按产品型号查询订单（JSONB 查询）

```javascript
const { Order } = require('./src/models');
const { Op } = require('sequelize');

const orders = await Order.findAll({
  where: {
    products: {
      [Op.contains]: [{ modelId: 'MG714CH/A' }]
    }
  }
});
```

## 🛠️ 故障排查

### 连接失败

```bash
# 检查 PostgreSQL 是否运行
pg_isready

# 检查数据库是否存在
psql -U postgres -l | grep apple_order_mgr
```

### 迁移失败

```bash
# 查看迁移状态
npx sequelize-cli db:migrate:status

# 手动回滚
npm run db:migrate:undo

# 重新执行
npm run db:migrate
```

## 📖 更多文档

详细的数据库设计文档请查看：
- `docs/DATABASE_SCHEMA.md` - 完整的数据库设计规范

## ⚠️ 注意事项

1. **生产环境**：使用迁移文件，不要使用 `db:init` 命令
2. **敏感信息**：`.env` 文件包含敏感信息，不要提交到 Git
3. **数据备份**：重置数据库前务必备份数据
