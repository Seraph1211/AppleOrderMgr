# Apple 订单管理系统 - 前端设计规范

> 本文档定义了 Apple 订单管理系统前端界面的设计标准，确保所有开发人员在实现新功能时保持视觉和交互的一致性。

## 📋 目录

- [设计系统概述](#设计系统概述)
- [配色方案](#配色方案)
- [字体规范](#字体规范)
- [组件库](#组件库)
- [布局规范](#布局规范)
- [交互规范](#交互规范)
- [图标使用](#图标使用)
- [响应式设计](#响应式设计)
- [开发检查清单](#开发检查清单)

---

## 设计系统概述

### 设计理念
- **清晰简洁** - 使用浅色主题，减少视觉干扰
- **数据优先** - 强调数据展示，使用表格列表而非卡片（仪表板统计除外）
- **高效操作** - 减少点击层级，快速访问核心功能
- **专业可靠** - 蓝色系传递信任感，适合管理后台

### 风格定位
- **UI 风格**: 现代简约 (Modern Clean)
- **主题**: 浅色主题 (Light Mode)
- **技术栈**: React + Tailwind CSS + Lucide Icons

---

## 配色方案

### 主色调 (Primary)

**用途**: 主要操作按钮、链接、导航高亮、强调元素

```css
/* Tailwind 类名 */
bg-primary        /* #1E3A8A - 深蓝色 */
bg-primary-50     /* #EFF6FF - 极浅蓝（图标背景） */
bg-primary-700    /* #1D4ED8 - 悬停状态 */

text-primary
border-primary
```

**示例**:
```jsx
// 主按钮
<button className="bg-primary hover:bg-primary-700 text-white">保存</button>

// 图标背景
<div className="w-10 h-10 bg-primary-50 rounded-lg flex items-center justify-center">
  <Mail className="w-5 h-5 text-primary" />
</div>

// 链接文字
<a className="text-primary hover:text-primary-700">查看详情</a>
```

### 辅助色 (Accent)

**用途**: 次要强调元素、金额显示、特殊标记

```css
bg-accent         /* #7C3AED - 紫色 */
text-accent
```

**示例**:
```jsx
// 金额强调
<span className="text-lg font-semibold text-accent">¥19,999</span>
```

### 中性色 (Neutral)

**用途**: 文字、背景、边框、卡片

```css
/* 背景色 */
bg-white          /* 卡片、表格、侧边栏 */
bg-gray-50        /* 页面背景 */
bg-gray-100       /* 悬停状态 */

/* 文字色 */
text-gray-900     /* 主要标题 */
text-gray-700     /* 次要标题 */
text-gray-600     /* 正文 */
text-gray-500     /* 辅助文字、表头 */
text-gray-400     /* 图标、占位符 */

/* 边框色 */
border-gray-200   /* 卡片、表格边框 */
border-gray-300   /* 输入框边框 */
```

### 语义色 (Semantic)

**用途**: 状态标识、反馈信息

```css
/* 成功 - 绿色 */
bg-green-100 text-green-700 border-green-200    /* 成功徽章 */

/* 警告 - 黄色 */
bg-yellow-100 text-yellow-700 border-yellow-200  /* 警告徽章 */

/* 错误 - 红色 */
bg-red-100 text-red-700 border-red-200           /* 错误徽章 */

/* 信息 - 蓝色 */
bg-blue-100 text-blue-700 border-blue-200        /* 信息徽章 */
```

**示例**:
```jsx
// 订单状态徽章
<span className="badge badge-success">已完成</span>
<span className="badge badge-warning">待处理</span>
<span className="badge badge-error">已取消</span>
<span className="badge badge-info">处理中</span>
```

---

## 字体规范

### 字体家族

```css
font-family: 'Fira Sans', system-ui, sans-serif;  /* 正文字体 */
font-family: 'Fira Code', monospace;              /* 代码/订单号 */
```

### 字体大小

| 用途 | Tailwind 类 | 大小 | 示例 |
|------|------------|------|------|
| 页面主标题 | `text-3xl` | 30px | 仪表板、订单管理 |
| 卡片标题 | `text-xl` | 20px | 最近订单、订单信息 |
| 正文 | `text-base` | 16px | 表格内容 |
| 辅助文字 | `text-sm` | 14px | 表头、描述文字 |
| 标签/徽章 | `text-xs` | 12px | 状态徽章 |

### 字重

| 用途 | Tailwind 类 | 字重 |
|------|------------|------|
| 页面标题 | `font-bold` | 700 |
| 卡片标题 | `font-semibold` | 600 |
| 强调文字 | `font-medium` | 500 |
| 正文 | `font-normal` | 400 |
| 次要文字 | `font-light` | 300 |

**示例**:
```jsx
// 页面标题
<h1 className="text-3xl font-bold text-gray-900">订单管理</h1>

// 辅助说明
<p className="text-gray-500 mt-1">管理所有 Apple 订单</p>

// 订单号（等宽字体）
<span className="font-mono text-sm text-primary">W123456789</span>

// 数据强调
<span className="text-lg font-semibold text-primary">156</span>
```

---

## 组件库

### 按钮 (Button)

#### 主按钮 (Primary)

```jsx
<button className="btn btn-primary">
  保存
</button>
```

**样式**:
- 背景: `bg-primary`
- 悬停: `hover:bg-primary-700`
- 文字: `text-white`
- 圆角: `rounded-lg`
- 内边距: `px-4 py-2`
- 阴影: `shadow-sm hover:shadow-md`

#### 次要按钮 (Secondary)

```jsx
<button className="btn btn-secondary">
  取消
</button>
```

**样式**:
- 背景: `bg-white`
- 悬停: `hover:bg-gray-50`
- 文字: `text-gray-700`
- 边框: `border border-gray-300`

#### 带图标按钮

```jsx
<button className="btn btn-primary flex items-center space-x-2">
  <Plus className="w-4 h-4" />
  <span>添加订单</span>
</button>
```

**图标规范**:
- 尺寸: `w-4 h-4` (16px)
- 间距: `space-x-2` (8px)
- 位置: 文字左侧

### 卡片 (Card)

**用途**: 仅用于仪表板统计数据展示

```jsx
<div className="card">
  <h2 className="text-xl font-semibold mb-4">标题</h2>
  {/* 内容 */}
</div>
```

**样式**:
- 背景: `bg-white`
- 边框: `border border-gray-200`
- 圆角: `rounded-xl`
- 内边距: `p-6`
- 阴影: `shadow-sm hover:shadow-md`
- 过渡: `transition-all duration-200`

**⚠️ 重要**: 除仪表板统计卡片外，其他页面使用表格列表展示数据。

### 输入框 (Input)

```jsx
<input 
  type="text" 
  placeholder="搜索订单号..."
  className="input"
/>
```

**样式**:
- 背景: `bg-white`
- 边框: `border border-gray-300`
- 聚焦: `focus:ring-2 focus:ring-primary`
- 圆角: `rounded-lg`
- 内边距: `px-4 py-2`

**带图标的搜索框**:
```jsx
<div className="relative">
  <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-gray-400" />
  <input 
    type="text" 
    placeholder="搜索..."
    className="input pl-10"
  />
</div>
```

### 徽章 (Badge)

```jsx
<span className="badge badge-success">已完成</span>
<span className="badge badge-warning">待处理</span>
<span className="badge badge-error">已取消</span>
<span className="badge badge-info">处理中</span>
```

**样式**:
- 圆角: `rounded-full`
- 内边距: `px-2.5 py-0.5`
- 字体: `text-xs font-medium`
- 带边框: `border`

### 表格 (Table)

**标准表格结构**:

```jsx
<div className="card">
  <div className="overflow-x-auto">
    <table className="w-full">
      <thead>
        <tr className="border-b border-gray-200 bg-gray-50">
          <th className="text-left py-3 px-4 text-sm font-medium text-gray-500">
            列标题
          </th>
        </tr>
      </thead>
      <tbody className="bg-white">
        <tr className="border-b border-gray-200 hover:bg-gray-50 transition-colors">
          <td className="py-4 px-4 text-sm text-gray-600">
            单元格内容
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</div>
```

**表格规范**:
- 表头背景: `bg-gray-50`
- 表头文字: `text-gray-500 text-sm font-medium`
- 单元格间距: `py-4 px-4`
- 边框: `border-b border-gray-200`
- 悬停: `hover:bg-gray-50`
- 文字对齐: `text-left` / `text-center` / `text-right`

**带图标的表格单元格**:
```jsx
<td className="py-4 px-4">
  <div className="flex items-center space-x-3">
    <div className="w-10 h-10 bg-primary-50 rounded-lg flex items-center justify-center">
      <Mail className="w-5 h-5 text-primary" />
    </div>
    <div>
      <p className="text-sm font-medium text-gray-900">user@example.com</p>
    </div>
  </div>
</td>
```

---

## 布局规范

### 页面结构

```
┌─────────────────────────────────────────────┐
│ 侧边栏 (240px)  │  主内容区                   │
│                 │                             │
│  Logo          │  ┌─ 顶部栏 (64px) ────────┐ │
│                 │  │  菜单 + 状态指示         │ │
│  导航菜单       │  └─────────────────────────┘ │
│                 │                             │
│                 │  ┌─ 内容区 (padding: 24px) ┐│
│                 │  │                          ││
│                 │  │  页面内容                ││
│                 │  │                          ││
│                 │  └──────────────────────────┘│
└─────────────────────────────────────────────┘
```

### 间距系统

| 用途 | Tailwind 类 | 尺寸 |
|------|------------|------|
| 页面外边距 | `p-6` | 24px |
| 卡片内边距 | `p-6` | 24px |
| 组件间距 | `space-y-6` | 24px |
| 表格单元格 | `py-4 px-4` | 16px 垂直, 16px 水平 |
| 按钮内边距 | `px-4 py-2` | 16px 水平, 8px 垂直 |
| 图标与文字间距 | `space-x-2` / `space-x-3` | 8px / 12px |

### 圆角规范

| 元素 | Tailwind 类 | 圆角 |
|------|------------|------|
| 卡片 | `rounded-xl` | 12px |
| 按钮 | `rounded-lg` | 8px |
| 输入框 | `rounded-lg` | 8px |
| 图标背景 | `rounded-lg` | 8px |
| 徽章 | `rounded-full` | 完全圆角 |

---

## 交互规范

### 悬停效果

**按钮悬停**:
```jsx
// 主按钮
hover:bg-primary-700 hover:shadow-md

// 次要按钮
hover:bg-gray-50

// 图标按钮
hover:bg-gray-100
```

**表格行悬停**:
```jsx
hover:bg-gray-50 transition-colors
```

**链接悬停**:
```jsx
text-primary hover:text-primary-700 transition-colors
```

### 过渡动画

**标准过渡**:
```jsx
transition-all duration-200
```

**颜色过渡**:
```jsx
transition-colors duration-200
```

**阴影过渡**:
```jsx
hover:shadow-md transition-all duration-200
```

### 聚焦状态

**输入框聚焦**:
```jsx
focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent
```

**按钮聚焦**:
```jsx
focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2
```

### 加载状态

```jsx
<div className="flex items-center justify-center py-12">
  <div className="text-center">
    <div className="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
    <p className="text-gray-500">加载中...</p>
  </div>
</div>
```

---

## 图标使用

### 图标库
**使用 Lucide React**: https://lucide.dev/

### 图标尺寸

| 场景 | 类名 | 尺寸 |
|------|------|------|
| 按钮内图标 | `w-4 h-4` | 16px |
| 导航图标 | `w-5 h-5` | 20px |
| 表格图标 | `w-4 h-4` | 16px |
| 装饰图标 | `w-8 h-8` | 32px |

### 常用图标

```jsx
import {
  LayoutDashboard,  // 仪表板
  Package,          // 订单/包裹
  User,             // 用户/取机人
  Mail,             // 邮件/Apple ID
  Apple,            // Apple 品牌
  Search,           // 搜索
  Plus,             // 添加
  Edit,             // 编辑
  Trash2,           // 删除
  RefreshCw,        // 刷新
  Download,         // 下载
  Filter,           // 筛选
  ArrowLeft,        // 返回
  ExternalLink,     // 外部链接
  CheckCircle,      // 成功
  XCircle,          // 错误
  AlertCircle,      // 警告
  Clock,            // 时间
  TrendingUp,       // 增长
  CreditCard,       // 支付
  MapPin,           // 位置
  Calendar,         // 日历
  Phone,            // 电话
} from 'lucide-react'
```

### 图标颜色

```jsx
// 主色图标
<Mail className="w-5 h-5 text-primary" />

// 辅助色图标
<CreditCard className="w-4 h-4 text-accent" />

// 中性色图标
<Search className="w-5 h-5 text-gray-400" />

// 图标背景
<div className="w-10 h-10 bg-primary-50 rounded-lg flex items-center justify-center">
  <User className="w-5 h-5 text-primary" />
</div>
```

---

## 响应式设计

### 断点

```css
/* Tailwind 断点 */
sm: 640px   /* 平板竖屏 */
md: 768px   /* 平板横屏 */
lg: 1024px  /* 桌面 */
xl: 1280px  /* 大屏桌面 */
```

### 响应式布局

**侧边栏**:
```jsx
{/* 移动端: 隐藏, 桌面端: 显示 */}
<aside className="hidden lg:block">
  {/* 侧边栏内容 */}
</aside>

{/* 移动端菜单按钮 */}
<button className="lg:hidden">
  <Menu className="w-6 h-6" />
</button>
```

**网格布局**:
```jsx
{/* 响应式网格 */}
<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
  {/* 卡片 */}
</div>
```

**表格**:
```jsx
{/* 表格水平滚动 */}
<div className="overflow-x-auto">
  <table className="w-full">
    {/* 表格内容 */}
  </table>
</div>
```

---

## 开发检查清单

### 新页面开发

- [ ] 页面标题使用 `text-3xl font-bold text-gray-900`
- [ ] 辅助说明使用 `text-gray-500 mt-1`
- [ ] 数据使用表格展示（除仪表板统计）
- [ ] 表头背景色 `bg-gray-50`
- [ ] 表格行悬停 `hover:bg-gray-50`
- [ ] 操作按钮在右侧对齐 `text-right`
- [ ] 搜索框带图标 (Search)
- [ ] 加载状态使用标准组件

### 新组件开发

- [ ] 按钮使用 `btn btn-primary` 或 `btn btn-secondary`
- [ ] 输入框使用 `input` 类
- [ ] 徽章使用 `badge badge-{type}`
- [ ] 图标尺寸正确 (`w-4 h-4` 或 `w-5 h-5`)
- [ ] 图标颜色符合规范
- [ ] 间距使用设计系统定义的值
- [ ] 圆角使用标准值 (`rounded-lg` / `rounded-xl`)
- [ ] 悬停效果平滑 (`transition-all duration-200`)

### 交互开发

- [ ] 所有可点击元素有 `cursor-pointer`
- [ ] 悬停状态明确可见
- [ ] 聚焦状态符合规范 (`focus:ring-2 focus:ring-primary`)
- [ ] 过渡动画 150-300ms
- [ ] 表格行悬停高亮

### 响应式开发

- [ ] 在 375px (移动端) 测试
- [ ] 在 768px (平板) 测试
- [ ] 在 1024px (桌面) 测试
- [ ] 侧边栏在移动端可折叠
- [ ] 表格在小屏幕可横向滚动

### 无障碍开发

- [ ] 文字对比度 ≥ 4.5:1 (WCAG AA)
- [ ] 聚焦状态可见
- [ ] 图标有语义化标签
- [ ] 表单输入有 placeholder
- [ ] 按钮文字清晰

---

## 示例代码

### 完整页面示例

```jsx
import { useState, useEffect } from 'react'
import { Search, Plus, Edit, Trash2, Package } from 'lucide-react'

export default function ExamplePage() {
  const [data, setData] = useState([])
  const [loading, setLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState('')

  useEffect(() => {
    loadData()
  }, [])

  const loadData = async () => {
    setLoading(true)
    // TODO: API 调用
    setLoading(false)
  }

  return (
    <div className="space-y-6">
      {/* 页面标题 */}
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

      {/* 搜索 */}
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

      {/* 数据列表 */}
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
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-500">列1</th>
                  <th className="text-center py-3 px-4 text-sm font-medium text-gray-500">列2</th>
                  <th className="text-right py-3 px-4 text-sm font-medium text-gray-500">操作</th>
                </tr>
              </thead>
              <tbody className="bg-white">
                {data.map((item) => (
                  <tr key={item.id} className="border-b border-gray-200 hover:bg-gray-50 transition-colors">
                    <td className="py-4 px-4">
                      <div className="flex items-center space-x-3">
                        <div className="w-10 h-10 bg-primary-50 rounded-lg flex items-center justify-center">
                          <Package className="w-5 h-5 text-primary" />
                        </div>
                        <div>
                          <p className="text-sm font-medium text-gray-900">{item.name}</p>
                        </div>
                      </div>
                    </td>
                    <td className="py-4 px-4 text-center text-sm text-gray-600">
                      {item.value}
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

---

## 维护与更新

### 更新流程

1. **提出变更** - 在团队中讨论设计变更需求
2. **更新文档** - 修改本设计规范文档
3. **更新组件** - 修改 `src/index.css` 中的组件样式
4. **通知团队** - 确保所有开发人员知晓变更
5. **审查代码** - 在 PR 中检查是否符合规范

### 版本历史

- **v1.0** (2026-07-08) - 初始版本，浅色主题 + 列表布局

---

**最后更新**: 2026-07-08  
**维护者**: seraphpeng  
**生成工具**: UI/UX Pro Max Skill v2.6.2
