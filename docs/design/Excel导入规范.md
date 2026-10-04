# Excel 导入规范

> 状态：当前有效（2026-09-17 本地实现，真实全量导入与生产验收待执行）

## 文件与权限

使用随仓库固定的 SheetJS 0.20.3 制品，来源与校验见[第三方依赖说明](../../vendor/README.md)。基础档案首次从表格导入后由系统维护，不持续同步腾讯文档。

仅接受 `.xlsx`；一次最多 20 个 files 或一个兼容 file，各文件不超过 10MB，总有效源行最多 10000。工作表范围不得超过 20001 行／101 列。上传文件在预览结束后删除。预览只读，不创建档案。

模板、预览、重新预览、执行都需要登录；分别要求对应 `*.template.read` 或 `*.import` 权限。修改已有档案另需对应 edit 权限；取机人表同时创建账号需 `apple_ids.import`，建立或改变绑定需 `recipients.bind_apple_ids`，修改已有密保需 `apple_ids.secrets.read`。缺少权限时整批回滚，不绕过其他模块权限。

## 来源与标准表头

| 类型            | 工作表与列                                                                                                                                                                                |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Apple ID 标准表 | 工作表 Apple IDs；Apple ID、密码、国家、状态、备注、密保问题1、密保答案1、密保问题2、密保答案2、密保问题3、密保答案3                                                                      |
| 腾讯账号表      | 只读取以 26年AppleID 开头的两个来源表；A 账号、B 密码、D—I 三组问答、K 状态；大陆 L 备注，香港 L 不作备注；J、M 忽略；国家统一中国                                                        |
| 取机人          | 读取含身份证号／身份证号码列的各渠道工作表；标准列为 Apple ID、密码、下单手机号码、Email、省、市、区、街道地址、使用状态、姓、名、身份证号码、TAG、渠道、信息导入模板、真实联系电话、备注 |

标准模板前 1000 行预设文本格式，身份证不能以 Excel 数值存储。数值身份证列为错误，不尝试恢复丢失的低位。来源公式不执行；无缓存值的有效字段公式报错。信息导入模板列作为导出结果，导入时不参与字段解析。

支持旧表头别名（手机号、邮箱、标签、备注名称等），统一保存为当前字段；不再建立昵称字段。仅有姓名而无姓／名时要求修正源表，不自动拆复姓。来源“已挂服务器”和“已挂 需下架”映射使用中，“已进表 未挂”映射未使用，不保留原状态。新建缺省未使用，绑定／解绑不联动状态。

“渠道”是取机人档案的单值可空标签，导入时去除首尾空白，最长 100 字符；空单元格不覆盖已有渠道。它独立于原始 TAG，不参与订单权限、付款分配或渠道管理，也不从工作表名称、AOS 字段或 TAG 推断。完整敏感导出的外部“信息导入模板”文本保持原固定格式，不插入渠道列。

下单邮箱仅允许 @vvv8.net；自动生成时为下单手机号加该域名。新账号需密码；仅提供已有账号邮箱可绑定，不创建假密码。密保如提供需完整三组问答，问题代码保持原字符串。

## 预览、差异与执行协议

1. `GET /api/import/template/:type` 下载模板；type 为 apple_ids 或 recipients。
2. `POST /api/import/preview?type=...`：multipart 上传 files（兼容 file）。返回 sessionToken、expiresInSeconds、summary、records、conflicts、errors。每条记录带文件／工作表／原行号；密码和密保在预览中不回显。
3. 身份证标准化后去重；账号按去首尾空白、忽略大小写去重。同证件不同姓名需裁定；同名不同证件独立。空来源不擦除库值，来源有值而库为空可补齐，非空差异必须选择来源。冲突字段用 conflict.id 作为键，值为返回的 options.key；整条跳过键为 `记录id:skip`、值 true。
4. `POST /api/import/review` 接收 `{ sessionToken, type, decisions }`，按选择重新计算预览。尚有差异、账号占用或资料问题时不能执行；可跳过问题档案。无效源行单列且不导入。
5. `POST /api/import/execute` 提交相同结构。执行前消费令牌，事务内串行化档案写入，重新验证库中档案摘要；资料已变返回 409，要求重新上传。无半批写入。返回 imported、updated、skipped、errors；档案计数可能同时包含取机人和账号，不能理解为源行数。

会话绑定用户及类型、15 分钟有效，最多每人 5 个在途预览。进程内保存，不跨实例持久化；进程重启、切换实例后需要重新上传。生产多实例须保持会话粘性或另行建设共享会话存储。

## 导出及回导

普通导出为脱敏 Excel，不生成完整录入串。完整导出显式 `includeSensitive=true`，要求 `recipients.export_sensitive`；前端根据权限显示“导出录入信息”或“导出脱敏资料”。支持勾选导出和当前筛选导出。

完整导出不生成工作簿，只把腾讯模板 N 列“信息导入模板”的计算结果写入 UTF-8 TXT：每条档案一行、无列名、无状态／真实电话／备注等附加列。每行按已核对公式保留连续逗号、WECHAT 配置及尾部占位，空账号／地址输出空字符串；字段内换行替换为空格，避免拆成额外记录。脱敏 Excel 不可作为完整档案回导，录入 TXT 也不是本系统的批量导入格式。

来源、具体规则与验收见[实施方案](../planning/取机人与AppleID管理实施方案.md)。代码：[解析](../../src/services/importService.js)、[差异计划](../../src/services/profileImportService.js)、[接口](../../src/controllers/importController.js)、[前端](../../frontend/src/components/BatchImportModal.jsx)。

## 身份核验名单与结果

此模块独立于 `/api/import`，不创建或修改取机人和订单。权限为 `identity.read` 加 `identity.batch`，导出另需 `identity.export`；管理员全部可见，普通用户仅本人批次。

- 使用[身份核验模板](../../templates/identity_verification_template.xlsx)，列名为「姓名」「身份证号」；工作表优先选择「身份核验」，否则读取首个工作表。
- 仅 `.xlsx`，文件最多 10MB，非空数据最多 1000 行；模板两列均为文本。解析范围超过 10000 行／100 列时拒绝。
- 身份证数字单元格与公式一律拒绝，不猜测 Excel 丢失的低位；保留原始行号与输入文本。先验证姓名、18 位大陆身份证、出生日期和校验位。
- `POST /api/identity-verifications/preview` 接受唯一 file 字段，保存加密草稿，15 分钟内通过批次 start 开始；上传不会调用供应商。
- 同一批次按去首尾空白的姓名及大写身份证组合去重，保留每个原始行，共用首次出现行的结果；相同证件不同姓名分开核验。格式错误不外呼。
- 结果下载将原始姓名、身份证号、说明和返回业务信息全部写为文本单元格，避免证件精度丢失与公式注入。查看与导出均保留原文，这是用户明确批准的身份核验规则。

接口、状态、暂停与恢复见[API 契约](API设计.md)，背景和验收边界见[接入方案](../planning/身份核验接入方案.md)。

## 自有库存、历史销售与资金导入

2026-10-04 本地实现。下述规则仅用于 `/api/stock`；已通过专用 PostgreSQL 合成数据验证，尚未执行生产历史数据导入或真实业务验收。来源订单可以待补，真实 SN 不能缺失；历史已售不能借道当前仓库扣减库存。模型与字段边界见[自有库存数据契约](../database/自有库存与销售数据契约.md)，全部接口见[API 契约的自有库存段](API设计.md#自有库存与销售接口目标契约)。

### 文件、字段与权限

- 使用仓库既有 SheetJS 制品，只接受单个 `.xlsx` 或 UTF-8 `.csv`，上传字段为 `file`。单文件不超过 10MiB、数据不超过 500 行、最多 64 列。XLSX 同时检查压缩目录与受限解压后的实际大小，展开总量不超过 50MiB；不接受加密或不完整压缩包。
- 优先读取“数据”表，否则读取首表；可附一张“填写说明”，不接受其他有内容的数据表。表头同时接受模板中文名称及下表 camelCase 字段名，未知列、重复列和公式单元格均拒绝；不会执行公式或读取供应商图片来推断价格。
- 商品可填 `productId`，也可精确填写 `modelName/storageGb/colorName`。容量为 GB 整数。位置和人员可填 ID，也可填对应 Name 字段；名称必须唯一且与基础资料完全相同，同时填写 ID 和名称时两者必须一致。导入不自动创建商品、仓库或人员。
- 拿货日填写 `YYYY-MM-DD`，其他业务时间使用带时区的 ISO 文本，如 `2026-10-04T15:30:00+08:00`。不把 Excel 日期序号、系统录入时间或所在浏览器时区猜作业务时间。
- 所有类型要求 `stock.read`、`stock.import` 及所属业务权限；填写成本另需 `stock.cost.read/edit`，填写来源订单另需 `stock.source.link`、`orders.read`、`pickups.read/edit` 及订单 TAG 范围。模板按当前权限省略无权填写的成本与来源列；预览、回读和提交再次检查当前权限。成功预览中的来源订单失去 TAG 访问权后也不能回读其旧来源信息。

| kind                           | 必填及归组规则                                                                                                                                             | 可选或成组字段                                                                                                                                                                                       | 追加权限                                                               |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `opening`（期初现货）          | `serialNumber`、商品、`locationId/locationName`；SN 按现有扫码规则标准化，已在库／在途／已售不能重复导入                                                   | `acquiredOn`、`costAmount/costBasis`、`sourceOrderId`；`receivedAt` 省略时采用管理员配置的 `cutoverAt`，显式填写时也必须等于该时点                                                                   | `stock.receive`                                                        |
| `historical_sales`（历史已售） | `saleKey`、`serialNumber`、商品、`channel`、销售负责人、交货人、`shippedAt`、`saleAmount`；重庆自销还需客户；同一 `saleKey` 的渠道、人员、时间及备注须一致 | `customerId/customerName`（代卖最终客户未知可空）、`consigneeLocationId/consigneeLocationName`（代卖必填）、`fromLocationId/fromLocationName`（未知用系统历史地点）、拿货日、成本、来源订单、`notes` | `stock.sales.read/ship`                                                |
| `collections`（客户付款）      | `externalRecordKey`、`saleId/saleNo`、`destination`、`amount`、`receivedAt`；金额必须等于本单全部已售机器售价                                              | `collectorId/collectorName`（`agent` 必填，`company` 不填）、`notes`                                                                                                                                 | `stock.collections.read/edit`；公司直收另需 `stock.receipts.read/edit` |
| `receipts`（公司到账）         | `externalRecordKey`、`payerId/payerName`、`amount`、`receivedAt`；只导入合作人全额或部分转回，公司直收由客户付款同时生成                                   | `saleId/saleNo`、`allocationSerialNumber`、`allocationAmount` 三组一起填写，全部为空表示暂未分配；`notes`                                                                                            | `stock.receipts.read/edit`                                             |

`channel=local/consignment`，`destination=company/agent`；模板也接受“自销／重庆自销／代卖”和“公司／代收”。人员字段使用 `customerId/customerName`、`salespersonId/salespersonName`、`handlerId/handlerName`；负责人和交货人必须具备对应业务角色，代收人或转款人可以是有效的外部人员或商户。

成本不明时留空，不能填 0。填写 `costAmount` 时必须同时填写拿货日期与 `costBasis`，以拿货当日对应官网价作人工确认的成本快照；之后补订单或维护价格不会自动重算已有成本。历史出货时间必须早于 `cutoverAt`，仅可新建历史已售实物或把 registered 身份补成已售，不能覆盖当前现货。

每次都需填写 `sourceLabel`（来源名称），来源内资金记录的 `externalRecordKey` 必须稳定，换文件或重新排序不换键。数据库唯一键为 SHA-256（来源名称 NFKC 标准化并 trim + NUL + 原始外部键 trim）；外部键保留大小写，不根据同金额同日期猜测重复。公司到账可同键多行分配不同 SN，但每行金额都是该笔到账总额，不能逐行累计；同组转款人、总额、时间、备注必须一致，不能分配到其他代收人的货款。

### 预览、确认及导出

1. `GET /api/stock/imports/template?kind=...` 下载中文表头模板与填写说明，无示例业务记录。
2. `POST /api/stock/imports/preview` 上传 `file/kind/sourceLabel`，解析后加密保存有限行载荷，返回 `previewId`、`version`、`previewHash`、`rows[{rowNumber,data,errors}]`、归组 `groups`、全体 `errors`、`canCommit` 与有效期。预览不写实物、销售或货款。
3. `POST /api/stock/imports/:id/commit` 传 `requestKey/expectedVersion/previewHash`。服务端在统一事务锁内重新读权限、相关资料版本、SN 和资金键，整批校验及写入；任何错误均回滚，不静默部分成功。相同请求键可安全重放，失败事务不遗留成功幂等记录。单批 500 行可以在同一事务中内部拆为有限处理段，但不能分别提交。
4. `GET /api/stock/imports/:id` 仅本人或管理员可读，并遵循当前业务及字段权限。已提交结果通过 `resultRefs` 返回实物、销售、付款或到账引用；不把预览成功当作已入账。
5. `GET /api/stock/export` 支持 `entity=units/sales/receipts`、白名单 `fields` 与所属列表筛选，每次最多 5000 行。导出读取同一只读数据库快照和权限投影；未确认金额留空。用户文本按纯文本输出，并转义以 `= + - @` 等起始的内容，已校验金额保留数值单元格及两位格式。

### 过期预览维护

预览有效 24 小时。应用启动和普通查询不会自动清理；过期后提交返回冲突。维护命令 `npm run stock:cleanup-previews` 默认仅统计过期且未提交的预览，不写数据。显式加 `-- --apply` 后每次最多清理 500 条：清空加密载荷、标记 `expired` 并递增版本，保留批次元信息及追加式操作审计；已提交批次和 `resultRefs` 永远不在清理范围。

可用 `--before <带时区的ISO时间>` 缩小过期范围，不允许未来时间；`--created-by <用户ID>` 可限定创建人。库存专用隔离库之外，实际清理还必须提供 `--confirm-database <实际数据库名>`，服务端按连接到的数据库名逐字核对。清理是显式运维动作，不代替生产备份或发布步骤；本轮仅在专用测试库验证。

实现入口：[导入服务](../../src/services/stockImportService.js)、[接口适配](../../src/controllers/stockImportController.js)、[维护脚本](../../scripts/cleanupStockImportPreviews.js)。专项验证见[验收清单](../testing/自有库存与销售管理验收清单.md)及[真实数据库导入测试](../../test/stockImport.integration.test.js)。
