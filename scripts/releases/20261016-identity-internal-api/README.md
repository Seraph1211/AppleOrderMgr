# 身份核验内部 API 发布准备

状态：候选发布方案，尚未构建、提交或部署。只读生产核对与合成测试不构成生产验收。

## 本轮范围

仅发布身份核验内部 GET、本人令牌管理、管理员保护处置、共享暂停及 API Tab。`制品白名单.json` 是覆盖范围：API 11 个源文件、前端 8 个源文件及一个 Migration `20261016000002-add-identity-internal-api.js`。Dockerfile 只逐文件覆盖这些内容，不复制整个本地 `src`。API 和前端更新，migrator 只执行迁移；其他 Worker 保留原容器、镜像与启动时间。前端由宿主机 Nginx 读取版本目录静态文件，没有前端生产容器需要重启。镜像归档只包含API/migrator，前端构建镜像留在本地，其dist进入静态制品；避免将累计多层的前端构建镜像导入生产overlay2触发层数上限。

Nginx 使用实际生产配置的局部补丁，独立备份、候选校验、原子替换和 reload。不以仓库模板整体替换服务器文件。仅本站 HTTP/TLS 两个 server 改为安全访问日志、关闭可能含请求行的错误日志、增加 server 级 `no-store`/`no-referrer`、HTTP 直接拒绝和 TLS 独立路由。其他域名与既有 location 保留。存在多域名 server、优先级冲突、已有相同入口或 server 级 rewrite 时停止并交主审处理。

## 基线与重新核准

本轮最新主审只读快照：生产 `current` 为 `20261016-appleid-dialog-simplify`，制品 manifest commit 为 `1d9f975c9a814808f4157ed79163bf34d81af945`，已包含 Apple ID 弹窗简化；API 与 migrator 仍采用 `20261016-proxy-delete` 镜像，包含此前 Apple ID 管理和代抢删除。配置模板记录当时镜像摘要，但 `approved=false`、`approvedCommit=null`、`backupInventoryApproved=false`，不能直接执行。正式操作前主审必须重新读取当前 release、运行镜像、manifest 及最新 main，并填入最终核准配置副本。

Docker Desktop 本地 `.Id` 可能是索引摘要，服务器运行镜像 ID 是导出 Config 内容摘要。`localId` 用于固定本地基线，`id` 用于核准生产基线；构建脚本从 `docker save` 的 Config 字节计算最终服务器镜像 ID，不把二者混用。

正式构建必须在干净 `main`、核准 `approvedCommit` 上进行。构建前：

1. 对比 `baselineCommit..approvedCommit` 的运行代码，只允许白名单文件变化。
2. 从核准基线镜像提取完整源树；每个将覆盖的既有文件必须与 `baselineCommit` 中同文件逐字一致，新文件必须在基线镜像中不存在。
3. 任一文件不一致即停止，先核对其他任务的上线差异，将其合入最新 main 并重新核准基线；禁止强行跳过检查，禁止把旧 feature 文件覆盖到生产。
4. 用核准镜像创建唯一临时基线 tag，构建前后复验 tag 的本地 ID。构建后完整 API/前端源树和迁移目录的差异必须恰好等于白名单，并逐文件等于核准 main 内容。

此流程允许后续更新基线，不锁死本轮只读快照。若生产或 main 再变化，丢弃旧候选，更新配置并从新 main 重新构建。

## 脚本与运行环境

本目录 Python 文件是可审阅的发布配方，`.tmp/identity-api/release/` 是本轮工作副本和证据目录。Python 必须至少 3.11；服务器执行命令必须明确使用 `/usr/local/bin/python3.11`，不能使用系统默认 Python 3.6.8。配置不含业务密钥；应用环境文件只在服务器保持原路径与权限，不输出明文。

| 文件               | 执行位置与作用                                                                         |
| ------------------ | -------------------------------------------------------------------------------------- |
| `build.py`         | 本地 main：白名单构建、基线与候选完整源树检查、镜像/静态资源打包                       |
| `backup.py`        | 服务器：业务库一致性快照、配置/附件及旧发布目录备份                                    |
| `restore.py`       | 本地：无网络隔离 PostgreSQL 恢复，全部业务表与文件摘要核对                             |
| `rehearse.py`      | 本地：恢复库执行唯一新增迁移，验证旧业务列及历史不变                                   |
| `prepareServer.py` | 服务器：校验导入制品，Compose 仅改 API/migrator 镜像，生成隔离 Nginx 候选并 `nginx -t` |
| `deploy.py`        | 服务器：校验演练证据，执行迁移、安全 Nginx 切换、仅更新 API，原子切换静态前端指针      |
| `readback.py`      | 本地：独立 SSH 只读摘要、公开静态资源、匿名安全拒绝与响应头核对                        |
| `patchNginx.py`    | 纯文本局部补丁，不自动写生产文件                                                       |
| `testRelease.py`   | 合成配置测试，不执行 SSH、构建或生产操作                                               |
| `common.py`        | 共享校验、摘要及受限数据库读取                                                         |

示例顺序仅供主审核准后执行；本轮没有执行下列发布动作：

```bash
# 本地：复制模板到受限临时配置，填写最终main、生产镜像与备份清单后执行
python3 scripts/releases/20261016-identity-internal-api/build.py .tmp/identity-api/release/核准配置.json

# 服务器：先传核准配置与本目录Python脚本，备份目录必须尚不存在
/usr/local/bin/python3.11 backup.py 核准配置.json

# 通过受控SCP取回业务备份，避免对外HTTP提供数据库、配置和附件
# 本地：恢复与迁移演练
python3 scripts/releases/20261016-identity-internal-api/restore.py .tmp/identity-api/release/核准配置.json .tmp/identity-api/release/backup
python3 scripts/releases/20261016-identity-internal-api/rehearse.py .tmp/identity-api/release/核准配置.json .tmp/identity-api/release/backup

# 主审将核对过的restored-snapshot.json、rehearsal-result.json回传对应服务器备份目录
# 通过SCP将images.tar.gz、release-files.tar.gz传到新发布目录
/usr/local/bin/python3.11 prepareServer.py 核准配置.json
/usr/local/bin/python3.11 deploy.py 核准配置.json

# 本地独立回查；不携带真实姓名、证件或Token，不调用供应商
python3 scripts/releases/20261016-identity-internal-api/readback.py .tmp/identity-api/release/核准配置.json .tmp/identity-api/release/artifact
```

## 备份与演练边界

数据库备份仅排除 AGENTS 约定的 AOS 监控日志明细、目录、压缩块、账号目录和回执数据，保留其表结构与索引；不删除任何生产日志。订单、账号、资金、库存、权限、配置和运行游标等业务表全部备份并比对恢复摘要。摘要采用固定长度行哈希流，设置 8MB `work_mem` 和查询超时，避免无界读取业务行到客户端内存。

`businessPaths` 必须由主审根据生产数据目录、附件路径及容器挂载独立核准，`aosRawPaths` 列出对应原始 AOS 日志路径；包含配置、附件等业务文件，但避免约 5GB 的 shared 历史代码/采集证据缓存。模板里的整个 shared 只是待填写提醒，脚本明确拒绝整目录备份；替换为实际业务路径并设置 `backupInventoryApproved=true` 后才能执行。文件摘要和归档恢复逐一比对，原始日志不纳入恢复门槛。敏感备份目录和文件权限由 `umask 077` 保护，不放入公开目录或本次制品。

迁移演练要求所有旧业务表（除迁移表）行数与旧列摘要一致；身份核验批次仅新增空 `api_token_id`，新增五张表，服务状态仅有初始未暂停记录。演练与安全匿名探测不调用真实供应商。

## 切换、故障与独立验收

部署再次断言 current、API 镜像、所有既有容器、环境文件摘要及 Nginx 基线未漂移；迁移列表必须与已恢复演练的快照完全一致。迁移前只读统计 `processing` 明细、`queued/running` 批次及其关联的 `pending` 明细，这三类活动计数任一非零即停止发布；暂停或草稿批次中的 pending 是合法保留记录，仅统计、不阻断，不能为通过发布而删除、取消或改写任务。迁移前后对 `identity_verification_batches`（排除新增 `api_token_id`）、`identity_verification_items`、`users`、`user_permissions`、`user_permission_events` 的全部旧行生成一致性快照，用固定长度行哈希流比对计数及摘要，不返回身份内容。保存 `protected-business-before.json`、`protected-business-after.json` 和 `protected-business-check.json`；摘要不同或出现活跃任务即停止，不切换 API/静态前端。用户登录、权限调整或核验操作也可能使上述表变化，发布窗口应避免这些操作；检查不能消除最后一次只读检查之后新提交的竞争窗口。API 更新前再次只读检查任务状态，保存 `identity-activity-cutover.json`；若此时停止且尚未更新 API，不执行旧 API 重启。独立回查重新读取并验证前后摘要、证据文件 SHA-256、五张真实模型表名和各次空闲检查，不能只信“比对通过”标志。Nginx 在克隆的完整配置树中先验证，然后同目录原子替换，生产再次 `nginx -t` 后 reload。其他站点内容保留，共享 Nginx reload 本身仍须记录与回查。

API/静态切换失败时回退旧 API 镜像和静态指针，保留已 up 的结构、令牌、用量和审计，不执行 migration down。已经验证并发布的安全 Nginx 默认保留，避免已流转令牌退回原始查询日志；此时故障报告明确 `secureNginxRetained`，主审独立决定后续处置。Nginx 测试/reload 本身失败则恢复原文件并重新验证/reload，不切换 API。

本轮本地证据：6 项补丁测试通过；从实际生产站点基线生成候选后，独立内部网络合成网关 15 项探测通过，含 HTTP/大小写/编码变体、畸形 URL、HEAD、上游断开及超时（约 15 秒），断开与超时均只有一次上游请求；容器和访问日志不含合成证件、令牌或 Referer。证据位于 `.tmp/identity-api/release/gateway/`。这不等同于生产共享 Nginx、WAF/CDN 或调用方工具验收，正式切换后仍需主审确认实际入口与日志保护、PC/H5 页面及权限正常。
