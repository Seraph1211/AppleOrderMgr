# Apple 订单管理系统

通过邮件解析、Apple 官网详情补全和状态同步，管理 Apple ID、取机人、订单、渠道和统计数据。

系统已有 React 管理台、Express API、PostgreSQL/Sequelize 数据层及独立邮件、爬虫 Worker。当前为持续完善中的 MVP；生产技术部署和存量敏感数据转换已完成，真实订单邮件与 Apple 官网同步仍需业务验收，详见[开发进度](docs/development/开发进度.md)。

## 快速开始

本地开发只要求 Docker Engine 或 Docker Desktop，以及 Docker Compose。从仓库根目录准备配置并启动完整开发栈：

```bash
cp .env.example .env
docker compose -f docker-compose.dev.yml up --build -d
```

启动前填写 `.env` 中的数据库密码、JWT、字段加密密钥和首次管理员密码。Compose 会启动本地 PostgreSQL、自动 Migration、API 和 Vite 前端；首次创建管理员显式执行：

```bash
docker compose -f docker-compose.dev.yml --profile tools run --rm seed-admin
```

前端默认端口 5173，API 默认端口 3000，PostgreSQL 默认映射到宿主机 5433。邮件和爬虫 Worker 通过 profile 按需启动，不会随默认开发栈连接外部服务。完整命令见[本地开发指南](docs/development/本地开发指南.md)。

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

| 目录                              | 职责                               |
| --------------------------------- | ---------------------------------- |
| `frontend/src/`                   | 页面、组件、API 客户端             |
| `src/routes/`、`src/controllers/` | HTTP 路由与接口处理                |
| `src/services/`                   | 邮件处理、订单保存、爬虫和统计服务 |
| `src/models/`、`migrations/`      | 模型与数据库迁移                   |
| `src/workers/`                    | 邮件、爬虫独立进程入口             |
| `test/`、`scripts/`               | 测试和开发维护工具                 |

## 本地检查

```bash
docker compose -f docker-compose.dev.yml exec api npm run lint
docker compose -f docker-compose.dev.yml exec api npm test -- --runInBand
docker compose -f docker-compose.dev.yml exec api npm run docs:check
docker compose -f docker-compose.dev.yml exec frontend npm run lint
docker compose -f docker-compose.dev.yml exec frontend npx vite build
```

## 生产发布

生产环境保留宿主机 PostgreSQL 与共享 Nginx，应用的 API、邮件 Worker 和爬虫 Worker 由 `docker-compose.prod.yml` 管理。发布制品只允许从本地 `main` 构建为 `linux/amd64`：

```bash
./scripts/buildProductionRelease.sh
```

制品输出到忽略追踪的 `release-artifacts/`，包含镜像归档、前端静态文件、Compose、版本清单和校验和。数据库备份、隔离迁移演练、切换和回滚步骤见[生产环境部署指南](docs/deployment/生产环境部署指南.md)。

本地检查通过不等于真实数据库、邮箱、官网或生产业务验收通过。许可证口径待项目负责人确认：根目录历史 README 标注 MIT，而当前 package.json 标注 ISC；本轮未变更授权条款。
