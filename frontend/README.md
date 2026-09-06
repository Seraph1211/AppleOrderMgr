# Apple 订单管理系统前端

React + Vite + Tailwind CSS 管理台，使用浅色蓝色系、Lucide React 图标和表格列表。仪表板统计可使用卡片。设计规则统一见[前端设计规范](../docs/development/前端设计规范.md)。

## 开发

在 frontend 目录执行：

```bash
npm ci
npm run dev
```

默认端口 5173，/api 代理到 3000；完整数据库、API 和 Worker 配置见[本地开发指南](../docs/development/本地开发指南.md)。

## 检查和构建

```bash
npm run lint
npm run build
```

源码入口为 src/App.jsx，页面位于 src/pages，API 客户端位于 src/api。主界面包括登录、用户、Apple ID、取机人、订单、渠道、仪表板和系统日志。

当前页面已接入业务 API，真实数据库和浏览器流程的验收范围见[开发进度](../docs/development/开发进度.md)。构建通过不代表全部功能已验收。

[文档导航](../docs/README.md) · [API 契约](../docs/design/API设计.md) · [测试指南](../docs/testing/测试与验收指南.md)
