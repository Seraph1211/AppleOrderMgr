# ApplePurchase 云同步 PP 端实现协作任务

> 状态：本地实现、隔离 HTTPS 与 ApplePurchase 503 条韧性联调完成；远程 HTTPS 联调、七天对账和生产发布未开始
>
> 最近核对：2026-11-06
>
> 基线：`main@7ffabb5414b603c67d2ca0fec96720c567e6ea8a`
>
> 验证范围：本地源码、冻结 v1 契约、隔离 PostgreSQL／HTTPS 测试及 ApplePurchase 本地真实客户端端到端联调；不代表远程 HTTPS 或生产部署验收

## 目标与契约

- PP 端实现 `apple_purchase_sync` 独立 schema、终端管理、批次接收、网页查询、SSE 和三个独立页面。
- 唯一跨项目外部契约为 DuoPurchaseClient 的《ApplePurchase 与 PP 库存同步接口》冻结 v1；不得单边修改字段、路径、错误码、时间、bigint 或幂等语义。
- 机器 Token 与网页用户权限隔离；网页查询复用 `inventory.read`，终端创建、禁用和轮换仅管理员可操作。
- 实现、离线测试、本地端到端联调、远程联调和部署分别陈述。本轮仅授权在 `main` 创建本地提交；未授权推送、部署、生产数据库写入或生产配置修改。

## 文件归属

- 数据库：`migrations/20261106000001-create-apple-purchase-sync.js`、`docs/database/数据库架构.md`、`docs/database/数据库初始化与迁移指南.md`。
- 后端：`src/services/applePurchaseSync*`、`src/routes/applePurchaseSync*`、`src/app.js`、权限与审计映射。
- 前端：`frontend/src/pages/ApplePurchase*`、对应 API、路由和导航，包括有货记录、监控变更历史和管理员终端管理三个页面。
- 测试：`test/applePurchaseSync*`、`test/browser/applePurchaseSync*`，全部使用合成数据和隔离数据库。
- 文档：API、测试、部署、导航和开发进度；不覆盖 DuoPurchaseClient 源方案。

## 阶段证据

| 阶段 | 状态 | 证据 |
| --- | --- | --- |
| 契约与现有模式核对 | 已完成 | 已读取根级规范、文档导航／维护规范、冻结方案、冻结接口和源协作任务；确认 `main` 比 `origin/main` ahead 1，保护既有 `开发进度.md` 未提交修改 |
| Migration 与最小权限 | 已完成隔离验证 | Compose 专用合成库完成 up/down/up；三类 NOLOGIN 角色、约束、索引和跨角色拒绝通过 |
| 接收／status／终端管理 | 已完成本地验证 | 四个同步测试文件共 30 项通过；本地契约入口验证 status、混合批次、原批重放和跨批重复 |
| 查询／SSE／页面 | 已完成本地验证 | 修复文本别名导致的 bigint 跨位数错排；9／10、99／100、999／1000 和超安全整数在两类查询的升降序、游标及固定高水位回归通过；三个页面源码验收、前端 lint 和正式构建通过 |
| ApplePurchase 本地端到端联调 | 已完成 | ApplePurchase 使用真实客户端流程向本地隔离 PP 入口发送混合批次；模拟响应丢失后以相同 `batchId` 和字节一致原请求重试，PP 最终仅有 1 个批次、1 条有货记录和 1 条监控变更，ApplePurchase outbox 清零且两类本地永久历史各保留 1 条 |
| 503 条韧性与本机 HTTPS | 已完成 | 501 条有货记录＋2 条监控变更完成 500＋3 回填和尾批 503 重启续传；PP 有货查询 503／唯一 503、监控变更 3／唯一 3。显式 CA、转发头、`no-store`、1 MiB、SSE 流式提交事件／重连及终端 Token 创建／轮换／禁用通过 |
| 远程 HTTPS 联调与七天对账 | 未开始 | 仍需非生产 HTTPS 基址、非敏感终端 ID 和仅一次线下安全交付 Token；另需验证断网积压、历史回填、轮换、容量和告警 |
| 部署 | 未授权 | 仅检查配置、Nginx SSE、备份恢复、容量与告警前置条件 |

## 跨项目依赖与阻塞

- PP 隔离契约测试、脱敏 fixture 和 ApplePurchase 本地真实客户端联调已完成；远程联调仍需非生产 HTTPS 基址、非敏感终端 ID 和一次性 Token 安全交付。
- 生产 Migration 属 D 级发布，必须执行本次完整业务数据库备份、隔离恢复和正式迁移演练；当前不执行。
- 生产需提供独立同步写入数据库账号／连接池、HTTPS 基址和 SSE 反向代理配置；Token 明文不得进入文档、聊天、日志或 Git。
