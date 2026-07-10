# 仪表板功能实现文档

## 概述

本文档记录了 Apple 订单管理系统仪表板页面的完整实现，包括前端界面、后端 API 和数据可视化。

## 实现日期

2026-07-08

## 功能特性

### 1. 筛选区域

**位置**: 页面顶部
**功能**: 支持多维度数据筛选

#### 筛选项

- **时间范围**: 开始日期 + 结束日期（默认近 7 天）
- **订单状态**: 全部状态 / 待处理 / 处理中 / 已发货 / 可取货 / 已完成 / 已取消
- **产品型号**: 动态加载所有存在的产品型号
- **取机门店**: 动态加载所有存在的取货门店

**交互**:
- 所有筛选项变更会自动触发数据刷新
- "重置筛选" 按钮恢复默认值（近 7 天，全部状态/型号/门店）

### 2. 统计卡片

**布局**: 响应式 4 列网格（移动端 1 列，平板 2 列，桌面 4 列）

#### 卡片 1: 总订单量
- **指标**: 当前时间范围内的订单总数
- **增长率**: 与上一同等时长周期对比的增长百分比
- **图标**: 📦 Package（蓝色背景）
- **趋势**: 显示上升 ↑ 或下降 ↓ 箭头（绿色/红色）

#### 卡片 2: 待取订单
- **指标**: 状态为"待处理"/"处理中"/"可取货"的订单数
- **标签**: "需处理"（黄色徽章）
- **图标**: ⏰ Clock（黄色背景）

#### 卡片 3: 订单总额
- **指标**: 从所有产品的 `price * quantity` 累加计算
- **增长率**: 与上一周期对比的金额增长百分比
- **图标**: 💵 DollarSign（绿色背景）
- **趋势**: 显示上升 ↑ 或下降 ↓ 箭头

#### 卡片 4: 活跃收件人
- **指标**: 当前时间范围内有订单的收件人数量（去重）
- **标签**: "在线"（绿色徽章）
- **图标**: 👥 Users（紫色背景）

### 3. 折线图: 近 7 日订单趋势

**图表类型**: Area Line Chart（区域折线图）
**图表库**: Recharts
**数据源**: `/api/dashboard/daily-trend`

#### 特性
- **渐变填充**: 紫色渐变（#8B5CF6 → 透明）
- **数据点**: 圆点标记，悬停时放大
- **X 轴**: 日期格式"7月1日"（中文）
- **Y 轴**: 订单数量
- **Tooltip**: 自定义工具提示，显示具体日期和订单数
- **网格**: 虚线网格（浅灰色）
- **缺失日期填充**: 自动填充时间范围内无数据的日期为 0

### 4. 环形图: 产品型号分布

**图表类型**: Pie Chart（饼图，带内环）
**位置**: 左侧环形图
**数据源**: `/api/dashboard/product-distribution`

#### 特性
- **内环半径**: 60px
- **外环半径**: 100px
- **颜色方案**: 渐变色板（紫色 → 蓝色 → 青色 → 绿色）
- **标签**: 百分比显示在环内（小于 5% 不显示）
- **图例**: 底部显示"型号名称 (数量)"
- **Tooltip**: 显示具体数量和百分比
- **数据限制**: 最多显示前 10 个型号

### 5. 环形图: 取货门店分布

**图表类型**: Pie Chart（饼图，带内环）
**位置**: 右侧环形图
**数据源**: `/api/dashboard/store-distribution`

#### 特性
- 与产品型号分布图相同的样式
- **图例**: 底部显示"门店名称 (数量)"
- **数据限制**: 最多显示前 10 个门店

## 技术实现

### 前端架构

#### 依赖库
```json
{
  "react": "^18.2.0",
  "recharts": "^2.x", // 数据可视化
  "lucide-react": "^0.344.0", // 图标
  "axios": "^1.6.7", // HTTP 客户端
  "date-fns": "^3.3.1" // 日期处理
}
```

#### 文件结构
```
frontend/src/
├── api/
│   └── dashboard.js          # 仪表板 API 客户端
├── pages/
│   └── Dashboard.jsx         # 仪表板主组件
└── index.css                 # 全局样式（包含图表样式）
```

#### 核心组件

**Dashboard.jsx**
- **状态管理**: useState 管理筛选参数、统计数据、图表数据
- **数据加载**: useEffect 监听筛选参数变化，自动重新加载数据
- **并发请求**: Promise.all 同时请求多个 API，提高性能
- **错误处理**: try-catch 捕获错误，console.error 记录日志
- **加载状态**: 显示 loading 动画（旋转圆圈）

#### API 客户端

**dashboard.js**
```javascript
// 5 个 API 端点
getDashboardStats(params)         // 统计数据
getDailyOrderTrend(params)        // 每日趋势
getProductModelDistribution(params) // 产品分布
getStoreDistribution(params)      // 门店分布
getFilterOptions()                // 筛选器选项
```

### 后端架构

#### 文件结构
```
src/
├── routes/
│   └── dashboardRoutes.js    # 路由定义
├── controllers/
│   └── dashboardController.js # 控制器
└── services/
    └── dashboardService.js   # 业务逻辑
```

#### API 端点

| 端点 | 方法 | 描述 | 参数 |
|------|------|------|------|
| `/api/dashboard/stats` | GET | 获取统计数据 | startDate, endDate, status, productModel, store |
| `/api/dashboard/daily-trend` | GET | 获取每日趋势 | startDate, endDate, status, productModel, store |
| `/api/dashboard/product-distribution` | GET | 获取产品分布 | startDate, endDate, status, store |
| `/api/dashboard/store-distribution` | GET | 获取门店分布 | startDate, endDate, status, productModel |
| `/api/dashboard/filter-options` | GET | 获取筛选器选项 | 无 |

#### 数据库查询优化

**1. 订单总额计算**
```sql
-- 从 JSONB products 数组中动态计算
SELECT COALESCE(SUM(
  (product->>'price')::numeric * (product->>'quantity')::integer
), 0) AS total
FROM orders, jsonb_array_elements(products) AS product
WHERE ...
```

**2. 产品型号提取**
```sql
-- 从 JSONB 中提取所有型号并统计
SELECT
  product->>'model' AS name,
  COUNT(*) AS value
FROM orders, jsonb_array_elements(products) AS product
WHERE ...
GROUP BY product->>'model'
ORDER BY value DESC
LIMIT 10
```

**3. 日期填充**
- 查询返回有订单的日期
- 服务端填充时间范围内的缺失日期（设为 0）
- 确保折线图连续显示

#### 状态映射

**前端使用中文，后端使用英文枚举**

```javascript
const STATUS_MAP = {
  '待处理': 'pending',
  '处理中': 'processing',
  '已发货': 'shipped',
  '可取货': 'ready_for_pickup',
  '已完成': 'completed',
  '已取消': 'cancelled'
};
```

### 数据流

```
用户交互（修改筛选条件）
    ↓
前端 useState 更新 filters
    ↓
useEffect 监听到变化
    ↓
并发调用 5 个 API 端点
    ↓
后端 dashboardController 接收请求
    ↓
dashboardService 查询数据库
    ↓
构建 Sequelize where 条件 + 原生 SQL
    ↓
PostgreSQL 执行查询（JSONB 操作 + 分组统计）
    ↓
后端返回 JSON 数据
    ↓
前端更新 state（stats, dailyTrend, productDistribution, storeDistribution）
    ↓
React 重新渲染
    ↓
Recharts 渲染图表
```

## 配色方案

### 主题色
- **主色**: #1E3A8A（深蓝色） - 按钮、链接
- **辅助色**: #8B5CF6（紫色） - 图表、强调
- **成功色**: #10B981（绿色） - 增长、成功状态
- **警告色**: #F59E0B（黄色） - 待处理、警告
- **错误色**: #EF4444（红色） - 下降、错误

### 图表渐变色板
```javascript
['#8B5CF6', '#6366F1', '#3B82F6', '#06B6D4', '#10B981']
// 紫色 → 靛蓝 → 蓝色 → 青色 → 绿色
```

### 背景色
- **页面**: #F9FAFB（浅灰）
- **卡片**: #FFFFFF（白色）
- **表头**: #F3F4F6（灰色）
- **图标背景**: 半透明主题色（如 bg-blue-50, bg-purple-50）

## 响应式设计

### 断点
- **移动端**: < 768px（1 列）
- **平板**: 768px - 1024px（2 列）
- **桌面**: > 1024px（4 列）

### 适配策略
- 统计卡片: `grid-cols-1 md:grid-cols-2 lg:grid-cols-4`
- 筛选区域: `grid-cols-1 md:grid-cols-5`（移动端堆叠，桌面横排）
- 环形图: `grid-cols-1 lg:grid-cols-2`（移动端堆叠，桌面并排）
- 图表: `ResponsiveContainer` 自适应宽度

## 性能优化

### 前端
1. **并发请求**: 使用 `Promise.all` 同时请求多个 API
2. **条件渲染**: 数据加载时显示 loading 动画
3. **数据缓存**: React state 缓存已加载数据，避免重复请求
4. **懒加载**: 图表库按需加载（Vite 自动代码分割）

### 后端
1. **SQL 优化**: 
   - 使用 PostgreSQL GIN 索引加速 JSONB 查询
   - 使用 `LIMIT 10` 限制分布图数据量
   - 使用 `COALESCE` 处理空值
2. **并发查询**: 控制器使用 `Promise.all` 并发查询统计数据
3. **连接池**: Sequelize 管理数据库连接池
4. **错误处理**: 所有 service 方法有 try-catch，避免崩溃

## 已知问题与限制

### 1. 订单总额计算
- **前提**: products JSONB 中每个产品必须有 `price` 和 `quantity` 字段
- **限制**: 如果价格缺失，该订单不计入总额
- **建议**: 邮件解析或爬虫时确保价格字段完整

### 2. 筛选器选项
- **动态加载**: 产品型号和门店从数据库实时查询
- **性能**: 如果订单量巨大（> 100 万），可考虑缓存筛选器选项
- **建议**: 定期（如每小时）重新生成缓存

### 3. 日期填充
- **时区**: 默认使用服务器时区
- **边界**: 日期范围过大（> 1 年）可能影响性能
- **建议**: 前端限制日期范围最多 90 天

### 4. 图表数据量
- **限制**: 分布图最多显示前 10 项
- **原因**: 避免图例过长，环形图标签重叠
- **建议**: 如需查看完整分布，可添加"查看全部"跳转到详情页

## 测试验证

### API 测试

```bash
# 1. 筛选器选项
curl "http://localhost:3000/api/dashboard/filter-options"

# 2. 统计数据
curl "http://localhost:3000/api/dashboard/stats?startDate=2026-07-01&endDate=2026-07-08"

# 3. 每日趋势
curl "http://localhost:3000/api/dashboard/daily-trend?startDate=2026-07-01&endDate=2026-07-08"

# 4. 产品分布
curl "http://localhost:3000/api/dashboard/product-distribution?startDate=2026-07-01&endDate=2026-07-08"

# 5. 门店分布
curl "http://localhost:3000/api/dashboard/store-distribution?startDate=2026-07-01&endDate=2026-07-08"
```

### 预期响应

**成功响应**:
```json
{
  "success": true,
  "data": { ... }
}
```

**错误响应**:
```json
{
  "success": false,
  "message": "错误描述",
  "error": "详细错误信息"
}
```

## 部署说明

### 前端

```bash
cd frontend
npm install
npm run build
# 生成 dist/ 目录，部署到 Nginx 或 Vercel
```

### 后端

```bash
npm install
npm start
# 启动在 http://localhost:3000
```

### 环境变量

```env
# 数据库
DATABASE_URL=postgresql://user:pass@host:5432/dbname

# API 服务器
PORT=3000
NODE_ENV=production

# 前端地址（CORS）
FRONTEND_URL=https://your-frontend.com
```

## 未来改进

### 功能增强
1. **导出报表**: 支持导出 PDF/Excel 格式的统计报表
2. **自定义时间段**: 支持"今天"、"本周"、"本月"快捷选项
3. **实时刷新**: WebSocket 推送订单更新，实时刷新数据
4. **对比模式**: 支持选择两个时间段进行对比
5. **钻取分析**: 点击图表数据跳转到详细订单列表

### 性能优化
1. **Redis 缓存**: 缓存统计数据（TTL 5 分钟）
2. **分页加载**: 大数据量时分页加载图表数据
3. **CDN 加速**: 静态资源使用 CDN
4. **SSR**: 服务端渲染首屏，提升加载速度

### 可视化增强
1. **更多图表类型**: 柱状图、堆叠图、热力图
2. **交互式图例**: 点击图例隐藏/显示对应数据
3. **动画效果**: 图表加载时的过渡动画
4. **主题切换**: 支持深色/浅色主题

## 参考资料

- **Recharts 文档**: https://recharts.org/
- **Lucide Icons**: https://lucide.dev/
- **Tailwind CSS**: https://tailwindcss.com/
- **PostgreSQL JSONB**: https://www.postgresql.org/docs/current/datatype-json.html

## 变更日志

### 2026-07-08
- ✅ 初始实现：前端界面、后端 API、数据可视化
- ✅ 修复字段名映射问题（驼峰 vs 下划线）
- ✅ 实现动态订单总额计算
- ✅ 添加状态中英文映射
- ✅ 所有 API 端点测试通过

---

**文档版本**: 1.0.0  
**最后更新**: 2026-07-08  
**作者**: Claude Code Agent
