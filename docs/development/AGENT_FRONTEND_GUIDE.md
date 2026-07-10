# Agent 前端开发指南

> 本文档为 AI Agent 提供明确的开发指令，确保在开发新功能时严格遵循设计规范。

## 🎯 核心原则

**在开发任何前端代码前，必须先阅读并遵循 `docs/development/FRONTEND_DESIGN_SPEC.md`**

## ⚠️ 强制要求

### 1. 布局规则

**✅ 必须使用表格列表**:
- Apple ID 管理页面
- 取机人管理页面
- 订单列表页面
- 任何数据展示页面

**❌ 禁止使用卡片网格布局**（除仪表板统计数据外）

**示例 - 正确的列表布局**:
```jsx
<div className="card">
  <div className="overflow-x-auto">
    <table className="w-full">
      <thead>
        <tr className="border-b border-gray-200 bg-gray-50">
          <th className="text-left py-3 px-4 text-sm font-medium text-gray-500">列名</th>
        </tr>
      </thead>
      <tbody className="bg-white">
        <tr className="border-b border-gray-200 hover:bg-gray-50 transition-colors">
          <td className="py-4 px-4 text-sm text-gray-600">数据</td>
        </tr>
      </tbody>
    </table>
  </div>
</div>
```

**示例 - 错误的卡片布局** (❌ 不要这样做):
```jsx
{/* ❌ 错误: 不要用卡片网格 */}
<div className="grid grid-cols-3 gap-6">
  {items.map(item => (
    <div className="card">...</div>
  ))}
</div>
```

### 2. 配色规则

**主色 (Primary) - 深蓝色**:
```jsx
// ✅ 正确用法
bg-primary           // 主按钮背景
text-primary         // 链接、强调文字
bg-primary-50        // 图标背景（浅色）
hover:bg-primary-700 // 悬停状态
```

**辅助色 (Accent) - 紫色**:
```jsx
// ✅ 用于金额等特殊强调
text-accent          // 金额显示
```

**中性色**:
```jsx
// ✅ 文字颜色
text-gray-900  // 主标题
text-gray-600  // 正文
text-gray-500  // 辅助文字/表头
text-gray-400  // 图标/占位符

// ✅ 背景颜色
bg-white       // 卡片、表格
bg-gray-50     // 页面背景、表头
bg-gray-100    // 悬停状态

// ✅ 边框颜色
border-gray-200  // 卡片、表格边框
border-gray-300  // 输入框边框
```

**❌ 禁止使用深色主题**:
```jsx
// ❌ 错误: 不要使用深色背景
bg-dark-bg
bg-dark-surface
text-dark-text
text-dark-muted
border-dark-border
```

### 3. 组件使用规则

**按钮**:
```jsx
// ✅ 正确: 主按钮
<button className="btn btn-primary">保存</button>

// ✅ 正确: 次要按钮
<button className="btn btn-secondary">取消</button>

// ✅ 正确: 带图标按钮
<button className="btn btn-primary flex items-center space-x-2">
  <Plus className="w-4 h-4" />
  <span>添加</span>
</button>
```

**输入框**:
```jsx
// ✅ 正确: 标准输入框
<input type="text" className="input" placeholder="请输入..." />

// ✅ 正确: 带图标搜索框
<div className="relative">
  <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-gray-400" />
  <input type="text" className="input pl-10" placeholder="搜索..." />
</div>
```

**徽章**:
```jsx
// ✅ 正确: 状态徽章
<span className="badge badge-success">已完成</span>
<span className="badge badge-warning">待处理</span>
<span className="badge badge-error">已取消</span>
<span className="badge badge-info">处理中</span>
```

**卡片** (仅用于统计数据):
```jsx
// ✅ 正确: 仅在仪表板统计使用
<div className="card">
  <p className="text-sm text-gray-500">订单总数</p>
  <p className="text-3xl font-bold mt-2">156</p>
</div>

// ❌ 错误: 不要在列表页面使用卡片
<div className="grid grid-cols-3 gap-6">
  {users.map(user => <div className="card">...</div>)}
</div>
```

### 4. 图标使用规则

**图标库**: Lucide React

**图标尺寸**:
```jsx
// ✅ 按钮内图标
<Plus className="w-4 h-4" />

// ✅ 导航/列表图标
<Mail className="w-5 h-5" />

// ✅ 装饰性大图标
<Package className="w-8 h-8" />
```

**图标颜色**:
```jsx
// ✅ 主色图标
<Mail className="w-5 h-5 text-primary" />

// ✅ 中性色图标
<Search className="w-5 h-5 text-gray-400" />

// ✅ 图标带背景
<div className="w-10 h-10 bg-primary-50 rounded-lg flex items-center justify-center">
  <User className="w-5 h-5 text-primary" />
</div>
```

### 5. 页面结构规则

**标准页面结构**:
```jsx
export default function PageName() {
  const [data, setData] = useState([])
  const [loading, setLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState('')

  useEffect(() => {
    loadData()
  }, [])

  const loadData = async () => {
    setLoading(true)
    // API 调用
    setLoading(false)
  }

  return (
    <div className="space-y-6">
      {/* 1. 页面标题 */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">页面标题</h1>
          <p className="text-gray-500 mt-1">页面描述</p>
        </div>
        <button className="btn btn-primary flex items-center space-x-2">
          <Plus className="w-4 h-4" />
          <span>添加</span>
        </button>
      </div>

      {/* 2. 搜索/筛选 */}
      <div className="card">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-gray-400" />
          <input
            type="text"
            placeholder="搜索..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="input pl-10"
          />
        </div>
      </div>

      {/* 3. 数据表格 */}
      <div className="card">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="text-center">
              <div className="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
              <p className="text-gray-500">加载中...</p>
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              {/* 表格内容 */}
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
```

## 📋 开发前检查清单

在开始编写代码前，确认以下事项：

### 阅读文档
- [ ] 已阅读 `docs/development/FRONTEND_DESIGN_SPEC.md`
- [ ] 理解配色方案（蓝色主色，紫色辅助色）
- [ ] 理解布局规则（表格列表，非卡片网格）
- [ ] 理解组件使用规范

### 页面布局
- [ ] 使用表格列表展示数据（除仪表板统计）
- [ ] 页面标题使用 `text-3xl font-bold text-gray-900`
- [ ] 辅助说明使用 `text-gray-500`
- [ ] 表头背景使用 `bg-gray-50`
- [ ] 表格行悬停使用 `hover:bg-gray-50`

### 配色
- [ ] 主按钮使用 `btn btn-primary`
- [ ] 链接使用 `text-primary hover:text-primary-700`
- [ ] 文字使用 `text-gray-900/600/500`
- [ ] 背景使用 `bg-white/bg-gray-50`
- [ ] 不使用深色主题类名

### 组件
- [ ] 按钮使用 `btn` 基类
- [ ] 输入框使用 `input` 类
- [ ] 徽章使用 `badge badge-{type}`
- [ ] 图标尺寸正确（`w-4 h-4` 或 `w-5 h-5`）
- [ ] 加载状态使用标准组件

## 🔍 代码审查要点

在提交代码前，自查以下内容：

### 1. 布局审查
```bash
# ❌ 搜索卡片网格布局（应避免）
grep -r "grid.*gap" src/pages/

# ✅ 确认使用表格
grep -r "<table" src/pages/
```

### 2. 配色审查
```bash
# ❌ 搜索深色主题类名（不应存在）
grep -r "dark-bg\|dark-text\|dark-muted\|dark-border" src/

# ✅ 确认使用浅色主题
grep -r "bg-white\|bg-gray-50\|text-gray" src/
```

### 3. 组件审查
```bash
# ✅ 确认使用标准组件类
grep -r "btn btn-primary\|input\|badge badge-" src/
```

## 🎨 常见场景示例

### 场景 1: 创建新的数据列表页面

**要求**: 创建"供应商管理"页面

**正确实现**:
```jsx
import { useState, useEffect } from 'react'
import { Search, Plus, Edit, Trash2, Building } from 'lucide-react'

export default function Suppliers() {
  const [suppliers, setSuppliers] = useState([])
  const [loading, setLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState('')

  useEffect(() => {
    loadSuppliers()
  }, [])

  const loadSuppliers = async () => {
    setLoading(true)
    // TODO: API 调用
    setLoading(false)
  }

  const filteredSuppliers = suppliers.filter(s =>
    s.name.toLowerCase().includes(searchTerm.toLowerCase())
  )

  return (
    <div className="space-y-6">
      {/* 页面标题 */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">供应商管理</h1>
          <p className="text-gray-500 mt-1">管理所有供应商信息</p>
        </div>
        <button className="btn btn-primary flex items-center space-x-2">
          <Plus className="w-4 h-4" />
          <span>添加供应商</span>
        </button>
      </div>

      {/* 搜索 */}
      <div className="card">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-gray-400" />
          <input
            type="text"
            placeholder="搜索供应商..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="input pl-10"
          />
        </div>
      </div>

      {/* 供应商列表 - 使用表格 */}
      <div className="card">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="text-center">
              <div className="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
              <p className="text-gray-500">加载中...</p>
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50">
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-500">供应商名称</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-500">联系人</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-500">电话</th>
                  <th className="text-center py-3 px-4 text-sm font-medium text-gray-500">合作订单</th>
                  <th className="text-right py-3 px-4 text-sm font-medium text-gray-500">操作</th>
                </tr>
              </thead>
              <tbody className="bg-white">
                {filteredSuppliers.map((supplier) => (
                  <tr key={supplier.id} className="border-b border-gray-200 hover:bg-gray-50 transition-colors">
                    <td className="py-4 px-4">
                      <div className="flex items-center space-x-3">
                        <div className="w-10 h-10 bg-primary-50 rounded-lg flex items-center justify-center">
                          <Building className="w-5 h-5 text-primary" />
                        </div>
                        <div>
                          <p className="text-sm font-medium text-gray-900">{supplier.name}</p>
                        </div>
                      </div>
                    </td>
                    <td className="py-4 px-4 text-sm text-gray-600">{supplier.contact}</td>
                    <td className="py-4 px-4 text-sm text-gray-600">{supplier.phone}</td>
                    <td className="py-4 px-4 text-center">
                      <span className="text-lg font-semibold text-primary">{supplier.orderCount}</span>
                    </td>
                    <td className="py-4 px-4">
                      <div className="flex items-center justify-end space-x-2">
                        <button className="p-2 hover:bg-gray-100 rounded-lg transition-colors">
                          <Edit className="w-4 h-4 text-gray-400 hover:text-primary" />
                        </button>
                        <button className="p-2 hover:bg-gray-100 rounded-lg transition-colors">
                          <Trash2 className="w-4 h-4 text-gray-400 hover:text-red-500" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
```

### 场景 2: 添加新的表单页面

**要求**: 创建"添加订单"表单

**正确实现**:
```jsx
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, Save } from 'lucide-react'

export default function AddOrder() {
  const navigate = useNavigate()
  const [formData, setFormData] = useState({
    appleId: '',
    recipient: '',
    products: ''
  })

  const handleSubmit = async (e) => {
    e.preventDefault()
    // TODO: API 调用
    navigate('/orders')
  }

  return (
    <div className="space-y-6">
      {/* 返回按钮 */}
      <button
        onClick={() => navigate('/orders')}
        className="flex items-center space-x-2 text-gray-500 hover:text-gray-700 transition-colors"
      >
        <ArrowLeft className="w-4 h-4" />
        <span>返回订单列表</span>
      </button>

      {/* 页面标题 */}
      <div>
        <h1 className="text-3xl font-bold text-gray-900">添加订单</h1>
        <p className="text-gray-500 mt-1">填写订单信息</p>
      </div>

      {/* 表单 */}
      <div className="card">
        <form onSubmit={handleSubmit} className="space-y-6">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Apple ID
            </label>
            <input
              type="email"
              value={formData.appleId}
              onChange={(e) => setFormData({ ...formData, appleId: e.target.value })}
              placeholder="请输入 Apple ID"
              className="input"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              取机人
            </label>
            <input
              type="text"
              value={formData.recipient}
              onChange={(e) => setFormData({ ...formData, recipient: e.target.value })}
              placeholder="请输入取机人姓名"
              className="input"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              商品
            </label>
            <textarea
              value={formData.products}
              onChange={(e) => setFormData({ ...formData, products: e.target.value })}
              placeholder="请输入商品信息"
              className="input"
              rows={4}
              required
            />
          </div>

          <div className="flex space-x-4">
            <button type="submit" className="btn btn-primary flex items-center space-x-2">
              <Save className="w-4 h-4" />
              <span>保存</span>
            </button>
            <button
              type="button"
              onClick={() => navigate('/orders')}
              className="btn btn-secondary"
            >
              取消
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
```

## 🚫 常见错误示例

### 错误 1: 使用卡片网格而非表格

❌ **错误**:
```jsx
<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
  {appleIds.map(appleId => (
    <div key={appleId.id} className="card">
      <h3>{appleId.email}</h3>
      <p>订单数: {appleId.orderCount}</p>
    </div>
  ))}
</div>
```

✅ **正确**:
```jsx
<div className="card">
  <div className="overflow-x-auto">
    <table className="w-full">
      <thead>
        <tr className="border-b border-gray-200 bg-gray-50">
          <th className="text-left py-3 px-4 text-sm font-medium text-gray-500">邮箱</th>
          <th className="text-center py-3 px-4 text-sm font-medium text-gray-500">订单数</th>
        </tr>
      </thead>
      <tbody className="bg-white">
        {appleIds.map(appleId => (
          <tr key={appleId.id} className="border-b border-gray-200 hover:bg-gray-50 transition-colors">
            <td className="py-4 px-4 text-sm text-gray-900">{appleId.email}</td>
            <td className="py-4 px-4 text-center text-lg font-semibold text-primary">{appleId.orderCount}</td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
</div>
```

### 错误 2: 使用深色主题类名

❌ **错误**:
```jsx
<div className="bg-dark-surface text-dark-text border-dark-border">
  <p className="text-dark-muted">内容</p>
</div>
```

✅ **正确**:
```jsx
<div className="bg-white text-gray-900 border-gray-200">
  <p className="text-gray-500">内容</p>
</div>
```

### 错误 3: 图标尺寸不规范

❌ **错误**:
```jsx
<Plus className="w-3 h-3" />  {/* 太小 */}
<Edit className="w-6 h-6" />  {/* 按钮内图标太大 */}
```

✅ **正确**:
```jsx
<Plus className="w-4 h-4" />   {/* 按钮内图标 */}
<Edit className="w-5 h-5" />   {/* 列表图标 */}
```

## 📞 获取帮助

如有疑问，请参考：
- **设计规范**: `docs/development/FRONTEND_DESIGN_SPEC.md`
- **现有代码**: `frontend/src/pages/` 中的示例页面
- **组件样式**: `frontend/src/index.css`

---

**最后更新**: 2026-07-08  
**维护者**: seraphpeng
