# Apple 订单管理系统 - 前端

基于 UI/UX Pro Max Skill 生成的深色主题管理面板。

## 🎨 设计系统

- **风格**: Dark Mode (OLED) - 深色主题，适合运营/管理面板
- **主色**: 青色 (#0D9488) - 主要操作按钮和强调元素
- **辅助色**: 琥珀色 (#D97706) - CTA 和重要提示
- **字体**: 
  - Fira Sans - 界面文字
  - Fira Code - 代码和订单号

## 🚀 快速开始

### 安装依赖

```bash
npm install
```

### 开发模式

```bash
npm run dev
```

应用将在 http://localhost:5173 启动

### 构建生产版本

```bash
npm run build
```

### 预览生产构建

```bash
npm run preview
```

## 📁 项目结构

```
frontend/
├── src/
│   ├── components/        # 可复用组件
│   │   └── Layout.jsx    # 主布局（侧边栏 + 顶部栏）
│   ├── pages/            # 页面组件
│   │   ├── Dashboard.jsx      # 仪表板
│   │   ├── Orders.jsx         # 订单列表
│   │   ├── OrderDetail.jsx    # 订单详情
│   │   ├── AppleIds.jsx       # Apple ID 管理
│   │   └── Recipients.jsx     # 取机人管理
│   ├── hooks/            # 自定义 Hooks
│   ├── utils/            # 工具函数
│   ├── services/         # API 服务
│   ├── App.jsx          # 根组件
│   ├── main.jsx         # 入口文件
│   └── index.css        # 全局样式
├── index.html
├── package.json
├── vite.config.js
├── tailwind.config.js
└── postcss.config.js
```

## 🎯 功能特性

### 1. 仪表板
- 实时订单统计（总订单、待处理、已完成）
- Apple ID 和取机人数量概览
- 最近订单列表
- 关键指标可视化

### 2. 订单管理
- 订单列表展示（支持搜索和筛选）
- 订单详情查看
- 订单状态实时更新
- 导出订单数据

### 3. Apple ID 管理
- Apple ID 列表
- 每个账号的订单统计
- 添加/编辑/删除 Apple ID

### 4. 取机人管理
- 取机人信息管理
- 订单数和总金额统计
- 联系方式管理

## 🎨 UI 组件

### 基础组件
- **按钮**: `btn`, `btn-primary`, `btn-secondary`
- **卡片**: `card`
- **输入框**: `input`
- **徽章**: `badge`, `badge-success`, `badge-warning`, `badge-error`, `badge-info`

### 使用示例

```jsx
// 主按钮
<button className="btn btn-primary">
  保存
</button>

// 卡片
<div className="card">
  <h2>标题</h2>
  <p>内容</p>
</div>

// 状态徽章
<span className="badge badge-success">已完成</span>
```

## 🌈 配色方案

```css
/* 主色 - 青色 */
--primary: #0D9488
--primary-50: #F0FDFA
--primary-600: #0D9488
--primary-700: #0F766E

/* 辅助色 - 琥珀色 */
--accent: #D97706

/* 深色主题 */
--dark-bg: #0A0E1A        /* 背景 */
--dark-surface: #131827   /* 卡片/面板 */
--dark-border: #1F2937    /* 边框 */
--dark-text: #F9FAFB      /* 文字 */
--dark-muted: #9CA3AF     /* 次要文字 */
```

## 🔧 API 集成

前端通过 Vite 代理连接后端 API：

```javascript
// vite.config.js
export default defineConfig({
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true
      }
    }
  }
})
```

### API 调用示例

```javascript
import axios from 'axios'

// 获取订单列表
const response = await axios.get('/api/orders')

// 获取订单详情
const order = await axios.get(`/api/orders/${id}`)
```

## 📱 响应式设计

支持以下断点：
- 移动端: 375px
- 平板: 768px
- 桌面: 1024px
- 大屏: 1440px

## ✨ 特效

- **发光效果**: 主要元素带有青色发光阴影
- **平滑过渡**: 所有交互元素 150-300ms 过渡
- **悬停状态**: 按钮和卡片的悬停反馈
- **Focus 状态**: 键盘导航可见的焦点状态

## 🔐 无障碍支持

- WCAG AAA 对比度标准
- 键盘导航支持
- Focus 状态可见
- 支持 `prefers-reduced-motion`

## 🛠️ 技术栈

- **框架**: React 18
- **构建工具**: Vite 5
- **路由**: React Router 6
- **样式**: Tailwind CSS 3
- **图标**: Lucide React
- **HTTP 客户端**: Axios
- **日期处理**: date-fns

## 📝 开发规范

1. **组件命名**: PascalCase（如 `OrderDetail.jsx`）
2. **函数命名**: camelCase（如 `loadOrders`）
3. **CSS 类**: kebab-case（如 `dark-bg`）
4. **代码格式**: 使用 ESLint + Prettier

## 🐛 调试

```bash
# 开启开发模式
npm run dev

# 检查 ESLint
npm run lint
```

## 📄 许可证

MIT

---

**生成工具**: UI/UX Pro Max Skill v2.6.2
**生成时间**: 2026-07-08
