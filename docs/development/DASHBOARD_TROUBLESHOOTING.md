# 仪表板页面空白问题排查指南

## 问题描述
访问 http://localhost:5173/ 时页面显示空白，没有内容。

## 已修复的问题

### 1. API 导入错误 ✅
**问题**: `dashboard.js` 使用了错误的导入方式
- **错误**: `import { client } from './index'`
- **正确**: `import client from './client'`

### 2. API 路径重复 ✅
**问题**: API 路径包含重复的 `/api` 前缀
- **错误**: `client.get('/api/dashboard/stats')`
- **正确**: `client.get('/dashboard/stats')`
- **原因**: `client.js` 中 baseURL 已包含 `/api`

## 浏览器排查步骤

### 步骤 1: 打开浏览器开发者工具

**Chrome/Edge**:
- 按 `F12` 或 `Ctrl+Shift+I` (Windows)
- 按 `Cmd+Option+I` (Mac)

**Firefox**:
- 按 `F12` 或 `Ctrl+Shift+I`

### 步骤 2: 检查控制台 (Console) 错误

查找以下类型的错误：

#### 可能的错误 1: 模块加载失败
```
Failed to load module script
```
**解决方案**: 检查网络连接，确保 Vite 服务器正在运行

#### 可能的错误 2: CORS 跨域错误
```
Access to XMLHttpRequest at 'http://localhost:3000/...' from origin 'http://localhost:5173' has been blocked by CORS policy
```
**解决方案**: 后端已配置 CORS，应该不会出现此问题

#### 可能的错误 3: React 未定义
```
React is not defined
```
**解决方案**: 清除浏览器缓存，重启 Vite 服务器

#### 可能的错误 4: API 调用失败
```
GET http://localhost:3000/api/dashboard/stats 404 (Not Found)
```
**解决方案**: 已修复，确保后端服务正在运行

### 步骤 3: 检查网络 (Network) 请求

1. 切换到 "Network" 标签
2. 刷新页面 (`Ctrl+R` 或 `Cmd+R`)
3. 查看所有请求的状态：

**预期的请求**:
- `GET /` - 200 OK (HTML 页面)
- `GET /src/main.jsx` - 200 OK (入口文件)
- `GET /src/App.jsx` - 200 OK
- `GET /src/pages/Dashboard.jsx` - 200 OK
- `GET /api/dashboard/filter-options` - 200 OK
- `GET /api/dashboard/stats` - 200 OK
- `GET /api/dashboard/daily-trend` - 200 OK
- `GET /api/dashboard/product-distribution` - 200 OK
- `GET /api/dashboard/store-distribution` - 200 OK

**如果某个请求失败**:
- **404**: 路径错误，检查 API 路由配置
- **500**: 后端服务器错误，查看后端日志
- **CORS**: 跨域错误，检查后端 CORS 配置
- **超时**: 网络问题或后端未启动

### 步骤 4: 检查 Elements (DOM 结构)

1. 切换到 "Elements" 标签
2. 查看 `<div id="root">` 内部是否有内容

**正常情况**:
```html
<div id="root">
  <div class="min-h-screen bg-gray-50 flex">
    <nav class="...">...</nav>
    <main class="...">
      <div class="space-y-6">
        <!-- 仪表板内容 -->
      </div>
    </main>
  </div>
</div>
```

**异常情况**:
```html
<div id="root"></div>  <!-- 空的 -->
```

**解决方案**: React 应用未挂载，检查控制台错误

### 步骤 5: 检查 React DevTools

如果安装了 React DevTools:

1. 切换到 "React" 标签
2. 查看组件树

**预期结构**:
```
<BrowserRouter>
  <Layout>
    <Dashboard>
      <!-- 仪表板组件 -->
    </Dashboard>
  </Layout>
</BrowserRouter>
```

**如果看不到组件**: React 未正确加载

## 命令行排查

### 1. 检查服务器状态

```bash
# 检查前端服务器
curl http://localhost:5173/

# 检查后端服务器
curl http://localhost:3000/api/health

# 检查端口占用
lsof -i:5173  # 前端
lsof -i:3000  # 后端
```

### 2. 查看日志

```bash
# 前端日志
tail -f /tmp/frontend.log

# 后端日志
tail -f /tmp/backend.log
```

### 3. 测试 API 接口

```bash
# 测试筛选器选项
curl http://localhost:3000/api/dashboard/filter-options | jq

# 测试统计数据
curl "http://localhost:3000/api/dashboard/stats?startDate=2026-07-01&endDate=2026-07-08" | jq

# 测试每日趋势
curl "http://localhost:3000/api/dashboard/daily-trend?startDate=2026-07-01&endDate=2026-07-08" | jq
```

### 4. 重新构建

```bash
# 清理并重新构建
npm run build

# 如果构建失败，查看错误信息
```

## 常见问题及解决方案

### 问题 1: 浏览器缓存问题

**症状**: 修改代码后页面未更新

**解决方案**:
1. 硬刷新: `Ctrl+Shift+R` (Windows) 或 `Cmd+Shift+R` (Mac)
2. 清除浏览器缓存
3. 使用隐私/无痕模式测试

### 问题 2: Node 模块缓存问题

**症状**: 构建或运行时出现奇怪错误

**解决方案**:
```bash
# 清理 node_modules 和缓存
rm -rf node_modules
rm -rf .vite
npm install
```

### 问题 3: 端口被占用

**症状**: `EADDRINUSE: address already in use`

**解决方案**:
```bash
# 找到占用端口的进程
lsof -ti:5173 | xargs kill -9  # 前端
lsof -ti:3000 | xargs kill -9  # 后端

# 重新启动服务
npm run dev
```

### 问题 4: 数据库连接失败

**症状**: 后端 API 返回 500 错误

**解决方案**:
1. 检查 PostgreSQL 是否运行
2. 检查 `.env` 文件中的 `DATABASE_URL`
3. 测试数据库连接:
```bash
psql $DATABASE_URL -c "SELECT 1"
```

### 问题 5: Recharts 图表不显示

**症状**: 统计卡片显示，但图表区域空白

**可能原因**:
1. 数据格式不正确
2. 图表容器高度为 0
3. Recharts 未正确安装

**解决方案**:
```bash
# 重新安装 recharts
npm install recharts

# 检查数据格式
console.log(dailyTrend)  // 应该是数组
```

### 问题 6: 白屏但控制台无错误

**症状**: 页面完全空白，但控制台没有任何错误

**可能原因**:
1. CSS 样式问题导致内容不可见
2. 加载状态一直显示
3. React 条件渲染逻辑错误

**解决方案**:
1. 检查 Elements 标签，看 DOM 是否存在
2. 检查 CSS 样式，特别是 `display: none`
3. 在 Dashboard.jsx 中添加调试日志:
```javascript
useEffect(() => {
  console.log('Dashboard mounted');
  console.log('Loading:', loading);
  console.log('Stats:', stats);
}, [loading, stats]);
```

## 调试模式

### 在 Dashboard.jsx 中添加调试信息

```javascript
const Dashboard = () => {
  const [loading, setLoading] = useState(true);
  
  // 添加调试日志
  console.log('Dashboard render, loading:', loading);

  useEffect(() => {
    console.log('Dashboard mounted');
    loadDashboardData();
  }, []);

  const loadDashboardData = async () => {
    try {
      console.log('开始加载数据...');
      setLoading(true);
      
      const [statsData, trendData, productData, storeData] = await Promise.all([
        getDashboardStats(filters),
        getDailyOrderTrend(filters),
        getProductModelDistribution(filters),
        getStoreDistribution(filters)
      ]);
      
      console.log('数据加载成功:', { statsData, trendData, productData, storeData });
      
      setStats(statsData.data);
      setDailyTrend(trendData.data);
      setProductDistribution(productData.data);
      setStoreDistribution(storeData.data);
    } catch (error) {
      console.error('加载仪表板数据失败:', error);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    console.log('显示 loading 动画');
    return <div>Loading...</div>;
  }

  console.log('渲染仪表板内容');
  return (
    <div className="space-y-6">
      {/* 仪表板内容 */}
    </div>
  );
};
```

## 最终检查清单

- [ ] 前端服务器正在运行 (http://localhost:5173/)
- [ ] 后端服务器正在运行 (http://localhost:3000/)
- [ ] 数据库连接正常
- [ ] 浏览器控制台无错误
- [ ] 网络请求全部成功 (200 状态码)
- [ ] DOM 中存在 React 组件
- [ ] API 返回正确的 JSON 数据
- [ ] recharts 库已正确安装

## 联系信息

如果以上所有步骤都无法解决问题，请提供以下信息：

1. **浏览器控制台截图** (Console 标签)
2. **网络请求截图** (Network 标签)
3. **Elements 标签中的 `<div id="root">` 内容**
4. **前端日志**: `cat /tmp/frontend.log`
5. **后端日志**: `cat /tmp/backend.log`
6. **测试 API**: `curl http://localhost:3000/api/dashboard/stats | jq`

---

**文档版本**: 1.0.0  
**最后更新**: 2026-07-08  
**作者**: Claude Code Agent
