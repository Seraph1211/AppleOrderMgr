# AOS 日志压缩存储迁移手册

> 状态：当前有效（隔离测试工具；生产执行须满足整体发布验收）
>
> 最近核对：2026-10-07
>
> 基线：`codex/aos-log-storage-optimization` 工作树
>
> 验证范围：CLI 单元测试与隔离 PostgreSQL 真实事务演练；规模、生产及磁盘释放结果以本次交付验收记录为准。

本工具对应 [AOS 日志存储与查询优化方案](../planning/AOS日志存储与查询优化方案.md)，逐实例操作必须明确设备与实例；全局收尾与默认回退需要额外确认，并在短锁内检查前置条件。正式新增表和回退约束见 [数据库架构](../database/数据库架构.md)，整体发布、备份与业务隔离见 [生产环境部署指南](生产环境部署指南.md)。工具不调整 30 天保留规则、不删除业务订单，也不执行整个数据库覆盖恢复。

## 操作前条件

1. 新正式 Migration 已在隔离库演练成功，运行代码具备 `rows/shadow/blocks` 三种模式和设备事务行锁保护。
2. `shadow` 上传必须原子提交旧行、压缩块及回执；任何压缩错误整批事务回滚，不能先确认再异步保存块。
3. 已批准的容量、查询、完整性、合成库日志恢复演练、既有生产业务恢复边界和 PC/H5 验收通过，发布时重新核算本批新增块、回执、索引、WAL、正常业务增长及从已验证压缩副本恢复旧行所需的空间。生产常规业务备份继续排除全部 AOS 日志，不以新增 AOS 日志备份作为迁移或回收前置。
4. 获得设备 UUID 与实例 `localId`；只使用受控部署环境数据库配置，避免将连接串或凭据写进命令和输出。

下方示例在隔离测试运行容器执行，生产采用实际经验证的 API／运行容器。变量填写实际授权作用域，工具不自动发现并迁移全部实例：

```bash
AOS_DEVICE_ID='<设备 UUID>'
AOS_LOCAL_ID='<实例 localId UUID>'
docker compose -f docker-compose.aos-storage-test.yml exec runtime \
  node scripts/monitorLogStorageMigration.js status \
  --device="$AOS_DEVICE_ID" --instance="$AOS_LOCAL_ID"
```

`status` 输出模式、代次、窗口内旧片段数量、新块片段数量、待补齐数量及持久进度，不输出原始日志或账号。计数查询不持设备锁；规模库应在读取预算内使用。

## 命令与运行预算

逐实例命令必须传 `--device=<UUID> --instance=<UUID>`；`finalize`、`rollback-default` 是全局命令。修改与校验命令持有独立会话级 PostgreSQL advisory lock，CLI 与后台压实复用同一个会话锁，同一数据库最多运行一个维护操作；异常断开后会话锁自动释放。解锁失败时销毁连接，避免将持锁会话交还连接池。

| 命令                        | 行为与保护                                                                                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shadow`                    | 持设备锁切到原子双写，旧表继续读取；首次进入时清空之前的迁移证书                                                                                                    |
| `backfill`                  | 持久日期／排序时间／文件 UUID／偏移四元组 keyset 逐批扫描旧表，复用既有实例分页索引，通过全局回执幂等追加；旧 UUID 游标自动重置并幂等重跑；每批提交进度，可反复运行 |
| `verify`                    | 不持设备锁，逐块验证解压摘要、回执序号、事件 ID、文件位置、载荷及旧表内容，额外重算块排序边界、账号成员与边界、关键词签名及文件目录，提交块水位与链式 SHA256        |
| `verify --reset-verify=yes` | 从首块重新校验；用于新的独立核验或发现直接 SQL 修改／存储异常之后，后续续跑勿再传 reset                                                                             |
| `read-switch`               | 历史扫描完成后，持设备锁验证最多 4 个未认证尾块，再切到块读取；超过尾部预算拒绝切换                                                                                 |
| `abort`                     | 仅 `rows/shadow` 可用，恢复旧表模式并清空证书；已生成副本保留，可重新 shadow／补齐                                                                                  |
| `revert`                    | 首事务登记持久恢复维护标记，保持块读取并从当前活跃块恢复；跨批次和进程阻止压实，最终捕获最多 4 个新尾块，完整恢复后切回 rows 并清标记                               |
| `abort-maintenance`         | 显式终止未完成恢复，保持 blocks 权威读取和已恢复的部分旧行，清维护标记与认证；下次 revert 从当前首块重新恢复                                                        |
| `finalize`                  | 全局旧表必须为空；确认全部 API 已升级后设新实例默认块写入、转换空旧模式 scope，并受控 TRUNCATE 空旧表回收页                                                         |
| `rollback-default`          | 全部 scope 已 rows，且活跃压缩范围持有完整恢复证书后，短锁恢复全局旧写入默认，才能回退 API 版本                                                                     |
| `retire`                    | 仅块模式，显式限定日期；按块水位逐批认证副本后删除对应旧行，不删除压缩块或回执                                                                                      |

通用预算为 `--batch-size=1000 --max-batches=20 --budget-ms=30000`。`batch-size` 对历史补齐为旧行数，对校验为最多 20 块，对恢复／回收为最多 10 块。整数必须为正；最大 batch/max-batches 为 5000，单次预算最大 300000 毫秒。修改批次设置本地 SQL statement timeout 和 5 秒 lock timeout。最终切读及恢复冻结采用最多 5 秒 SQL 预算，超时或差异均回滚并保持原模式。

输出 `complete=false` 表示本次预算耗尽，应使用同一命令续跑。`processed` 在 backfill/retire 表示旧片段数，在 verify/revert 表示已处理块数；回收同时输出 `blocks`。持久 `verifiedEntries` 是累计认证片段数，包含已到期的过去批次，不用它代替当前 30 天数量。恢复返回累计 `restoredEntries`。进度记录位于 `monitor_log_storage_metrics`，不要手动删除或改写。

## 影子补齐与灰度切换

按单个实例依次执行：

```bash
node scripts/monitorLogStorageMigration.js shadow --device="$AOS_DEVICE_ID" --instance="$AOS_LOCAL_ID"
node scripts/monitorLogStorageMigration.js backfill --device="$AOS_DEVICE_ID" --instance="$AOS_LOCAL_ID"
node scripts/monitorLogStorageMigration.js verify --device="$AOS_DEVICE_ID" --instance="$AOS_LOCAL_ID"
node scripts/monitorLogStorageMigration.js status --device="$AOS_DEVICE_ID" --instance="$AOS_LOCAL_ID"
node scripts/monitorLogStorageMigration.js read-switch --device="$AOS_DEVICE_ID" --instance="$AOS_LOCAL_ID"
```

对 `backfill` 和 `verify` 重复执行至 `complete=true`。最终冻结不重复解压全量历史；若报告“历史遍历尚未完成”或“校验积压超过切换预算”，续跑对应命令后重试。不要扩大最终冻结预算绕过门槛。

迟到提交的安全性来自设备锁和原子双写：进入 shadow 前，持设备锁的历史上传必须先提交；进入后每个上传的旧行、块和回执在同一事务提交。历史 keyset 复用 `(device_id,local_id,business_date,sort_at,file_id,byte_offset)` 索引前缀，不依赖 `created_at`；新增或补传排序元组即使在游标之前，也已有原子回执。块水位安全性同样依赖同设备上传和补齐先取得设备锁，再分配块 ID；其他设备的块 ID 间隙不影响本实例。未经此锁协议直接执行 SQL 插入、修改旧日志，或在后台独立分配并晚提交块，不能复用这份认证证明，应停止迁移、完整重校验并重新补齐。百万合成库深于第 100,000 个片段的位置，1000 行批次使用 `monitor_log_instance_page` Index Scan，1.414 毫秒、88 个 shared read buffers；这是本机合成单次计划证据，不是生产或 2,752 万片段性能承诺。

压缩块及原始旧日志均为不可变数据；认证水位不是数据库文件防篡改签名。正常到期清理与最新 30 天窗口并行运行；若验证遇到清理导致的副本消失，事务失败后续跑，不输出部分成功。切换后再次核验旧 ID 详情、前后上下文、关键词、账号候选和同范围排序，监控上传 P95 与数据库锁等待，先稳定单实例再扩大范围。

## 逐批回收与恢复

确认指定日期的真实逐块完整对账和查询差分通过，明确原表继续保留及本批回收的范围，并验证从压缩副本执行 `revert` 恢复旧行的路径后，显式传回收确认。既有生产业务备份继续按现行范围执行并排除全部 AOS 日志；`retire` 不要求新建 AOS 日志备份：

```bash
node scripts/monitorLogStorageMigration.js retire \
  --device="$AOS_DEVICE_ID" --instance="$AOS_LOCAL_ID" \
  --first=2026-10-01 --last=2026-10-01 --confirm-retire=yes
```

回收只删每个已解压认证块对应的旧副本。可反复运行直至 `complete=true`；按块水位推进，避免每次从旧表首 UUID 扫描已删除位置。日期超出当前保留窗口可用于明确的旧副本回收，生命周期仍按整体 30 天规则执行。普通 DELETE 主要回收数据库内部可复用空间，不保证立刻增加操作系统可用空间；不要把删除数量或新旧关系大小直接当作磁盘释放结果。

块读取后有新独有日志，回滚必须执行恢复：

```bash
node scripts/monitorLogStorageMigration.js revert --device="$AOS_DEVICE_ID" --instance="$AOS_LOCAL_ID"
```

反复运行至输出 `mode=rows`。整个恢复过程中块读取保持权威；每批按块完整性、回执与已有旧行核验，缺失旧行连同原事件 ID、源位置、正文、原始异常字节、时间和载荷摘要恢复。最后设备锁内捕获新块；尾部超过预算拒绝切回，继续恢复再试。块模式禁止 `abort`，避免直接遗失只在新存储中的数据。恢复的耗时和空间随已回收范围增加，不能承诺配置回退即可立即完成。

## 后台压实与恢复维护保护

完成全局收尾后，后台压实只处理默认 `storage-default=blocks`、实例 `mode=blocks` 的当前业务日及已结束业务日，按业务日期降序优先当前日。即时上传仍同步形成不可变块并确认入库；压实在后台以有界事务合并小块，原回执事件 ID、文件位置和载荷摘要保持不变，只调整块定位与序号。新块、目录、回执换位及旧块删除同事务提交，失败保留原布局。压实会增加 scope `generation` 并清空过期认证，保留历史补齐进度。后续 `verify` 根据新代次从当前活跃块重新核验；blocks 模式允许旧副本已经回收，完整核验新块、回执和目录后重新生成当前代次证书，不能复用旧块水位。

后台压实使用独立预算：`maxBatches` 默认 100、上限 100，单次默认总预算 5000 毫秒；每批默认最多合并 1000 个片段（上限 2000）与 64 个来源块，每批事务预算最多 1000 毫秒。候选 SQL 的 statement timeout 按剩余总预算限制到 1～1000 毫秒，避免候选扫描单独耗尽运行预算。来源块同时满足小块字节阈值及 `entry_count <= floor(maxRows / 2)`，保证片段预算至少容纳两个候选块；在合法的 2 MiB 块配置下，也避免反复选中无法两块合并的组而使其他候选长期得不到处理。当前日及已结束业务日参与压实，优先当前日；即时上传仍先独立提交可靠块，再由后台按预算压实。普通 VACUUM 回收后的数据库内部页可供同日后续上传复用。实际物理页、自动 VACUUM 与 WAL 稳态证据仍须单独验收，不能把块数量下降当作磁盘空间释放或生产验证通过。

`revert` 的首事务写入 `migration:<device UUID>:<localId UUID>` 的 `maintenance={kind:'revert',generation,startedAt}`。该标记没有自动过期时间，CLI 退出、预算耗尽、恢复批次失败或进程重启后仍持续阻止该 scope 压实；上传仍可按 blocks 模式追加。恢复期间禁止 `verify`、`retire`、切读及其他改变恢复状态的逐实例命令。使用原 `revert` 命令续跑，直至 `mode=rows` 与完整恢复证书同事务完成，才会清标记。

如果决定停止恢复、继续使用块读取，可执行：

```bash
node scripts/monitorLogStorageMigration.js abort-maintenance --device="$AOS_DEVICE_ID" --instance="$AOS_LOCAL_ID"
```

该命令保留已恢复的部分旧行，清除恢复维护标记、恢复水位与认证，不切回 rows，也不删除日志。之后后台可以重新压实；需要完整恢复时再次 `revert` 将从最新活跃块首部开始，已有旧行必须匹配才会保留，缺失旧行按原事件 ID 和载荷恢复。不要手动删除维护标记或修改 generation；它们保护跨运行的定位一致性。`finalize` 和旧 API 回退仍须通过当前代次认证或完整恢复门槛。

## 全局收尾与 API 版本回退

只有全部实例完成切块、回收旧副本且旧表全局为空，才可执行：

```bash
node scripts/monitorLogStorageMigration.js finalize --confirm-finalize=yes --all-api-upgraded=yes
```

`--all-api-upgraded=yes` 表示执行者已根据整体发布记录核对所有接收入口均运行新版本；工具本身不探测 API 镜像版本。该事务按设备 UUID 顺序取得行锁，并取得旧表 ACCESS EXCLUSIVE 锁；任何旧行残留均拒绝执行。短锁内再次核对所有活跃块实例的 mode=blocks、切读证书代次与当前 generation 匹配，且认证水位覆盖最新块；未认证新尾块须先续跑 verify，rows/shadow 的活跃块禁止强切。只有没有活跃块的空 rows/shadow scope 才能转换。设置 `storage-default=blocks`、转换空旧模式 scope 后，仅对已经证明为空的旧表执行 TRUNCATE；输出实际旧关系前后字节和差额。正常 new localId 后续自动走块写入，未知但仍有旧行的历史 scope 必须继续旧读取，不能由默认值隐藏历史。

正式 Migration 的 AFTER INSERT STATEMENT guard 在全局默认 blocks 时阻止无 scope 或 blocks scope 的陈旧旧写入；SQLSTATE 55000 使陈旧请求事务回滚，采集器重传后按最新模式路由。已认证 `revert` 写入使用事务 LOCAL `apple.monitor_log_restore=verified` 例外，事务结束不污染连接池，恢复完成后显式 rows scope 可继续旧写入。不要手动设置该例外或直接改变 mode 绕过验证。

要回退旧 API，先对全部块实例（包括 finalize 后新发现的实例）执行 `revert` 到 rows。每个恢复范围保留最大已认证块 ID、链式摘要、恢复累计量和完成时间，确认全部活跃块都有对应恢复证书后再执行：

```bash
node scripts/monitorLogStorageMigration.js rollback-default --confirm-default-rollback=yes
```

全局设备锁和旧表锁内，任何 blocks/shadow scope、缺失恢复证书或超过恢复水位的新块都会阻断默认回退。成功后设 `storage-default=rows`，陈旧旧 API 对未来新实例的 INSERT 不再被 guard 误拒。只改变 scope mode 不能替代恢复证书。之后才按整体部署指南回退 API 制品；仍不执行整库恢复。

独立 `aos_log_test_cli_finalize` 库的完整演练覆盖：原 600 行 6 块在旧副本回收后压实为 2 块并重新认证；新默认实例的 8 个即时单块在恢复维护期间跳过压实、终止维护后压实为 1 块，随后逐原 ID／载荷摘要恢复 608 行；以及非空拒绝 finalize、旧历史 fallback rows、逐块回收、实际 TRUNCATE 638976 字节关系页、新实例 blocks 写入、陈旧 INSERT 55000 拒绝、LOCAL 认证恢复 600 行、未恢复新实例阻断默认回退、仅改 mode 而无恢复证书拒绝默认回退、全部恢复后默认 rows 以及后续新实例旧写入。实际值随本次数据页变化，不外推生产释放量。

工具没有提供“删除新表全部副本”或“删除旧表／索引”的快捷命令。正式 down Migration 在存在新回执时拒绝执行；表级退役另按经验证的完整恢复和容量方案执行，不将其混入灰度实例回收。

## 已验证与待验证范围

生产备份范围沿用 2026-10-05 用户确认的规则：常规业务备份排除全部 AOS 日志，新增 `monitor_log_files`、`monitor_log_blocks`、`monitor_log_block_accounts`、`monitor_log_receipts` 四张数据表同样排除，不扩大日志备份。生产业务恢复的验收只覆盖既有备份范围；日志回滚依赖已验证的压缩副本和明确保留的原表范围。本轮完整 AOS 日志 dump／恢复仅在合成库验证，不能作为生产全日志备份或恢复证据。

本工具的隔离真实事务用例覆盖：历史旧行、shadow 同步新增、keyset 断点恢复、未补齐拒绝切读、完整校验、blocks 新独有、限定日期回收、逐批恢复及恢复后幂等重传。另有持设备锁且 `createdAt` 早于水位的事务，验证 shadow 等待其提交后迁移不漏记录。单元测试覆盖全局锁竞争、解锁失败销毁、认证尾部超预算、回执序号／旧行载荷／目录边界／账号成员／关键词签名不一致、重新完整认证，以及块模式禁止 abort、压实代次变更后重新认证与恢复、持久恢复维护跨预算及执行器重启、显式终止维护后从首块完整重启。真实 PostgreSQL 演练额外验证非零毫秒、乱序、多账号目录和部分恢复期间的维护阻断。

```bash
docker compose -f docker-compose.aos-storage-test.yml exec -e RUN_FULL_LOG_DB=true runtime \
  npx jest test/monitorLogStorageMigration.test.js \
  test/monitorLogStorageMigration.integration.test.js --runInBand --coverage=false
```

上述真实数据库演练只允许 `aos_log_test_` 前缀隔离库，拒绝 DATABASE_URL 环境。合成演练不是生产全量、真实高峰与 30 天滚动生命周期验收；这些证据由主交付报告单列。

全局收尾用例单独启用，必须使用专用可清空的 `aos_log_test_cli_finalize` 库，不能复用有其他验收样本的库：

```bash
docker compose -f docker-compose.aos-storage-test.yml exec \
  -e DB_NAME=aos_log_test_cli_finalize -e DB_NAME_TEST=aos_log_test_cli_finalize \
  -e RUN_LOG_FINALIZE_DB=true runtime \
  npx jest test/monitorLogStorageMigrationFinalize.integration.test.js --runInBand --coverage=false
```
