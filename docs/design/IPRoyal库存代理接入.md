# IPRoyal 库存代理接入

> 状态：已部署；真实中国出口与 Apple 库存请求已验证，长期稳定性另行观察。
>
> 日期：2026-10-16。现有生产 Worker 代码为接入基线。

## 范围与固定参数

库存监控暂时仅允许 IPRoyal 中国住宅代理。入口固定 `geo.iproyal.com:12321`，以 HTTP CONNECT 访问 HTTPS 目标；使用十分钟粘性、高端池及 killswitch。不会切换供应商、直接访问 Apple 或自动购买流量。中国备用入口需要独立确认，不能以地区能力不同的入口静默降级。

保持 300 秒周期、三并发、全局约 1 RPS 加小幅抖动、三次有效库存请求恢复、五分钟 Apple 风控窗口及现有请求/流量预算。此次不调整恢复门槛、长窗口与持续告警。

## 私密配置与凭据

`INVENTORY_PROXY_FILE` 指向容器只读私密文件，内容如下（占位符不是可用凭据）：

```json
{
  "label": "iproyal-main",
  "url": "http://USERNAME:BASE_PASSWORD@geo.iproyal.com:12321",
  "tunnel": {
    "provider": "iproyal",
    "stickySeconds": 600,
    "expiresAt": null
  }
}
```

控制台只读凭据输入框可能返回掩码，不能直接把其 value 当作凭据。使用控制台可见集成示例中的真实用户名／密码，去除示例路由后缀后安全保存；先做受闸门约束的出口验证，再确认库存采集。

用户名和基础密码使用 URL 百分号编码；密码不得预拼接路由参数。`expiresAt` 为空表示未配置套餐期限；仅当已知套餐实际截止时间时填写带时区 ISO 时间，届时停止请求。该期限与每个会话十分钟有效期独立。旧 `INVENTORY_BACKUP_PROXY_FILE` 和 `INVENTORY_PROXY_API_FILE` 不参与选路；配置缺失、非法、被停用或未验证时关闭请求。

会话密码后缀严格为 `_country-cn_session-xxxxxxxx_lifetime-10m_streaming-1_killswitch-1`，session 使用八位随机字母数字。每个候选 URL 加密存储在现有保护状态中；日志、请求证据和接口仅保留固定标签、原因枚举、HTTP 状态及实际出口 IP 的 SHA-256 摘要。错误正文、用户名、密码、认证 URL 与原始出口 IP 不进入日志/文档/通知。

## 出口验证与持久化

继续使用数据库行锁领取探测租约、跨重启复用候选和预算。每个新候选先经过固定 HTTPS 出口回显主机白名单验证实际 IP，保存哈希后才允许库存请求。回显与库存请求均计入现有预算；回显成功不清空 Apple 风控、不累计库存恢复成功。

Apple 541 后仍要求不同的真实出口摘要；重命名或新建 session 不能冒充实际换 IP。保留被拒摘要和既有冷却。killswitch 防止供应商在会话失效时静默切换出口；410 使当前候选失效，下个受控候选重新验证。

## 供应商故障与有限轮换

CONNECT 状态仅作为代理供应商结果，不能解释为 Apple 风控或无货。IPRoyal 文档明确 500 为内部错误、503 为无匹配出口、504 为出口连接失败；这些状态与 410 会话失效进入供应商暂时故障路径。每次失败释放当前候选并保留失败计数，同候选并发失败只计一次；首次和第二次分别冷却 60/120 秒后选择候选，连续三次耗尽时停止供应商请求，需人工恢复。迟到旧会话结果只能结算预算，不能废弃新候选。明确人工恢复可清零供应商失败次数，但保留尚未结束的冷却、请求预算和 Apple 风控证据。出口验证失败同样受候选次数上限约束。

407 记录为代理认证失败并停用。其他未识别 CONNECT 拒绝（包括尚未获得官方明确解释的 402）保守停用为 `PROXY_CONNECT_REJECTED`，不推断欠费、封号或地区原因。网络超时/断连等仍受既有连续失败与恢复保护，不隐含重试。Apple 的 429/416/541 和结构校验继续原规则。

## 验收边界

使用本地 Docker 内合成代理、响应与保护状态测试验证严格配置、固定路由后缀、候选复用、并发租约、出口哈希、认证停用、临时故障有限轮换、持久化和敏感信息隔离。没有真实 IPRoyal/Apple 探测前，不宣称中国实际出口、Apple 可达、库存质量或长期稳定性通过。剩余流量及运行预算由发布前只读核验确认。

## 官方依据

- [粘性会话、八位 session、lifetime 与 killswitch 410](https://docs.iproyal.com/proxies/residential/proxy/rotation.md)。
- [高端池 streaming-1](https://docs.iproyal.com/proxies/residential/proxy/high-end-pool.md)。
- [住宅代理响应码 500、503、504](https://docs.iproyal.com/proxies/residential/proxy/making-requests/response-codes.md)。
- [中国备用入口能力差异](https://docs.iproyal.com/proxies/residential/proxy/making-requests/china-entry-nodes.md)。

首次真实认证失败与纠正、生产出口和自然轮次证据见[主审与生产发布](../archive/2026-10/2026-10-16-库存监控IPRoyal主审与生产发布.md)。

## 库存目标 307 的有限恢复

2026-10-16 的停采证据确认：CONNECT 成功后，目标 HTTP 307 被统一归为 `REDIRECT_BLOCKED`，单次响应即可形成持续人工暂停。旧证据没有保存 `Location`，原始目的地及上游为什么返回 307 均不可追溯；不能据此认定官网规范化路径、维护或其他具体原因。后续同上下文在新验证出口取得有效库存，也不能还原旧跳转目的地。

此次修复始终设置 `maxRedirects=0`，不跟随、不访问或消费任何 `Location`，只区分后续重试原始固定库存 URL 的处置方式：

- 仅 `purpose=inventory`、目标 HTTP 307 且 CONNECT 已确认 200 才适用有限恢复。`Location` 缺失、空字符串，或解析为 `https://www.apple.com.cn` 默认 443 且没有下列危险特征时，记录 `TARGET_REJECTED`，保留实际状态 307，并标记 `UNFOLLOWED_REDIRECT`。未知同源路径或参数不会获得访问授权。
- 外域、降级或其他协议、异常端口、用户凭据、片段、控制字符、非法编码、无法解析、过长以及明显 challenge/captcha/verify/login/auth 等挑战认证信号，仍记录 `REDIRECT_BLOCKED`，需人工处理。
- 其他用途、其他 3xx 或未确认 CONNECT 200 的响应维持原拒绝。CONNECT 失败仍先分类为供应商故障，不冒充 Apple 风控。

有限恢复完全复用既有冷却、实际不同出口验证、三次有效库存请求恢复及失败升级；不改变 RPS、恢复门槛、预算和冷却时长。每次只有原 URL 的一次许可、一次网络请求及一次结果结算；不会出现不计预算的隐含跳转。307 不作为有效库存或无货，不保存响应正文。

诊断只保存 `Location` 的 SHA-256 定长摘要和固定分类枚举（是否缺失、协议/主机/路径类别、决策及原因），不保存原始 URL、路径、查询参数、敏感请求头或原始响应头。摘要用于对比证据，不表示其目的地可信。
