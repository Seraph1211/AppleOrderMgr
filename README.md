# Apple 订单管理系统

通过邮件解析、Apple 官网详情补全和状态同步，管理 Apple ID、取机人、订单、渠道和统计数据。

系统已有 React 管理台、Express API、PostgreSQL/Sequelize 数据层及独立邮件、爬虫 Worker。当前为持续完善中的 MVP，真实数据迁移、集成测试和生产验收尚未完成，详见[开发进度](docs/development/开发进度.md)。

## 快速开始

需要 Node.js 20+ 和 PostgreSQL 14+。从仓库根目录安装依赖：

```bash
npm ci
npm --prefix frontend ci
cp .env.example .env
```

填写 `.env` 中的数据库 `DB_*`、JWT 和字段加密密钥。首次初始化、管理员创建及各进程启动步骤见[本地开发指南](docs/development/本地开发指南.md)。

已完成初始化后，在两个终端分别启动 API 和前端：

```bash
# 终端一，仓库根目录
npm run dev
```

```bash
# 终端二，仓库根目录
npm --prefix frontend run dev
```

前端默认端口 5173，API 默认端口 3000。邮件和爬虫 Worker 独立启动，会访问外部服务，不属于仅查看前端的必要步骤。

## 文档入口

- [文档导航](docs/README.md)：全部有效文档、阅读路线及历史入口。
- [系统架构](docs/design/系统架构.md)：模块职责、数据流与实现边界。
- [编码规范](docs/development/编码规范.md)与[前端设计规范](docs/development/前端设计规范.md)：开发前必读。
- [数据库架构](docs/database/数据库架构.md)与[API 契约](docs/design/API设计.md)：数据和接口规范。
- [测试与验收指南](docs/testing/测试与验收指南.md)：验证层级与证据要求。
- [生产环境部署指南](docs/deployment/生产环境部署指南.md)：发布、迁移和回滚。
- [项目优化计划](docs/planning/项目优化计划.md)：任务优先级和后续演进。

新增文档、修改功能或修复 Bug 时，按[文档管理规范](docs/development/文档管理规范.md)选择目录和需要更新的文档，并记录开发进度；具体执行要求见 [AGENTS.md](AGENTS.md#文档维护强制速查)。

## 代码入口

| 目录                              | 职责                                       |
| --------------------------------- | ------------------------------------------ |
| `frontend/src/`                   | 页面、组件、API 客户端                     |
| `src/routes/`、`src/controllers/` | HTTP 路由与接口处理                        |
| `src/services/`                   | 邮件处理、订单保存、爬虫和统计服务         |
| `src/models/`、`migrations/`      | 模型与数据库迁移                           |
| `src/workers/`                    | 邮件、爬虫独立进程入口                     |
| `services/`、`crawler/`           | 历史独立邮件与爬虫解析实现，关系见架构文档 |
| `test/`、`scripts/`               | 测试和开发维护工具                         |

## 本地检查

```bash
npm run lint
npm test -- --runInBand
npm run docs:check
npm --prefix frontend run lint
npm --prefix frontend run build
```

本地检查通过不等于真实数据库、邮箱、官网或生产业务验收通过。许可证口径待项目负责人确认：根目录历史 README 标注 MIT，而当前 package.json 标注 ISC；本轮未变更授权条款。
