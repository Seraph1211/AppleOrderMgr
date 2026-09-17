# API 契约与接口导航

> 状态：当前有效
>
> 最近核对：2026-09-07
>
> 基线：main@d000d03 与当前工作树
>
> 验证范围：本地工作树静态核对；未验证真实数据库、邮箱、官网和生产环境

## 通用约束

前缀为 /api。除登录和健康检查外均需认证；auth 下改密、登出、me 各自经过 authenticate，其余业务统一经过全局认证与最多三个会话校验。Bearer Token 不放入 URL。

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

AOS 设备协议挂载于 `/api/aos-collector/v1`，管理员来源管理挂载于 `/api/order-ingestion`，详见本页 [AOS 契约](#aos-文件入库与数据源切换契约2026-09-10)。新增设备认证与员工 JWT 分离；本地实现已联调，生产尚未发布。

下表从当前路由核对，路由注释中的历史 Public 标记不覆盖全局认证。每个模块的详细字段与校验入口链接在表后。

| 方法   | 路径                                     | 权限要求                                                                               |
| ------ | ---------------------------------------- | -------------------------------------------------------------------------------------- |
| GET    | /api/health/live                         | 公开；进程存活                                                                         |
| GET    | /api/health/ready                        | 公开；数据库检查，失败 503                                                             |
| GET    | /api/health                              | 公开；307 到 ready                                                                     |
| POST   | /api/auth/login                          | 公开；登录限流                                                                         |
| POST   | /api/auth/logout                         | 有效登录会话；所有角色可用                                                             |
| POST   | /api/auth/change-password                | 有效登录会话；所有角色可用                                                             |
| GET    | /api/auth/me                             | 有效登录会话；所有角色可用                                                             |
| PATCH  | /api/auth/profile                        | 已登录本人，无业务权限要求                                                             |
| POST   | /api/users/:id/reset-password            | admin 且 users.manage                                                                  |
| GET    | /api/system/operation-logs               | admin 且 system.logs.read                                                              |
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
| PUT    | /api/payment-dispatch/tasks/:id/notes    | payment_dispatch.correct（admin 保留）；修改处理备注                                   |
| POST   | /api/payment-dispatch/tasks/:id/refresh  | payment_dispatch.assign（admin 保留）                                                  |
| POST   | /api/payment-dispatch/tasks/refresh      | payment_dispatch.assign（admin 保留）；1–100 项批量刷新                                |
| POST   | /api/payment-dispatch/tasks/:id/reopen   | payment_dispatch.correct（admin 保留）                                                 |
| POST   | /api/payment-dispatch/scan               | payment_dispatch.assign（admin 保留）                                                  |

## 身份核验（2026-09-09 已确认契约）

独立入口 `/api/identity-verifications`，继承 JWT 与账号会话检查。`identity.read` 控制读取，`identity.verify` 控制单人核验，`identity.batch` 控制批量预览／执行，`identity.export` 控制原始结果导出；后三项依赖 read，管理员默认拥有，普通用户显式授予。普通用户只能访问本人批次，管理员可查全部。按用户确认，返回及导出完整原始姓名、身份证号；其他模块脱敏规则不变。响应 `Cache-Control: no-store`，日志不含输入和供应商原始响应。

| 方法及路径（相对此入口） | 契约                                                                                                                    |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| GET /status              | read；配置状态、批量上限和速率，不返回凭据或推测余额                                                                    |
| GET /template            | batch；xlsx，工作表「身份核验」，列「姓名」「身份证号」为文本                                                           |
| POST /single             | verify；`{name,idCardNumber}`，`Idempotency-Key` UUID 必填；返回202及batchId；同一用户同键同内容返回原批次，内容冲突409 |
| POST /preview            | batch；multipart file，仅xlsx，10MB、1000非空行；只预览不扣次，返回draft批次、原始行和有效／错误／重复计数，15分钟有效  |
| POST /batches/:id/start  | batch；开始draft或恢复paused中的pending行；queued/running重复调用幂等；不重发unknown/error/已完成行                     |
| POST /batches/:id/stop   | 根据single/excel来源要求verify/batch；停止未开始行，在途行等待结果，停止后不可恢复                                      |
| GET /batches             | read；page、limit（最多50）、source（single/excel）、from/to日期；分页返回批次和进度                                    |
| GET /batches/:id         | read；返回批次和最多1000原始行；duplicateOf指同批首个相同组合行号，结果解析到该行                                       |
| GET /batches/:id/export  | export；xlsx，保留行号、原始姓名／身份证、结果、说明、重复来源、时间及地区／性别／生日／流水号                          |

批次：draft/queued/running/paused/completed/cancelled；行：pending/processing/matched/mismatched/error/unknown/invalid/duplicate/cancelled。只有 `error_code=0` 且布尔 `result.isok` 确定一致与否；超时、未知返回、进程中断标unknown，不自动重试。凭据或额度错误暂停队列。每次开始和领取锁用户复查权限、账号状态；全局PostgreSQL会话锁保证单请求在途、请求起点至少相隔500ms（上限2RPS），与Apple爬虫独立。见[身份核验接入方案](../planning/身份核验接入方案.md)。

## 认证与用户规则

- 登录提交 username、password，密码至少 8 位，返回 Token 与用户信息；账号/IP 限流与锁定分别生效。
- 改密提交 oldPassword、newPassword、confirmPassword；新密码至少 8 位，不再强制首次改密；改密成功后当前会话失效，需使用新密码重新登录。
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
- 本人任务列表支持 page、limit、orderNumber、productNames、recipientTags、processingStatus；`productNames` 是 JSON 数组，最多 100 项，每项去除首尾空格后按完整 `products[].name` 精确匹配且最长 500 字符，多个商品之间为 OR。筛选在分页前完成，与 TAG、订单号、状态和日期等其他维度之间为 AND。旧 `productModel`、`productKeyword` 继续兼容且与商品名称条件命中同一 products 元素。`recipientTags` 同样最多 100 项、每项最长 500 字符，多个 TAG 之间为 OR；兼容单值 `recipientTag`。AOS 订单使用来源 TAG，其他订单使用订单入库时保存的 `tag`。
- `PUT /api/payment-tasks/:id` 是行级原子保存接口，body 可包含 `{ processingStatus?, processingNotes?, expectedVersion?, payerName?, expectedPayerVersion? }`，幂等键通过请求头传入。接口只更新实际提交且发生变化的字段；任务字段要求 `payment_tasks.handle_own`，付款人字段要求 `payment_tasks.payer.edit_own`，同时修改时在同一事务提交或全部回滚。四态为 pending、processing、completed、exception；官网状态、复制链接、登记付款人、到期和转派不自动改变处理状态。状态变更与备注填写、保存无关，备注可空。兼容的独立付款人接口仍保留。
- 外部付款人姓名在四种状态、到期、官网已付／退款／取消后仍可维护。`PUT /api/payment-tasks/:id/payer` 使用 `{ payerName: string | null, expectedVersion, reason? }`；系统不提供付款人候选接口，不创建付款人账号或主数据。
- 单项和当前页勾选批量复制订单信息均通过既有链接接口逐单校验 `payment_tasks.link.read_own` 和当前任务归属，接口直接返回该任务关联订单的 `orders.orderUrl`；前端结合本人任务 DTO 生成 `orders.id || 商品信息 || 支付方式 || 订单链接`，批量结果按当前列表顺序每单一行。商品名称优先、型号兜底，每项按 `名称 x 数量` 展示，多商品使用 `、` 连接；`WECHAT`／`WECHAT PAY`／`微信支付` 显示为 `微信`，`ALIPAY` 显示为 `支付宝`，其他非空值保留原文，商品或支付方式缺失时使用 `-`，链接保持普通 URL。接口不按核实、截止时间、人工处理状态或官网支付／订单状态限制复制；链接为空时返回资源不存在，响应设置 `Cache-Control: no-store`，事件和日志不保存原始链接。
- 本人任务刷新提交返回 HTTP `202`、`jobId`、是否新建或合并；`GET /api/payment-tasks/:id/refresh/:jobId` 仅允许当前负责人查询同一关联订单的刷新任务，返回 pending、running、succeeded、failed、skipped、错误摘要和订单最新抓取时间。入队不表示官网已更新；前端应展示提交中、排队／运行、成功／失败，终态后重新加载当前列表，Worker 未运行时明确保持“等待后台处理”。
- 本人任务列表和详情返回关联订单已有的 `paymentMethod` 和派生的 `recipientTag`；两个付款列表额外返回当前权限及其他筛选条件范围内的 `productNameOptions` 和 `recipientTagOptions`，分别不受已选商品、已选 TAG 限制，供可搜索下拉多选使用，不能只从当前页计算。这些字段只用于展示和筛选，不作为任务处理结果或可编辑选项。本人任务和管理员调度列表均按关联订单 `orderDate DESC` 稳定分页，时间相同时按任务 ID 倒序；`updatedAt` 仍取付款任务与关联订单更新时间中的较新值，但两张付款页面的“数据更新时间”只展示最后一次成功官网抓取时间 `lastCrawledAt`。
- 付款倒计时优先使用 `officialPaymentExpiresAt`，回退 `officialOrderCreatedAt + 30 分钟`。官网创建时间必须包含时分，仅有日期时保持未知；服务端返回 `serverTime`、`deadlineAt` 和 `remainingSeconds`，客户端不得用本机时间决定是否超时。管理员人工截止时间核实接口已取消。
- `GET /api/payment-dispatch/tasks` 新增 `page`（默认 1，1–100000）和 `pagination: { page, limit, total, totalPages }`；`limit` 保持默认 100、上限 200，页面使用 10/20/50/100。两个付款列表新增返回 `orderDate`（关联订单已有的下单时间，与订单管理一致），`officialOrderCreatedAt` 继续供官网时间和截止规则使用；下单时间展示优先 `orderDate`、缺失时回退已确认的 `officialOrderCreatedAt`，都缺失保持未知。支持 `orderNumber`、`productNames`、`recipientTags`、`assignee`、`officialOrderStatus` 和 `processingStatus` 组合筛选；商品名称和 TAG 各自组内 OR、跨维度 AND，均在数据库分页前执行，并兼容旧商品查询参数和单值 `recipientTag`。每项返回关联订单已有的 `paymentMethod`、派生的 `recipientTag`、`officialOrderStatus`、`lastCrawledAt` 和派生的 `deadlineAt`，列表级返回 `productNameOptions`、`recipientTagOptions`，其中页面“数据更新时间”只使用最后一次成功官网抓取时间 `lastCrawledAt`。
- `PUT /api/payment-dispatch/tasks/:id/notes` 允许具有 `payment_dispatch.correct` 的管理员修改任意现有付款任务的处理备注。body 为 `{ processingNotes: string | null, expectedVersion }`，备注去除首尾空格后最长 2000 字，空字符串保存为 `null`；`Idempotency-Key` 必填。接口使用任务版本防覆盖，只修改备注并递增任务版本，不改变人工状态、负责人或官网状态；写入 `notes_updated` 任务事件并返回更新后的任务 DTO。任务不存在返回 404，旧版本返回 `CONCURRENT_MODIFICATION`。
- 批量分配 body 为 `{ tasks: [{ id, expectedVersion }], assigneeUserId, handoffConfirmed?, reason? }`，一次最多 100 项，在同一事务内校验版本、状态、付款窗口、目标权限和容量后全部提交或全部回滚。管理员单项刷新返回 HTTP `202` 和 `{ jobId, status, created, merged }`；批量刷新 body 为 `{ taskIds }`，返回 `{ total, created, merged, missing, results }` 汇总。两者都只把对应订单提交持久化刷新队列，HTTP `202` 不代表官网已更新。
- payment-dispatch/settings 首次启用写 scope_started_at；默认关闭且 mode=manual。自动和手动分配都要求完整付款执行权限、账号正常、上限有余量、合法付款链接以及官网付款窗口仍有效。官网已付款、退款、终态、身份异常和待核对状态禁止新分配；active_count 为 pending＋processing＋exception，completed 释放容量，官网收款不自动修改人工四态。

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

### 订单列表组合筛选与取货时间（2026-09-17）

- `GET /api/orders` 和 `GET /api/orders/export` 支持 `statuses`、`productNames`、`pickupStores` 三个 JSON 数组筛选参数，每项最多 100 个值。同一数组内按 OR 匹配，不同筛选维度之间按 AND 组合；订单状态必须属于现有状态枚举，商品名称和门店按完整值精确匹配。继续兼容既有单值 `status`、`productModel`、`pickupStore` 参数。
- `pickupDate` 仅接受 `YYYY-MM-DD`。它匹配 `official_fulfillment_message` 中同一天的官网预约提示日期，不比较具体时分，也不使用下单时间、付款截止、实际取货日期或系统时间替代。列表派生返回 `pickup_time`，只提取并规范显示预约提示中的 `YYYY/MM/DD HH:mm – HH:mm`；原始履约提示和详情 DTO 保持不变。
- `GET /api/orders/filter-options` 返回 `productNames` 和 `stores`，候选来自订单完整 `products[].name` 与 `pickup_store`，不从当前分页临时拼接。兼容返回 `productModels`，但订单管理页面不再使用型号筛选。
- 订单管理主表不展示 `validation_status` 和 `apple_id` 列；校验问题仍通过行首提示图标进入原异常说明，异常行不使用整行红色背景。上述字段仍保留在既有 DTO、搜索和详情能力中。

### 下单时间精度与时区（2026-09-09 修复）

`orderDate` / `order_date` 保留邮件或人工录入的来源下单时间，官网只有日期时禁止覆盖，官网精确时间独立保存在 `officialOrderCreatedAt`。日期冲突提示核对，不用官网日期补造时分秒。页面和导出统一北京时间（Asia/Shanghai）；日期筛选包含北京时间的完整起止日。仅有日期时仅展示日期，未知时间不使用入库时间或付款截止倒推。人工录入必须包含时分；无时区输入按北京时间解释。付款截止仍只使用官网截止或精确官网时间。历史修复只恢复可核验来源快照，不将来源时间宣称为官网精确时间。

## 账号与操作记录补充契约（2026-09-09）

- 新账号登录后按 `availableHome` 进入第一个有权限的页面；零业务权限进入 `/profile` 个人设置。
- 用户 DTO 增加 `accountId`（`U` 加补齐至少四位的数字 ID）和 `nickname`。登录账号和 ID 不可由编辑接口修改；创建时昵称可选（默认登录账号），昵称输入去首尾空格后为 1–50 字符。
- `PATCH /api/auth/profile`：所有已登录账号可提交 `{ nickname }`，只更新本人昵称，未知字段返回 400；返回最新本人 DTO。
- `POST /api/users` 支持 nickname；`PUT /api/users/:id` 支持管理员配置 nickname。账号列表 keyword 支持昵称、登录账号和完整账号 ID。
- `POST /api/users/:id/reset-password`：仅 `admin` 且具备 users.manage，提交 `{ newPassword, confirmPassword }`，至少 8 位且两次一致。重置后清除该账号全部会话，不自动解锁账号，不强制下次改密；不返回原密码或密码哈希。新密码由管理员当次填写，可在弹窗临时显示。
- 每个账号最多同时保留 3 个有效设备会话；前三台直接登录，第 4 台登录返回 409 `SESSION_CONFIRMATION_REQUIRED` 与 `error.details.confirmationToken`。客户端展示接管弹窗，确认后重提账号、密码、confirmationToken。短期签名确认凭证绑定当时的会话集合及最早登录会话、两分钟有效；名额仍满且会话改变时须再次确认。确认只替换最早登录的一台，取消不改变现有会话。
- 同一有效 Bearer 会话重新登录可直接续签；不同浏览器或独立浏览器配置按不同设备会话处理。同一浏览器的多个标签页可共用同一个会话，不使用指纹推断物理设备。
- JWT 增加 sessionId；每个受保护请求核对数据库有效会话集合。被接管返回 401 `SESSION_REPLACED`；清除或迁移前旧 Token 返回 401 `SESSION_EXPIRED`。旧页面每 5 秒及恢复前台时检查会话并退出，服务端即时拒绝旧凭证。`POST /auth/logout` 只撤销当前服务端会话；本人改密、管理员重置和锁定撤销全部会话。
- `GET /api/system/operation-logs`：仅管理员具备 system.logs.read，分页 page/limit（最大 100）；筛选 keyword（登录账号／昵称／完整账号 ID）、action、result、dateFrom/dateTo。返回 data.logs、total、page、limit；每条含操作人 ID/账号/昵称、中文动作、目标、IP、时间与中文结果说明。
- 记录已到达系统的账号 API 操作（包括读取、导入、导出、失败与拒绝），不记录鼠标点击、输入草稿、健康检查和 `/auth/me` 自动心跳。失败登录保留尝试账号。未知路由只记录所属模块；不保存密码、令牌、原始链接、请求正文或查询参数值。新记录从本次迁移启用后开始，历史缺失不能补造。
- 操作记录保存到数据库；写入失败记录结构化应急运行日志，不能保证数据库故障或进程突然退出时绝对无遗漏。运行环境需正确设置 TRUST_PROXY 才能在反向代理后记录实际客户端 IP。
- 系统运行日志保留原技术代码供排障，页面主要展示中文类型、级别、事件、结果和说明。

### 过期任务手动分配（2026-09-09）

`PUT /api/payment-dispatch/tasks/assignee` 及单项兼容入口允许管理员手动分配／转派已过期的现有任务，`reason` 选填、最多 500 字；存在转派仍要求 `handoffConfirmed=true`。仅解除过期拦截，不放宽已付、退款、取消、状态待核实、未知付款截止和链接身份校验；容量、版本及整批原子性保持。自动分配不纳入过期订单。审计记录可空原因和 `expiredAtAssignment`，不修改订单官网状态或付款时间。

## 人员批量配置与账号软删除（2026-09-09）

- `PUT /api/payment-dispatch/staff`：管理员具备 payment_dispatch.configure，提交 `{ staff: [{ userId, maxActiveTasks, autoAssignEnabled, expectedVersion }] }`，仅提交修改行，1–1000 人且 ID 不重复。整批在同一事务及调度锁下校验版本、权限和有效账号；任一失败全部回滚。保留单人兼容入口。
- `DELETE /api/users/:id` 改为软删除。禁止删除自己和最后一个有效管理员；有未交接任务返回 409 及任务数量，历史审计记录不再阻止删除。删除后隐藏账号、拒绝登录及旧 Token、关闭接单，保留历史引用和用户名占用。

## TAG 自动分配规则（2026-09-12）

以下端点均要求管理员及 `payment_dispatch.configure`，普通付款人员不能读取规则和目标账号集合。

- `GET /api/payment-dispatch/tag-rules`：返回 `data: { items, tagOptions }`。规则字段为 `id, name, enabled, recipientTags, assigneeUserIds, version, updatedBy, createdAt, updatedAt`；TAG 候选取全部 AOS 来源订单的来源 TAG（缺失回退订单 tag），不限任务当前页。可手工输入尚未入库的 TAG。
- `POST /api/payment-dispatch/tag-rules`：提交 `{ name, enabled, recipientTags, assigneeUserIds }`，返回 201 与新规则。名称去首尾空格后 1–100 字符；TAG 数组 1–100 项、每项 1–500 字符、去首尾空格及去重；账号数组 1–100 个互不重复的正整数。新增账号必须正常且具备完整付款执行权限，允许暂未开启接单／没有容量。
- `PUT /api/payment-dispatch/tag-rules/:id`：提交完整规则字段及 `expectedVersion`（非负整数）；启停也使用此端点。允许保留该规则原有失效账号；新增账号仍按上述资格校验。
- `DELETE /api/payment-dispatch/tag-rules/:id`：请求体 `{ expectedVersion }`，删除规则，返回 `data: { id }`。
- 不存在返回 404；参数非法返回 400；同 TAG 在启用规则中重复返回 409 `TAG_RULE_CONFLICT`；过期版本返回 409 `CONCURRENT_MODIFICATION`。增改删与分配共用事务调度锁并原子记录审计。停用规则允许 TAG 重叠，重新启用必须检查。
- `GET /api/payment-dispatch/tasks` 的任务增加 `autoAssignment: { ruleId, ruleName, reasonCode, reason }`（已分配为 null）；只显示当前规则名称和待分配原因，不向本人任务端点暴露账号规则。原因区分全局关闭、手动模式、非待处理、订单不可付款、时间未知／过期、入口缺失、规则内无人可接单、规则内容量已满和等待调度。展示按查询时状态派生，不把旧原因持久化到任务。
- 自动分配只对 AOS TAG 完整匹配（区分大小写）；命中后只在规则账号内按现有负载算法分配，无合格账号时等待。非 AOS／空 TAG／未命中仅在未绑定启用 TAG 规则的普通账号中沿用默认算法。保存后下次调度生效；未分配存量参与，已分配保持负责人，人工转派不受 TAG 限制。停用／删除会让未分配订单重新走其他启用规则或默认分配。

## AOS 文件入库与数据源切换契约（2026-09-10）

### AOS 1 通用约定与认证

本节定义本地开发分支已实现的首版契约，生产尚未部署。字段统一使用 camelCase，不改写现有端点的 snake_case 返回；`email` 表示邮件业务来源，不替换现有 `email_logs.source=imap`。所有示例均为合成数据或占位值。

- 管理后台前缀：`/api/order-ingestion`，复用现有用户 Bearer 会话认证。首版要求 admin 且对应权限，不创建新用户角色。
- 采集器前缀：`/api/aos-collector/v1`，使用设备专用 Bearer 凭证。必须单独挂载设备认证中间件，不能混用员工登录 Token，也不能以“绕过用户认证”方式裸露接口。
- 拟新增权限：`ingestion.read`、`ingestion.manage`、`ingestion.devices.manage`、`ingestion.records.process`、`ingestion.content.read`；后四项依赖 `ingestion.read`。下列表格省略 `ingestion.` 前缀，但均另需 admin。admin 沿用现有权限目录机制获得权限，普通员工首版不开放本模块。
- 时间为 ISO 8601 且含时区，返回统一 UTC `Z`；下单原文按北京时间解释。日期筛选为 `YYYY-MM-DD`，包含北京时间起止日。未知值使用 `null`，不能以 0、空字符串或当前时间冒充。
- 标识符：设备 ID、接收记录 ID、事件 ID、文件实例 ID、预览 ID 和补录 ID 为 UUID 字符串；现有订单／用户 ID 延续整数；记录 `version`、配置 `version` 为正整数。
- 列表统一 `{ items, total, page, limit }`，page 默认 1、limit 默认 20、最大 100；超界报 400。未知枚举、未知写入字段或无时区时间报 400，不静默忽略。
- 成功返回 `{ success: true, data: ... }`；错误返回 `{ success: false, error: { code, message, details } }`，响应头 `X-Request-Id` 关联脱敏日志，详情只含字段路径和安全错误原因。
- 管理写操作使用 `Idempotency-Key`（UUID）防止响应丢失导致重复执行。作用域为操作者、方法、路径和键，保留 24 小时；同键同请求返回原结果，同键异内容返回 409。并发编辑另外校验 `expectedVersion`，两者不能替代。
- 设备凭证仅创建／轮换当次返回，服务端长期只存校验摘要。幂等重放不再次显示明文凭证，返回 `credential: null, credentialDisplayed: true`；响应丢失时通过明确的凭证轮换恢复，不能重复创建设备。
- 敏感内容和凭证响应使用 `Cache-Control: no-store`，不得进入浏览器持久化存储或诊断日志。列表与普通详情不返回密码、原始行、完整订单链接。

### AOS 2 全局来源设置、切换预览与补录结果

| 方法与路径                                 | 权限   | 请求                                                   | 返回及用途                                                                      |
| ------------------------------------------ | ------ | ------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `GET /api/order-ingestion/settings`        | read   | 无                                                     | `SettingsDto`，包括当前来源、版本、生效时间、补录规则、重复策略和就绪摘要       |
| `POST /api/order-ingestion/switch-preview` | manage | `{ targetSource, expectedVersion }`                    | `SwitchPreviewDto`；仅计算预览，不触发扫描或入库，不要求幂等键                  |
| `PUT /api/order-ingestion/settings`        | manage | `{ activeSource, expectedVersion, previewId }`，幂等键 | 事务切换后返回 `{ settings, backfillId, warnings }`；来源立即生效，补录异步执行 |
| `GET /api/order-ingestion/backfills/:id`   | read   | 路径 ID                                                | `BackfillDto`，查询本次当天补录进度                                             |
| `GET /api/order-ingestion/audits`          | read   | page、limit、dateFrom、dateTo                          | 切换／设备／人工处理审计列表，不含敏感载荷                                      |

`SettingsDto`：

```json
{
  "activeSource": "email",
  "version": 3,
  "effectiveAt": "2026-09-10T02:00:00.000Z",
  "timeZone": "Asia/Shanghai",
  "backfillPolicy": "current_day",
  "duplicatePolicy": "keep_existing",
  "duplicatePolicyStatus": "confirmed",
  "updatedBy": { "id": 1, "displayName": "管理员" },
  "readiness": {
    "email": {
      "ready": true,
      "lastSuccessfulScanAt": "2026-09-10T02:01:00.000Z",
      "errorCode": null
    },
    "aos": {
      "ready": false,
      "enabledDeviceCount": 3,
      "onlineDeviceCount": 2,
      "healthyDirectoryDeviceCount": 1
    }
  }
}
```

`duplicatePolicy` 在业务确认后只读返回 `keep_existing`、`fill_missing` 或 `aos_source_fields`；本版设置接口不开放修改该策略，不能借前端默认值提前决定尚未批准的字段覆盖行为。

`SwitchPreviewDto` 包含 `previewId`、`targetSource`、`settingsVersion`、`serverTime`、`expiresAt`、`businessDate`、`from`、`toExclusive`、`knownPendingCount`、`knownDuplicateCount`、`inventoryComplete`、`warnings[]`。例如北京时间 9 月 10 日范围为 UTC 9 月 9 日 16:00 至 9 月 10 日 16:00，左闭右开。未知计数为 null；设备离线或尚未扫描时 `inventoryComplete=false`，不能声称预览数量已覆盖全部文件。

预览有效期 5 分钟，绑定当前配置版本、操作者、目标来源和北京时间日期；跨午夜或版本变化必须重新预览。目标来源不就绪作为明确 warning 展示，允许管理员主动切换，不要求所有电脑在线。前端提交期间禁用重复操作；收到成功响应后以返回的 settings 为准，不乐观显示已生效。请求超时先用同一幂等键核对结果，不能创建新的切换请求。

提交时再次校验版本和预览；无实际来源变化时返回当前配置、`backfillId: null`，不启动新补录。真实切换与持久化补录任务同事务提交。并发切换只允许一个期望版本成功；入库事务和切换遵循 [AOS 方案](../planning/AOS文件入库与数据源切换方案.md)中定义的锁边界。

`BackfillDto`：`id`、`source`、`settingsVersion`、`businessDate`、`from`、`toExclusive`、`status`（queued/running/waiting_source/partial/completed/superseded/failed）、`counts`（received/created/duplicate/manualReview/pending）、`devices[]`（deviceId、status、lastScanAt、errorCode）、`errorCode`、`createdAt`、`updatedAt`。`completed` 仅指本轮已确认扫描范围的处理完成，持续监听仍继续；存在未完成设备则 partial 或 waiting_source。后续切换使旧补录任务 superseded，已经保存的记录保留。

补录设备范围在发起时固定为当时启用设备，新启用设备独立执行首次当天扫描；设备上报扫描完成且该扫描记录已全部可靠接收后才计作完成。邮件侧需同时观察回查结束及入库处理结果，不能以 IMAP 查询完成冒充补录完成。

### AOS 3 设备管理与凭证

| 方法与路径                                                | 权限           | 请求                                                      | 返回                                                                                                                                       |
| --------------------------------------------------------- | -------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/order-ingestion/devices`                        | read           | page、limit、enabled、online、keyword                     | `DeviceDto` 分页列表                                                                                                                       |
| `POST /api/order-ingestion/devices`                       | devices.manage | `{ name, notes? }`，name 1–100、notes 最多 500 字；幂等键 | 201 `{ device, credential, credentialDisplayed: false }`；新增设备默认 enabled                                                             |
| `GET /api/order-ingestion/devices/:id`                    | read           | 路径 ID                                                   | `DeviceDto`                                                                                                                                |
| `GET /api/order-ingestion/devices/:id/credential`         | devices.manage | 路径 ID                                                   | `{ device, credential }`；凭证使用 AES-256-GCM 密文保存，每次查看记录审计；历史设备无密文时返回 `DEVICE_CREDENTIAL_NOT_VIEWABLE`，须先轮换 |
| `PATCH /api/order-ingestion/devices/:id`                  | devices.manage | `{ expectedVersion, name?, notes?, enabled? }`，幂等键    | 修改后的 `DeviceDto`，至少一个变更字段                                                                                                     |
| `POST /api/order-ingestion/devices/:id/rotate-credential` | devices.manage | `{ expectedVersion }`，幂等键                             | `{ device, credential, credentialDisplayed: false }`；旧凭证立即失效，更新本机前停止上传但保留队列                                         |

`DeviceDto`：`id`、`name`、`notes`、`enabled`、`version`、`credentialVersion`、`credentialConfigured`、`credentialViewable`、`agentVersion`、`osVersion`、`lastHeartbeatAt`、`lastSuccessfulScanAt`、`lastNewOrderAt`、`online`、`scanHealthy`、`directories[]`、`localCounts`、`serverCounts`、`lastErrorCode`、`createdAt`、`updatedAt`。`SettingsDto.collectorServerUrl` 返回服务端配置的 `AOS_COLLECTOR_PUBLIC_URL`；未配置或不是合法 HTTPS 根地址时返回 `null`。

`directories[]` 只含 `directoryId`、`label`、`state`（ready/waiting_file/unreadable/missing）、`currentFileNames`（最多 20 个）、`lastSuccessfulScanAt`、`errorCode`，不含完整磁盘路径。`localCounts` 为 pendingUpload/uploadError/todayDiscovered；`serverCounts` 为 todayReceived/created/duplicate/manualReview/paused，全部非负整数，另带 `countsBusinessDate`，今日新增与存量积压分别统计。

心跳建议 15 秒一次，服务端超过 60 秒未收到有效心跳即 `online=false`；扫描健康单独由服务端接收时间及扫描结果判断，设备时间只用于诊断。没有当天文件时可以 online 且 waiting_file，不显示读取故障。停止服务造成的离线需等待心跳过期，不假装即时可知。

禁用设备不删除历史记录；服务器拒绝该设备的新接收及未开始的来源入库，已提交订单保留，队列显示 device_disabled；重新启用后按同一凭证恢复。撤销访问使用禁用或轮换，不提供首版硬删除端点。设备启停与入库最终检查必须协调事务，保证生效后未开始任务不能越过禁用限制。

### AOS 4 AOS 记录查询、预览和人工处理

以下路径前缀统一为 `/api/order-ingestion/aos-records`。

| 方法与相对路径      | 权限            | 请求                                                                      | 返回                                                                                                   |
| ------------------- | --------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `GET /`             | read            | page、limit、deviceId、orderNumber、status、eligibility、dateFrom、dateTo | `AosRecordDto` 列表；日期按下单日，另有 receivedFrom/receivedTo 按接收日筛选                           |
| `GET /:id`          | read            | 路径 ID                                                                   | 普通 `AosRecordDto`，来源元数据、脱敏字段、问题列表及处理历史摘要                                      |
| `GET /:id/content`  | content.read    | 路径 ID                                                                   | 原始行与解密后的字段、脱敏前草稿；写查看审计，no-store                                                 |
| `POST /:id/reparse` | records.process | `{ expectedVersion }`，幂等键                                             | `{ record, preview, issues }`；重解析原始行并保存新预览，不写订单；敏感字段仅返回掩码和 hasPassword    |
| `PUT /:id/draft`    | records.process | `{ expectedVersion, data, passwordAction, password? }`，幂等键            | `{ record, preview, issues }`；保存草稿，不入库；密码保留／替换明确区分                                |
| `POST /:id/ingest`  | records.process | `{ expectedVersion }`，幂等键                                             | `{ record, orderId, outcome }`，outcome 为 created/duplicate；提交前重新校验当前来源、范围、身份和版本 |
| `POST /:id/retry`   | records.process | `{ expectedVersion }`，幂等键                                             | 202 `{ record }`，只重新排队 retry_wait，不绕过永久错误校验                                            |
| `POST /:id/resolve` | records.process | `{ expectedVersion, action, reason, orderId? }`，幂等键                   | `{ record }`；action 为 close/link_existing，reason 1–500 字                                           |

`AosRecordDto`：`id`、`deviceId`、`eventId`、`fileName`、`lineNumber`、`orderNumber`、`orderDate`、`receivedAt`、`status`、`eligibility`、`outcome`、`orderId`、`version`、`attemptCount`、`nextRetryAt`、`errorCode`、`issues[]`、`hasDraft`、`hasPassword`、`safePreview`、`createdAt`、`updatedAt`。`safePreview` 包含商品、姓名、门店代码和 TAG，手机／邮箱掩码展示，不含原始行、密码或完整订单链接。每项 issue 为 `{ field, code, message }`，冲突敏感值只在 content 端点提供。

`status` 与暂停原因分开，避免把业务暂停误当入库成功：

| 字段值                                              | 含义与状态变化                                               |
| --------------------------------------------------- | ------------------------------------------------------------ |
| received → parsing → ready → processing → succeeded | 正常创建并提交订单                                           |
| processing → duplicate                              | 同单已存在且已按确认策略处理，关联已有订单                   |
| retry_wait                                          | 临时错误，按退避调度；上限 3 次后进入 manual_review          |
| manual_review                                       | 永久格式错误、字段冲突或重试用尽；修正／重解析后可返回 ready |
| closed                                              | 管理员有理由关闭，仅关闭来源记录，不删除订单                 |

`eligibility` 取 allowed/source_disabled/device_disabled/out_of_range/merge_policy_pending；来源／设备停用不把 status 改成终态、不增加失败次数。入库端点遇到暂停返回对应 409，数据继续保留。已确定的来源范围资格持久化，跨午夜按 [AOS 方案](../planning/AOS文件入库与数据源切换方案.md)中定义的恢复规则处理。`succeeded`、`duplicate`、`closed` 为终态，重复幂等请求可读回结果，新操作不得隐式重开。

人工 `link_existing` 必须检查订单号与目标订单一致，只关联来源记录，不能跨单绑定或覆盖订单；同样要求当前来源和设备可处理。`close` 只关闭来源记录，在来源停用时仍可执行，不构成订单写入例外。修正草稿和重解析在停用时可用，最终 ingest 被来源开关阻止。

`data` 为完整替换草稿，字段如下；原文件第 8、9 列不进入业务草稿。`passwordAction` 为 keep/replace，默认 keep；replace 时 password 必填且最多 1024 字符，仅更新加密来源草稿，接口不回显密码。首版不提供清空密码动作。

| 草稿字段              | 类型与校验                                                                                                                 |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| orderNumber           | string，`W` 加 10 位数字                                                                                                   |
| contactEmail、appleId | string，必填，最多 255 字符，邮箱格式校验                                                                                  |
| lastName、firstName   | string，分别必填、最多 50 字符，保留文件显式拆分                                                                           |
| contactPhone          | string，必填，11 位中国大陆手机号；原样字符串存储                                                                          |
| recipientIdLast4      | string 或 null，前三位数字、末位数字或 `X`，统一大写；16 列文件取值，历史 15 列为空，只在敏感内容接口返回                  |
| pickupStoreCode       | string，必填，`R` 加数字、最多 50 字符；未知字典值可用                                                                     |
| products              | 1–50 项，每项 `{ model, name, quantity }`，model 最多 50、name 最多 300 字符，quantity 为 1–999 整数                       |
| paymentMethod         | string，必填、最多 50 字符，按统一支付方式校验；未识别值进入人工核对                                                       |
| recipientTag          | string 或 null，最多 500 字符，完整保存                                                                                    |
| orderUrl              | string，最多 2048 字符，必须为 HTTPS Apple 中国 vieworder 路径，订单号和联系邮箱一致，拒绝凭证、非标准端口、额外查询与片段 |
| orderDate             | string，ISO 8601 含时区，保留毫秒，不接受仅日期                                                                            |

已存在订单的字段策略仍待确认。本草案不启用自动覆盖；如果最终批准补空或 AOS 优先，须明确字段白名单、人工锁定和对应 outcome（例如 enriched），再更新此契约。不能在实现时自行把 duplicate 当成覆盖成功。

### AOS 5 采集器连接、心跳与批量接收

| 方法与路径                                  | 请求                                 | 返回及用途                                                                                                   |
| ------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `GET /api/aos-collector/v1/context`         | 设备凭证；不接受任意 deviceId        | 当前设备、协议版本、服务器时间、全局来源只读值、业务日期、待执行当天扫描指令及容量限制；配置窗口测试连接复用 |
| `POST /api/aos-collector/v1/heartbeat`      | `HeartbeatRequest`                   | `{ serverTime, settingsVersion, activeSource, pendingScanRequests }`；仅更新设备状态和扫描完成回执           |
| `POST /api/aos-collector/v1/records`        | `RecordBatchRequest`                 | 200 `{ results[] }`，逐条可靠接收回执；不以 HTTP 200 代表全部行成功或订单已创建                              |
| `POST /api/aos-collector/v1/records/status` | `{ eventIds: [...] }`，1–100 个 UUID | 本设备对应记录的最小处理状态；未知 ID 返回 not_found，不泄露其他设备记录                                     |

`context` 返回：`device: { id, name, enabled, credentialVersion }`、`protocolVersion: 1`、`serverTime`、`settingsVersion`、`activeSource`、`businessDate`、`backfillPolicy: current_day`、`limits: { maxBatchRecords: 100, maxRequestBytes: 1048576, maxRawLineBytes: 16384, heartbeatIntervalSeconds: 15 }`、`pendingScanRequests[]`。设备身份仅由凭证解析，客户端不能通过请求体替换。

`pendingScanRequests[]` 每项为 `{ id, backfillId, businessDate, from, toExclusive, settingsVersion }`，不含文件路径或任意执行命令。设备按本地配置目录扫描指定的当天范围，重传和重启保持扫描 ID。旧来源切换后指令可标为 superseded，设备停止该补录任务但保留可靠队列。

`HeartbeatRequest`：`heartbeatId`（UUID，用于重复心跳忽略）、`agentVersion`、`osVersion`、`observedAt`、`lastSuccessfulScanAt`、`lastNewOrderAt`、`directories[]`、`localCounts`、`scanResults[]`。前三个时间字段含时区且允许后两项 null，服务端到达时间才是在线判断依据；扫描结果每项为 `{ scanRequestId, status, discoveredCount, receiptedCount, pendingUploadCount, errorCode }`，status 为 running/completed/failed/superseded。计数不能为负，completed 要求该次发现的记录全部已获可靠接收回执，坏行也需收到人工处理记录回执。无变更心跳不产生重复业务审计。

`RecordBatchRequest`：

```json
{
  "schemaVersion": 1,
  "records": [
    {
      "eventId": "a45c27ca-a641-4101-a50c-bcb8a0cd8276",
      "directoryId": "1e22e695-c97d-4db0-a18f-dd4d9ee834c3",
      "fileInstanceId": "be2224f8-f33d-416d-8213-46a247743ef0",
      "fileName": "AOS订单记录-0910(example).txt",
      "lineNumber": 1,
      "observedAt": "2026-09-10T02:00:00.000Z",
      "scanRequestId": null,
      "rawLine": "<完整原始行，至少 15 列以制表符分隔；此占位值不可直接提交>"
    }
  ]
}
```

`records` 1–100 项、整个 JSON UTF-8 请求最多 1 MiB；`rawLine` 必填、UTF-8 最多 16 KiB，不含行终止 CR/LF，也不剥离字段中的制表符。`fileName` 只允许文件基名、最多 255 字符，拒绝路径分隔和目录穿越；`lineNumber` 为大于 0 的安全整数，仅用于追溯；`observedAt` 为设备观察时间，不作下单时间和数据权威顺序。

客户端转换编码、识别稳定行，服务端独立解析 rawLine 并校验最低 15 列、商品、字段和 Apple 链接。第 16 列按身份证后四位校验；第 17 列及之后作为未知尾部扩展保留在加密原文中，不阻断已知字段，也不自动映射。不要同时传可互相矛盾的客户端结构化订单作为事实来源。稳定但格式错误的行也可可靠接收后进入 manual_review；不完整尾行继续留在本机等待。

事件首次进入本地队列时生成并持久化 eventId，此后重试保持 eventId 和载荷不变。服务器以 `(deviceId, eventId)` 唯一并重算载荷摘要；同键同载荷回放，同键异载荷拒绝。文件重新创建使用新 fileInstanceId；同单同内容跨文件重现仍由内容识别及订单唯一约束防重。凭证轮换不改变设备 ID 和既有事件 ID。

逐条返回结构：

```json
{
  "success": true,
  "data": {
    "results": [
      {
        "eventId": "a45c27ca-a641-4101-a50c-bcb8a0cd8276",
        "receiptStatus": "accepted",
        "recordId": "33d4a0f9-82a5-407e-9d9c-f01b646404fc",
        "processingStatus": "received",
        "eligibility": "source_disabled",
        "errorCode": null,
        "retryable": false
      }
    ]
  }
}
```

- `receiptStatus` 为 accepted/already_received/rejected；前两者只有持久化提交后返回，客户端才可结束该条上传并保留最小回执。accepted 包括暂未解析、待人工处理和来源停用的记录。
- rejected 必须含稳定 errorCode 和 retryable，recordId 可以 null；不能计为已接收。可重试项原样保留；永久拒绝项转本机错误队列并可诊断，不无限重发或静默丢弃。
- 批内相同 eventId 重复直接在请求校验阶段拒绝整批；不同事件逐条独立提交。批次中途断连时，未获明确回执的条目均用原 eventId 重试。
- 整批 JSON、认证、协议版本或大小不合法时用 HTTP 错误；数据库不可用或服务中断可返回 503。即使部分条目已经提交也不得撤销已持久化成功回执，客户端仍依赖逐条幂等恢复。
- `records/status` 返回 `{ items: [{ eventId, recordId, processingStatus, eligibility, outcome, errorCode, updatedAt }] }`，不返回密码、原始行、联系人、完整订单链接或其他设备的数据。
- 全局来源为邮件时仍可 accepted，eligibility 为 source_disabled；设备禁用或凭证失效则拒绝接收。两者不可混为同一种“暂停”。

### AOS 6 订单来源展示、门店查询与页面交互

- 订单列表／详情 DTO 增加 `ingestion_source`（email/aos/unknown），只表示创建来源，不返回设备令牌、原文或敏感快照；查询可增加同名筛选参数，原有字段和权限不变。
- `GET /api/order-ingestion/orders/:orderId/sources`（read）返回分页来源引用 `{ id, source, receivedAt, result, aosRecordId, emailLogId }`，仅管理员可进入。无关联历史数据返回空列表，不能根据当前全局来源伪造历史。
- `GET /api/order-ingestion/stores`（read）支持 code（精确）、keyword、page、limit；返回 `{ code, name, city, verifiedAt, sourceUrl }`。首版字典随经过核对的数据交付，不新增网页自动抓取或编辑接口；未知代码由订单原值展示。
- 页面初次请求 settings、设备／记录列表；可见页面建议每 5 秒刷新概况，切回页面立即刷新。补录详情和单条处理中记录可每 2 秒查询，离开页面停止轮询；超时或错误保留上次结果并显示更新时间。
- UI 依据服务端 eligibility 禁用入库按钮并展示原因，后端仍必须再次检查。保存草稿与执行入库分成两个操作；终态显示结果和订单跳转入口。
- Windows 端通过 context／heartbeat 只读显示来源；不提供调用 settings 写接口的入口或凭证。

### AOS 7 稳定错误码与恢复行为

| HTTP／逐条结果        | error.code / errorCode                                                                                                 | 客户端处理                                                         |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 400                   | VALIDATION_ERROR、UNSUPPORTED_SCHEMA_VERSION                                                                           | 展示字段错误；结构版本不支持时暂停相关上传并提示升级               |
| 401                   | DEVICE_UNAUTHORIZED                                                                                                    | 停止网络重试，提示重新配置凭证；保留队列                           |
| 403                   | FORBIDDEN、DEVICE_DISABLED                                                                                             | 不自动重试业务写入；保留队列；设备恢复后允许人工测试连接恢复       |
| 404                   | NOT_FOUND                                                                                                              | 刷新列表；跨设备 ID 查询也不泄露对象存在性                         |
| 409                   | VERSION_CONFLICT、PREVIEW_EXPIRED                                                                                      | 重新获取配置／记录或预览，由用户确认重提；不自动覆盖               |
| 409                   | IDEMPOTENCY_CONFLICT、EVENT_PAYLOAD_CONFLICT                                                                           | 不复用旧键发送新内容；事件冲突转本机异常处理                       |
| 409                   | SOURCE_DISABLED、RECORD_OUT_OF_RANGE、DUPLICATE_POLICY_PENDING、RECORD_STATE_INVALID                                   | 展示业务暂停原因；修正／切换后重新检查，不能无限重试               |
| 413                   | PAYLOAD_TOO_LARGE                                                                                                      | 批量过大则拆批，单行过大留本机异常队列                             |
| 429                   | RATE_LIMITED                                                                                                           | 按 Retry-After 等待，加抖动重试；不能丢弃事件                      |
| 503／网络超时         | TEMPORARILY_UNAVAILABLE                                                                                                | 指数退避，建议 1 秒起、最大 60 秒；保持原幂等键／事件 ID           |
| accepted 后的处理错误 | AOS_COLUMN_COUNT_INVALID、AOS_PRODUCT_INVALID、AOS_ORDER_DATE_INVALID、AOS_ORDER_IDENTITY_MISMATCH、AOS_FIELD_CONFLICT | 服务器持久化 manual_review，由管理后台处理，Windows 不重复上传同条 |

限流初始建议每设备每分钟 120 次请求、其中 records 每分钟 60 次；独立于 Apple 官网爬虫限流。具体参数可按实测调节，但 429 和 Retry-After 契约保持一致。

### AOS 8 联调验收要求

接口实施前固定合成请求／响应样例与字段 Schema；至少覆盖：管理员／普通员工／设备三类凭证隔离、设备跨设备查询、凭证轮换响应丢失、乐观锁与幂等重放、批内部分持久化后断连、混合有效坏行、来源停用仍可接收但不能入库、跨午夜预览失效、设备离线补录不显示完成、人工草稿不回显密码和错误不泄露原始行。

前后端按上述 DTO 和状态语义联调，Windows 文件写入与可靠传输另外在真实目标系统验收。管理与设备路由已经挂载；权限隔离、批量回执和事务规则已在隔离数据库验证。真实 Windows 与真实抢购软件验收另记。

### AOS 实现补充

- `context`、`heartbeat` 返回 `capturePermitId`（可空）、`serverCounts` 和 `countsBusinessDate`。设备在 AOS 启用当天取得服务端持久化许可，将它与不可变事件一起写入本地队列；离线跨日首次上传必须匹配设备和行内下单日。记录已取得的资格不因切换或午夜清除，当前来源和设备启用仍在最终入库事务检查。
- `POST /api/aos-collector/v1/records/status` 接受 `{ eventIds, scanRequestId? }`。提供扫描 ID 时只允许把当前设备已可靠接收的事件关联到该扫描；不存在的事件或跨设备扫描返回 400。采集器先分批确认扫描关联，再上报 completed；服务器要求关联条数与 receiptedCount 相同。旧本地回执参与新扫描时也执行该关联，不改原事件。
- `serverCounts.todayReceived` 按北京时间接收日统计；created、duplicate 为累计结果，manualReview、paused 为当前积压。客户端上次同步时间与当前本地扫描时间分别展示。
- 订单 DTO 另含 `recipient_profile_tag`、`recipient_linked`、`source_recipient_tag`、`recipient_tag_conflict`；详情增加 `pickup_store_code`，未知门店可展示原代码。订单列表来源筛选首版暂未增加；AOS 记录支持按设备、状态、资格、订单号及下单／接收日期筛选。
- 邮件补录按实际扫描绑定的记录统计，不以 IMAP 完成替代订单处理完成。
- 每个 API 实例按设备限流 120 请求/分钟，records 另限 60 次/分钟，429 提供 Retry-After；多副本部署时各实例限额独立。

实施与客户端操作见 [AOS 文件采集与入库](AOS文件采集与入库.md)。

### H5 批量处理调用说明（2026-09-11）

本人付款任务的批量修改处理状态复用现有单项更新接口，由前端逐单提交 `processingStatus`、`expectedVersion` 与独立 `idempotencyKey`；填写统一备注时另传 `processingNotes`，为空时省略以保留原备注。权限、归属、状态流转、备注、版本和审计沿用单项契约。各单独立事务，前端汇总部分成功和逐项失败；不新增批量端点，不修改官网付款状态，不自动重试不确定结果。

### 全局待付款概览（2026-09-12）

`GET /api/payment-dispatch/pending-overview`：管理员及 `payment_dispatch.read` 权限，返回 `data: { total, unassignedCount, assignedCount, staff: [{ userId, username, nickname, count }], generatedAt }`。仅统计订单官网状态 `payment_due`，显式排除 `paymentStatus=paid/refunded`。不受列表筛选、分页、调度启用时间和人工处理状态影响；没有付款任务或任务无负责人均计未分配。按账号 ID 聚合，包含零单账号及仍有任务的停用／已删除账号；昵称缺失回退登录账号。只读数据库快照，不触发官网刷新。

## 调度复制与 TAG 专属分配（2026-09-13）

- `GET /api/payment-dispatch/tasks/:id/payment-link`：管理员及 `payment_dispatch.read`；id 必须为正整数。读取任意现有付款任务的订单 orderUrl，不限制处理状态、负责人和付款时限；不存在任务或链接返回 404。返回 `{ success: true, data: { paymentUrl, serverTime, deadlineAt } }`，记录 payment_link_accessed 事件但不记录链接正文，不访问官网。普通账号仍只能用本人任务链接接口。
- `GET /api/payment-dispatch/overview` 的 staff 增加 `assignmentMode: tag_only | general` 和 `tagRules: [{ id, name }]`，由启用规则实时派生。tag_only 账号从未命中规则订单的自动候选集合排除；等待原因与实际分配使用同一范围。已有负责人及手动分配不变。
- 刷新 job 的 trigger 新增 initial（首次入库），保留历史 auto/page_open；新周期任务停止，历史周期任务执行前跳过。首次及人工刷新后无下一次自动刷新。API 的手动刷新提交和进度查询契约保持不变。

## 付款页面官网状态多选（2026-09-13）

`GET /api/payment-dispatch/tasks` 与 `GET /api/payment-tasks` 支持 `officialOrderStatuses`，值为官网订单状态代码的 JSON 数组（也接受查询数组）；不传或空数组不限制官网状态。仅允许现有 ORDER_STATUSES 枚举，最多 12 项，去重后使用 OR 匹配 orders.status，非法格式／值返回 400。保留 pending（待处理）与 unknown（原样显示），拒绝订单 completed；读取的非法存量状态统一为 unknown，筛选 unknown 同时包含这些存量值。订单管理采用同一口径。兼容旧单值 officialOrderStatus；同时传入时以 officialOrderStatuses 为准。同组 OR，与 TAG、商品、负责人和人工状态条件 AND，在数据库分页和统计前应用；TAG 候选同时受官网状态限制。本人任务始终只查询本人归属；processingStatus 不传或为空时不限制人工状态，包含已完成与异常。传入时按 pending／processing／completed／exception 精确匹配，非法值返回 400；两页 UI 提供全部、待处理、处理中、已完成、异常五个筛选选项。

三张页面统一展示“官网状态”，付款两页只以 officialOrderStatus 作为状态文案与颜色依据，不再展示“官网付款状态”列。paymentStatus 及其 DTO 派生字段保留供内部付款资格与倒计时使用。人工 processingStatus 仍为 pending/processing/completed/exception，状态变更与 processingNotes 是否填写或保存无关；可空备注独立修改，权限、版本、幂等、合法状态流转与审计规则保持。

管理员重开任务的 reason 改为选填、最长 500 字，仅保存在重开事件中，不再覆盖 processingNotes。公共订单入库统一初始化 pending，同事务登记 initial 官网刷新任务；来源或人工草稿中的 orderStatus 不作为已确认官网状态。

## 订单与付款下单日期范围（2026-09-13）

订单列表／导出、渠道订单列表／订单统计、付款调度和本人付款任务统一支持 dateFrom/dateTo（兼容 date_from/date_to）。日期 YYYY-MM-DD 按北京时间完整日边界，起日 00:00:00.000 至止日 23:59:59.999；兼容已有精确 ISO 时间参数。允许仅起日或止日，不传不限制；非法日期、起日晚于止日返回 400。以来源下单时间 orders.order_date 为依据，缺失时间的订单在指定日期范围时不命中，不用入库时间补造。与其他筛选条件 AND，分页、总数及付款 TAG 候选均在过滤后计算；订单导出带相同条件。渠道订单统计受日期范围影响，取机人总数仍为渠道关联数量；本人权限范围保持。

## AOS 付款码与 Windows 更新扩展（2026-09-13，实施中）

- `POST /api/aos-collector/v1/payment-codes`：设备认证；`{records:[{eventId,orderNumber,orderDate,sourceTime,contactEmail,appleId,paymentMethod,imageDataUrl}]}`，每批 20 条、PNG 每张最多 128 KiB、整个请求最多 1 MiB。独立不可变事件回执，重复事件不同载荷 409；只接收微信 PNG。设备启用、当前来源为 AOS 才处理；无目标订单返回可重试等待，不因缺码阻断订单入库。已有订单允许历史补码，订单号、来源账号／联系邮箱及日期须一致。成功回执才结束本地上传。
- `GET /api/payment-tasks/:id/payment-code`：沿用本人付款链接权限及当前任务归属；`GET /api/payment-dispatch/tasks/:id/payment-code`：沿用管理员付款调度读取权限。均返回 `{success:true,data:{availability,message,orderId,orderNumber,products,amount,paymentMethod,officialOrderStatus,officialPaymentStatus,deadlineAt,imageDataUrl,sourceTime}}`；支付宝只返回 availability=unsupported 与“支付宝暂无法获取付款码”，不返回图片或链接。微信缺码为 missing，已付款／取消／过期仍可查看。读码审计、no-store，不访问官网或改变付款状态。
- `GET /api/order-ingestion/collector-releases`：管理员设备管理权限，列出已验签发布版本；`GET /api/order-ingestion/collector-updates` 列出最近更新任务；`POST /api/order-ingestion/collector-updates`：`{deviceIds,releaseVersion}`，限定最多 20 台已启用设备；重复同一进行中目标复用任务，不同目标冲突。
- `GET /api/aos-collector/v1/update`：领取自身更新任务和签名 manifest；`GET /api/aos-collector/v1/update/:id/package`：仅自身非终态任务的已验签固定制品；`POST /api/aos-collector/v1/update/:id/status`：`{status,agentVersion,errorCode}`，稳定状态码，终态幂等且禁止倒退。
- manifest 使用 `{payload,signature}`，两值为 Base64；原始 UTF-8 payload 为 `{product:'AppleOrderMgrAosCollector',version,platform:'win-x64',sha256,size,queueSchema:1}`，RSA-SHA256 PKCS#1 v1.5 校验精确字节。配置 `COLLECTOR_RELEASE_DIR` 与 `COLLECTOR_UPDATE_PUBLIC_KEY_FILE`；未配置时更新发布不可用，既有采集继续。
- 首次管理员执行新安装包非交互入口，安装受保护的独立更新副本和固定计划任务；后续设备仅出站 HTTPS 获取固定签名制品。旧采集器 v1 context 与 records 保持兼容，不向旧版返回更高 protocolVersion。

## 服务器监控契约（2026-09-15）

通知设置响应增加 `updatedAt`（ISO时间），用于显示服务端已保存状态。保存 `enabled=false` 时事务内将 pending/sending 投递标记 skipped；仅 `sendRecovery=false` 时只取消 recovery 类型。重启用不恢复旧队列；已进入SMTP的邮件无法撤回，最终发送结果仍如实记录。

`overview` 继续包含已移除实例（`active=false`、`state=removed`），供网站显式查看历史；默认列表、规则同步统计排除它们。已移除实例的历史接口保持可读，提交处理动作返回409（`MONITOR_INSTANCE_REMOVED`）。规则保存时禁止新增已移除实例范围（400），更新规则允许保留原有旧范围，避免无意扩大为全部实例。

网站 `/api/server-monitor` 全部要求登录和唯一权限 `monitor.manage`，不要求 admin／ingestion 权限。GET `/overview` 返回安全设备、实例与规则；GET `/traffic?from=YYYY-MM-DD&to=YYYY-MM-DD&deviceIds=UUID,UUID` 查询最多 90 个北京时间日，返回按设备、日、小时聚合、收发与采集器正文流量及覆盖秒数；GET `/instances/:id/history?page=1` 返回分页告警及动作。POST `/rules` 新建，PUT `/rules/:id` 更新（expectedVersion 乐观锁），POST `/rules/test` 试匹配（rule、text，不持久化输入）；POST `/instances/:id/actions` 接受 expectedVersion、action=start/ignore/extend/end/complete/note、minutes=15/30/60/120（默认30）、note（最多500字符）。规则包含 name、enabled、mode=any/all、keywords/excludes 字符串数组、windowMinutes=1..60、threshold=1..100000、severity=info/warning/critical、deviceIds/directoryIds UUID 数组；空范围为全部。规则正文放在 config 属性。

设备独立认证协议新增 GET `/api/aos-collector/v1/monitor/context` 返回 revision 与规则；POST `/monitor/reports` 一批最多 10 份报告，每份包含 id、revision、startedAt、endedAt、traffic（receivedBytes/sentBytes/collectorReceivedBytes/collectorSentBytes/quality）、instances（localId、label、state、files、results：ruleId/count/samples）。字节非负安全整数，quality=complete/gap/unavailable，状态 ready/missing/unreadable/invalid/catching_up；samples 包含 at、file、keywords、lineNumber、message、truncated，每规则最多 3 条，message 为用户确认的未经脱敏原始日志行、最多 4,000 字符。报告有独立 UUID，事务幂等，同 ID 不同载荷409。每设备最多20实例／100规则，请求体仍1MiB。旧采集器无需上传新字段；未知新端点不能阻断原订单采集。监控不受邮件／AOS来源切换影响，但仍受设备启停和身份认证约束。

`GET /api/server-monitor/overview` 同时返回 `notificationSettings`，只含网站通知设置版本、启停、收件地址、恢复通知开关和 SMTP 是否就绪／是否复用订单邮箱，不返回授权码。`PUT /api/server-monitor/notifications/settings` 使用 `expectedVersion` 更新 `enabled`、`recipients`（最多20个标准邮箱）和 `sendRecovery`；启用时至少一个收件人且 SMTP 必须就绪。`POST /api/server-monitor/notifications/test` 创建异步测试邮件；`GET /api/server-monitor/notifications/history?page=1` 返回每页30条投递记录。全部沿用唯一 `monitor.manage` 权限及 `no-store`。
