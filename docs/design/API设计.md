# API 契约与接口导航

> 状态：当前有效
>
> 最近核对：2026-09-06
>
> 基线：main@0fd7f80 与当前未提交工作树
>
> 验证范围：本地工作树静态核对；未验证真实数据库、邮箱、官网和生产环境

## 通用约束

前缀为 /api。除登录和健康检查外均需认证；auth 下改密、登出、me 各自经过 authenticate，其余业务统一经过全局认证与强制改密检查。Bearer Token 不放入 URL。

角色为 admin、operator、readOnly：后者只读；operator 可写、脱敏导出及受控刷新；删除、用户管理、系统运行控制限 admin。具体权限常量见[business.js](../../src/constants/business.js)。

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

| 方法   | 路径                                   | 权限要求                   |
| ------ | -------------------------------------- | -------------------------- |
| GET    | /api/health/live                       | 公开；进程存活             |
| GET    | /api/health/ready                      | 公开；数据库检查，失败 503 |
| GET    | /api/health                            | 公开；307 到 ready         |
| POST   | /api/auth/login                        | 公开；登录限流             |
| POST   | /api/auth/logout                       | 登录；允许强制改密状态     |
| POST   | /api/auth/change-password              | 登录；允许强制改密状态     |
| GET    | /api/auth/me                           | 登录；允许强制改密状态     |
| GET    | /api/users                             | admin                      |
| POST   | /api/users                             | admin                      |
| PUT    | /api/users/:id                         | admin                      |
| DELETE | /api/users/:id                         | admin                      |
| PUT    | /api/users/:id/unlock                  | admin                      |
| GET    | /api/apple-ids                         | 登录并完成强制改密         |
| GET    | /api/apple-ids/:id                     | 登录并完成强制改密         |
| POST   | /api/apple-ids                         | write                      |
| PUT    | /api/apple-ids/:id                     | write                      |
| DELETE | /api/apple-ids/:id                     | delete（admin）            |
| GET    | /api/recipients                        | 登录并完成强制改密         |
| GET    | /api/recipients/export                 | export                     |
| GET    | /api/recipients/:id                    | 登录并完成强制改密         |
| POST   | /api/recipients                        | write                      |
| POST   | /api/recipients/batch-generate-contact | write                      |
| POST   | /api/recipients/batch-generate-address | write                      |
| POST   | /api/recipients/bind-apple-ids         | write                      |
| PUT    | /api/recipients/:id                    | write                      |
| DELETE | /api/recipients/:id                    | delete（admin）            |
| GET    | /api/orders                            | 登录并完成强制改密         |
| GET    | /api/orders/export                     | export                     |
| GET    | /api/orders/filter-options             | 登录并完成强制改密         |
| GET    | /api/orders/:id                        | 登录并完成强制改密         |
| PUT    | /api/orders/:id                        | write                      |
| POST   | /api/orders/:id/refresh                | refresh                    |
| POST   | /api/orders/batch-refresh              | refresh                    |
| GET    | /api/stats/overview                    | 登录并完成强制改密         |
| GET    | /api/stats/apple-ids                   | 登录并完成强制改密         |
| GET    | /api/stats/recipients                  | 登录并完成强制改密         |
| GET    | /api/stats/products                    | 登录并完成强制改密         |
| POST   | /api/import/preview                    | write                      |
| POST   | /api/import/execute                    | write                      |
| GET    | /api/import/template/:type             | 登录并完成强制改密         |
| GET    | /api/dashboard/stats                   | 登录并完成强制改密         |
| GET    | /api/dashboard/daily-trend             | 登录并完成强制改密         |
| GET    | /api/dashboard/product-distribution    | 登录并完成强制改密         |
| GET    | /api/dashboard/store-distribution      | 登录并完成强制改密         |
| GET    | /api/dashboard/filter-options          | 登录并完成强制改密         |
| GET    | /api/channels                          | 登录并完成强制改密         |
| GET    | /api/channels/:tag/stats               | 登录并完成强制改密         |
| GET    | /api/channels/:tag/orders              | 登录并完成强制改密         |
| PUT    | /api/channels/:tag                     | write                      |
| GET    | /api/system/logs                       | admin                      |
| GET    | /api/system/auto-refresh               | admin                      |
| POST   | /api/system/auto-refresh/resume        | admin                      |

## 认证与用户

- 登录提交 username、password，返回 Token 与用户信息；账号/IP 限流与锁定分别生效。
- 改密提交 oldPassword、newPassword、confirmPassword，首次改密完成后才可访问业务 API。
- 登出目前由客户端移除 Token，不能理解成服务端已维护 JWT 撤销名单。
- 用户管理的 role 必须使用当前三个枚举。用户列表、增改、删除、解锁输入以[userController.js](../../src/controllers/userController.js)为准；解锁方法是 PUT。

## Apple ID 与取机人

- Apple ID 列表 query 为 page、limit、status、country、keyword；新增接收 apple_id、password、nickname、country、status、security_qa，更新另支持 is_modified。返回使用 snake_case，默认不含密码/密保。
- 取机人列表 query 包含 page、limit、tag、status、apple_id_ref、keyword；新增必须 lastName、firstName、idCardNumber，关联写入使用 appleIdRef。写入为 camelCase，不按列表字段直接回传。
- 联系方式/地址批量生成接收 recipient_ids；绑定 Apple ID 使用 recipientIds，保留现状差异，不能统一猜测。
- 取机人导出需要 export 权限；admin 显式 includeSensitive=true 存在敏感字段导出分支，此行为需要受控授权与验收。默认导出脱敏并处理公式注入。

来源：[Apple ID 控制器](../../src/controllers/appleIdController.js)、[取机人控制器](../../src/controllers/recipientController.js)。

## 订单

- 列表和详情由不同序列化函数构建；详情中的 apple_id 是关联对象或 null，不能套用列表的字符串类型。
- 批量刷新传 orderIds 时仅对目标集合操作；未传时才使用受限筛选与 limit。详见[orderController.js](../../src/controllers/orderController.js)。
- PUT /api/orders/:id 当前只允许 payerName、paymentScreenshot，不提供任意状态/商品字段更新。
- 官网金额、支付与取货状态是独立字段。列表、详情不返回 Apple 密码/原始订单链接，手机号、身份证和地址脱敏。
- 导出使用当前筛选条件，下载按 Blob 处理；不能以固定价格代替缺失官网金额。

## 专题协议

- [Excel 导入](Excel导入规范.md)：模板、上传预览、15 分钟用户绑定会话、单次消费令牌。
- [渠道管理](渠道管理说明.md)：标签聚合、分页、newTag 事务改名。
- [仪表板](仪表板说明.md)：图表与指标口径；stats 独立统计入口见[statsController.js](../../src/controllers/statsController.js)。
- 系统自动刷新在独立 Worker 模式为日志观测；resume 返回 409，不把 API 内存状态当作 Worker 真实状态，见[systemController.js](../../src/controllers/systemController.js)。

## 维护与验证

API 变更同时更新 Router、Controller、前端调用和测试。当前表描述已挂载端点；完整 DTO 统一和真实 API/数据库集成仍未完成。旧未挂载的 /api/config 等示例进入[历史接口资料](../archive/2026-09/整理前接口设计.md)，不再作为可调用接口。
