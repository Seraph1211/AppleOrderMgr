# API 契约与接口导航

> 状态：当前有效
>
> 最近核对：2026-09-07
>
> 基线：main@d000d03 与当前工作树
>
> 验证范围：本地工作树静态核对；未验证真实数据库、邮箱、官网和生产环境

## 通用约束

前缀为 /api。除登录和健康检查外均需认证；auth 下改密、登出、me 各自经过 authenticate，其余业务统一经过全局认证与强制改密检查。Bearer Token 不放入 URL。

角色字段继续保留 admin、operator、readOnly，但普通业务授权以数据库 `user_permissions` 为唯一来源。admin 通过受保护身份获得代码目录中的全部有效权限；operator/readOnly 仅作为存量标签，不再在请求时隐式叠加权限。所有业务路由显式声明权限，未登记入口默认拒绝。权限目录与依赖见[用户权限方案](../planning/用户权限分配与访问控制方案.md)。

字段目前混用 camelCase 和 snake_case，不能按惯例自动转换或增加别名。新契约修改需更新本页及对应专题文档，CON-01/CON-02 的完整统一尚未完成。

## 响应与错误

常规成功为 success/data；公共分页结构如下，列表键由端点决定（例如 apple_ids、recipients、orders、items）：

```json
{ "success": true, "data": { "total": 0, "page": 1, "limit": 20, "items": [] } }
```

公共错误处理中间件返回 success=false 和 error.code/message/details，并通过 X-Request-Id 关联日志。部分认证、仪表板及模板错误仍返回顶层 message 或字符串 error，客户端必须兼容，不能把公共格式当成全量端点已经统一。

文件下载返回 Excel/Blob，不按 JSON 解析。401 为认证失败、403 为权限或账号限制、409 可表示冲突或不支持的跨进程恢复；其余状态按各控制器处理。

## 已挂载接口

下表从当前路由核对，路由注释中的历史 Public 标记不覆盖全局认证。每个模块的详细字段与校验入口链接在表后。

| 方法   | 路径                                     | 权限要求                                                                               |
| ------ | ---------------------------------------- | -------------------------------------------------------------------------------------- |
| GET    | /api/health/live                         | 公开；进程存活                                                                         |
| GET    | /api/health/ready                        | 公开；数据库检查，失败 503                                                             |
| GET    | /api/health                              | 公开；307 到 ready                                                                     |
| POST   | /api/auth/login                          | 公开；登录限流                                                                         |
| POST   | /api/auth/logout                         | 登录；允许强制改密状态                                                                 |
| POST   | /api/auth/change-password                | 登录；允许强制改密状态                                                                 |
| GET    | /api/auth/me                             | 登录；允许强制改密状态                                                                 |
| GET    | /api/users/permission-catalog            | users.permissions.manage（admin 保留）                                                 |
| GET    | /api/users                               | users.read（admin 保留）                                                               |
| POST   | /api/users                               | users.manage（admin 保留）                                                             |
| PUT    | /api/users/:id                           | users.manage（admin 保留）                                                             |
| DELETE | /api/users/:id                           | users.manage（admin 保留）                                                             |
| PUT    | /api/users/:id/unlock                    | users.manage（admin 保留）                                                             |
| GET    | /api/users/:id/permissions               | users.permissions.manage（admin 保留）                                                 |
| PUT    | /api/users/:id/permissions               | users.permissions.manage（admin 保留）                                                 |
| GET    | /api/apple-ids                           | apple_ids.read                                                                         |
| GET    | /api/apple-ids/:id                       | apple_ids.read                                                                         |
| POST   | /api/apple-ids                           | apple_ids.create                                                                       |
| PUT    | /api/apple-ids/:id                       | apple_ids.edit                                                                         |
| DELETE | /api/apple-ids/:id                       | apple_ids.delete                                                                       |
| GET    | /api/recipients                          | recipients.read                                                                        |
| GET    | /api/recipients/export                   | recipients.export                                                                      |
| GET    | /api/recipients/:id                      | recipients.read                                                                        |
| POST   | /api/recipients                          | recipients.create                                                                      |
| POST   | /api/recipients/batch-generate-contact   | recipients.generate_contact                                                            |
| POST   | /api/recipients/batch-generate-address   | recipients.generate_address                                                            |
| POST   | /api/recipients/bind-apple-ids           | recipients.bind_apple_ids                                                              |
| PUT    | /api/recipients/:id                      | recipients.edit                                                                        |
| DELETE | /api/recipients/:id                      | recipients.delete                                                                      |
| GET    | /api/orders                              | orders.read                                                                            |
| GET    | /api/orders/export                       | orders.export                                                                          |
| GET    | /api/orders/filter-options               | orders.read                                                                            |
| GET    | /api/orders/:id                          | orders.read                                                                            |
| PUT    | /api/orders/:id                          | orders.edit                                                                            |
| PUT    | /api/orders/:id/payer                    | orders.read + orders.payer.edit                                                        |
| POST   | /api/orders/:id/refresh                  | orders.refresh                                                                         |
| POST   | /api/orders/batch-refresh                | orders.refresh                                                                         |
| POST   | /api/orders/refresh-all                  | orders.refresh                                                                         |
| POST   | /api/orders/page-open-refresh            | orders.refresh                                                                         |
| GET    | /api/order-refresh/jobs/:id              | orders.refresh                                                                         |
| GET    | /api/order-refresh/batches/:id           | orders.refresh                                                                         |
| GET    | /api/email-processing                    | admin + email.read                                                                     |
| GET    | /api/email-processing/metrics            | admin + email.read                                                                     |
| POST   | /api/email-processing/batch-reparse      | admin + email.process                                                                  |
| GET    | /api/email-processing/:id                | admin + email.content.read                                                             |
| POST   | /api/email-processing/:id/reparse        | admin + email.process                                                                  |
| PUT    | /api/email-processing/:id/draft          | admin + email.process                                                                  |
| POST   | /api/email-processing/:id/ingest         | admin + email.process                                                                  |
| POST   | /api/email-processing/:id/resolve        | admin + email.process                                                                  |
| GET    | /api/stats/overview                      | stats.read                                                                             |
| GET    | /api/stats/apple-ids                     | stats.read                                                                             |
| GET    | /api/stats/recipients                    | stats.read                                                                             |
| GET    | /api/stats/products                      | stats.read                                                                             |
| POST   | /api/import/preview                      | type 对应模块 import                                                                   |
| POST   | /api/import/execute                      | type 与预览会话对应的 import                                                           |
| GET    | /api/import/template/:type               | type 对应模块 template.read                                                            |
| GET    | /api/dashboard/*                         | dashboard.read                                                                         |
| GET    | /api/channels                            | channels.read                                                                          |
| GET    | /api/channels/:tag/stats                 | channels.read                                                                          |
| GET    | /api/channels/:tag/orders                | channels.read                                                                          |
| PUT    | /api/channels/:tag                       | channels.rename                                                                        |
| GET    | /api/system/logs                         | admin + system.logs.read                                                               |
| GET    | /api/system/auto-refresh                 | admin + system.refresh.read                                                            |
| POST   | /api/system/auto-refresh/resume          | admin + system.refresh.manage                                                          |
| GET    | /api/system/proxy-provider               | admin + system.proxy.read                                                              |
| POST   | /api/system/proxy-provider               | admin + system.proxy.manage                                                            |
| GET    | /api/payment-tasks                       | payment_tasks.read_own；仅本人范围                                                     |
| GET    | /api/payment-tasks/:id                   | payment_tasks.read_own＋当前归属                                                       |
| PUT    | /api/payment-tasks/:id                   | payment_tasks.handle_own 和／或 payment_tasks.payer.edit_own＋当前归属；按实际字段检查 |
| PUT    | /api/payment-tasks/:id/payer             | payment_tasks.payer.edit_own＋当前归属                                                 |
| GET    | /api/payment-tasks/:id/payment-link      | payment_tasks.link.read_own＋当前归属                                                  |
| POST   | /api/payment-tasks/:id/refresh           | payment_tasks.refresh_own＋当前归属                                                    |
| GET    | /api/payment-tasks/:id/refresh/:jobId    | payment_tasks.refresh_own＋当前归属；仅关联订单任务                                    |
| GET    | /api/payment-dispatch/overview           | payment_dispatch.read（admin 保留）                                                    |
| GET    | /api/payment-dispatch/tasks              | payment_dispatch.read（admin 保留）                                                    |
| PUT    | /api/payment-dispatch/settings           | payment_dispatch.configure（admin 保留）                                               |
| PUT    | /api/payment-dispatch/staff/:userId      | payment_dispatch.configure（admin 保留）                                               |
| PUT    | /api/payment-dispatch/tasks/:id/assignee | payment_dispatch.assign（admin 保留）                                                  |
| PUT    | /api/payment-dispatch/tasks/assignee     | payment_dispatch.assign（admin 保留）；原子批量分配／转派                              |
| POST   | /api/payment-dispatch/tasks/:id/refresh  | payment_dispatch.assign（admin 保留）                                                  |
| POST   | /api/payment-dispatch/tasks/refresh      | payment_dispatch.assign（admin 保留）；1–100 项批量刷新                                |
| POST   | /api/payment-dispatch/tasks/:id/reopen   | payment_dispatch.correct（admin 保留）                                                 |
| POST   | /api/payment-dispatch/scan               | payment_dispatch.assign（admin 保留）                                                  |

## 认证与用户

- 登录提交 username、password，密码至少 8 位，返回 Token 与用户信息；账号/IP 限流与锁定分别生效。
- 改密提交 oldPassword、newPassword、confirmPassword；新密码至少 8 位，首次改密完成后才可访问业务 API。
- 登出目前由客户端移除 Token，不能理解成服务端已维护 JWT 撤销名单。
- 用户管理的 role 必须使用当前三个枚举，创建用户的初始密码至少 8 位。用户列表、增改、删除、解锁输入以[userController.js](../../src/controllers/userController.js)为准；解锁方法是 PUT。
- 登录和 `/auth/me` 返回 `permissions`、`permissionsVersion` 和 `availableHome`。普通用户权限每次请求从数据库重新读取；撤权提交后旧 Token 的后续业务请求立即按新集合判定。
- `PUT /users/:id/permissions` body 为 `{ permissions, expectedVersion, reason? }`，幂等键通过 `Idempotency-Key` 请求头传入；permissions 是完整集合。未知键、依赖不完整、普通用户获管理员保留项返回 400，版本冲突返回 409；授权集合、版本和审计同事务提交。

## Apple ID 与取机人

- Apple ID 列表 query 为 page、limit、status、country、keyword；新增接收 apple_id、password、nickname、country、status、security_qa，更新另支持 is_modified。返回使用 snake_case，默认不含密码/密保。本地开发 Compose 显式开启 `ALLOW_LOCAL_SENSITIVE_DISPLAY=true` 且当前用户为 admin 时，列表和详情额外返回解密后的 `password`；production、非 admin 或未开启配置时均不返回。
- 取机人列表 query 包含 page、limit、tag、status、apple_id_ref、keyword；新增必须 lastName、firstName、idCardNumber，关联写入使用 appleIdRef。写入为 camelCase，不按列表字段直接回传。
- 取机人列表和详情默认返回脱敏的 `id_card_number`、`phone` 且 `street_address=null`；仅在上述本地开发 admin 门禁同时满足时返回完整身份证号、手机号和详细地址。
- 联系方式/地址批量生成接收 recipient_ids；联系方式生成会覆盖选中记录已有的电话和邮箱，电话满足 `^1[3-9]\\d{9}$`，邮箱为“电话@8lvv.com”。前端在生成意图首次确认后，若选中记录已有对应数据，必须再次确认覆盖；取消二次确认不得调用生成接口。绑定 Apple ID 使用 recipientIds，保留现状差异，不能统一猜测。
- 取机人导出需要 export 权限；admin 显式 includeSensitive=true 存在敏感字段导出分支，此行为需要受控授权与验收。默认导出脱敏并处理公式注入。

来源：[Apple ID 控制器](../../src/controllers/appleIdController.js)、[取机人控制器](../../src/controllers/recipientController.js)。

## 订单

- 列表和详情由不同序列化函数构建；详情中的 apple_id 是关联对象或 null，不能套用列表的字符串类型。
- `POST /api/orders/:id/refresh` 只提交或合并 `manual_single` 任务，返回 HTTP `202` 和 `jobId`；任务入队不代表官网已经更新。
- `POST /api/orders/refresh-all` 为所有具有合法订单链接的订单创建或复用全量批次，返回 HTTP `202` 和 `batchId`。运行中重复提交返回同一批次。
- `POST /api/orders/page-open-refresh` 保留参数校验和权限门禁，但返回空任务结果，不再触发官网请求。打开列表或详情只读取已有数据，已付款订单仅手动刷新。
- 兼容端点 `POST /api/orders/batch-refresh` 仍接收 `orderIds/order_ids` 或既有筛选字段，但改为异步提交任务并返回 HTTP `202`，不再同步等待爬虫完成。
- `GET /api/order-refresh/jobs/:id` 返回任务状态、错误分类和订单当前新鲜度；只能查询本人提交的任务，admin 可查询全部，系统自动任务允许所有已认证用户读取其非敏感状态。
- `GET /api/order-refresh/batches/:id` 返回批次六类计数和完成时间；只能查询本人批次，admin 可查询全部。
- 列表和详情新增 `refresh` 对象：`freshness_status`、`last_attempt_at`、`last_success_at`、`last_failure_at`、`last_error_code`、`last_error_message` 和当前活动 `job`。超过 90 秒没有成功结果的待付款/未知订单由服务端序列化为 `stale`。
- PUT /api/orders/:id 只允许 paymentScreenshot，不再接受 payerName。付款人必须经 `PUT /api/orders/:id/payer` 或本人任务入口更新，body 为 `{ payerName: string | null, expectedVersion, reason? }`，幂等键通过请求头传入。`payerName` 去除首尾空白后最长 100 个字符，空字符串按 null 清空；付款人不是系统账号，也不存在候选目录。
- 官网金额、支付与取货状态是独立字段。列表、详情不返回 Apple 密码/原始订单链接，身份证和地址保持脱敏；`recipient_phone` 默认脱敏，仅在 `NODE_ENV=development`、`ALLOW_LOCAL_SENSITIVE_DISPLAY=true` 且当前用户为 admin 时返回完整值。
- 导出使用当前筛选条件，下载按 Blob 处理；不能以固定价格代替缺失官网金额。

## 邮件处理

邮件处理页面、列表、完整详情、指标、重新解析、草稿、入库、批量操作和人工关闭均仅允许 `admin`。`operator`、`readOnly` 和未认证请求由后端拒绝，前端隐藏导航不替代该门禁。

- `GET /api/email-processing`：query 支持 `page`、`limit`、`status`、`error_code`、`order_number`、`date_from`、`date_to`。省略 status 时只返回 `manual_review`。列表按人工优先、接收时间倒序，返回完整邮件主题和 From，不做字段脱敏；来源过滤错误码包括 `SUBJECT_NOT_ALLOWED` 和 `SENDER_NOT_ALLOWED`，后者保留加密原文并进入人工处理。
- `GET /api/email-processing/metrics`：返回各状态计数、最近收信、最近成功、24 小时失败数，以及独立 Worker 的连接、30 秒心跳运行判断、连续失败和最近错误码。`worker` 新增 `lastScanStartedAt`、`lastScanSucceededAt`、`lastScanDurationMs`、`lastScanErrorCode`、`isScanHealthy`；只有进程运行、邮箱已连接、最近 90 秒有成功扫描且最近扫描无错误时 `isScanHealthy=true`，空值不代表正常。扫描时间与收信／订单成功时间独立。
- `GET /api/email-processing/:id`：返回解密后的完整 `raw_mime`、`parsed_data`、`manual_draft`、`final_data`、处理尝试和管理员操作审计；读取完整详情本身写入 `view_full_detail` 审计。若草稿或解析结果中的订单号已存在，返回 `duplicate_order` 入口。
- `POST /api/email-processing/:id/reparse`：只允许 `manual_review/retry_wait`，使用当前解析器生成预览但不创建订单；返回预览、最新 version 和重复订单结果。
- `PUT /api/email-processing/:id/draft`：body 为 `{ draft, version }`，执行完整人工字段校验并加密保存。旧 version 返回 HTTP 409、错误码 `CONCURRENT_MODIFICATION`。
- `POST /api/email-processing/:id/ingest`：body 同草稿保存；在订单号 advisory lock 和邮件行锁下统一创建/关联订单、邮件终态和首次刷新任务。相同订单不覆盖，返回已有订单并把邮件置为 `superseded`。
- `POST /api/email-processing/batch-reparse`：body 为 `{ ids }`，1–50 个去重整数；只处理指定的可重解析记录，并为每个请求 ID 返回独立的成功、稳定错误码或 `NOT_FOUND`。
- `POST /api/email-processing/:id/resolve`：body 为 `{ resolutionType, reason, version, orderNumber? }`；`resolutionType` 仅允许 `ignored/existing_order`，原因必填且不超过 500 字，关联已有订单时必须提供确实存在的订单号。

管理员人工草稿可包含 `appleId`、`applePassword`、`orderNumber`、`orderUrl`、`orderDate`、`orderStatus`、`paymentMethod`、`products[]`，以及 `recipient.name/idLast4/idCard/email/phone/address/tag`。允许查看和填写密码、完整身份证号及系统内部状态是本模块的明确 admin 专属规则；字段在 `email_logs` 草稿/最终数据及订单敏感快照中加密存储，不得进入运行日志或错误响应。Apple URL 仍只允许中国官网 `vieworder` 路径且必须与订单号一致。

## 付款任务与付款人姓名

- 新增付款接口沿用项目现有 JavaScript API 的 camelCase 请求／响应，不对既有 snake_case 订单 DTO 做隐式全局转换。普通用户的列表、详情、状态、付款人、链接和刷新入口均同时校验权限和最新 assigneeUserId；转派后原负责人立即失去访问。
- 本人任务列表支持 page、limit、orderNumber、productModel、productKeyword、processingStatus；筛选在分页前完成，商品型号与关键词必须命中同一 products 元素。
- `PUT /api/payment-tasks/:id` 是行级原子保存接口，body 可包含 `{ processingStatus?, processingNotes?, expectedVersion?, payerName?, expectedPayerVersion? }`，幂等键通过请求头传入。接口只更新实际提交且发生变化的字段；任务字段要求 `payment_tasks.handle_own`，付款人字段要求 `payment_tasks.payer.edit_own`，同时修改时在同一事务提交或全部回滚。四态为 pending、processing、completed、exception；官网状态、复制链接、登记付款人、到期和转派不自动改变处理状态。异常、异常恢复和人工完成但官网未付时备注必填。兼容的独立付款人接口仍保留。
- 外部付款人姓名在四种状态、到期、官网已付／退款／取消后仍可维护。`PUT /api/payment-tasks/:id/payer` 使用 `{ payerName: string | null, expectedVersion, reason? }`；系统不提供付款人候选接口，不创建付款人账号或主数据。
- 复制订单链接接口只保留 `payment_tasks.link.read_own` 和当前任务归属校验，直接返回该任务关联订单的 `orders.orderUrl`；不再按核实、截止时间、人工处理状态或官网支付／订单状态限制复制。链接为空时返回资源不存在；响应设置 `Cache-Control: no-store`，事件和日志不保存原始链接。
- 本人任务刷新提交返回 HTTP `202`、`jobId`、是否新建或合并；`GET /api/payment-tasks/:id/refresh/:jobId` 仅允许当前负责人查询同一关联订单的刷新任务，返回 pending、running、succeeded、failed、skipped、错误摘要和订单最新抓取时间。入队不表示官网已更新；前端应展示提交中、排队／运行、成功／失败，终态后重新加载当前列表，Worker 未运行时明确保持“等待后台处理”。
- 本人任务列表和详情返回关联订单已有的 `paymentMethod`；该字段只用于展示订单付款方式，不作为任务处理结果或可编辑选项。`updatedAt` 取付款任务与关联订单更新时间中的较新值，前端“最后更新时间”按用户本地时区显示为 `YYYY/MM/DD HH:mm:ss`。
- 付款倒计时优先使用 `officialPaymentExpiresAt`，回退 `officialOrderCreatedAt + 30 分钟`。官网创建时间必须包含时分，仅有日期时保持未知；服务端返回 `serverTime`、`deadlineAt` 和 `remainingSeconds`，客户端不得用本机时间决定是否超时。管理员人工截止时间核实接口已取消。
- `GET /api/payment-dispatch/tasks` 新增 `page`（默认 1，1–100000）和 `pagination: { page, limit, total, totalPages }`；`limit` 保持默认 100、上限 200，页面使用 10/20/50/100。两个付款列表新增返回 `orderDate`（关联订单已有的下单时间，与订单管理一致），`officialOrderCreatedAt` 继续供官网时间和截止规则使用；下单时间展示优先 `orderDate`、缺失时回退已确认的 `officialOrderCreatedAt`，都缺失保持未知。支持 `orderNumber`、`productKeyword`、`assignee`、`officialOrderStatus` 和 `processingStatus` 组合筛选；商品匹配在数据库分页前执行。每项返回关联订单已有的 `paymentMethod`、`officialOrderStatus`、`lastCrawledAt` 和派生的 `deadlineAt`，其中页面“最后更新时间”只使用最后一次成功官网抓取时间 `lastCrawledAt`。
- 批量分配 body 为 `{ tasks: [{ id, expectedVersion }], assigneeUserId, handoffConfirmed?, reason? }`，一次最多 100 项，在同一事务内校验版本、状态、付款窗口、目标权限和容量后全部提交或全部回滚。批量刷新 body 为 `{ taskIds }`，仅把选中任务对应订单提交持久化刷新队列，HTTP 202 不代表官网已更新。
- payment-dispatch/settings 首次启用写 scope_started_at；默认关闭且 mode=manual。自动和手动分配都要求完整付款执行权限、账号正常、完成首次改密、上限有余量、合法付款链接以及官网付款窗口仍有效。官网已付款、退款、终态、身份异常和待核对状态禁止新分配；active_count 为 pending＋processing＋exception，completed 释放容量，官网收款不自动修改人工四态。

### 生命周期与来源冲突响应

订单链接末段为订单联系邮箱，可与邮件解析的 Apple ID 不同；保留后者作为下单账户，不以联系邮箱覆盖。域名、路径、协议与订单号校验保持生效。

订单列表和详情增加 `official_raw_status`、`official_status_description`、`official_status_observed_at`、`official_fulfillment_message`、`official_payment_expires_at`、`official_payment_method`、`official_status_needs_review`、`official_all_items_terminal` 和 `official_field_diagnostics`。状态枚举见[数据库架构](../database/数据库架构.md)。`products` 为官网优先的有效商品，商品 `fulfillmentMessage` 为提示文案，不伪造日期；历史 `deliveryDate` 仅兼容已有数据。

`validation_issues` 用于行首叹号的悬停／键盘聚焦提示，包含白名单字段名、来源、原值、官网值和处理结果；身份不一致仅返回安全错误说明，不暴露另一个订单的号码或内容。`source_snapshot` 不整体对外返回，图片、动作 URL、取货说明、原始 JSON 和敏感来源内容不进入 DTO。付款任务增加 `officialPaymentConfirmed`、`officialPaymentDiscrepancy`，分别表达官网确认已付和官网已付但人工任务尚未完成。

## 专题协议

- [Excel 导入](Excel导入规范.md)：模板、上传预览、15 分钟用户绑定会话、单次消费令牌。
- [渠道管理](渠道管理说明.md)：标签聚合、分页、newTag 事务改名。
- [仪表板](仪表板说明.md)：图表与指标口径；stats 独立统计入口见[statsController.js](../../src/controllers/statsController.js)。
- 仪表板 `GET /api/dashboard/stats` 返回 `availableRecipients`，统计状态为“使用中”或“未使用”的取机人总数，不受订单筛选影响。
- `GET /api/system/auto-refresh` 从持久化系统状态、任务和调度表返回 Worker 心跳、暂停原因、队列计数及新鲜度统计。
- `POST /api/system/auto-refresh/resume` 仅 admin 可调用；清除持久化断路状态并返回当前状态，不重启 Worker、不改代理配置，也不把 API 进程状态冒充 Worker 状态。
- `GET /api/system/proxy-provider` 新增 `workerReady` 与 `workerBlockedReason`，依据当前代理初始化结果及 20 秒心跳时效判断；暂停、代理禁用、恢复失败或心跳过期均不显示就绪。`activeProvider` 为最后确认的 Provider，只有 workerReady 才表示当前进程可处理任务。仅返回代理是否启用、`kdl_tunnel`、`kdl_private`、`fanproxy_tunnel`、`yiyou_http` 四个 Provider 是否已配置、环境默认值、管理员请求值、Worker 已确认值、切换状态、时间和脱敏错误；不返回主机鉴权、账号、用户名、密码、提取 API URL 或签名。
- `POST /api/system/proxy-provider` 仅 admin 可调用，body 的 `provider` 可为 `kdl_tunnel`、`kdl_private`、`fanproxy_tunnel` 或 `yiyou_http`。未知枚举、代理未启用或目标 Provider 配置不完整时拒绝。接口只持久化切换请求并返回 HTTP `202`；独立 Worker 在停止补位并等待在途任务结束后预初始化并验证目标 Provider，成功才切换，失败保留旧 Provider。重复提交当前请求幂等，不把“已提交”响应表示成“已切换”。四套凭据预先配置完成后，运行时切换不重启 Worker；凭据新增或替换仍需按授权更新环境并重建 Worker。

## 维护与验证

API 变更同时更新 Router、Controller、前端调用和测试。当前表描述已挂载端点；完整 DTO 统一和真实 API/数据库集成仍未完成。旧未挂载的 /api/config 等示例进入[历史接口资料](../archive/2026-09/整理前接口设计.md)，不再作为可调用接口。

### 订单列表信息补全与单行刷新（2026-09-09）

- 列表 `apple_id`、`recipient_name` 优先使用关联档案，缺失时使用邮件已入库的订单快照；详情采用相同回退，快照对象的 `id=null`，不伪造档案关联。
- 列表新增 `recipient_tag`：取机人档案标签优先，否则使用邮件入库的订单 `tag`。姓名和关键词搜索覆盖订单快照。
- 订单页“最后更新时间”读取 `last_crawled_at`，仅官网抓取及数据更新成功才改变；未成功过显示“尚未更新”。不使用本地 `updated_at` 或最近失败时间。
- 每行刷新复用 `POST /api/orders/:id/refresh` 和任务查询接口，要求 `orders.refresh` 权限；显示排队、执行、完成或失败，失败可重试。移除订单列表联系电话列，保留后端字段及原有脱敏门禁。
