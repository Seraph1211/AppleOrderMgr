# API 契约与接口导航

> 状态：当前有效
>
> 最近核对：2026-09-07
>
> 基线：main@d000d03 与当前工作树
>
> 验证范围：本地工作树静态核对；未验证真实数据库、邮箱、官网和生产环境

## 通用约束

### 浏览器辅助刷新（2026-09-21 API 已发布）

新增端点均沿用登录会话认证并仅允许管理员及 `orders.refresh` 权限，默认由 `BROWSER_ORDER_REFRESH_ENABLED=false` 关闭；生产 `20260921-browser-query-fix` 延续仅对 API 配置为 true，原全局暂停保持。浏览器扩展只读取自己创建的指定订单标签页；登录令牌留在管理台，不发送给扩展。

| 端点                                          | 请求与响应                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/orders/:id/browser-refresh/start`  | 空请求体或 `{ mode: "isolated_batch" }`；返回 `ticket`、`orderUrl`、`orderNumber`、`expiresAt`、`maxRequests=100`、`maxDurationMs`、`refreshScope=status_products_lifecycle`（已随 `20260921-local-lifecycle-batch-r2` 发布）。新执行器在采集前校验 scope，拒绝旧版仅同步商品／阶段的接口。默认 90 秒采集／120 秒任务票据；隔离批量模式 300 秒采集／330 秒票据。票据绑定账号、当前登录会话、订单号、链接摘要和数据库版本，采用与登录 JWT 分离的签名密钥用途。 |
| `POST /api/orders/:id/browser-refresh/permit` | `{ ticket }`；复核权限、有效期、订单版本及全局暂停状态，取得 PostgreSQL 全局请求时隙后返回 `allowed=true`。每个官网请求和重定向须先取得许可；此端点不代替浏览器任务的 100 请求上限。                                                                                                                                                                                                                                                                          |
| `POST /api/orders/:id/browser-refresh/result` | `{ ticket, page: { pageUrl, orderJson } }`；只接收扩展或本机隔离执行器提取的业务字段白名单，`pageUrl` 的访客令牌段须脱敏为 `redacted`，不接受 Cookie、令牌、原始 HTML 或客户端已归一化的业务状态。服务端解析、校验并调用既有短事务更新，返回更新摘要。                                                                                                                                                                                                        |

2026-09-21 用户收窄浏览器刷新范围：只采集订单号、逐商品官网阶段与状态说明、商品名称／型号规格／明确数量。订单号仅用于身份校验，不改写订单身份。官网观测金额、支付方式、日期、门店、地址和付款截止均不作为成功必填，也不通过本入口更新；商品变化引起的独立映射金额重算遵循下方金额契约。服务器仅合并状态、商品及对应观察／校验／审计元数据；按本次本机批量状态刷新需求，复用既有逐商品阶段映射同步 `paymentStatus` 与 `pickupStatus`；无法确定时保留旧值并标记待核对，取消或配送不推断付款。非商品校验问题和人工付款任务保持不变。此增量已随 `20260921-local-lifecycle-batch-r2` 发布生产，真实官网批次待验收。状态变化仍参与既有自动刷新停止判断。商品不完整时保留已有商品并提示待核对；不会按条目数猜测数量。此为当前实现契约，生产版本与真实验收状态见开发进度。

票据不是登录凭据；跨账号／会话／订单使用或过期返回 409 `BROWSER_TICKET_INVALID`；订单版本／链接变化或已消费后的再次提交返回 409 `BROWSER_ORDER_CHANGED`。成功写入时在 CrawlLog 保存票据随机标识；事务行锁下再次比对初始版本并检查票据是否已消费，避免同一毫秒内的并发重放。任务开始不产生后台自动刷新任务，浏览器断开、失败或超时不提交成功结果；本机在线与浏览器权限是此辅助入口的前提。仍需完成真实采集、权限及生产端到端验收。

前缀为 /api。除登录和健康检查外均需认证；auth 下改密、登出、me 各自经过 authenticate，其余业务统一经过全局认证与有效会话校验。Bearer Token 不放入 URL。

角色字段继续保留 admin、operator、readOnly，但普通业务授权以数据库 `user_permissions` 为唯一来源。admin 通过受保护身份获得代码目录中的全部有效权限；operator/readOnly 仅作为存量标签，不再在请求时隐式叠加权限。所有业务路由显式声明权限，未登记入口默认拒绝。权限目录与依赖见[用户权限方案](../planning/用户权限分配与访问控制方案.md)。

字段目前混用 camelCase 和 snake_case，不能按惯例自动转换或增加别名。新契约修改需更新本页及对应专题文档，CON-01/CON-02 的完整统一尚未完成。

## 响应与错误

常规成功为 success/data；公共分页结构如下，列表键由端点决定（例如 apple_ids、recipients、orders、items）：

```json
{ "success": true, "data": { "total": 0, "page": 1, "limit": 20, "items": [] } }
```

## Apple 公开报价接口（2026-09-25）

公开接口在全局认证中间件之前挂载，管理接口仍要求登录管理员。所有接口使用统一 `{success,data}`／`{success:false,error}` 结构。

- `GET /api/public/apple-quotes`：无需登录，每 IP 每分钟最多 120 次，且不写入内部操作日志。公开开关关闭返回 503 `QUOTE_PAGE_PAUSED`；来源不可用或无完整批次返回 503 `QUOTE_SOURCE_UNAVAILABLE`。成功仅返回 `enabled`、`updatedAt`、`stale`、筛选候选及 `items[{productKey,productName,productModel,storageGb,color,quotePrice,officialPrice}]`，不返回明威价、调价字段、规格码、来源地址或操作人。
- `GET /api/public/iphone18-quotes`：历史兼容别名，返回内容与 `/api/public/apple-quotes` 相同；新客户端不得继续使用该地址。
- `GET /api/quote-pricing/iphone18`：仅管理员。返回公开设置版本、来源批次、完整商品列表及每项明威价、官网价、百分比、固定金额和最终报价。
- `PUT /api/quote-pricing/iphone18/availability`：仅管理员；请求 `{enabled:boolean,expectedVersion:integer}`，切换固定公开链接，不改调价规则。
- `PUT /api/quote-pricing/iphone18/display-order`：仅管理员；请求 `{productKeys:string[1..1000],expectedVersion:integer}`，`productKeys` 必须恰好包含当前全部商品且不得重复。保存后公开页和报价复制立即同序；商品来源变化返回 `QUOTE_PRODUCTS_CHANGED`（409），设置版本冲突返回 `CONCURRENT_MODIFICATION`（409）。
- `PUT /api/quote-pricing/iphone18/adjustments`：仅管理员；请求 `{productKeys:string[1..100],percentage:number,fixedAmount:number,expectedVersion:integer}`。百分比 -100 至 1000，固定金额 -100000 至 100000；选中商品必须存在于最新完整批次，重复保存覆盖原调整值。
- `POST /api/quote-pricing/iphone18/adjustments/reset`：仅管理员；请求 `{productKeys:string[1..100],expectedVersion:integer}`，删除选中规则并生成新版本。
- `GET /api/quote-pricing/iphone18/versions?limit=20`：仅管理员；返回最近价格版本元数据，不直接返回完整快照。
- `POST /api/quote-pricing/iphone18/versions/:id/restore`：仅管理员；请求 `{expectedVersion:integer}`，恢复目标快照并生成新的恢复版本。

最终报价固定为 `round(basePrice × (1 + percentage / 100) + fixedAmount)`。服务端重新计算且拒绝负值；不接收客户端提交最终价格或明威价格。

公共错误处理中间件返回 success=false 和 error.code/message/details，并通过 X-Request-Id 关联日志。部分认证、仪表板及模板错误仍返回顶层 message 或字符串 error，客户端必须兼容，不能把公共格式当成全量端点已经统一。

文件下载返回 Excel/Blob，不按 JSON 解析。401 为认证失败、403 为权限或账号限制、409 可表示冲突或不支持的跨进程恢复；其余状态按各控制器处理。

## 已挂载接口

AOS 设备协议挂载于 `/api/aos-collector/v1`，管理员来源管理挂载于 `/api/order-ingestion`，详见本页 [AOS 契约](#aos-文件入库与数据源切换契约2026-09-10)。新增设备认证与员工 JWT 分离；本地实现已联调，生产尚未发布。

下表从当前路由核对，路由注释中的历史 Public 标记不覆盖全局认证。每个模块的详细字段与校验入口链接在表后。

| 方法   | 路径                                                | 权限要求                                                                               |
| ------ | --------------------------------------------------- | -------------------------------------------------------------------------------------- |
| GET    | /api/health/live                                    | 公开；进程存活                                                                         |
| GET    | /api/health/ready                                   | 公开；数据库检查，失败 503                                                             |
| GET    | /api/health                                         | 公开；307 到 ready                                                                     |
| POST   | /api/auth/login                                     | 公开；登录限流                                                                         |
| POST   | /api/auth/logout                                    | 有效登录会话；所有角色可用                                                             |
| POST   | /api/auth/change-password                           | 有效登录会话；所有角色可用                                                             |
| GET    | /api/auth/me                                        | 有效登录会话；所有角色可用                                                             |
| PATCH  | /api/auth/profile                                   | 已登录本人，无业务权限要求                                                             |
| POST   | /api/users/:id/reset-password                       | admin 且 users.manage                                                                  |
| GET    | /api/system/operation-logs                          | admin 且 system.logs.read                                                              |
| GET    | /api/users/permission-catalog                       | users.permissions.manage（admin 保留）                                                 |
| GET    | /api/users                                          | users.read（admin 保留）                                                               |
| POST   | /api/users                                          | users.manage（admin 保留）                                                             |
| PUT    | /api/users/:id                                      | users.manage（admin 保留）                                                             |
| DELETE | /api/users/:id                                      | users.manage（admin 保留）                                                             |
| PUT    | /api/users/:id/unlock                               | users.manage（admin 保留）                                                             |
| GET    | /api/users/:id/permissions                          | users.permissions.manage（admin 保留）                                                 |
| PUT    | /api/users/:id/permissions                          | users.permissions.manage（admin 保留）                                                 |
| GET    | /api/apple-ids                                      | apple_ids.read                                                                         |
| GET    | /api/apple-ids/:id                                  | apple_ids.read                                                                         |
| POST   | /api/apple-ids                                      | apple_ids.create                                                                       |
| PUT    | /api/apple-ids/:id                                  | apple_ids.edit                                                                         |
| DELETE | /api/apple-ids/:id                                  | apple_ids.delete                                                                       |
| GET    | /api/recipients                                     | recipients.read                                                                        |
| GET    | /api/recipients/filter-options                      | recipients.read                                                                        |
| GET    | /api/recipients/export                              | recipients.export                                                                      |
| GET    | /api/recipients/:id                                 | recipients.read                                                                        |
| POST   | /api/recipients                                     | recipients.create                                                                      |
| POST   | /api/recipients/batch-generate-contact              | recipients.generate_contact                                                            |
| POST   | /api/recipients/batch-generate-address              | recipients.generate_address                                                            |
| POST   | /api/recipients/bind-apple-ids                      | recipients.bind_apple_ids                                                              |
| PUT    | /api/recipients/:id                                 | recipients.edit                                                                        |
| DELETE | /api/recipients/:id                                 | recipients.delete                                                                      |
| GET    | /api/orders                                         | orders.read                                                                            |
| GET    | /api/orders/export                                  | orders.export                                                                          |
| GET    | /api/orders/filter-options                          | orders.read                                                                            |
| GET    | /api/orders/:id                                     | orders.read                                                                            |
| GET    | /api/orders/:id/link                                | orders.read + 订单数据范围                                                             |
| PUT    | /api/orders/:id                                     | orders.edit                                                                            |
| PUT    | /api/orders/:id/payer                               | orders.read + orders.payer.edit                                                        |
| POST   | /api/orders/:id/refresh                             | orders.refresh                                                                         |
| POST   | /api/orders/batch-refresh                           | orders.refresh                                                                         |
| POST   | /api/orders/refresh-all                             | orders.refresh                                                                         |
| POST   | /api/orders/page-open-refresh                       | orders.refresh                                                                         |
| GET    | /api/order-refresh/jobs/:id                         | orders.refresh                                                                         |
| GET    | /api/order-refresh/batches/:id                      | orders.refresh                                                                         |
| GET    | /api/email-processing                               | email.read                                                                             |
| GET    | /api/email-processing/metrics                       | email.read                                                                             |
| POST   | /api/email-processing/batch-reparse                 | email.process                                                                          |
| GET    | /api/email-processing/:id                           | email.content.read                                                                     |
| POST   | /api/email-processing/:id/reparse                   | email.process                                                                          |
| PUT    | /api/email-processing/:id/draft                     | email.process                                                                          |
| POST   | /api/email-processing/:id/ingest                    | email.process                                                                          |
| POST   | /api/email-processing/:id/resolve                   | email.process                                                                          |
| GET    | /api/stats/overview                                 | stats.read                                                                             |
| GET    | /api/stats/apple-ids                                | stats.read                                                                             |
| GET    | /api/stats/recipients                               | stats.read                                                                             |
| GET    | /api/stats/products                                 | stats.read                                                                             |
| POST   | /api/import/preview                                 | type 对应模块 import                                                                   |
| POST   | /api/import/execute                                 | type 与预览会话对应的 import                                                           |
| GET    | /api/import/template/:type                          | type 对应模块 template.read                                                            |
| GET    | /api/dashboard/*                                    | dashboard.read                                                                         |
| GET    | /api/channels                                       | channels.read                                                                          |
| GET    | /api/channels/:tag/stats                            | channels.read                                                                          |
| GET    | /api/channels/:tag/orders                           | channels.read                                                                          |
| PUT    | /api/channels/:tag                                  | channels.rename                                                                        |
| GET    | /api/system/logs                                    | admin + system.logs.read                                                               |
| GET    | /api/system/auto-refresh                            | admin + system.refresh.read                                                            |
| POST   | /api/system/auto-refresh/resume                     | admin + system.refresh.manage                                                          |
| GET    | /api/system/proxy-provider                          | admin + system.proxy.read                                                              |
| POST   | /api/system/proxy-provider                          | admin + system.proxy.manage                                                            |
| GET    | /api/payment-tasks                                  | payment_tasks.read_own；仅本人范围                                                     |
| GET    | /api/payment-tasks/:id                              | payment_tasks.read_own＋当前归属                                                       |
| PUT    | /api/payment-tasks/:id                              | payment_tasks.handle_own 和／或 payment_tasks.payer.edit_own＋当前归属；按实际字段检查 |
| PUT    | /api/payment-tasks/:id/payer                        | payment_tasks.payer.edit_own＋当前归属                                                 |
| GET    | /api/payment-tasks/:id/payment-link                 | payment_tasks.link.read_own＋当前归属                                                  |
| GET    | /api/payment-tasks/:id/alipay-payment-link          | payment_tasks.link.read_own＋当前归属；仅支付宝订单                                    |
| POST   | /api/payment-tasks/:id/refresh                      | payment_tasks.refresh_own＋当前归属                                                    |
| GET    | /api/payment-tasks/:id/refresh/:jobId               | payment_tasks.refresh_own＋当前归属；仅关联订单任务                                    |
| GET    | /api/payment-dispatch/overview                      | payment_dispatch.read（admin 保留）                                                    |
| GET    | /api/payment-dispatch/tasks                         | payment_dispatch.read（admin 保留）                                                    |
| GET    | /api/payment-dispatch/tasks/:id/alipay-payment-link | payment_dispatch.read（admin 保留）；仅支付宝订单                                      |
| PUT    | /api/payment-dispatch/settings                      | payment_dispatch.configure（admin 保留）                                               |
| PUT    | /api/payment-dispatch/staff/:userId                 | payment_dispatch.configure（admin 保留）                                               |
| PUT    | /api/payment-dispatch/tasks/:id/assignee            | payment_dispatch.assign（admin 保留）                                                  |
| PUT    | /api/payment-dispatch/tasks/assignee                | payment_dispatch.assign（admin 保留）；原子批量分配／转派                              |
| PUT    | /api/payment-dispatch/tasks/:id/notes               | payment_dispatch.correct（admin 保留）；修改处理备注                                   |
| POST   | /api/payment-dispatch/tasks/:id/refresh             | payment_dispatch.assign（admin 保留）                                                  |
| POST   | /api/payment-dispatch/tasks/refresh                 | payment_dispatch.assign（admin 保留）；1–100 项批量刷新                                |
| POST   | /api/payment-dispatch/tasks/:id/reopen              | payment_dispatch.correct（admin 保留）                                                 |
| POST   | /api/payment-dispatch/scan                          | payment_dispatch.assign（admin 保留）                                                  |

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

- Apple ID 列表 query 为 page、limit、status、country、bound、keyword；前端筛选区使用 keyword、status、bound，不展示国家地区筛选。`keyword` 同时模糊搜索 Apple ID 和当前绑定取机人的完整姓名、姓或名；`bound` 仅接受 true／false。列表返回 `recipient_count` 和 `recipient_names`，当前绑定列直接展示姓名。新增接收 apple_id、password、notes、country、status、security_qa；更新不再接收或维护 is_modified。返回使用 snake_case。经 2026-09-17 用户确认，持有 `apple_ids.read` 的用户在所有环境均可通过列表和详情读取完整 `password`；普通请求不返回密保，详情 includeSecrets=true 另要求 secrets 权限。响应 `Cache-Control: no-store`，存储继续加密，日志不记录明文。
- 取机人列表 query 包含 page、limit、tags、channels、status、apple_id_ref、keyword；`tags` 和 `channels` 分别接受数组或兼容逗号分隔值，逐项精确匹配，各自维度内按 OR、跨维度按 AND 组合，并兼容旧单值 `tag`／`channel`。数组形式可保留值内部的逗号。`keyword` 只搜索姓名、当前 Apple ID、完整身份证号或身份证后四位；完整身份证走盲索引精确匹配，不对密文字段做模糊查询。`GET /recipients/filter-options` 返回数据库中非空原始 `tags` 与 `channels`。新增必须 lastName、firstName、idCardNumber；可选 `channel` 是最长 100 字符、去除首尾空白、空值保存为 null 的单值渠道标签，独立于 TAG、订单权限、付款分配及渠道管理；关联写入使用 appleIdRef。写入为 camelCase，不按列表字段直接回传。
- 经 2026-09-17 用户确认，持有 `recipients.read` 的用户在所有环境均可通过列表和详情读取完整 `id_card_number`、`phone`，响应 `Cache-Control: no-store`。详细地址在具有 `recipients.edit` 或 `recipients.export_sensitive` 权限时返回；仍兼容本地管理员敏感显示配置，其他请求返回 `street_address=null`。订单快照及导出权限不随此变更扩大。
- 下单手机号 `phone` 和真实联系电话 `realPhone` 非必填；新增／编辑支持省略、null、空字符串或纯空白，空值规范为 null；编辑时省略代表不修改，显式空值代表清空，非空须为合法大陆手机号。
- 联系方式/地址批量生成接收 recipient_ids；联系方式生成会覆盖选中记录已有的电话和邮箱，电话满足 `^1[3-9]\\d{9}$`，邮箱为“电话@vvv8.net”。前端在生成意图首次确认后，若选中记录已有对应数据，必须再次确认覆盖；取消二次确认不得调用生成接口。绑定 Apple ID 使用 recipientIds，保留现状差异，不能统一猜测。
- 取机人导出需要 export 权限；显式 includeSensitive=true 必须另有 recipients.export_sensitive 权限，否则 403。完整导出响应为 UTF-8 文本，只含逐条“信息导入模板”值，每条一行且无表头；该外部固定格式不增加渠道字段。页面只允许对已勾选记录请求完整文本，并在弹窗中展示及一键复制，不自动下载文件。默认脱敏 Excel 增加“渠道”列并处理公式注入，当前筛选导出沿用 `channels` 条件。

来源：[Apple ID 控制器](../../src/controllers/appleIdController.js)、[取机人控制器](../../src/controllers/recipientController.js)。

## 订单

- 列表和详情由不同序列化函数构建；详情中的 apple_id 是关联对象或 null，不能套用列表的字符串类型。
- `POST /api/orders/:id/refresh` 只提交或合并 `manual_single` 任务，返回 HTTP `202` 和 `jobId`；任务入队不代表官网已经更新。
- `POST /api/orders/refresh-all` 为所有具有合法订单链接的订单创建或复用全量批次，返回 HTTP `202` 和 `batchId`。运行中重复提交返回同一批次。
- `POST /api/orders/page-open-refresh` 保留参数校验和权限门禁，但返回空任务结果，不再触发官网请求。打开列表或详情只读取已有数据，已付款订单仅手动刷新。
- `POST /api/orders/batch-refresh` 接收 `orderIds/order_ids`（1–100 个正整数）或既有筛选字段，按 `orders.refresh` 权限异步提交，返回 HTTP `202`。显式 ID 去重后逐项返回 `{ orderId, jobId, created, reason }`，含不存在／无法提交项；汇总 `total/created/merged/missing`。订单页面只勾选当前页，翻页或筛选清空选择；重复任务复用队列，逐行跟踪执行状态，不把入队视为刷新成功。
- `GET /api/order-refresh/jobs/:id` 返回任务状态、错误分类和订单当前新鲜度；只能查询本人提交的任务，admin 可查询全部，系统自动任务允许所有已认证用户读取其非敏感状态。
- 刷新错误分类新增 PAGE_LOADING（加载／校验未完成）、REQUEST_TIMEOUT（请求超时）、RESPONSE_STREAM（响应中断）、REQUEST_CANCELLED（主动取消）、TASK_TIMEOUT（抓取总预算耗尽）；631 保留 HTTP_631，不假定返回方。lastErrorMessage 中“已尝试 N 次”表示实际顶层抓取次数，attemptCount 仍是队列领取次数。列表沿用 last_success_at／last_failure_at／活动 job 协调状态，后续成功应清除旧错误；本次不增加字段或改变权限。
- `GET /api/order-refresh/batches/:id` 返回批次六类计数和完成时间；只能查询本人批次，admin 可查询全部。
- 列表和详情新增 `refresh` 对象：`freshness_status`、`last_attempt_at`、`last_success_at`、`last_failure_at`、`last_error_code`、`last_error_message` 和当前活动 `job`。超过 90 秒没有成功结果的待付款/未知订单由服务端序列化为 `stale`。
- PUT /api/orders/:id 只允许 paymentScreenshot，不再接受 payerName。付款人必须经 `PUT /api/orders/:id/payer` 或本人任务入口更新，body 为 `{ payerName: string | null, expectedVersion, reason? }`，幂等键通过请求头传入。`payerName` 去除首尾空白后最长 100 个字符，空字符串按 null 清空；付款人不是系统账号，也不存在候选目录。
- 官网金额、支付与取货状态是独立字段。列表不返回 Apple 密码或原始订单链接；`GET /api/orders/:id` 仅在当前用户具有管理员保留权限 `orders.secrets.read` 时返回订单密码快照 `apple_password` 明文，否则为 `null`，并统一设置 `Cache-Control: no-store`。详情响应不直接携带原始订单链接，页面打开详情后另经 `GET /api/orders/:id/link` 按订单范围读取。身份证和地址保持脱敏；详情顶层 `recipient_email`、`recipient_phone` 表示订单入库时保存的下单联系方式，不使用之后变更的取机人档案覆盖，其中 `recipient_phone` 默认脱敏，仅在 `NODE_ENV=development`、`ALLOW_LOCAL_SENSITIVE_DISPLAY=true` 且当前用户为 admin 时返回完整值。
- 导出使用当前筛选条件，下载按 Blob 处理；订单金额改用已确认价格映射，无法完整映射时显示待确认，不回退官网金额。

## 邮件处理

邮件处理按逐用户权限授权，不再要求管理员角色；`operator`、`readOnly` 均可获授权，未认证或缺少对应权限的请求仍由后端拒绝。`email.read` 允许列表与指标；`email.content.read` 允许完整详情并依赖 `email.read`；`email.process` 允许重新解析、草稿、入库、批量操作和人工关闭，依赖前两项。普通用户不会自动获得权限，管理员仍拥有全部权限。页面按权限显示详情及处理入口，仅有完整内容查看权限时字段只读。

这三项权限覆盖全局收单邮件处理队列，不按订单 TAG 过滤；与按订单数据范围授权的 `order_mail.*` 独立，不扩大订单接口的数据范围。

- `GET /api/email-processing`：query 支持 `page`、`limit`、`status`、`error_code`、`order_number`、`date_from`、`date_to`。省略 status 时只返回 `manual_review`。列表按人工优先、接收时间倒序，返回完整邮件主题和 From，不做字段脱敏；来源过滤错误码包括 `SUBJECT_NOT_ALLOWED` 和 `SENDER_NOT_ALLOWED`，后者保留加密原文并进入人工处理。
- `GET /api/email-processing/metrics`：返回各状态计数、最近收信、最近成功、24 小时失败数，以及独立 Worker 的连接、30 秒心跳运行判断、连续失败和最近错误码。`worker` 新增 `lastScanStartedAt`、`lastScanSucceededAt`、`lastScanDurationMs`、`lastScanErrorCode`、`isScanHealthy`；只有进程运行、邮箱已连接、最近 90 秒有成功扫描且最近扫描无错误时 `isScanHealthy=true`，空值不代表正常。扫描时间与收信／订单成功时间独立。
- `GET /api/email-processing/:id`：返回解密后的完整 `raw_mime`、`parsed_data`、`manual_draft`、`final_data`、处理尝试和操作审计；读取完整详情本身写入 `view_full_detail` 审计。若草稿或解析结果中的订单号已存在，返回 `duplicate_order` 入口。
- `POST /api/email-processing/:id/reparse`：只允许 `manual_review/retry_wait`，使用当前解析器生成预览但不创建订单；返回预览、最新 version 和重复订单结果。
- `PUT /api/email-processing/:id/draft`：body 为 `{ draft, version }`，执行完整人工字段校验并加密保存。旧 version 返回 HTTP 409、错误码 `CONCURRENT_MODIFICATION`。
- `POST /api/email-processing/:id/ingest`：body 同草稿保存；在订单号 advisory lock 和邮件行锁下统一创建/关联订单、邮件终态和首次刷新任务。相同订单不覆盖，返回已有订单并把邮件置为 `superseded`。
- `POST /api/email-processing/batch-reparse`：body 为 `{ ids }`，1–50 个去重整数；只处理指定的可重解析记录，并为每个请求 ID 返回独立的成功、稳定错误码或 `NOT_FOUND`。
- `POST /api/email-processing/:id/resolve`：body 为 `{ resolutionType, reason, version, orderNumber? }`；`resolutionType` 仅允许 `ignored/existing_order`，原因必填且不超过 500 字，关联已有订单时必须提供确实存在的订单号。

获授权用户的人工草稿可包含 `appleId`、`applePassword`、`orderNumber`、`orderUrl`、`orderDate`、`orderStatus`、`paymentMethod`、`products[]`，以及 `recipient.name/idLast4/idCard/email/phone/address/tag`。查看密码、完整身份证号及系统内部状态要求 `email.content.read`，修正并保存要求 `email.process`；字段在 `email_logs` 草稿/最终数据及订单敏感快照中加密存储，不得进入运行日志或错误响应。Apple URL 仍只允许中国官网 `vieworder` 路径且必须与订单号一致。

## 付款任务与付款人姓名

- 新增付款接口沿用项目现有 JavaScript API 的 camelCase 请求／响应，不对既有 snake_case 订单 DTO 做隐式全局转换。普通用户的列表、详情、状态、付款人、链接和刷新入口均同时校验权限和最新 assigneeUserId；转派后原负责人立即失去访问。
- 本人任务列表支持 page、limit、orderNumber、productNames、recipientTags、processingStatus；`productNames` 是 JSON 数组，最多 100 项，每项去除首尾空格后按完整 `products[].name` 精确匹配且最长 500 字符，多个商品之间为 OR。筛选在分页前完成，与 TAG、订单号、状态和日期等其他维度之间为 AND。旧 `productModel`、`productKeyword` 继续兼容且与商品名称条件命中同一 products 元素。`recipientTags` 同样最多 100 项、每项最长 500 字符，多个 TAG 之间为 OR；兼容单值 `recipientTag`。AOS 订单使用来源 TAG，其他订单使用订单入库时保存的 `tag`。
- `PUT /api/payment-tasks/:id` 是行级原子保存接口，body 可包含 `{ processingStatus?, processingNotes?, expectedVersion?, payerName?, expectedPayerVersion? }`，幂等键通过请求头传入。接口只更新实际提交且发生变化的字段；任务字段要求 `payment_tasks.handle_own`，付款人字段要求 `payment_tasks.payer.edit_own`，同时修改时在同一事务提交或全部回滚。四态为 pending、processing、completed、exception；官网状态、复制链接、登记付款人、到期和转派不自动改变处理状态。状态变更与备注填写、保存无关，备注可空。兼容的独立付款人接口仍保留。
- 外部付款人姓名在四种状态、到期、官网已付／退款／取消后仍可维护。`PUT /api/payment-tasks/:id/payer` 使用 `{ payerName: string | null, expectedVersion, reason? }`；系统不提供付款人候选接口，不创建付款人账号或主数据。
- 单项和当前页勾选批量复制订单信息均通过既有链接接口逐单校验 `payment_tasks.link.read_own` 和当前任务归属，接口直接返回该任务关联订单的 `orders.orderUrl`；前端结合本人任务 DTO 生成 `orders.id || 商品信息 || 支付方式 || 付款截止时间 || 订单链接`，批量结果按当前列表顺序每单一行。商品名称优先、型号兜底，每项按 `名称 x 数量` 展示，多商品使用 `、` 连接；`WECHAT`／`WECHAT PAY`／`微信支付` 显示为 `微信`，`ALIPAY` 显示为 `支付宝`，其他非空值保留原文，商品或支付方式缺失时使用 `-`，付款截止时间仅由任务 DTO 的来源下单时间 `orderDate + 30 分钟` 计算，固定北京时间 `YY/MM/DD HH:mm`；来源时间缺失、不含时分／时区或无效时使用 `-`，不回退官网时间；链接保持普通 URL。接口不按核实、截止时间、人工处理状态或官网支付／订单状态限制复制；链接为空时返回资源不存在，响应设置 `Cache-Control: no-store`，事件和日志不保存原始链接。
- 本人任务刷新提交返回 HTTP `202`、`jobId`、是否新建或合并；`GET /api/payment-tasks/:id/refresh/:jobId` 仅允许当前负责人查询同一关联订单的刷新任务，返回 pending、running、succeeded、failed、skipped、错误摘要和订单最新抓取时间。入队不表示官网已更新；前端应展示提交中、排队／运行、成功／失败，终态后重新加载当前列表，Worker 未运行时明确保持“等待后台处理”。
- 本人任务列表和详情返回关联订单已有的 `paymentMethod` 和派生的 `recipientTag`；两个付款列表额外返回当前权限及其他筛选条件范围内的 `productNameOptions` 和 `recipientTagOptions`，分别不受已选商品、已选 TAG 限制，供可搜索下拉多选使用，不能只从当前页计算。这些字段只用于展示和筛选，不作为任务处理结果或可编辑选项。本人任务和管理员调度列表均按关联订单 `orderDate DESC` 稳定分页，时间相同时按任务 ID 倒序；`updatedAt` 仍取付款任务与关联订单更新时间中的较新值，但两张付款页面的“数据更新时间”只展示最后一次成功官网抓取时间 `lastCrawledAt`。
- 付款截止、倒计时、复制、付款码弹窗和分配资格统一使用来源 `orderDate + 30 分钟`，`deadlineSource=source_order`；缺失或不完整来源时间返回 null，不回退官网时间。客户端按 `serverTime` 校准，未知显示“时间未知”，到期显示“已超时”，明确已付／取消等终态优先。官网字段保持独立；历史任务截止缓存不决定分配资格。
- `GET /api/payment-dispatch/tasks` 新增 `page`（默认 1，1–100000）和 `pagination: { page, limit, total, totalPages }`；`limit` 保持默认 100、上限 200，页面使用 10/20/50/100。两个付款列表新增返回 `orderDate`（关联订单已有的下单时间，与订单管理一致），`officialOrderCreatedAt` 继续供官网时间和截止规则使用；下单时间展示优先 `orderDate`、缺失时回退已确认的 `officialOrderCreatedAt`，都缺失保持未知。支持 `orderNumber`、`productNames`、`recipientTags`、`assignee`、`officialOrderStatus` 和 `processingStatus` 组合筛选；商品名称和 TAG 各自组内 OR、跨维度 AND，均在数据库分页前执行，并兼容旧商品查询参数和单值 `recipientTag`。每项返回关联订单已有的 `paymentMethod`、派生的 `recipientTag`、`officialOrderStatus`、`lastCrawledAt` 和派生的 `deadlineAt`，列表级返回 `productNameOptions`、`recipientTagOptions`，其中页面“数据更新时间”只使用最后一次成功官网抓取时间 `lastCrawledAt`。
- `PUT /api/payment-dispatch/tasks/:id/notes` 允许具有 `payment_dispatch.correct` 的管理员修改任意现有付款任务的处理备注。body 为 `{ processingNotes: string | null, expectedVersion }`，备注去除首尾空格后最长 2000 字，空字符串保存为 `null`；`Idempotency-Key` 必填。接口使用任务版本防覆盖，只修改备注并递增任务版本，不改变人工状态、负责人或官网状态；写入 `notes_updated` 任务事件并返回更新后的任务 DTO。任务不存在返回 404，旧版本返回 `CONCURRENT_MODIFICATION`。
- 批量分配 body 为 `{ tasks: [{ id, expectedVersion }], assigneeUserId, handoffConfirmed?, reason? }`，一次最多 100 项，在同一事务内校验版本、状态、付款窗口、目标权限和容量后全部提交或全部回滚。管理员单项刷新返回 HTTP `202` 和 `{ jobId, status, created, merged }`；批量刷新 body 为 `{ taskIds }`，返回 `{ total, created, merged, missing, results }` 汇总。两者都只把对应订单提交持久化刷新队列，HTTP `202` 不代表官网已更新。
- payment-dispatch/settings 首次启用写 scope_started_at；默认关闭且 mode=manual。自动和手动分配都要求完整付款执行权限、账号正常、上限有余量、合法付款链接及有效来源下单时间；自动分配额外要求来源下单时间加 30 分钟尚未到期，手动允许超时。已付款、退款、取消等明确终态禁止新分配；身份异常、状态待核实及抓取失败仅提示，不阻止分配；active_count 为 pending＋processing＋exception，completed 释放容量，官网收款不自动修改人工四态。

### 生命周期与来源冲突响应

订单链接末段为订单联系邮箱，可与邮件解析的 Apple ID 不同；保留后者作为下单账户，不以联系邮箱覆盖。域名、路径、协议与订单号校验保持生效。

订单列表和详情增加 `official_raw_status`、`official_status_description`、`official_status_observed_at`、`official_fulfillment_message`、`official_payment_expires_at`、`official_payment_method`、`official_status_needs_review`、`official_all_items_terminal` 和 `official_field_diagnostics`。状态枚举见[数据库架构](../database/数据库架构.md)。`products` 为官网优先的有效商品，商品 `fulfillmentMessage` 保留官网提示原文；派生的 `pickup_time`、`official_pickup_date`、`official_pickup_time_slot` 仅用于展示绝对预约时间，不回写原文。官网返回“今天／明天”时以 `official_status_observed_at` 的北京时间日期为基准，缺失时只回退同次成功抓取的 `last_crawled_at`，禁止按页面打开日期重新计算；商品项使用同一基准返回 `pickupTime`。历史 `deliveryDate` 仅兼容已有数据。

`validation_issues` 用于行首叹号的悬停／键盘聚焦提示，包含白名单字段名、来源、原值、官网值和处理结果；身份不一致仅返回安全错误说明，不暴露另一个订单的号码或内容。`source_snapshot` 不整体对外返回，图片、动作 URL、取货说明、原始 JSON 和敏感来源内容不进入 DTO。付款任务增加 `officialPaymentConfirmed`、`officialPaymentDiscrepancy`，分别表达官网确认已付和官网已付但人工任务尚未完成。

## 专题协议

- [Excel 导入](Excel导入规范.md)：模板、上传预览、15 分钟用户绑定会话、单次消费令牌。
- [渠道管理](渠道管理说明.md)：标签聚合、分页、newTag 事务改名。
- [仪表板](仪表板说明.md)：图表与指标口径；stats 独立统计入口见[statsController.js](../../src/controllers/statsController.js)。
- 仪表板 `GET /api/dashboard/stats` 返回 `availableRecipients`，统计状态为“使用中”或“未使用”的取机人数；按 `recipientTags` 精确筛选档案 TAG，不受下单日期、订单状态、商品筛选影响。
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

- `GET /api/orders` 和 `GET /api/orders/export` 支持 `statuses`、`productNames`、`pickupStores`、`recipientTags` 四个 JSON 数组筛选参数，每项最多 100 个值。同一数组内按 OR 匹配，不同筛选维度之间按 AND 组合；订单状态必须属于现有状态枚举，商品名称和门店按完整值精确匹配。继续兼容既有单值 `status`、`productModel`、`pickupStore` 参数。
- `pickupDate` 仅接受 `YYYY-MM-DD`。它匹配 `official_fulfillment_message` 中同一天的官网预约提示日期，不比较具体时分，也不使用下单时间、付款截止、实际取货日期或页面打开时间替代；“今天／明天”按该订单官网观测时的北京时间日期换算。列表和详情派生返回 `pickup_time`、`official_pickup_date`、`official_pickup_time_slot`，原始履约提示继续保留用于核对。
- `recipientTags` 按列表实际展示的 `recipient_tag` 精确匹配，最多 100 项、每项最长 500 字符；数组值保留内部逗号及首尾空格。AOS 订单依次使用非空来源 TAG、取机人档案 TAG、订单 TAG；其他订单使用取机人档案 TAG、订单 TAG。多个 TAG 为 OR，与其他维度为 AND，分页与导出前过滤，始终叠加已有订单访问范围。
- `GET /api/orders/filter-options` 新增 `recipientTags`，来自当前账号可见的全部订单展示 TAG，排除空值、去重排序，不受分页或前 5000 条订单限制。返回 `productNames` 和 `stores`，候选来自订单完整 `products[].name` 与邮件 `email_pickup_info.storeName`，不从当前分页临时拼接。兼容返回 `productModels`，但订单管理页面不再使用型号筛选。
- 订单管理主表不展示 `validation_status` 和 `apple_id` 列；校验问题仍通过行首提示图标进入原异常说明，异常行不使用整行红色背景。上述字段仍保留在既有 DTO、搜索和详情能力中。
- `keyword` 为纯正整数且不超过 PostgreSQL `INTEGER` 上限时，额外对系统订单 `orders.id` 做精确匹配；官网订单号、Apple ID、取机人和商品等既有模糊搜索保持不变。
- `GET /api/orders/:id/link` 要求 `orders.read`，同时叠加订单数据范围；用户点击官网订单号或打开订单详情时按需返回 `{ id, orderNumber, orderUrl }`，响应 `Cache-Control: no-store`。链接只临时进入当前详情视图，不进入列表响应、导出或浏览器持久化存储。
- `GET /api/orders/export` 继续要求独立的 `orders.export`，不依赖 `orders.refresh`。可选 `orderIds` 为 1–100 个不重复正整数的 JSON 数组，表示导出当前页明确勾选的订单；可选 `fields` 为服务端白名单字段键 JSON 数组且至少一项。范围外、缺失订单整批拒绝；未知字段、密码、身份证号、订单链接和付款截图不能通过请求加入导出。未传 `orderIds`／`fields` 时保留原筛选导出和原字段契约。

### 下单时间精度与时区（2026-09-09 修复）

`orderDate` / `order_date` 保留邮件或人工录入的来源下单时间，官网只有日期时禁止覆盖，官网精确时间独立保存在 `officialOrderCreatedAt`。日期冲突提示核对，不用官网日期补造时分秒。页面和导出统一北京时间（Asia/Shanghai）；日期筛选包含北京时间的完整起止日。仅有日期时仅展示日期，未知时间不使用入库时间或付款截止倒推。人工录入必须包含时分；无时区输入按北京时间解释。服务端分配资格和两个付款页面统一使用完整来源下单时间加 30 分钟，超时仅显示“已超时”。历史修复只恢复可核验来源快照，不将来源时间宣称为官网精确时间。

## 账号与操作记录补充契约（2026-09-09）

- 新账号登录后按 `availableHome` 进入第一个有权限的页面；零业务权限进入 `/profile` 个人设置。
- 用户 DTO 增加 `accountId`（`U` 加补齐至少四位的数字 ID）和 `nickname`。登录账号和 ID 不可由编辑接口修改；创建时昵称可选（默认登录账号），昵称输入去首尾空格后为 1–50 字符。
- `PATCH /api/auth/profile`：所有已登录账号可提交 `{ nickname }`，只更新本人昵称，未知字段返回 400；返回最新本人 DTO。
- `POST /api/users` 支持 nickname；`PUT /api/users/:id` 支持管理员配置 nickname。账号列表 keyword 支持昵称、登录账号和完整账号 ID。
- `POST /api/users/:id/reset-password`：仅 `admin` 且具备 users.manage，提交 `{ newPassword, confirmPassword }`，至少 8 位且两次一致。重置后清除该账号全部会话，不自动解锁账号，不强制下次改密；不返回原密码或密码哈希。新密码由管理员当次填写，可在弹窗临时显示。
- 账号不限制同时登录的设备或有效会话数量；每次在新浏览器登录均新增独立会话，不再返回 `SESSION_CONFIRMATION_REQUIRED`，也不替换其他设备。同一有效 Bearer 会话重新登录时只续签并替换该会话；同一浏览器的多个标签页可共用同一个会话，不使用指纹推断物理设备。
- JWT 包含 sessionId；每个受保护请求核对数据库有效会话集合。单个会话被撤销后返回 401 `SESSION_REPLACED`；全部会话被清除、旧格式或迁移前 Token 返回 401 `SESSION_EXPIRED`。旧页面每 5 秒及恢复前台时检查会话并退出，服务端即时拒绝已撤销凭证。`POST /auth/logout` 只撤销当前服务端会话；本人改密、管理员重置和锁定仍撤销全部会话。
- `GET /api/system/operation-logs`：仅管理员具备 system.logs.read，分页 page/limit（最大 100）；筛选 keyword（登录账号／昵称／完整账号 ID）、action、result、dateFrom/dateTo。返回 data.logs、total、page、limit；每条含操作人 ID/账号/昵称、中文动作、目标、IP、时间与中文结果说明。
- 记录已到达系统的账号 API 操作（包括读取、导入、导出、失败与拒绝），不记录鼠标点击、输入草稿、健康检查和 `/auth/me` 自动心跳。失败登录保留尝试账号。未知路由只记录所属模块；不保存密码、令牌、原始链接、请求正文或查询参数值。新记录从本次迁移启用后开始，历史缺失不能补造。
- 操作记录保存到数据库；写入失败记录结构化应急运行日志，不能保证数据库故障或进程突然退出时绝对无遗漏。运行环境需正确设置 TRUST_PROXY 才能在反向代理后记录实际客户端 IP。
- 系统运行日志保留原技术代码供排障，页面主要展示中文类型、级别、事件、结果和说明。

### 过期任务手动分配（2026-09-09）

`PUT /api/payment-dispatch/tasks/assignee` 及单项兼容入口允许管理员手动分配／转派已过期的现有任务，`reason` 选填、最多 500 字；存在转派仍要求 `handoffConfirmed=true`。仅解除过期拦截，保留已付、退款、取消、未知来源下单时间和链接格式／订单号匹配校验，移除身份异常与状态待核实拦截；容量、版本及整批原子性保持。自动分配不纳入过期订单。审计记录可空原因和 `expiredAtAssignment`，不修改订单官网状态或付款时间。

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

客户端转换编码、识别稳定行，服务端独立解析 rawLine 并校验最低 15 列、商品、字段和 Apple 链接。第 16 列按身份证后四位校验；第 17 列作为加密尾部数据保留，订单入库不自动映射，但付款读取链路可按普通微信／支付宝分别校验为 PNG 付款码或支付宝签名链接。其余尾部扩展不阻断已知字段，也不自动映射。不要同时传可互相矛盾的客户端结构化订单作为事实来源。稳定但格式错误的行也可可靠接收后进入 manual_review；不完整尾行继续留在本机等待。

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
- `GET /api/payment-dispatch/tasks/:id/alipay-payment-link`：管理员及 `payment_dispatch.read`；仅接受来源付款方式归一化为普通“支付宝”的付款任务。
- `GET /api/payment-tasks/:id/alipay-payment-link`：需要 `payment_tasks.link.read_own`，且付款任务当前负责人必须是请求账号；任务不存在或已转派统一返回 404，不泄露他人任务。
- 两个支付宝链接接口均从已关联且状态为 succeeded／duplicate 的加密 AOS 订单原文第 17 列读取链接，严格校验 HTTPS、`openapi.alipay.com/gateway.do`、`alipay.trade.page.pay`、RSA2、必需签名参数、`biz_content.out_trade_no` 与 Apple 订单号，以及原文 Apple ID、联系邮箱和下单日期与目标订单一致。返回结构与 payment-link 一致；非支付宝返回 400 `ALIPAY_PAYMENT_METHOD_REQUIRED`，缺失或校验不通过返回 404 `ALIPAY_PAYMENT_LINK_MISSING`。响应 `Cache-Control: no-store`，同事务记录 `payment_link_accessed` 及来源 `payment_dispatch`／`payment_tasks`，但不保存链接正文，不访问支付地址。付款调度页和本人付款任务页均仅对普通支付宝显示“复制付款链接”；原 Apple 订单链接接口和其他支付方式不变。
- `GET /api/payment-dispatch/overview` 的 staff 增加 `assignmentMode: tag_only | general` 和 `tagRules: [{ id, name }]`，由启用规则实时派生。tag_only 账号从未命中规则订单的自动候选集合排除；等待原因与实际分配使用同一范围。已有负责人及手动分配不变。
- 刷新 job 的 trigger 新增 initial（首次入库），保留历史 auto/page_open；新周期任务停止，历史周期任务执行前跳过。首次及人工刷新后无下一次自动刷新。API 的手动刷新提交和进度查询契约保持不变。

## 付款页面官网状态多选（2026-09-13）

`GET /api/payment-dispatch/tasks` 与 `GET /api/payment-tasks` 支持 `officialOrderStatuses`，值为官网订单状态代码的 JSON 数组（也接受查询数组）；不传或空数组不限制官网状态。仅允许现有 ORDER_STATUSES 枚举，最多 12 项，去重后使用 OR 匹配 orders.status，非法格式／值返回 400。保留 pending（待处理）与 unknown（原样显示），拒绝订单 completed；读取的非法存量状态统一为 unknown，筛选 unknown 同时包含这些存量值。订单管理采用同一口径。兼容旧单值 officialOrderStatus；同时传入时以 officialOrderStatuses 为准。同组 OR，与 TAG、商品、负责人和人工状态条件 AND，在数据库分页和统计前应用；TAG 候选同时受官网状态限制。本人任务始终只查询本人归属；processingStatus 不传或为空时不限制人工状态，包含已完成与异常。传入时按 pending／processing／completed／exception 精确匹配，非法值返回 400；两页 UI 提供全部、待处理、处理中、已完成、异常五个筛选选项。

三张页面统一展示“官网状态”，付款两页只以 officialOrderStatus 作为状态文案与颜色依据，不再展示“官网付款状态”列。paymentStatus 及其 DTO 派生字段保留供内部付款资格与倒计时使用。人工 processingStatus 仍为 pending/processing/completed/exception，状态变更与 processingNotes 是否填写或保存无关；可空备注独立修改，权限、版本、幂等、合法状态流转与审计规则保持。

管理员重开任务的 reason 改为选填、最长 500 字，仅保存在重开事件中，不再覆盖 processingNotes。公共订单入库统一初始化 pending，同事务登记 initial 官网刷新任务；来源或人工草稿中的 orderStatus 不作为已确认官网状态。

## 订单与付款下单日期范围（2026-09-13）

订单列表／导出、渠道订单列表／订单统计、付款调度和本人付款任务统一支持 dateFrom/dateTo（兼容 date_from/date_to）。日期 YYYY-MM-DD 按北京时间完整日边界，起日 00:00:00.000 至止日 23:59:59.999；兼容已有精确 ISO 时间参数。允许仅起日或止日，不传不限制；非法日期、起日晚于止日返回 400。以来源下单时间 orders.order_date 为依据，缺失时间的订单在指定日期范围时不命中，不用入库时间补造。与其他筛选条件 AND，分页、总数及付款 TAG 候选均在过滤后计算；订单导出带相同条件。渠道订单统计受日期范围影响，取机人总数仍为渠道关联数量；本人权限范围保持。

## AOS 付款码与 Windows 更新扩展（2026-09-13，实施中）

2026-09-18 增量：两个付款码 GET 接口保持既有响应结构，增加从已关联且 succeeded／duplicate 的 AOS 订单来源原文第 17 列直接读取微信 PNG。原文身份与目标订单一致且图片完整才可返回；按原文下单时间与独立付款码记录共同选取最新有效图片，同时间按图片摘要固定排序。已有来源原文可直接生效，不依赖重采集，不回填或改写业务记录；15／16 列、无图、坏图仍走原有独立码或 missing。权限、审计和 no-store 不变。

2026-09-25 增量：生产只读核对 9 月 21 日起 23 条成功支付宝 AOS 订单，第 17 列均为独立 `openapi.alipay.com/gateway.do` 签名付款链接，与第 14 列 Apple 订单链接不同。新接口仅对普通支付宝读取该列；不将签名链接拆分、重签、打开或写入日志，也不新增明文表字段。缺失或身份／签名结构校验失败时明确失败，不回退成 Apple 订单链接。企微通知因链接过长继续使用第 14 列 Apple 订单链接；两个原付款码 GET 接口仍只向普通微信返回图片。

- `POST /api/aos-collector/v1/payment-codes`：设备认证；`{records:[{eventId,orderNumber,orderDate,sourceTime,contactEmail,appleId,paymentMethod,imageDataUrl}]}`，每批 20 条、PNG 每张最多 128 KiB、整个请求最多 1 MiB。独立不可变事件回执，重复事件不同载荷 409；只接收微信 PNG。设备启用、当前来源为 AOS 才处理；无目标订单返回可重试等待，不因缺码阻断订单入库。已有订单允许历史补码，订单号、来源账号／联系邮箱及日期须一致。成功回执才结束本地上传。
- `GET /api/payment-tasks/:id/payment-code`：沿用本人付款链接权限及当前任务归属；`GET /api/payment-dispatch/tasks/:id/payment-code`：沿用管理员付款调度读取权限。均返回 `{success:true,data:{availability,message,orderId,orderNumber,products,amount,paymentMethod,officialOrderStatus,officialPaymentStatus,deadlineAt,imageDataUrl,sourceTime}}`；所有非普通微信方式只返回 availability=unsupported 与“具体支付方式暂无法获取付款码”（支付宝仍为“支付宝暂无法获取付款码”），不返回图片或链接。微信缺码为 missing，已付款／取消／过期仍可查看。读码审计、no-store，不访问官网或改变付款状态。
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

## 基础档案管理增量契约（2026-09-17 本地实现）

- Apple ID 接收／返回 notes，country 默认中国；列表支持 bound=true/false。详情 includeSecrets=true 要求 apple_ids.secrets.read，返回 security_qa。取机人新增 realPhone，返回 real_phone，phone 为下单手机号；地址在具有 recipients.edit 或 recipients.export_sensitive 权限时可读。账号密码读取仍要求 apple_ids.read。
- PUT /recipients/:id/binding：{appleIdRef: 正整数或 null, expectedAppleIdRef: 当前值或 null}，要求 recipients.bind_apple_ids；账号被其他人占用返回 409，不自动抢占。GET /recipients/:id/bindings 和 /apple-ids/:id/bindings 返回历史，双方读取权限同时检查。绑定不改状态。
- 导出 includeSensitive=true 要求 recipients.export_sensitive，默认脱敏。完整导出按腾讯文档“信息导入模板”公式生成 UTF-8 TXT，每条档案一行、无表头、不附加其他列；空账号输出空字符串。默认导出仍为脱敏 Excel。
- POST /import/preview 支持 files（兼容 file），返回服务器会话 token、有效行／差异／来源位置／汇总；execute 提交 {type,sessionToken,decisions}，差异决策为 keep/source/skip，未裁定不能执行。跨资源写入分别检查账号导入／编辑、取机人编辑／绑定权限；执行前重验档案摘要。
- POST /import/associations/preview 和 /execute：要求 orders.edit、orders.read、recipients.read、apple_ids.read；预览未关联订单并选中执行，只补空关联，不改快照、TAG、付款任务；无证据或歧义保持未关联。

基础档案增量补充：

- `GET /api/recipients/:id/bindings`、`GET /api/apple-ids/:id/bindings` 均要求 recipients.read 与 apple_ids.read，返回最近 200 条历史（不含密码和身份证）。当前名单由账号详情 recipients 返回，未获取机人读取权限时不返回姓名。
- `PUT /api/recipients/:id/binding` 要求 recipients.bind_apple_ids，body `{ appleIdRef: 正整数或null, expectedAppleIdRef: 当前编号或null }`。普通编辑也支持 appleId 邮箱／appleIdRef 与 expectedAppleIdRef；占用或预期值过期为 409。绑定不改双方状态。批量分配仅处理空绑定，不抢占。
- `POST /api/import/associations/preview` 要求 orders.read、orders.edit、recipients.read、apple_ids.read，body `{cursor?: 上批最后订单ID}`，每批最多 500 条缺关联订单；返回 token、nextCursor、records，其中 matchable 标识有唯一证据的候选。
- `POST /api/import/associations/execute` 相同权限，body `{token,orderIds}`；令牌 5 分钟、绑定用户、一次性消费。事务内重验选中订单快照摘要及候选，只补空外键。没有足够证据的订单拒绝，不通过账号绑定倒推取机人。分页下一批不会自动执行本批。
- 导入完整协议与计数口径见[Excel 导入规范](Excel导入规范.md)。

## 用户订单 TAG 授权（2026-09-18，已批准）

- 用户权限 GET/PUT 增加 `orderAccess: {mode: 'all'|'tags', tags: string[]}`。PUT 与 permissions 原子保存，共用 expectedVersion、Idempotency-Key 及审计；旧客户端省略范围时保留当前配置，不能重置为全部。
- `GET /api/users/order-tag-options` 仅 users.permissions.manage 可用，返回 `{tags: string[]}`，来源为 orders.tag 非空去重值。允许保留暂无订单的已授权 TAG。精确区分大小写和首尾空白，不拆分 TAG；最多 500 项，每项最多 500 字符，空白值拒绝。
- /auth/me 和登录用户信息返回 orderAccess。管理员固定全部；新普通用户默认指定 TAG 空集合，绑定 TAG 不授予读取或操作权限。
- orders.read/edit/export/refresh/payer.edit 均受范围限制；列表、分页总数、筛选候选、导出、详情、批量动作、刷新 job/batch、渠道查询和订单统计采用同一限制。指定 ID 混合越权批次整体拒绝；不存在或不可见订单统一 404。刷新全部只提交当前范围，每位发起人复用自己的批次，撤权后不可读取超出范围的旧批次。
- 本人付款任务展示、链接、刷新、付款人登记继续按既有任务权限与所有权执行，不受订单 TAG 限制；不能凭任务归属调用订单管理接口。
- 渠道改名仅允许全部订单范围且有 channels.rename 权限者执行；在同一事务更新授权 TAG 与审计，目标 TAG 已存在订单或已有授权时拒绝。订单普通编辑不开放 tag 写入。
- 仪表板、统计、基础档案内的订单聚合和历史订单关联入口均限制订单范围；基础档案自身的读取权限不改变。

## 稳定商品筛选（2026-09-20）

三个列表及订单导出新增 `productKeys` JSON 字符串数组（最多 100 项，每项最多 100 字符），按独立商品筛选索引匹配，服务端分页前同组 OR、跨条件 AND；旧 `productNames` 精确名称契约不变，同时传入时必须命中同一商品项。完整 SKU 归组，不依赖官网抓取／校验成功，名称缺型号仍可选。列表商品额外返回 `filterKeys`、`filterNeedsReview`，供命中高亮。

订单 `/api/orders/filter-options` 接受与订单列表相同的其他条件，新增 `productOptions`；两付款列表新增同名字段。每项 `{value,keys,keyCounts,label,aliases,count,needsReview}`（`keys` 为同一候选支持的历史键，`keyCounts` 为每个键在当前范围内的去重计数），count 为去重订单／任务数，候选排除自身商品条件但保留权限及其他条件，不截断 5000 单，不返回其他用户别名。已有 `productNames/productNameOptions` 继续兼容。已选零结果键由前端保留，查询失败不得把旧结果当新筛选结果。

`productKeys` 是不透明稳定键，客户端不得自行按型号拼接。服务端当前格式为 `sku:完整SKU:身份摘要` 或 `name:摘要`／`review:摘要`；摘要为 64 位十六进制 SHA-256，保护不同容量／颜色不因误录同 SKU 被合并。

### 付款分配预检与失败明细（2026-09-20）

`POST /api/payment-dispatch/tasks/assignment-preview`：admin 与 `payment_dispatch.assign`，只读预检。请求 `{ tasks: [{id, expectedVersion}], assigneeUserId? }`，1–100 条。返回 `{items:[{id,orderId,eligible,code,reason,solution,expired,warnings,hasTransfer}],eligibleCount,blockedCount,recipient}`；接收人选定后按任务 ID 升序核算容量，原负责人不重复占容量。预检不会写入任务，也不锁定资格。身份异常、状态待核实、未抓取只产生 warnings。

正式分配保留版本、容量与交接确认校验及整批事务。界面默认整批提交，有阻塞时可明确选择仅提交预检合格子集；子集也原子执行，数据变化则返回 409 与 `details.items`，重新预检后再确认，不静默跳过。界面保留成功与未分配明细。失败事件保存错误码、逐条规则原因、任务 ID、目标负责人和 requestId，写在业务事务回滚后；审计失败另写脱敏应急日志。

## 订单关联邮件 API（2026-09-20）

全部端点位于 /api/orders/:id/emails，要求登录、`orders.read` 及订单 TAG 范围。查看列表、正文、附件和转发记录要求 `order_mail.read`；提交转发另要求 `order_mail.forward`；重新解析和人工核定要求 `order_mail.manage`。现有 `order_mail.manage` 兼容包含查看和转发能力，原授权不变。新权限均可授予普通用户，`order_mail.read` 依赖 `orders.read`，`order_mail.forward` 依赖前两项。仅需查看并转发时授予 `orders.read`、`order_mail.read`、`order_mail.forward`，不授予 `order_mail.manage` 或收单处理的 `email.*`。发送 Worker 在准备内容前和实际发送前均重新检查最新转发权限及 TAG 范围，撤销转发权限后未发送任务取消。无权限403，范围外订单或邮件404，附件同样校验；Cache-Control:no-store。id为正整数，messageId为UUID。

- GET /：page/limit分页默认20上限50，返回items,total,page,limit,sync；元信息、脱敏同步状态及逐封 `lifecycle` 解析摘要，无邮件也返回同步状态。
- GET /:messageId：返回id,subject,from,to,date,receivedAt,text,html,remoteImageCount,inlineAttachmentIndexes,attachments,expired,lifecycle。`html` 是服务端移除脚本、表单、事件属性、危险URL和主动内容后的安全预览；远程图片地址延迟保存，客户端须经用户明确点击后才能加载。CID图片映射到 `inlineAttachmentIndexes`，再通过认证附件接口读取；附件摘要含index/name/size/contentType。`text` 优先从已去除head/style的HTML提取，HTML不存在时回退MIME纯文本，避免异常text/plain显示CSS源码。`lifecycle` 含模板、订单号核对结果、订单／付款候选、取货信息、待核对原因、规则版本及解析／应用时间，不返回 DKIM 原文或敏感认证材料。
- GET /:messageId/attachments/:index：认证下载，attachment/octet-stream、nosniff，过期内容410。
- GET /:messageId/forwards：最近50条发送历史，包含操作人ID、目标、备注、状态、时间、受控错误码。
- POST /:messageId/forward：recipient单一邮箱，note最多2000字符，idempotencyKey为16–100位字母数字及连字符；202返回持久化任务。同key不同请求409，未配置503，过期410。HTTP请求只排队。
- POST /:messageId/lifecycle/replay：202幂等重置该邮件解析任务；不绕过解析、订单应用或付款联动开关。
- POST /:messageId/lifecycle/review：请求 `expectedVersion`、5–500字 `reason`，可选 `orderStatus`、`paymentStatus`、`pickupInfo`；只允许基于当前订单关联邮件追加人工核定事件，版本冲突409。人工核定不会修改TAG、订单归属、付款人、备注或截图。

订单级重放另提供两个入口，均要求 `orders.read`、`order_mail.manage` 及订单 TAG 范围；单次最多100个订单，活动中的 pending／processing 任务复用，终态任务重置为 pending，原文已过期的邮件只计数不排队。返回 `results: [{orderId,messageCount,enqueued,active,expired}]`、对应 `totals` 及 `mode: shadow | apply`；HTTP 202 只表示已接受，不表示邮件已解析或订单已更新。两个入口始终遵循当前三个生命周期开关，不能绕过完整订单号精确匹配、模板／商品核对、人工核定、订单应用或付款任务联动：

- `POST /api/orders/:id/email-lifecycle/replay`：刷新单个订单的全部关联邮件。
- `POST /api/orders/email-lifecycle/replay`：请求 `{orderIds:[...]}`，批量刷新所选订单的全部关联邮件。

错误码：ORDER_MAIL_UNAVAILABLE、ORDER_MAIL_EXPIRED、IDEMPOTENCY_CONFLICT；队列 PREPARE_TEMPORARY/SMTP_TEMPORARY/SMTP_REJECTED/SMTP_AUTH/SEND_UNKNOWN/ACCESS_REVOKED。PREPARE_TEMPORARY 表示发信前的临时处理失败，最多尝试 3 次；accepted 仅表示 SMTP 接受。

订单列表和详情响应新增：`email_order_status`、`email_payment_status`、`email_status_needs_review`、`email_status_review_reasons`、`email_status_version`、`email_status_evidence_at`、`email_pickup_info`、`email_pickup_date`、`email_lifecycle_updated_at`。这些字段只表达官方订单邮件结论，原 `status/payment_status/pickup_status/official_*` 继续表达官网观测。`email_pickup_info.pickupDateEvidence` 在存在日期线索时返回 `raw`、`basis`、`referenceDate` 和 `offsetDays`；“今天／明天／后天”的 `basis` 固定为 `order_date`，不得使用邮件或页面当前时间换算。列表和导出接受 JSON 数组参数 `emailOrderStatuses`（unknown/confirmed/processing/ready_for_pickup/picked_up/partially_cancelled/cancelled/expired）及 `emailPaymentStatuses`（unknown/paid）；`picked_up` 表示收到精确标题的 Apple 个人设置辅导邮件后的单向推定，不是人工取货记录或实际取货时间。付款状态导出字段作为兼容 API 保留，但订单管理页面的列表、筛选、详情和导出字段弹窗均不展示付款状态。无权访问的订单仍不会因邮件字段泄露。

订单管理列表与详情另返回 `display_order_status`，只用于页面显示：邮件状态为 `confirmed`、邮件付款状态不是 `paid` 且完整来源下单时间 `order_date + 30 分钟` 已到时为 `payment_timeout`（显示“付款超时”）；其他情况沿用 `email_order_status`。缺少有效来源时间不推定付款超时；后续邮件确认付款或推进订单阶段后立即按新证据显示。该推算不证明 Apple 官网已取消订单，也不改写邮件生命周期、付款任务或人工取货记录。列表和导出新增 `displayOrderStatuses` 多选筛选（unknown/confirmed/payment_timeout/processing/ready_for_pickup/picked_up/partially_cancelled/cancelled/expired），在数据库分页前按相同规则计算；原 `emailOrderStatuses` 保持纯邮件状态筛选，两个参数同时提供时取交集。导出字段键 `emailOrderStatus` 为兼容保留，列标题改为“订单状态”，值按 `display_order_status` 输出。`picked_up` 的页面短名称为“已取货”，邮件推定的含义仍见订单状态说明，不代表人工实际取货。

邮件终态 `expired` 显示“已过期”，由完整订单号匹配的“订单 W… 已过期。”及明确未按时取货正文确认。取消邮件“订单 W… 已取消。”及正文“你的取货安排已取消”按不同归档消息 ID 计数：取消邮件数小于订单商品总件数时为 `partially_cancelled`（“部分取消”），达到总件数时为 `cancelled`（“已取消”）。同一封邮件重放／解析修订不重复计数，单封无需列全商品。两件订单一封取消为部分取消、两封取消为已取消；有任一有效过期邮件时统一为已过期，即过期优先于全部／部分取消，不按邮件先后覆盖。旧确认／处理／取货邮件不能撤销以上状态。取消／过期不新增付款或退款结论，已有 `paid` 保留。商品总件数缺失或非法时保留部分取消并待核对；人工核定的明确订单状态继续优先该封解析候选。`expired` 查询值现在只指 Apple 过期邮件，不再代表 30 分钟付款超时。

订单导出字段白名单保留 `emailPickupStore`（“邮件取货门店”），并增加 `emailPickupSchedule`（“邮件取货安排”）；页面显示邮件取货安排列时，两项均作为默认导出字段。固定预约按 `YYYY-MM-DD HH:mm–HH:mm` 输出，例如 `2026-09-21 12:30–12:45`；营业时间预约按“日期 营业时间内到店”输出，日期缺失时只输出已确认的安排，不从下单时间或官网状态推断。

付款任务与调度摘要保留 `emailPaymentStatus`、`emailPaymentConfirmed` 和必要的邮件订单状态／待核对标记，不开放邮件原文或完整订单详情。付款状态仅在付款调度和本人付款任务页面展示，订单管理列表与详情不展示。自动分配、人工分配预检及直接 SQL 候选统一排除 `email_payment_status='paid'`；邮件未知不额外禁止既有人工操作。

## 企微新订单通知接口（2026-09-20）

`/api/wecom-notifications` 全部要求已登录管理员及对应独立权限，Cache-Control: no-store。`wecom.read` 查看配置和投递；`wecom.configure` 依赖 read，保存配置及发送测试；`wecom.retry` 依赖 read，人工重试；三个权限均为管理员保留权限。普通订单／付款权限不能访问。

- GET `/settings`：enabled、groupName、configured（不返回 Webhook 或密文）、destinationId、enabledAt、version、pausedReason、workerHeartbeatAt、updatedAt、waitSeconds=60、ratePerMinute=18。
- PUT `/settings`：`{enabled:boolean,groupName:string,webhook?:string,expectedVersion:number}`。Webhook 空或省略保留原值，只允许官方 HTTPS send 地址且唯一 key 参数。切换 Webhook 须先停用；更换目标生成新 destinationId，取消旧待发任务。保存清除暂停原因；启用时间仅从关闭切换开启时更新，不补历史。
- POST `/test`：`{expectedVersion:number,idempotencyKey:UUID}`，固定合成内容，配置后可在自动通知关闭时测试；与订单共用速率。成功只表示入队，重复请求返回同一记录。
- GET `/deliveries?page=1&status=...`：分页 30 条，返回 `rows,total,page,totalPages,summary`；记录包含 ID、系统订单 ID、目标群、类型、状态、尝试次数、时间、固定错误码和 version；不含订单原文、支付地址或 Webhook。summary 含各状态计数、backlog、oldestPendingAt。
- POST `/deliveries/:id/retry`：`{expectedVersion:number,acknowledgeUnknown?:boolean}`，仅 failed/unknown，同目标仍有效且未被停用；unknown 必须明确 acknowledgeUnknown=true，防止重复付款通知。重试仍检查订单时效。

版本冲突返回 409；无效输入 400；无权 403。HTTP 和 errcode 均成功才标记 accepted；超时或不明确回执标为 unknown。仅明确未连接及明确限流最多自动尝试 3 次，配置错误暂停队列。不开放任意内容／任意地址发送接口。

## 订单映射金额契约（2026-09-21）

订单列表／详情增加 `order_amount`（十进制字符串或 null）、`order_amount_currency`（CNY）、`order_amount_source`（catalog）、`order_amount_price_version`。付款任务／调度 DTO 使用对应 camelCase；缺少映射显示“待确认”，不回退 officialOrderAmount。原官网金额字段为历史观测兼容保留。

付款码 GET 的既有 `amount` 改用映射金额，增加 `amountCurrency`、`amountSource`、`amountPriceVersion`。金额字段不改变付款状态、权限、任务归属或二维码选取规则。

订单导出使用“订单金额”“币种”“金额来源”“价格版本”；来源为“按官方售价计算”，未知金额导出“待确认”，零值保留。仪表板 totalAmount／amountGrowth、渠道 totalAmount／paidAmount／deliveredAmount 全部汇总 order_amount。仪表板增加 missingAmountOrders 和 amountSource=catalog；渠道原缺失数改统计映射缺失，amountSource=catalog。已付款／已取货分组仍按官网状态，金额仅为该分组的映射金额，不代表实际付款或退款额。

规则与八档价格见 [AOS 金额映射](AOS文件采集与入库.md#订单金额价格映射2026-09-21-已批准)。

### 支付方式扩展与来源展示（2026-09-21，已生产发布）

支持清单见 [AOS 支付方式扩展](AOS文件采集与入库.md#支付方式扩展2026-09-21已生产发布)。AOS 原文解析及人工草稿共用校验。订单列表／详情／导出、渠道订单、本人任务／调度 DTO 的支付方式优先读取 sourceSnapshot.paymentMethod，缺失时读取 paymentMethod；不向付款任务 DTO 暴露完整来源快照。普通官网合并仅保存 officialPaymentMethod，保留来源付款方式。

两个付款码 GET 接口继续执行权限、当前归属及访问审计，全部非普通微信方式返回 unsupported，不返回图片或链接；两页按钮保留并显示服务端提示。复制时只有普通微信读取付款码，其他方式直接调用原链接接口，仍由服务端校验权限和归属；微信分付使用订单链接。复制字段顺序、批量失败处理、来源时间加 30 分钟规则保持。

## 取货记录接口（2026-09-22，本地实现）

2026-09-23 设备扫码扩展（已生产发布，真实手机待验收）：

- `GET /api/pickups/:orderId/devices`：需 pickups.read 与订单 TAG 范围，返回 `{success:true,data:{orderId,items:[{id,orderId,serialNumber,scannedBy,createdAt}]}}`，按创建时间升序，no-store。
- `POST /api/pickups/:orderId/devices`：需 pickups.read、pickups.edit 与订单 TAG 范围；请求 `{serialBarcode:string}`，必填、最多 64 字符。Serial No. 为 10/12 位字母数字且包含字母，允许明确长度下的前导 S。201 返回 `{success:true,data:{device,alreadyBound:false}}`；相同订单和相同序列号重复提交返回 200、alreadyBound=true，不重复审计。序列号已绑定其他订单返回 409 DEVICE_ALREADY_BOUND，错误不带其他订单或设备信息。非法输入 400，越权订单 404，功能权限不足 403。记录与审计原子保存，数据库唯一约束兜底并发冲突。绑定不更新人工取货状态，不按姓名或后四位匹配订单。

`/api/pickups` 的全部接口同时检查对应功能权限与 `orders.tag` 范围。管理员范围为全部；混合或越权订单不返回存在性信息。

- `GET /api/pickups`：分页列表，支持 search、tags（JSON 字符串数组，最多 100 项，每项 1–500 字符；完整值精确 OR 匹配，保留原文）、兼容单值 tag 和 status；page/pageSize 为正整数，每页最多 100 条。列表和导出使用相同筛选及授权交集。
- `GET /api/pickups/filter-options`：需 pickups.read，返回 `{tags: string[]}`；候选来自授权范围内全部订单的非空 `orders.tag`，去重排序，不受分页限制。
- `GET /api/pickups/export`：导出当前筛选和授权范围 Excel。
- `PUT /api/pickups/:orderId`：请求状态、实际时间、结款金额、结款人、备注和 expectedVersion；首次已取货自动补当前时间，冲突返回 409 CONCURRENT_MODIFICATION。
- `GET /api/pickups/:orderId/events`：最多返回最近 200 条追加历史。
- `POST /api/pickups/:orderId/evidence/prepare`：校验文件和订单权限后返回 5 分钟 OSS PUT 地址。
- `POST /api/pickups/:orderId/evidence/confirm`：核验 OSS 对象后登记元数据并追加事件。
- `GET /api/pickups/:orderId/evidence/:evidenceId`：复验订单范围并返回 5 分钟私有读取地址，响应 no-store。

凭证仅允许 JPG/PNG/WebP/PDF，单文件上限 10MB。未配置 OSS 时上传端点返回 503 OSS_NOT_CONFIGURED，其他取货登记和导出仍可使用。

## 邮件联系人与多收件人转发（2026-09-22）

- `GET /api/mail-contacts`：管理员或同时有 `orders.read`、`order_mail.read`、`order_mail.forward` 的用户可用，`order_mail.manage` 兼容查看/转发。全局通讯录不按订单 TAG 划分，不扩大邮件/订单范围。`search` 最多100字，按姓名/邮箱包含匹配；`page` 默认1，`limit` 默认50、最大100。返回 `{items,total,page,limit}`，每项含 id/name/email/createdAt/updatedAt。响应 no-store。
- `POST /api/mail-contacts`、`PUT /api/mail-contacts/:id`、`DELETE /api/mail-contacts/:id`：仅管理员；新增/编辑必填 name（1–100字）、email（单一合法邮箱，最多254字符），邮箱去空白转小写，重复409，非法400，不存在404；新增201，其余200。返回标准 success/data。
- `POST /api/orders/:id/emails/:messageId/forward-batch`：沿用单封转发的权限、TAG、内容有效期规则。请求 `recipients`（1–50个单邮箱字符串，规范化后去重排序）、`note`（最多2000字）、`idempotencyKey`（16–64位字母数字和连字符）；202 返回 `{items:[发送任务]}`。同一事务创建所有任务，每个邮箱独立发送；同一操作人/key绑定完整目标列表、订单、邮件和备注，重试复用，改变内容409。原单收件人 `/forward` 保持兼容。联系人选择只填充邮箱，提交时形成快照；发信前仍重新检查用户权限。

2026-09-23 门店筛选修复：列表、导出及商品候选均按 `email_pickup_info.storeName` 精确匹配；门店候选来自同一邮件字段，保留其他筛选与订单权限，排除自身门店条件，便于继续多选。

### 2026-09-23：取货设备仅登记 Serial No.

`POST /api/pickups/:orderId/devices` 请求仅需 `{ "serialBarcode": "STEST000001" }`，不再读取 IMEI 输入。返回 device 仅含 id、orderId、serialNumber、scannedBy、createdAt。同订单同序列号返回 200 幂等成功，首次 201，跨订单冲突 409；TAG 范围与权限保持不变。GET 设备列表同样仅返回上述字段。

`GET /api/orders` 每条订单新增 `serial_numbers: string[]`（无登记时空数组，多设备稳定排序）；`keyword` 支持完整或部分序列号且不区分大小写，仍与 TAG 权限及其他筛选组合，分页总数按订单计算。

### 设备解除绑定（2026-09-23）

`DELETE /api/pickups/:orderId/devices/:deviceId` 需 pickups.read、pickups.edit 及订单 TAG 范围。设备 UUID 必须属于该订单；成功 200 `{success:true,data:{removed:true}}`，已不存在幂等返回 removed=false。事务内追加 device_removed 历史（设备 ID、Serial No.、原登记人/时间及原始条码），递增取货版本后删除活动绑定；不改变取货状态、结款、凭证。解除后序列号可绑定其他订单，新绑定使用新 UUID，旧请求重试不得删除新绑定。

### 取货序列号 OCR

`POST /api/pickups/:orderId/devices/ocr`：需 pickups.read、pickups.edit 及订单数据范围。multipart/form-data，单一 `image` 文件，JPG/PNG/WebP，最多 10 MB；不接受远程 URL。服务端转发至阿里云 RecognizeAdvanced，高精度识别后返回 `{success:true,data:{candidates:string[],requestId,provider:'aliyun'}}`，不自动绑定、不返回完整 OCR 文本、不保存图片。识别后确认仍使用设备绑定接口。

错误：400 无效图片，404 无权访问订单，429 频率或自然月额度超限，503 未配置，502 云端识别失败。调用前在数据库原子预占月度次数（北京时间），每月网站上限 1000；失败、超时仍计次且不自动重试，以防重复费用。另限制每用户每分钟 10 次。

## 仪表板筛选与分布（2026-09-23）

- `/api/dashboard/stats`、`daily-trend`、`product-distribution`、新增 `city-distribution` 及兼容 `store-distribution` 统一接受 `startDate/endDate`（北京时间日期）、`emailOrderStatuses`、`productKeys`、`recipientTags`。多选为 JSON 数组，最多 100 项；TAG 每项最多 500 字符，保留原始空格；状态仅 unknown/confirmed/processing/ready_for_pickup/picked_up/partially_cancelled/cancelled/expired，商品键复用订单筛选校验。非法参数返回 400。兼容旧 `status/productModel/store` 单值参数。
- stats 新增 `paidOrders`，仅统计当前条件与 processing/ready_for_pickup/picked_up 的交集；保留 `pendingOrders` 兼容字段但也与当前筛选取交集。`totalOrders/totalAmount/missingAmountOrders/amountSource/orderGrowth/amountGrowth` 保留；无完整日期范围时增长率为 null。金额查询失败返回错误，不伪装成 0。
- `filter-options` 接受相同参数，返回 `productOptions`、`recipientTags`，分别排除自身维度后从完整可见范围生成；保留 `productModels/stores` 兼容字段。候选和所有订单聚合必须叠加账号订单 TAG 访问范围。
- `daily-trend` 返回 `{ date, count }`，date 为北京时间 `YYYY-MM-DD`；完整日范围补 0（超过 3660 天只返回实际日期点）。商品／城市分布返回 `{ name, value }` 数组，商品附稳定 `key`，value 为订单数；商品按每订单每身份去重，多商品订单可进入不同组。城市取门店字典、未知归“未知城市”，不截断前 10 项。可用取机人数是独立档案统计，只有 TAG 筛选生效。完整规则见[仪表板说明](仪表板说明.md)。

## 代抢管理（2026-09-28 已生产发布）

所有 `/api/proxy-orders` 接口需认证与 proxy_orders.read。独立动作权限为 edit/status/copy/accounts/link，均依赖 read。普通列表/详情不返回 Apple 密码，no-store；相关系统订单仅返回必要摘要，不要求 orders.read，不含支付链接和账号秘密。

| 方法与路径 | 权限 | 契约 |
| --- | --- | --- |
| GET /api/proxy-orders | read | page/limit/keyword/status 分页，返回 rows/count；keyword 姓名/平台单号/委托编号；已知机型和颜色别名在响应中规范显示 |
| GET /api/proxy-orders/stores | read | 已核实门店及省市区 |
| POST /api/proxy-orders/parse | edit | text 单人文本；返回 draft/warnings；18PM → iPhone 18 Pro Max，iPhone 18 Pro/Pro Max 的红色、酒红色 → 勃艮第酒红色；缺数量默认 1、门店必须人工确认 |
| POST /api/proxy-orders/address | edit | storeCode；生成账单地址，不写入订单 |
| POST /api/proxy-orders | edit | 完整确认资料；pending，默认尝试分配一个账号；无账号仍保存 |
| GET /api/proxy-orders/:id | read | 详情、分配历史、脱敏事件、官方订单摘要 |
| PUT /api/proxy-orders/:id | edit | expectedVersion + 确认资料；成功/取消只允许改备注 |
| POST /api/proxy-orders/:id/status | status | expectedVersion,status；手动禁止 succeeded |
| POST /api/proxy-orders/:id/notes | edit | expectedVersion,notes；仅修改备注，保留加密原文及其他资料；所有状态可修改 |
| POST /api/proxy-orders/:id/accounts | accounts | expectedVersion，accountIds 或 count；追加占用 |
| POST /api/proxy-orders/:id/release | accounts | expectedVersion,assignmentIds,confirmedStopped=true；释放占用 |
| POST /api/proxy-orders/:id/link | link | expectedVersion,orderNumber,reason；人工核对关联，不覆盖已有关系；orderNumber=null 为解除 |
| POST /api/proxy-orders/copy | copy | ids 1–100；原子生成当前活跃账号模板，多行字符串；不更新状态 |
| GET /api/proxy-orders/accounts | accounts | page/limit/keyword，scope=pool/candidates；返回 rows/count/availableCount，其中 availableCount 为整个专用池中状态“未使用”、未占用且未绑定普通取机人的数量；无密码 |
| POST /api/proxy-orders/accounts/import | accounts | text，每行邮箱+密码；全量先验证，同账号密码差异拒绝不回显 |
| POST /api/proxy-orders/accounts/adopt | accounts | ids，核对后纳入已有账号；有普通绑定拒绝 |
| POST /api/proxy-orders/accounts/status | accounts | accounts=[{id,expectedUpdatedAt}] 1–100 个专用池账号、status=未使用/使用中/已下架/异常；改为未使用须 confirmedStopped=true。整批行锁、版本校验与事务，任一账号不存在、非专用池或仍被代抢占用时整批拒绝；仅更新状态，保留备注和占用历史 |
| PUT /api/proxy-orders/accounts/:id | accounts | status,notes,expectedUpdatedAt；改为未使用须 confirmedStopped=true，仍被代抢占用的账号拒绝；原账号更新冲突拒绝 |

业务校验返回 400；不存在 404；占用/重复/版本冲突 409；无权限 403。复制拒绝未确认门店/不完整资料/异常账号/终态订单，错误不回显密码。读接口无隐式自动变更；匹配由 API 内可恢复的 20 秒周期扫描触发，跨进程使用事务锁，最多每批 100 个委托，分页游标循环扫描防饥饿。

代抢列表在原有权限内支持就地修改状态和备注、请求自动追加一个可用账号。仅 pending/rushing 可人工切换为 pending/rushing/cancelled；成功及取消保持只读状态。备注独立更新接口不覆盖客户原文。账号池可单条编辑或勾选当前页账号后批量修改状态；批量操作不改变备注、池归属或代抢占用，任一失败不部分提交。历史账号备注为“代抢”但状态仍为“使用中”时不算可用，须由工作人员确认软件停抢，再在账号池改为“未使用”或导入新账号。
