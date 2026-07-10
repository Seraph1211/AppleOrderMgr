# 可配置列功能设计规范

**版本**：v1.0  
**创建时间**：2026-07-08  
**维护人**：Seraph  
**状态**：✅ 设计完成

---

## 📌 概述

本文档定义了订单管理系统中三个核心表格（Orders、AppleIds、Recipients）的可配置列功能。

**核心功能**：
- ✅ 用户可自定义显示哪些列
- ✅ 用户可调整列的显示顺序
- ✅ 配置保存到 localStorage（客户端持久化）
- ✅ 支持重置为默认配置

---

## 🎯 设计原则

1. **灵活性**：所有业务字段都可配置，仅必要字段（操作列）不可隐藏
2. **持久化**：配置保存到 localStorage，刷新页面后保持
3. **简洁性**：列配置 UI 不干扰主界面，使用弹窗或抽屉
4. **可恢复**：提供"恢复默认"功能

---

## 📋 Orders 表格可配置列

### 数据源映射

| 前端字段 | 数据库字段 | 数据来源 | 权威性 |
|---------|-----------|---------|-------|
| `orderNumber` | `order_number` | 邮件/官网 | ✅ 唯一标识 |
| `appleId` | `apple_id` | 邮件（快照） | ✅ 邮件权威 |
| `recipientName` | `recipient_name` | 邮件（快照） | ✅ 邮件权威 |
| `recipientPhone` | `recipient_phone` | 匹配填充（快照） | - |
| `products` | `products` (JSONB) | 邮件（型号+数量）+ 官网（图片+状态） | ✅ 数量邮件权威 |
| `totalAmount` | 计算字段 | 前端计算（商品价格总和） | - |
| `status` | `status` | 官网爬取 | ✅ 官网权威 |
| `paymentMethod` | `payment_method` | 邮件解析 | ✅ 邮件权威 |
| `pickupStore` | `pickup_store` | 官网爬取 | ✅ 官网权威 |
| `createdAt` | `created_at` | 系统生成 | ✅ 系统权威 |

### 可配置列定义

```javascript
const ordersColumns = [
  {
    key: 'orderNumber',
    label: '订单号',
    width: '140px',
    defaultVisible: true,
    sortable: true,
    pinned: false, // 不可取消（标识列）
  },
  {
    key: 'appleId',
    label: 'Apple ID',
    width: '200px',
    defaultVisible: true,
    sortable: true,
    pinned: false,
  },
  {
    key: 'recipientName',
    label: '取机人',
    width: '100px',
    defaultVisible: true,
    sortable: true,
    pinned: false,
  },
  {
    key: 'recipientPhone',
    label: '联系电话',
    width: '140px',
    defaultVisible: false, // 默认隐藏
    sortable: false,
    pinned: false,
  },
  {
    key: 'products',
    label: '商品',
    width: '300px',
    defaultVisible: true,
    sortable: false,
    pinned: false,
  },
  {
    key: 'totalAmount',
    label: '金额',
    width: '120px',
    defaultVisible: true,
    sortable: true,
    pinned: false,
  },
  {
    key: 'status',
    label: '状态',
    width: '100px',
    defaultVisible: true,
    sortable: true,
    pinned: false,
  },
  {
    key: 'paymentMethod',
    label: '支付方式',
    width: '120px',
    defaultVisible: false, // 默认隐藏
    sortable: false,
    pinned: false,
  },
  {
    key: 'pickupStore',
    label: '取货门店',
    width: '150px',
    defaultVisible: true,
    sortable: false,
    pinned: false,
  },
  {
    key: 'createdAt',
    label: '创建时间',
    width: '160px',
    defaultVisible: true,
    sortable: true,
    pinned: false,
  },
  {
    key: 'actions',
    label: '操作',
    width: '80px',
    defaultVisible: true,
    sortable: false,
    pinned: true, // 固定显示，不可隐藏
  },
]
```

### 默认显示列（9 列）

- ✅ 订单号
- ✅ Apple ID
- ✅ 取机人
- ✅ 商品
- ✅ 金额
- ✅ 状态
- ✅ 取货门店
- ✅ 创建时间
- ✅ 操作（固定）

### 默认隐藏列（2 列）

- ❌ 联系电话
- ❌ 支付方式

---

## 📋 AppleIds 表格可配置列

### 数据源映射

| 前端字段 | 数据库字段 | 数据来源 | 权威性 |
|---------|-----------|---------|-------|
| `appleId` | `apple_id` | 手动录入/导入 | ✅ 唯一标识 |
| `password` | `password` | 手动录入/导入 | ✅ 明文存储 |
| `nickname` | `nickname` | 手动录入 | - |
| `country` | `country` | 手动录入 | - |
| `isModified` | `is_modified` | 手动录入 | - |
| `status` | `status` | 系统管理 | - |
| `orderCount` | 计算字段 | `COUNT(orders)` | - |
| `lastOrderDate` | 计算字段 | `MAX(orders.created_at)` | - |
| `createdAt` | `created_at` | 系统生成 | ✅ 系统权威 |

### 可配置列定义

```javascript
const appleIdsColumns = [
  {
    key: 'appleId',
    label: 'Apple ID',
    width: '250px',
    defaultVisible: true,
    sortable: true,
    pinned: false, // 不可取消（标识列）
  },
  {
    key: 'password',
    label: '密码',
    width: '150px',
    defaultVisible: false, // 默认隐藏（安全性）
    sortable: false,
    pinned: false,
    sensitive: true, // 标记为敏感字段
  },
  {
    key: 'nickname',
    label: '备注名称',
    width: '150px',
    defaultVisible: true,
    sortable: true,
    pinned: false,
  },
  {
    key: 'country',
    label: '国家地区',
    width: '120px',
    defaultVisible: true,
    sortable: true,
    pinned: false,
  },
  {
    key: 'isModified',
    label: '已修改',
    width: '100px',
    defaultVisible: false, // 默认隐藏
    sortable: true,
    pinned: false,
  },
  {
    key: 'status',
    label: '状态',
    width: '100px',
    defaultVisible: true,
    sortable: true,
    pinned: false,
  },
  {
    key: 'orderCount',
    label: '订单数',
    width: '100px',
    defaultVisible: true,
    sortable: true,
    pinned: false,
  },
  {
    key: 'lastOrderDate',
    label: '最后下单',
    width: '160px',
    defaultVisible: true,
    sortable: true,
    pinned: false,
  },
  {
    key: 'createdAt',
    label: '创建时间',
    width: '160px',
    defaultVisible: false, // 默认隐藏
    sortable: true,
    pinned: false,
  },
  {
    key: 'actions',
    label: '操作',
    width: '100px',
    defaultVisible: true,
    sortable: false,
    pinned: true, // 固定显示，不可隐藏
  },
]
```

### 默认显示列（7 列）

- ✅ Apple ID
- ✅ 备注名称
- ✅ 国家地区
- ✅ 状态
- ✅ 订单数
- ✅ 最后下单
- ✅ 操作（固定）

### 默认隐藏列（3 列）

- ❌ 密码（安全敏感）
- ❌ 已修改
- ❌ 创建时间

---

## 📋 Recipients 表格可配置列

### 数据源映射

| 前端字段 | 数据库字段 | 数据来源 | 权威性 |
|---------|-----------|---------|-------|
| `name` | `last_name` + `first_name` | 手动录入/导入 | ✅ 唯一标识（配合身份证） |
| `idCard` | `id_card_last4` | 自动提取 | ✅ 脱敏显示 |
| `phone` | `phone` | 手动录入/导入 | - |
| `email` | `email` | 手动录入/导入 | - |
| `address` | `province` + `city` + `district` + `street_address` | 手动录入/导入 | - |
| `boundAppleId` | `apple_id` | 匹配填充 | - |
| `tag` | `tag` | 手动录入 | - |
| `status` | `status` | 系统管理 | - |
| `orderCount` | 计算字段 | `COUNT(orders)` | - |
| `totalAmount` | 计算字段 | `SUM(商品金额)` | - |
| `lastOrderDate` | 计算字段 | `MAX(orders.created_at)` | - |
| `createdAt` | `created_at` | 系统生成 | ✅ 系统权威 |

### 可配置列定义

```javascript
const recipientsColumns = [
  {
    key: 'name',
    label: '姓名',
    width: '120px',
    defaultVisible: true,
    sortable: true,
    pinned: false, // 不可取消（标识列）
  },
  {
    key: 'idCard',
    label: '身份证后四位',
    width: '140px',
    defaultVisible: true,
    sortable: false,
    pinned: false,
  },
  {
    key: 'phone',
    label: '联系电话',
    width: '140px',
    defaultVisible: true,
    sortable: false,
    pinned: false,
  },
  {
    key: 'email',
    label: '下单邮箱',
    width: '200px',
    defaultVisible: false, // 默认隐藏
    sortable: false,
    pinned: false,
  },
  {
    key: 'address',
    label: '地址',
    width: '250px',
    defaultVisible: false, // 默认隐藏
    sortable: false,
    pinned: false,
  },
  {
    key: 'boundAppleId',
    label: '绑定 Apple ID',
    width: '200px',
    defaultVisible: false, // 默认隐藏
    sortable: true,
    pinned: false,
  },
  {
    key: 'tag',
    label: '标签',
    width: '120px',
    defaultVisible: true,
    sortable: true,
    pinned: false,
  },
  {
    key: 'status',
    label: '状态',
    width: '100px',
    defaultVisible: true,
    sortable: true,
    pinned: false,
  },
  {
    key: 'orderCount',
    label: '订单数',
    width: '100px',
    defaultVisible: true,
    sortable: true,
    pinned: false,
  },
  {
    key: 'totalAmount',
    label: '总金额',
    width: '120px',
    defaultVisible: true,
    sortable: true,
    pinned: false,
  },
  {
    key: 'lastOrderDate',
    label: '最后下单',
    width: '160px',
    defaultVisible: true,
    sortable: true,
    pinned: false,
  },
  {
    key: 'createdAt',
    label: '创建时间',
    width: '160px',
    defaultVisible: false, // 默认隐藏
    sortable: true,
    pinned: false,
  },
  {
    key: 'actions',
    label: '操作',
    width: '100px',
    defaultVisible: true,
    sortable: false,
    pinned: true, // 固定显示，不可隐藏
  },
]
```

### 默认显示列（9 列）

- ✅ 姓名
- ✅ 身份证后四位
- ✅ 联系电话
- ✅ 标签
- ✅ 状态
- ✅ 订单数
- ✅ 总金额
- ✅ 最后下单
- ✅ 操作（固定）

### 默认隐藏列（4 列）

- ❌ 下单邮箱
- ❌ 地址
- ❌ 绑定 Apple ID
- ❌ 创建时间

---

## 🎨 列配置 UI 设计

### 触发方式

在表格右上角添加"列设置"按钮：

```jsx
<button className="btn btn-secondary flex items-center space-x-2">
  <Settings className="w-4 h-4" />
  <span>列设置</span>
</button>
```

### 弹窗布局

使用模态框（Modal）或侧边抽屉（Drawer）：

```
┌─────────────────────────────────┐
│  列设置                    ✕    │
├─────────────────────────────────┤
│                                 │
│  ☑ 订单号                       │
│  ☑ Apple ID                     │
│  ☑ 取机人                       │
│  ☐ 联系电话                     │
│  ☑ 商品                         │
│  ☑ 金额                         │
│  ☑ 状态                         │
│  ☐ 支付方式                     │
│  ☑ 取货门店                     │
│  ☑ 创建时间                     │
│  ☑ 操作  [固定]                 │
│                                 │
│  [恢复默认]       [保存]        │
└─────────────────────────────────┘
```

### 功能要求

1. **复选框控制显隐**
   - 勾选 = 显示
   - 未勾选 = 隐藏
   - `pinned: true` 的列不可取消勾选，显示为禁用状态

2. **拖拽排序**（可选，v1.0 暂不实现）
   - 使用 `react-beautiful-dnd` 或原生拖拽
   - 拖拽改变列顺序

3. **恢复默认**
   - 恢复为 `defaultVisible` 定义的配置
   - 清除 localStorage 中的配置

4. **保存配置**
   - 保存到 localStorage
   - 立即应用到表格

---

## 💾 配置存储格式

### localStorage Key 命名规范

```
columnConfig:orders
columnConfig:appleIds
columnConfig:recipients
```

### 存储数据结构

```json
{
  "version": "1.0",
  "columns": [
    { "key": "orderNumber", "visible": true, "order": 0 },
    { "key": "appleId", "visible": true, "order": 1 },
    { "key": "recipientName", "visible": true, "order": 2 },
    { "key": "recipientPhone", "visible": false, "order": 3 },
    { "key": "products", "visible": true, "order": 4 },
    { "key": "totalAmount", "visible": true, "order": 5 },
    { "key": "status", "visible": true, "order": 6 },
    { "key": "paymentMethod", "visible": false, "order": 7 },
    { "key": "pickupStore", "visible": true, "order": 8 },
    { "key": "createdAt", "visible": true, "order": 9 },
    { "key": "actions", "visible": true, "order": 10 }
  ],
  "updatedAt": "2026-07-08T10:30:00Z"
}
```

### 字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `version` | String | 配置版本号，用于兼容性检查 |
| `columns` | Array | 列配置数组 |
| `columns[].key` | String | 列唯一标识 |
| `columns[].visible` | Boolean | 是否可见 |
| `columns[].order` | Number | 显示顺序（0 开始） |
| `updatedAt` | String | 最后更新时间（ISO 8601 格式） |

---

## 🔧 技术实现要点

### 1. 列配置 Hook

创建 `useColumnConfig` 自定义 Hook：

```javascript
// hooks/useColumnConfig.js
import { useState, useEffect } from 'react'

export default function useColumnConfig(tableName, defaultColumns) {
  const storageKey = `columnConfig:${tableName}`
  
  const loadConfig = () => {
    const saved = localStorage.getItem(storageKey)
    if (saved) {
      try {
        const config = JSON.parse(saved)
        // 合并配置（处理新增列）
        return mergeColumns(defaultColumns, config.columns)
      } catch (e) {
        console.error('Failed to parse column config:', e)
      }
    }
    return defaultColumns
  }
  
  const [columns, setColumns] = useState(loadConfig)
  
  const saveConfig = (newColumns) => {
    const config = {
      version: '1.0',
      columns: newColumns.map((col, index) => ({
        key: col.key,
        visible: col.visible,
        order: index
      })),
      updatedAt: new Date().toISOString()
    }
    localStorage.setItem(storageKey, JSON.stringify(config))
    setColumns(newColumns)
  }
  
  const resetConfig = () => {
    localStorage.removeItem(storageKey)
    setColumns(defaultColumns)
  }
  
  return { columns, saveConfig, resetConfig }
}
```

### 2. 动态表格渲染

```jsx
// 表头渲染
<thead>
  <tr className="border-b border-gray-200 bg-gray-50">
    {columns
      .filter(col => col.visible)
      .map(col => (
        <th key={col.key} style={{ width: col.width }}>
          {col.label}
        </th>
      ))
    }
  </tr>
</thead>

// 表体渲染
<tbody>
  {data.map(row => (
    <tr key={row.id}>
      {columns
        .filter(col => col.visible)
        .map(col => (
          <td key={col.key}>
            {renderCell(row, col)}
          </td>
        ))
      }
    </tr>
  ))}
</tbody>
```

### 3. 列配置组件

```jsx
// components/ColumnConfigModal.jsx
export default function ColumnConfigModal({ 
  columns, 
  onSave, 
  onReset, 
  onClose 
}) {
  const [tempColumns, setTempColumns] = useState(columns)
  
  const toggleColumn = (key) => {
    setTempColumns(prev => prev.map(col => 
      col.key === key && !col.pinned
        ? { ...col, visible: !col.visible }
        : col
    ))
  }
  
  const handleSave = () => {
    onSave(tempColumns)
    onClose()
  }
  
  const handleReset = () => {
    onReset()
    onClose()
  }
  
  return (
    <div className="modal">
      <div className="modal-content">
        <h3>列设置</h3>
        <div className="column-list">
          {tempColumns.map(col => (
            <label key={col.key} className="column-item">
              <input
                type="checkbox"
                checked={col.visible}
                onChange={() => toggleColumn(col.key)}
                disabled={col.pinned}
              />
              <span>{col.label}</span>
              {col.pinned && <span className="badge">固定</span>}
              {col.sensitive && <span className="badge badge-warning">敏感</span>}
            </label>
          ))}
        </div>
        <div className="modal-actions">
          <button onClick={handleReset}>恢复默认</button>
          <button onClick={handleSave}>保存</button>
        </div>
      </div>
    </div>
  )
}
```

---

## ✅ 验收标准

### 功能验收

- [ ] 点击"列设置"按钮，弹出列配置弹窗
- [ ] 勾选/取消勾选列，表格立即更新
- [ ] 固定列（`pinned: true`）不可取消勾选
- [ ] 点击"保存"，配置保存到 localStorage
- [ ] 刷新页面，配置仍然生效
- [ ] 点击"恢复默认"，恢复为初始配置
- [ ] 三个表格（Orders、AppleIds、Recipients）的配置互相独立

### 兼容性验收

- [ ] 如果 localStorage 中没有配置，使用默认配置
- [ ] 如果 localStorage 中有旧版本配置，能正常解析或回退到默认
- [ ] 如果新增了列，旧配置能正常合并新列

---

## 📝 开发清单

### Phase 1: 基础实现
- [ ] 创建列配置常量文件（`constants/tableColumns.js`）
- [ ] 实现 `useColumnConfig` Hook
- [ ] 实现 `ColumnConfigModal` 组件

### Phase 2: 集成到页面
- [ ] Orders 页面集成列配置
- [ ] AppleIds 页面集成列配置
- [ ] Recipients 页面集成列配置

### Phase 3: 测试和优化
- [ ] 测试配置保存和恢复
- [ ] 测试刷新页面后的持久化
- [ ] 测试恢复默认功能
- [ ] 优化 UI 和交互

---

**参考文档**：
- 数据库设计：`docs/database/SCHEMA.md`
- 前端设计规范：`docs/development/FRONTEND_DESIGN_SPEC.md`
