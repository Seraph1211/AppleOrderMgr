# 订单数据快照与自动匹配机制

**文档版本**：v1.0  
**创建时间**：2026-07-08  
**维护人**：Seraph  
**状态**：✅ 正式版

---

## 📋 目录

1. [核心设计理念](#核心设计理念)
2. [业务流程](#业务流程)
3. [自动匹配规则](#自动匹配规则)
4. [数据填充逻辑](#数据填充逻辑)
5. [快照模式说明](#快照模式说明)
6. [外键作用说明](#外键作用说明)
7. [匹配失败处理](#匹配失败处理)
8. [代码实现位置](#代码实现位置)

---

## 核心设计理念

### 🎯 为什么采用快照模式？

**问题场景**：
- 用户在 2025-09-24 下单，收货地址是"重庆市江北区观音桥拓维304"
- 用户在 2025-10-01 在 `recipients` 表中修改地址为"重庆市渝中区解放碑XXX"
- 如果订单表通过外键动态查询地址，会显示错误的地址（新地址）

**解决方案**：
- 订单表存储**下单时的快照数据**
- 即使 `recipients` 表后续修改，订单记录不变
- 前端展示时直接读取订单表的快照字段，无需关联查询

### 🔄 自动匹配的目的

- 减少人工录入工作量
- 邮件到达后自动填充完整信息
- 提高数据准确性和一致性

---

## 业务流程

### 完整流程图

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. 邮件到达                                                      │
│    - NULL AOS Helper 发送订单通知邮件                            │
└────────────────┬────────────────────────────────────────────────┘
                 ↓
┌─────────────────────────────────────────────────────────────────┐
│ 2. 解析邮件                                                      │
│    提取基础信息：                                                 │
│    - 订单号（W123456789）                                        │
│    - Apple ID（test@example.com）                               │
│    - 收件人姓名（张三）                                           │
│    - 身份证后4位（1234）                                         │
│    - 商品信息、付款方式、订单链接等                                │
└────────────────┬────────────────────────────────────────────────┘
                 ↓
┌─────────────────────────────────────────────────────────────────┐
│ 3. 自动匹配 recipients 表                                        │
│    匹配条件：                                                     │
│    ✓ 姓名拼接匹配（last_name + first_name = "张三"）            │
│    ✓ 身份证后4位匹配（id_card_last4 = "1234"）                  │
│                                                                  │
│    匹配成功 → 填充：                                              │
│    - recipient_ref = recipients.id                               │
│    - recipient_id_card = 完整18位身份证号                        │
│    - recipient_email = 邮箱                                      │
│    - recipient_phone = 手机号                                    │
│    - recipient_address = 省+市+区+街道（拼接）                   │
│                                                                  │
│    匹配失败 → 字段保持 NULL                                      │
└────────────────┬────────────────────────────────────────────────┘
                 ↓
┌─────────────────────────────────────────────────────────────────┐
│ 4. 自动匹配 apple_ids 表                                         │
│    匹配条件：                                                     │
│    ✓ apple_id = 邮件中的 Apple ID                               │
│                                                                  │
│    匹配成功 → 填充：                                              │
│    - apple_id_ref = apple_ids.id                                │
│    - apple_password = 密码                                       │
│                                                                  │
│    匹配失败 → 字段保持 NULL                                      │
└────────────────┬────────────────────────────────────────────────┘
                 ↓
┌─────────────────────────────────────────────────────────────────┐
│ 5. 保存订单（快照数据）                                          │
│    - 所有字段直接保存到 orders 表                                 │
│    - 不依赖动态关联查询                                           │
│    - 即使 recipients 表后续修改，订单记录不变                     │
└────────────────┬────────────────────────────────────────────────┘
                 ↓
┌─────────────────────────────────────────────────────────────────┐
│ 6. 触发爬虫（可选）                                              │
│    - 根据订单链接爬取 Apple 官网                                  │
│    - 补充门店信息、订单状态等                                     │
└────────────────┬────────────────────────────────────────────────┘
                 ↓
┌─────────────────────────────────────────────────────────────────┐
│ 7. 前端展示                                                      │
│    - 直接读取 orders 表的快照字段                                 │
│    - 无需关联查询 recipients 或 apple_ids 表                     │
│    - 如果需要追溯，可通过外键 recipient_ref / apple_id_ref      │
└─────────────────────────────────────────────────────────────────┘
```

---

## 自动匹配规则

### 1️⃣ 收件人匹配规则

#### 匹配条件（两个条件必须同时满足）

**条件1：姓名匹配**
- 邮件中解析出完整姓名（如 `"张三"`）
- 与 `recipients` 表中的 `(last_name + first_name)` 拼接后的值进行匹配
- 示例：
  ```javascript
  邮件中：recipient.name = "张三"
  数据库中：recipients.last_name = "张", first_name = "三"
  拼接后："张" + "三" = "张三" ✅ 匹配成功
  ```

**条件2：身份证后4位匹配**
- 邮件中解析出身份证后4位（如 `"1234"`）
- 与 `recipients` 表中的 `id_card_last4` 字段匹配

#### SQL 查询示例

```sql
SELECT * FROM recipients
WHERE last_name = '张'
  AND first_name = '三'
  AND id_card_last4 = '1234';
```

#### 代码实现示例

```javascript
// 邮件解析结果
const emailData = {
  recipient: {
    name: "张三",      // 完整姓名
    idLast4: "1234"    // 身份证后4位
  }
};

// 自动匹配 recipients 表
const recipient = await Recipient.findOne({
  where: {
    // 拆分姓名进行匹配
    lastName: emailData.recipient.name.substring(0, 1),    // "张"
    firstName: emailData.recipient.name.substring(1),       // "三"
    idCardLast4: emailData.recipient.idLast4                // "1234"
  },
  transaction
});

if (recipient) {
  // 匹配成功，填充完整信息
  recipientData.recipientRef = recipient.id;
  recipientData.recipientIdCard = recipient.idCardNumber;     // 完整18位
  recipientData.recipientEmail = recipient.email;
  recipientData.recipientPhone = recipient.phone;
  recipientData.recipientAddress = `${recipient.province}${recipient.city}${recipient.district}${recipient.streetAddress}`;
}
```

#### 匹配成功后填充的字段

| 目标字段 | 来源字段 | 说明 |
|---------|---------|------|
| `recipient_ref` | `recipients.id` | 外键关联 |
| `recipient_id_card` | `recipients.id_card_number` | 完整18位身份证号 |
| `recipient_email` | `recipients.email` | 邮箱 |
| `recipient_phone` | `recipients.phone` | 手机号 |
| `recipient_address` | 拼接字符串 | `province + city + district + street_address` |

---

### 2️⃣ Apple ID 匹配规则

#### 匹配条件

**条件：Apple ID 完全匹配**
- 邮件中解析出的 Apple ID（如 `"test@example.com"`）
- 与 `apple_ids` 表中的 `apple_id` 字段完全匹配

#### SQL 查询示例

```sql
SELECT * FROM apple_ids
WHERE apple_id = 'test@example.com';
```

#### 代码实现示例

```javascript
// 邮件解析结果
const emailData = {
  appleId: "test@example.com"
};

// 自动匹配 apple_ids 表
const appleAccount = await AppleId.findOne({
  where: { appleId: emailData.appleId },
  transaction
});

if (appleAccount) {
  // 匹配成功，填充完整信息
  appleData.appleIdRef = appleAccount.id;
  appleData.applePassword = appleAccount.password;
}
```

#### 匹配成功后填充的字段

| 目标字段 | 来源字段 | 说明 |
|---------|---------|------|
| `apple_id_ref` | `apple_ids.id` | 外键关联 |
| `apple_password` | `apple_ids.password` | Apple ID 密码（明文） |

---

## 数据填充逻辑

### 完整的字段填充表

| orders 表字段 | 数据来源 | 填充方式 | 说明 |
|--------------|---------|---------|------|
| **基础信息** |
| `order_number` | 邮件 | 直接解析 | W开头+9位数字 |
| `status` | 系统 | 默认值 | 初始为 `pending` |
| **Apple ID 相关** |
| `apple_id` | 邮件 | 直接解析 | Apple ID 邮箱 |
| `apple_id_ref` | 自动匹配 | `apple_ids.id` | 外键（可为 NULL） |
| `apple_password` | 自动匹配 | `apple_ids.password` | 密码（可为 NULL） |
| **收件人相关（快照）** |
| `recipient_name` | 邮件 | 直接解析 | 姓名 |
| `recipient_ref` | 自动匹配 | `recipients.id` | 外键（可为 NULL） |
| `recipient_id_card` | 自动匹配 | `recipients.id_card_number` | 完整18位（可为 NULL） |
| `recipient_email` | 自动匹配 | `recipients.email` | 邮箱（可为 NULL） |
| `recipient_phone` | 自动匹配 | `recipients.phone` | 手机号（可为 NULL） |
| `recipient_address` | 自动匹配 | 拼接字符串 | 完整地址（可为 NULL） |
| **商品信息** |
| `products` | 邮件 | 直接解析 | JSONB 数组 |
| **订单信息** |
| `order_url` | 邮件 | 直接解析 | 订单链接 |
| `order_date` | 邮件 | 直接解析 | 下单时间 |
| **取货信息** |
| `pickup_store` | 爬虫 | 后续填充 | 取货门店名 |
| `pickup_store_code` | 手动录入 | 前端补充 | 门店代码（如 R638） |
| `pickup_code` | 爬虫 | 后续填充 | 取货码 |
| `pickup_time_slot` | 手动录入 | 前端补充 | 时间段（如 25-18:30-18:45） |
| `actual_pickup_date` | 手动录入 | 前端补充 | 实际取货日期 |
| **付款信息** |
| `payment_method` | 邮件 | 直接解析 | 付款方式 |
| `payer_name` | 手动录入 | 前端补充 | 付款人姓名 |
| `payment_screenshot` | 手动录入 | 前端补充 | 付款截图URL |
| **业务字段** |
| `tag` | 邮件 | 直接解析 | 备注/标签 |
| `notes` | 手动录入 | 前端补充 | 备注 |

---

## 快照模式说明

### 什么是快照模式？

**快照模式**：订单表存储下单时的完整数据副本，后续即使主数据表（`recipients`、`apple_ids`）发生变化，订单记录也不会改变。

### 为什么需要快照？

#### 场景1：收件人地址变更

```
时间线：
2025-09-24 20:12:00  → 用户下单，收货地址：重庆市江北区观音桥拓维304
2025-09-26 10:00:00  → 用户在 recipients 表修改地址：重庆市渝中区解放碑XXX
2025-09-27 15:00:00  → 前端查询订单，应该显示什么地址？

✅ 快照模式：显示 "重庆市江北区观音桥拓维304"（下单时的地址）
❌ 动态查询：显示 "重庆市渝中区解放碑XXX"（当前地址，错误！）
```

#### 场景2：收件人手机号变更

```
时间线：
2025-09-24  → 订单1：手机号 13800138000
2025-10-01  → 用户修改 recipients 表手机号为 13900139000
2025-10-05  → 订单2：手机号 13900139000

✅ 快照模式：
   - 订单1 显示 13800138000（下单时的手机号）
   - 订单2 显示 13900139000（下单时的手机号）

❌ 动态查询：
   - 订单1 显示 13900139000（错误！）
   - 订单2 显示 13900139000
```

### 快照字段列表

以下字段采用快照模式，不依赖关联查询：

| 快照字段 | 说明 |
|---------|------|
| `recipient_name` | 收件人姓名 |
| `recipient_id_card` | 完整身份证号 |
| `recipient_email` | 收件人邮箱 |
| `recipient_phone` | 收件人手机号 |
| `recipient_address` | 收件人完整地址 |
| `apple_id` | Apple ID |
| `apple_password` | Apple ID 密码 |

---

## 外键作用说明

### 外键的用途

`recipient_ref` 和 `apple_id_ref` 两个外键字段的作用：

#### 1. 前端快速填充
- 创建新订单时，可以通过外键快速加载对应的 `recipients` 或 `apple_ids` 信息
- 用于下拉选择框、自动完成等功能

#### 2. 数据追溯
- 当需要追溯"这个订单用的是哪个收件人主数据"时，可以通过外键查询
- 用于审计、统计分析等场景

#### 3. 数据一致性检查
- 定期检查：订单快照数据与主数据是否一致
- 发现差异时，可以提示用户或记录日志

### 外键 ≠ 数据展示

**重要原则**：
- ✅ 前端展示订单时，直接读取快照字段（`recipient_name`、`recipient_phone` 等）
- ❌ 不要通过外键关联查询 `recipients` 表获取数据

**错误示例**：
```javascript
// ❌ 错误：通过外键动态查询
const order = await Order.findOne({
  where: { id: 123 },
  include: [{ model: Recipient, as: 'recipient' }]
});
const phone = order.recipient.phone;  // 可能是修改后的数据，错误！
```

**正确示例**：
```javascript
// ✅ 正确：直接读取快照字段
const order = await Order.findOne({
  where: { id: 123 }
});
const phone = order.recipientPhone;  // 快照数据，正确！
```

---

## 匹配失败处理

### 匹配失败的场景

1. **收件人匹配失败**
   - `recipients` 表中不存在该姓名 + 身份证后4位的记录
   - 可能是新收件人，尚未录入系统

2. **Apple ID 匹配失败**
   - `apple_ids` 表中不存在该 Apple ID
   - 可能是新账号，尚未录入系统

### 处理策略

#### ✅ 不阻塞订单创建
- 匹配失败时，相关字段保持 `NULL`
- 订单仍然正常创建和保存
- 不影响核心业务流程

#### ⚠️ 记录日志
```javascript
logger.warn('未找到匹配的收件人', {
  name: emailData.recipient.name,
  idLast4: emailData.recipient.idLast4
});

logger.warn('未找到匹配的 Apple ID', {
  appleId: emailData.appleId
});
```

#### 🔄 前端补充
- 前端展示时，如果发现关键字段为 `NULL`，提示用户补充
- 提供手动选择或录入功能
- 保存后更新快照字段

### 匹配失败后的数据示例

```javascript
// 收件人匹配失败的订单
{
  orderNumber: "W123456789",
  appleId: "test@example.com",
  recipientName: "张三",           // 邮件中的姓名（有值）
  recipientRef: null,              // 未匹配到（NULL）
  recipientIdCard: null,           // 未自动填充（NULL）
  recipientEmail: null,            // 未自动填充（NULL）
  recipientPhone: null,            // 未自动填充（NULL）
  recipientAddress: null           // 未自动填充（NULL）
}
```

---

## 代码实现位置

### 核心文件

| 文件 | 说明 | 关键函数/逻辑 |
|------|------|--------------|
| `src/services/orderService.js` | 订单服务 | `saveOrderFromEmail()` - 自动匹配逻辑 |
| `src/models/Order.js` | Order 模型 | 字段定义、索引定义 |
| `src/models/Recipient.js` | Recipient 模型 | 收件人表定义 |
| `src/models/AppleId.js` | AppleId 模型 | Apple ID 表定义 |
| `migrations/20260708035239-update-orders-table-with-snapshot-fields.js` | 数据库迁移 | 表结构更新 |

### 关键代码片段

#### 自动匹配逻辑（orderService.js）

```javascript
async function saveOrderFromEmail(emailData, emailUid) {
  const transaction = await sequelize.transaction();

  try {
    // 1. 自动匹配 recipients 表
    let recipientData = {
      recipientRef: null,
      recipientName: emailData.recipient?.name || null,
      recipientIdCard: null,
      recipientEmail: null,
      recipientPhone: null,
      recipientAddress: null
    };

    if (emailData.recipient?.name && emailData.recipient?.idLast4) {
      const recipient = await Recipient.findOne({
        where: {
          lastName: emailData.recipient.name.substring(0, 1),
          firstName: emailData.recipient.name.substring(1),
          idCardLast4: emailData.recipient.idLast4
        },
        transaction
      });

      if (recipient) {
        recipientData.recipientRef = recipient.id;
        recipientData.recipientIdCard = recipient.idCardNumber;
        recipientData.recipientEmail = recipient.email;
        recipientData.recipientPhone = recipient.phone;
        recipientData.recipientAddress = `${recipient.province || ''}${recipient.city || ''}${recipient.district || ''}${recipient.streetAddress || ''}`;
      }
    }

    // 2. 自动匹配 apple_ids 表
    let appleData = {
      appleIdRef: null,
      appleId: emailData.appleId,
      applePassword: null
    };

    const appleAccount = await AppleId.findOne({
      where: { appleId: emailData.appleId },
      transaction
    });

    if (appleAccount) {
      appleData.appleIdRef = appleAccount.id;
      appleData.applePassword = appleAccount.password;
    }

    // 3. 创建订单（保存快照数据）
    const order = await Order.create({
      orderNumber: emailData.orderNumber,
      ...appleData,
      ...recipientData,
      products: emailData.products,
      status: 'pending',
      orderUrl: emailData.orderUrl,
      paymentMethod: emailData.paymentMethod || null,
      orderDate: emailData.orderDate,
      tag: emailData.recipient?.tag || null
    }, { transaction });

    await transaction.commit();
    return order;
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}
```

---

## 总结

### 核心要点

1. **快照模式** - 订单数据是下单时的快照，不会因主数据变更而改变
2. **自动匹配** - 根据姓名+身份证后4位匹配收件人，根据 Apple ID 匹配账号
3. **外键作用** - 仅用于追溯和快速填充，不用于数据展示
4. **容错处理** - 匹配失败不阻塞订单创建，字段保持 NULL

### 后续维护

- 如需修改匹配规则，请同步更新本文档和代码
- 如需添加新的快照字段，请遵循相同的设计原则
- 定期检查快照数据与主数据的一致性（用于审计）

---

**文档结束**
