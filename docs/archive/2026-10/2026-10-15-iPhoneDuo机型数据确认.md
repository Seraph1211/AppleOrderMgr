# iPhone Duo 机型数据确认

> 状态：历史归档（采集事实已核验，新增机型待用户确认）
>
> 核对日期：2026-10-15，北京时间
>
> 基线：当前工作树；生产运行版本 `20261015-order-filter-export`
>
> 验证范围：生产商品及价格表只读查询、现有源码溯源、IPRoyal 代理访问 Apple 中国大陆公开购买页；未修改业务数据、未开发或发布新增机型功能、未验证下单及门店库存。

## 现有 iPhone 18 Pro Max 的来源

生产 `stock_products` 与 `stock_official_prices` 只读查询得到 16 个规格，商品和价格均启用，逐项与本地冻结目录一致。

| 数据 | 来源与使用方式 |
| --- | --- |
| 型号、容量、中文颜色、国行 SKU | `src/data/inventoryCatalog.json` 的官网目录种子，记录观测时间为 `2026-10-02T13:02:53.215Z`（北京时间 21:02:53）；其 16 个 Pro Max 项与 `src/data/stockCatalogV20260921.json` 完全一致 |
| 原始官网数据结构 | `src/services/inventoryValidationCatalog.js` 按 `partNumber` 将 metrics 与 `productSelectionData.products` 对齐，中文名称取 `displayValues`；历史记录已说明不能仅用 metrics 名称区分 Pro 与 Pro Max，见[库存数据源验证](../../testing/库存数据源验证.md) |
| 当前固定裸机价格 | `src/utils/orderCatalogPricingV1.js`，版本 `cn-iphone18-20260921`；属于 2026-09-21 已确认价格，不是本次重新查询的现价 |
| 初始化数据库 | `migrations/20261004000003-stock-fixed-catalog.js` 将冻结规格及价格写入商品、价格表；价格来源标签为“已确认大陆裸机固定目录” |
| 录入可用性 | `src/services/stockFixedCatalog.js` 只允许固定 Pro Max 规格；`stockLedgerProjectionService.js` 返回 `entryEligible` 和固定成本 |

冻结目录文件名中的日期不能当作全部 SKU 的官网采集时间。现有来源口径另见[预置规格和成本](../../planning/自有库存简化版方案.md#预置规格和成本)。

| 容量 | 黑色 SKU | 银色 SKU | 冰川蓝色 SKU | 勃艮第酒红色 SKU | 当前系统单价（元） |
| --- | --- | --- | --- | --- | ---: |
| 256GB | MJY64CH/A | MJY74CH/A | MJY94CH/A | MJY84CH/A | 10,999 |
| 512GB | MJYA4CH/A | MJYC4CH/A | MJYE4CH/A | MJYD4CH/A | 12,999 |
| 1TB | MJYF4CH/A | MJYG4CH/A | MJYJ4CH/A | MJYH4CH/A | 16,499 |
| 2TB | MJYK4CH/A | MJYL4CH/A | MJYN4CH/A | MJYM4CH/A | 21,499 |

这里“只有 Pro Max”指库存录入固定目录；订单金额映射还包含 Pro，库存监控也有独立目录及 Pro／Pro Max 白名单，不能视作全系统只有一份机型数据。

## 本次官网 iPhone Duo 数据

通过现有 IPRoyal 账号生成一个中国区 24 小时 sticky 代理，开启 killswitch，未购买或充值。两次 Apple 请求均显式指定该代理、校验 HTTPS 证书，无直连回退：

1. 北京时间 20:13:20 读取[购买 iPhone 总页](https://www.apple.com.cn/shop/buy-iphone)，HTTP 200，发现 Duo 购买页。
2. 北京时间 20:14:07 读取[iPhone Duo 购买页](https://www.apple.com.cn/shop/buy-iphone/iphone-duo)，HTTP 200。

官方机型名称为 `iPhone Duo`，两种颜色、四档容量，共 8 个国行 SKU。下表价格为 CNY 裸机全价，未减以旧换新金额，不使用月供价格。按每个精确 `partNumber` 核对 metrics 的 `price.fullPrice` 与选择器价格对象的 `currentPrice.raw_amount`；核对 `validProducts` 包含该 SKU，8 项一致。

| 容量 | 内部容量值（GB） | 星光白色 SKU | 夜空色 SKU | 官网裸机单价（元） |
| --- | ---: | --- | --- | ---: |
| 256GB | 256 | MK2M4CH/A | MK2N4CH/A | 15,999 |
| 512GB | 512 | MK2P4CH/A | MK2Q4CH/A | 17,999 |
| 1TB | 1024 | MK2T4CH/A | MK2U4CH/A | 21,499 |
| 2TB | 2048 | MK2V4CH/A | MK2W4CH/A | 26,499 |

官网字段：metrics 分类 `iphone_duo`，选择器 `familyType`／`productLocatorFamily` 为 `iphoneduo`，颜色键为 `starwhite`／`nightsky`。

页面明确写明 **10 月 16 日晚 8 点接受预购、10 月 23 日发售**，并附“机型将在获得批准后发售”。尽管 8 项 `comingSoon`／`getReady` 均为 false，也不能凭这些标志断言现在已能下单；本次未执行购物袋、支付或门店库存请求。

## 后续接入影响与待确认项

用户要求先确认数据，本轮停留在确认阶段。建议以官方名称、全部 8 个 SKU 和上表价格作为新增目录基线；价格增加新版本，保留旧目录及历史成本。

正式实施时需覆盖库存商品及价格初始化、固定目录校验、入库／出库选择与提示、盒标机型／颜色识别。为支持明日订单金额计算，还需扩展现行价格映射；仅写入商品表会被当前 `entryEligible` 和固定目录规则挡住。若纳入库存监控，还涉及独立机型白名单及预售状态判定，不能因目录解析成功直接启用采集或通知。

下一步由用户确认现有数据源口径、Duo 的 8 项规格及价格，以及所需接入模块后实施。未进行代码提交、推送或生产写入。

## 验证与证据

- 生产两次受限只读查询，16 项商品、颜色、容量、SKU、价格及启用状态逐项一致；无用户、订单或身份信息查询。
- 现有正式目录解析器可解析本次 HTML 的 8 个 Duo 规格；SKU 唯一性、价格交叉核对通过。
- 本地证据目录 `.tmp/iphone-duo-catalog-20261015/`：`production-catalog.json`、官网原始响应与元数据、`product-selection.json`、`verified-duo-catalog.json`。代理凭据未复制至本地证据或文档。
- Duo 解压后 HTML SHA-256：`3532e3160c9292e1a53bf78978d3d04e94e92483051c244c25bc9b7ce2b1fe84`。
- 本次仅整理核验记录、历史索引和开发进度；文档检查结果见开发进度。
