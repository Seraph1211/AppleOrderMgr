# Apple Order Manager 数据库表设计规范

**版本**：v2.0  
**创建时间**：2026-07-06  
**更新时间**：2026-07-06  
**维护人**：Seraph  
**状态**：✅ 正式版（所有开发必须遵循此设计）

---

## 📌 重要说明

**本文档是数据库表设计的权威规范，所有开发人员必须严格遵循。**

- ✅ 所有 Sequelize 模型定义必须与此文档一致
- ✅ 所有数据库迁移文件必须与此文档一致
- ✅ 任何表结构变更必须先更新本文档，经过讨论后才能实施
- ⚠️ 禁止私自修改表结构

---

## 🆕 v2.0 更新说明

**更新内容**：根据实际业务表（人头信息表、AppleID表）调整设计

**主要变更**：

1. **apple_ids 表**：
   - 新增 `password` 字段（明文存储）
   - 新增 `security_qa` JSONB 字段（密保问答）
   - 新增 `country` 字段（国家地区）
   - 新增 `is_modified` 字段（是否已修改）
   - 新增 `status` 字段（使用状态）

2. **recipients 表**：
   - `name` 字段拆分为 `last_name` + `first_name`
   - 新增 `id_card_number` 字段（完整身份证号，明文存储）
   - 保留 `id_card_last4` 字段（冗余存储，快速匹配）
   - 新增 `email` 字段（下单邮箱）
   - 新增地址字段：`province`、`city`、`district`、`street_address`
   - 新增 `status` 字段（使用状态）
   - 唯一约束改为 `UNIQUE(id_card_number)`

---

## 目录

1. [表结构总览](#表结构总览)
2. [apple_ids - Apple账号表](#1️⃣-apple_ids---apple账号表)
3. [recipients - 收件人表](#2️⃣-recipients---收件人表)
4. [orders - 订单主表](#3️⃣-orders---订单主表)
5. [email_logs - 邮件日志表](#4️⃣-email_logs---邮件日志表)
6. [crawl_logs - 爬虫日志表](#5️⃣-crawl_logs---爬虫日志表)
7. [表关系图](#表关系图)
8. [典型查询场景](#典型查询场景)
9. [数据库配置建议](#数据库配置建议)

---

## 表结构总览

| 表名 | 中文名 | 用途 | 记录数预估 | 主要关系 |
|------|--------|------|-----------|---------|
| `apple_ids` | Apple账号表 | 管理多个Apple ID账号及密码 | 10-100 | 1个账号 → 多个订单 |
| `recipients` | 收件人表 | 管理取机人完整信息 | 100-1000 | 1个收件人 → 多个订单 |
| `orders` | 订单主表 | 存储订单核心信息 | 10000+ | 核心表，关联账号、收件人 |
| `email_logs` | 邮件日志表 | 记录邮件处理状态 | 10000+ | 独立表，防重复处理 |
| `crawl_logs` | 爬虫日志表 | 记录爬虫执行日志 | 50000+ | 1个订单 → 多条爬虫日志 |

**数据库选型**：PostgreSQL 14+

**选择理由**：
- ✅ 支持 JSONB 数据类型（存储商品数组和密保问答）
- ✅ 支持 GIN 索引（提高 JSONB 字段查询性能）
- ✅ 支持并发写入（适合实时邮件处理）
- ✅ 开源免费，社区活跃，适合云部署

---

## 1️⃣ apple_ids - Apple账号表

### 表定义

**用途**：管理多个 Apple ID 账号，包括密码、密保、国家等信息

**表名**：`apple_ids`

**字段列表**：

| 字段名 | 类型 | 约束 | 默认值 | 说明 | 示例值 |
|--------|------|------|--------|------|--------|
| **基础信息** |
| `id` | SERIAL | PRIMARY KEY | - | 主键ID，自增 | 1 |
| `apple_id` | VARCHAR(255) | UNIQUE NOT NULL | - | Apple ID邮箱地址 | `lajavve036@hotmail.com` |
| `password` | VARCHAR(255) | NOT NULL | - | 密码（明文存储） | `NdMH5943` |
| `nickname` | VARCHAR(255) | - | - | 备注名称 | `主账号` / `测试账号` |
| **安全信息** |
| `security_qa` | JSONB | - | - | 密保问答（问题+答案） | 见下方结构说明 |
| **账号属性** |
| `country` | VARCHAR(50) | - | - | 国家地区 | `美国` / `中国` |
| `is_modified` | BOOLEAN | - | FALSE | 是否已修改国家及手机 | `true` / `false` |
| `status` | VARCHAR(20) | - | `'active'` | 使用状态 | `active` / `inactive` |
| **时间戳** |
| `created_at` | TIMESTAMP | NOT NULL | NOW() | 记录创建时间 | `2026-07-06 10:00:00` |
| `updated_at` | TIMESTAMP | NOT NULL | NOW() | 记录更新时间 | `2026-07-06 10:00:00` |

### security_qa 字段（JSONB）结构

**数据类型**：JSONB 对象

**结构说明**：存储3个密保问题及答案

```json
{
  "question1": "朋友",
  "answer1": "Aa64",
  "question2": "工作",
  "answer2": "136",
  "question3": "父母",
  "answer3": "142"
}
```

**字段说明**：

| 字段名 | 类型 | 说明 |
|--------|------|------|
| `question1` | String | 密保问题1（朋友） |
| `answer1` | String | 密保答案1 |
| `question2` | String | 密保问题2（工作） |
| `answer2` | String | 密保答案2 |
| `question3` | String | 密保问题3（父母） |
| `answer3` | String | 密保答案3 |

### status 字段枚举值

| 状态值 | 含义 | 说明 |
|--------|------|------|
| `active` | 使用中 | 账号正常可用 |
| `inactive` | 已停用 | 账号暂停使用 |

### 索引

```sql
CREATE INDEX idx_apple_ids_apple_id ON apple_ids(apple_id);
CREATE INDEX idx_apple_ids_status ON apple_ids(status);
CREATE INDEX idx_apple_ids_country ON apple_ids(country);
```

### 约束

- `apple_id` 字段必须全局唯一（UNIQUE 约束）
- `apple_id` 和 `password` 不能为空（NOT NULL 约束）

### 触发器

```sql
-- 自动更新 updated_at 字段
CREATE TRIGGER trigger_apple_ids_updated_at
BEFORE UPDATE ON apple_ids
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

-- Apple ID 或密码修改时，同步到已绑定的 recipients 冗余字段
CREATE TRIGGER trigger_sync_password_to_recipients
AFTER UPDATE OF apple_id, password ON apple_ids
FOR EACH ROW
EXECUTE FUNCTION sync_apple_password_to_recipients();
```

### 示例数据

```sql
INSERT INTO apple_ids (
  apple_id, 
  password, 
  nickname, 
  security_qa, 
  country, 
  is_modified, 
  status
) VALUES (
  'lajavve036@hotmail.com',
  'NdMH5943',
  '主账号',
  '{"question1": "朋友", "answer1": "Aa64", "question2": "工作", "answer2": "136", "question3": "父母", "answer3": "142"}'::jsonb,
  '美国',
  true,
  'active'
);
```

### 业务规则

1. **账号创建**：
   - `apple_id` 必须是有效的邮箱格式
   - `password` 为明文存储，方便业务查看和使用
   - 创建时默认 `status='active'`

2. **密保信息**：
   - `security_qa` 可为空（旧账号可能没有密保）
   - 新账号建议填写完整的3个密保问答

3. **状态管理**：
   - `active`：正常使用，可以下单
   - `inactive`：暂停使用，不可下单

---

## 2️⃣ recipients - 收件人表

### 表定义

**用途**：管理取机人完整信息，包括姓名、身份证、地址等

**表名**：`recipients`

**字段列表**：

| 字段名 | 类型 | 约束 | 默认值 | 说明 | 示例值 |
|--------|------|------|--------|------|--------|
| **基础信息** |
| `id` | SERIAL | PRIMARY KEY | - | 主键ID，自增 | 1 |
| `last_name` | VARCHAR(50) | NOT NULL | - | 姓 | `李` |
| `first_name` | VARCHAR(50) | NOT NULL | - | 名 | `浩` |
| **身份信息** |
| `id_card_number` | VARCHAR(18) | UNIQUE NOT NULL | - | 完整身份证号（明文存储） | `431225199301151815` |
| `id_card_last4` | VARCHAR(4) | - | - | 身份证后四位（冗余，快速匹配） | `1815` |
| `phone` | VARCHAR(20) | - | - | 手机号 | `15111988143` |
| `email` | VARCHAR(255) | - | - | 下单邮箱 | `15111988148@ikv.com` |
| **地址信息** |
| `province` | VARCHAR(50) | - | - | 省 | `重庆` |
| `city` | VARCHAR(50) | - | - | 市 | `重庆` |
| `district` | VARCHAR(50) | - | - | 区 | `江北区` |
| `street_address` | VARCHAR(255) | - | - | 街道地址 | `观音桥拓维304` |
| **关联Apple账号** |
| `apple_id` | VARCHAR(100) | - | - | 绑定的Apple账号邮箱 | `example@icloud.com` |
| `password` | VARCHAR(100) | - | - | 绑定的Apple账号密码 | `Pass@123` |
| `apple_id_ref` | INTEGER | FK | - | 关联到apple_ids表的外键 | `5` |
| **业务字段** |
| `tag` | VARCHAR(100) | - | - | 标签（地区或批次） | `刘天佟 微信` / `群华华 微信` |
| `status` | VARCHAR(20) | - | `'active'` | 使用状态 | `active` / `inactive` |
| `notes` | TEXT | - | - | 备注 | `转抢17` |
| **时间戳** |
| `created_at` | TIMESTAMP | NOT NULL | NOW() | 记录创建时间 | `2026-07-06 10:00:00` |
| `updated_at` | TIMESTAMP | NOT NULL | NOW() | 记录更新时间 | `2026-07-06 10:00:00` |

### status 字段枚举值

| 状态值 | 含义 | 说明 |
|--------|------|------|
| `active` | 使用中 | 可正常使用 |
| `inactive` | 已下架 | 不再使用 |

### 索引

```sql
CREATE INDEX idx_recipients_last_name_first_name ON recipients(last_name, first_name);
CREATE INDEX idx_recipients_id_card_number ON recipients(id_card_number);
CREATE INDEX idx_recipients_tag ON recipients(tag);
CREATE INDEX idx_recipients_status ON recipients(status);
CREATE INDEX idx_recipients_province_city ON recipients(province, city);
CREATE INDEX idx_recipients_apple_id ON recipients(apple_id);
CREATE INDEX idx_recipients_apple_id_ref ON recipients(apple_id_ref);
```

### 约束

```sql
-- 唯一约束：完整身份证号唯一
CONSTRAINT uk_recipient_id_card UNIQUE(id_card_number),

-- 外键约束：关联到apple_ids表
CONSTRAINT fk_recipient_apple_id FOREIGN KEY (apple_id_ref) 
  REFERENCES apple_ids(id) 
  ON DELETE SET NULL 
  ON UPDATE CASCADE
```

### 触发器

```sql
-- 自动更新 updated_at 字段
CREATE TRIGGER trigger_recipients_updated_at
BEFORE UPDATE ON recipients
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

-- 自动提取身份证后四位
CREATE OR REPLACE FUNCTION auto_extract_id_card_last4()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.id_card_number IS NOT NULL THEN
    NEW.id_card_last4 = RIGHT(NEW.id_card_number, 4);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_recipients_id_card_last4
BEFORE INSERT OR UPDATE ON recipients
FOR EACH ROW
EXECUTE FUNCTION auto_extract_id_card_last4();

-- apple_id_ref 变更时，同步 apple_id / password 冗余字段
CREATE TRIGGER trigger_sync_bound_apple_id
BEFORE INSERT OR UPDATE OF apple_id_ref ON recipients
FOR EACH ROW
EXECUTE FUNCTION sync_bound_apple_id_info();
```

### 示例数据

```sql
INSERT INTO recipients (
  last_name,
  first_name,
  id_card_number,
  phone,
  email,
  province,
  city,
  district,
  street_address,
  apple_id,
  password,
  apple_id_ref,
  tag,
  status
) VALUES (
  '李',
  '浩',
  '431225199301151815',
  '15111988143',
  '15111988148@ikv.com',
  '重庆',
  '重庆',
  '江北区',
  '观音桥拓维304',
  'example@icloud.com',
  'Pass@123',
  1,
  '刘天佟 微信',
  'active'
);
```

### 业务规则

1. **唯一性判断**：
   - 基于 `id_card_number`（完整身份证号）判断唯一性
   - 同一身份证号只能有一条记录

2. **自动字段填充**：
   - `id_card_last4` 自动从 `id_card_number` 提取（触发器）
   - 插入/更新时无需手动填写

3. **姓名处理**：
   - `last_name` 和 `first_name` 分开存储
   - 查询时拼接：`last_name || first_name AS full_name`

4. **地址字段**：
   - 省、市、区、街道分字段存储
   - 查询时拼接：`province || city || district || street_address AS full_address`

5. **状态管理**：
   - `active`：正常使用，可以下单
   - `inactive`：已下架，不再使用

---

## 3️⃣ orders - 订单主表 ⭐

### 表定义

**用途**：存储订单核心信息，采用**快照模式**存储下单时的完整数据

**表名**：`orders`

**设计原则**：
- ✅ 快照模式：存储下单时的完整数据副本，不依赖动态关联查询
- ✅ 自动匹配：邮件到达后自动匹配 `apple_ids` 和 `recipients` 表，填充完整信息
- ✅ 数据自包含：前端展示直接读取快照字段，无需关联查询

> 📘 详细说明请参考：[08-订单数据快照与自动匹配机制.md](./08-订单数据快照与自动匹配机制.md)

**字段列表**：

| 字段名 | 类型 | 约束 | 默认值 | 说明 | 示例值 |
|--------|------|------|--------|------|--------|
| **基础信息** |
| `id` | SERIAL | PRIMARY KEY | - | 主键ID，自增 | 1 |
| `order_number` | VARCHAR(50) | UNIQUE NOT NULL | - | Apple订单号（W+9位数字） | `W177976887` |
| `status` | VARCHAR(50) | NOT NULL | `'pending'` | 订单状态 | `pending` |
| **Apple ID 相关** |
| `apple_id_ref` | INT | FOREIGN KEY, NULL | - | 关联 apple_ids.id（自动匹配） | 1 |
| `apple_id` | VARCHAR(255) | NULL | - | Apple ID（邮件解析，快照） | `test@example.com` |
| `apple_password` | VARCHAR(255) | NULL | - | Apple ID 密码（自动匹配填充，快照） | `password123` |
| **收件人相关（快照）** |
| `recipient_ref` | INT | FOREIGN KEY, NULL | - | 关联 recipients.id（自动匹配） | 1 |
| `recipient_name` | VARCHAR(100) | NULL | - | 收件人姓名（邮件解析，快照） | `张三` |
| `recipient_id_card` | VARCHAR(18) | NULL | - | 完整身份证号（自动匹配填充，快照） | `110101199001011234` |
| `recipient_email` | VARCHAR(255) | NULL | - | 收件人邮箱（自动匹配填充，快照） | `zhangsan@example.com` |
| `recipient_phone` | VARCHAR(20) | NULL | - | 收件人手机号（自动匹配填充，快照） | `13800138000` |
| `recipient_address` | TEXT | NULL | - | 收件人完整地址（自动匹配填充，快照） | `重庆重庆江北区观音桥拓维304` |
| **产品信息** |
| `products` | JSONB | NOT NULL | `'[]'` | 商品列表（JSONB数组） | 见下方结构说明 |
| **订单信息** |
| `order_url` | TEXT | NULL | - | Apple订单详情链接 | `https://www.apple.com.cn/xc/cn/vieworder/W177976887/...` |
| `order_date` | TIMESTAMP | NULL | - | 下单时间（邮件解析） | `2025-10-08 20:21:58` |
| **取货信息** |
| `pickup_store` | VARCHAR(255) | NULL | - | 取货门店名称（爬虫填充） | `Apple 重庆万象城` |
| `pickup_store_code` | VARCHAR(50) | NULL | - | 取货门店代码（手动录入） | `R638` |
| `pickup_code` | VARCHAR(50) | NULL | - | 取货码（爬虫填充） | `ABC123` |
| `pickup_time_slot` | VARCHAR(50) | NULL | - | 取货时间段（手动录入） | `25-18:30-18:45` |
| `actual_pickup_date` | DATE | NULL | - | 实际取货日期（手动录入） | `2025-10-11` |
| **付款信息** |
| `payment_method` | VARCHAR(50) | NULL | - | 付款方式 | `ALIPAY` / `WECHAT` |
| `payer_name` | VARCHAR(100) | NULL | - | 付款人姓名（手动录入） | `李四` |
| `payment_screenshot` | TEXT | NULL | - | 付款截图URL（手动录入） | `/uploads/payment_123.png` |
| **爬虫相关** |
| `last_crawled_at` | TIMESTAMP | NULL | - | 最后爬取时间 | `2025-10-09 10:00:00` |
| `crawl_fail_count` | INT | NOT NULL | 0 | 爬取失败次数 | 0 |
| **业务字段** |
| `tag` | VARCHAR(500) | NULL | - | 备注/标签 | `VIP客户` |
| `notes` | TEXT | NULL | - | 备注 | `需要加急处理` |
| **时间戳** |
| `created_at` | TIMESTAMP | NOT NULL | NOW() | 记录创建时间 | `2026-07-06 10:00:00` |
| `updated_at` | TIMESTAMP | NOT NULL | NOW() | 记录更新时间 | `2026-07-06 10:00:00` |

### products 字段（JSONB）结构

**数据类型**：JSONB 数组

**结构说明**：支持多商品订单，每个商品包含以下字段

```json
[
  {
    "modelId": "MG714CH/A",
    "name": "iPhone 17 鼠尾草绿色 256G",
    "quantity": 2,
    "status": "READY_FOR_PICKUP",
    "imageUrl": "https://store.storeimages.cdn-apple.com/..."
  },
  {
    "modelId": "HNPW2ZM/A",
    "name": "Belkin Secure Holder 挂绳",
    "quantity": 1,
    "status": "READY_FOR_PICKUP",
    "imageUrl": "https://..."
  }
]
```

### status 字段枚举值

| 状态值 | 含义 | 来源 | 是否终态 | 说明 |
|--------|------|------|---------|------|
| `submitted` | 已提交 | 邮件刚收到 | ❌ | 初始状态 |
| `processing` | 处理中 | 官网爬取 | ❌ | 订单处理中 |
| `ready` | 准备就绪可取货 | 官网爬取 | ❌ | 可以去门店取货 |
| `shipped` | 已发货 | 官网爬取 | ❌ | 快递已发出 |
| `delivered` | 已送达 | 官网爬取 | ✅ | 已收货（终态） |
| `cancelled` | 已取消 | 官网爬取 | ✅ | 订单取消（终态） |
| `pickup_cancelled` | 取货已取消 | 官网爬取 | ✅ | 取货被取消（终态） |

### 索引

```sql
CREATE INDEX idx_orders_order_number ON orders(order_number);
CREATE INDEX idx_orders_apple_id_ref ON orders(apple_id_ref);
CREATE INDEX idx_orders_recipient_ref ON orders(recipient_ref);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_order_date ON orders(order_date DESC);
CREATE INDEX idx_orders_products_gin ON orders USING GIN(products);
```

### 外键关系

```sql
CONSTRAINT fk_orders_apple_id 
  FOREIGN KEY (apple_id_ref) 
  REFERENCES apple_ids(id) 
  ON DELETE CASCADE;

CONSTRAINT fk_orders_recipient 
  FOREIGN KEY (recipient_ref) 
  REFERENCES recipients(id) 
  ON DELETE SET NULL;
```

### 触发器

```sql
CREATE TRIGGER trigger_orders_updated_at
BEFORE UPDATE ON orders
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
```

---

## 4️⃣ email_logs - 邮件日志表

### 表定义

**用途**：记录邮件处理状态，防止重复处理同一封邮件

**表名**：`email_logs`

**字段列表**：

| 字段名 | 类型 | 约束 | 默认值 | 说明 | 示例值 |
|--------|------|------|--------|------|--------|
| `id` | SERIAL | PRIMARY KEY | - | 主键ID，自增 | 1 |
| `email_uid` | VARCHAR(255) | UNIQUE NOT NULL | - | 邮件唯一标识（IMAP UID） | `12345` |
| `email_subject` | VARCHAR(500) | - | - | 邮件主题 | `【重要通知】你的预约已确认` |
| `email_from` | VARCHAR(255) | - | - | 发件人邮箱 | `noreply@apple.com` |
| `source` | VARCHAR(50) | - | `'imap'` | 数据源（用于审计） | `imap` / `manual` / `api` |
| `raw_content` | TEXT | - | - | 原始邮件内容（Base64编码的邮件正文，用于调试和重新解析） | - |
| `processed` | BOOLEAN | - | FALSE | 是否已成功处理 | `true` / `false` |
| `processed_at` | TIMESTAMP | - | - | 处理成功时间 | `2026-07-06 10:05:30` |
| `error_message` | TEXT | - | - | 错误信息（处理失败时记录） | `订单号格式无效` |
| `created_at` | TIMESTAMP | NOT NULL | NOW() | 记录创建时间 | `2026-07-06 10:00:00` |

### 索引

```sql
CREATE INDEX idx_email_logs_email_uid ON email_logs(email_uid);
CREATE INDEX idx_email_logs_processed ON email_logs(processed);
CREATE INDEX idx_email_logs_source ON email_logs(source);
CREATE INDEX idx_email_logs_email_from ON email_logs(email_from);
CREATE INDEX idx_email_logs_created_at ON email_logs(created_at DESC);
```

---

## 5️⃣ crawl_logs - 爬虫日志表

### 表定义

**用途**：记录爬虫执行日志，用于监控爬虫性能和成功率

**表名**：`crawl_logs`

**字段列表**：

| 字段名 | 类型 | 约束 | 默认值 | 说明 | 示例值 |
|--------|------|------|--------|------|--------|
| `id` | SERIAL | PRIMARY KEY | - | 主键ID，自增 | 1 |
| `order_id` | INT | FOREIGN KEY | - | 关联 orders.id | 1 |
| `source` | VARCHAR(50) | - | `'auto'` | 数据源（用于审计） | `auto` / `manual` / `scheduled` |
| `proxy_ip` | VARCHAR(50) | - | - | 使用的代理IP | `123.45.67.89:8080` |
| `raw_html` | TEXT | - | - | 原始网页HTML内容（完整响应页面，用于调试和重新解析） | - |
| `success` | BOOLEAN | NOT NULL | - | 是否爬取成功 | `true` / `false` |
| `response_time` | INT | - | - | 响应时间（毫秒） | 2350 |
| `http_status` | INT | - | - | HTTP 状态码 | 200 / 541 / 404 |
| `error_message` | TEXT | - | - | 错误信息 | `HTTP 541 触发风控` |
| `created_at` | TIMESTAMP | NOT NULL | NOW() | 记录创建时间 | `2026-07-06 10:00:00` |

### 索引

```sql
CREATE INDEX idx_crawl_logs_order_id ON crawl_logs(order_id);
CREATE INDEX idx_crawl_logs_source ON crawl_logs(source);
CREATE INDEX idx_crawl_logs_success ON crawl_logs(success);
CREATE INDEX idx_crawl_logs_created_at ON crawl_logs(created_at DESC);
```

### 外键关系

```sql
CONSTRAINT fk_crawl_logs_order 
  FOREIGN KEY (order_id) 
  REFERENCES orders(id) 
  ON DELETE CASCADE;
```

---

## 📊 表关系图

```
┌─────────────────┐
│   apple_ids     │
│   - id          │
│   - apple_id    │
│   - password    │
│   - security_qa │
│   - status      │
└────────┬────────┘
         │ 1
         │
         │ N
┌────────┴────────┐         ┌─────────────────┐
│     orders      │    N    │   recipients    │
│   - id          │◄────────┤   - id          │
│   - apple_id_ref│    1    │   - last_name   │
│   - recipient   │         │   - first_name  │
│     _ref        │         │   - id_card     │
│   - products    │         │     _number     │
│   - status      │         │   - province    │
└────────┬────────┘         │   - city        │
         │ 1                │   - status      │
         │                  └─────────────────┘
         │ N
┌────────┴────────┐
│   crawl_logs    │
│   - order_id    │
│   - proxy_ip    │
│   - success     │
└─────────────────┘

┌─────────────────┐
│   email_logs    │
│   - email_uid   │
│   - processed   │
└─────────────────┘
```

---

## 📋 典型查询场景

### 场景1：查询某个收件人的所有订单（含姓名拼接）

```sql
SELECT 
  o.order_number,
  o.status,
  o.products,
  a.apple_id,
  (r.last_name || r.first_name) AS recipient_name,
  r.id_card_last4,
  (r.province || r.city || r.district || r.street_address) AS full_address
FROM orders o
JOIN apple_ids a ON o.apple_id_ref = a.id
LEFT JOIN recipients r ON o.recipient_ref = r.id
WHERE r.id_card_number = '431225199301151815'
ORDER BY o.order_date DESC;
```

### 场景2：查询所有可用的 Apple ID 账号

```sql
SELECT 
  apple_id,
  password,
  country,
  is_modified,
  security_qa->>'answer1' AS security_answer1
FROM apple_ids
WHERE status = 'active'
ORDER BY created_at DESC;
```

### 场景3：统计各省份的收件人数量

```sql
SELECT 
  province,
  city,
  COUNT(*) AS recipient_count,
  COUNT(CASE WHEN status = 'active' THEN 1 END) AS active_count
FROM recipients
GROUP BY province, city
ORDER BY recipient_count DESC;
```

---

