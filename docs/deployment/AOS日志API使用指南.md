# AOS 日志 API 使用指南

> 状态：当前有效
>
> 最近核对：2026-10-19
>
> 适用范围：获授 `monitor.logs.read` 的普通用户，通过现有 HTTPS API 读取未经脱敏的 AOS 完整运行日志
>
> 基线：`main@29e45a2`、生产 `20261018-log-query-permission`
>
> 验证范围：根据当前生产接口实现、权限专项测试和既有生产发布记录静态整理；本文编写未创建账号、未调用生产接口、未读取日志正文

浏览器默认查询入口为`/server-monitor/logs`；需要原范围导出操作时使用`/server-monitor/logs?view=legacy`。兼容入口复用原查询／导出组件和权限，并非API鉴权例外。

## 1. 使用边界

本指南面向需要让 AI 程序自动查询 AOS 原始日志的内部同事。接口返回已经上传到平台的原始日志正文，不进行脱敏；可能包含邮箱、手机号、IP、代理信息或带参数的 URL，应按内部受限资料保存和传递。

第一阶段复用网站账号和 Bearer Token，不新增 API Key：

- 每位同事使用独立普通账号，不共享账号；
- 管理员只授予 `monitor.logs.read`（界面名称“查看 AOS 完整运行日志”）；
- 不需要授予 `monitor.manage`，后者还包含服务器监控、告警处理和规则配置；
- 权限、账号状态和活动会话在每次请求时重新校验，撤权或锁定账号后不能继续读取；
- 权限当前覆盖全部服务器、实例和最近 90 个北京时间自然日，尚不支持按服务器或实例细分授权；
- 查询和导出会记录操作人、请求方法、结果和 IP 等审计信息，但审计记录不保存日志正文。

生产站点示例：

```text
https://apple.godp.me
```

下文用 `AOS_BASE_URL` 表示站点根地址。若域名调整，只替换该值；API 前缀固定为 `/api`。

管理员开通步骤：

1. 在“用户管理”中为同事创建独立普通账号；
2. 在账号权限中只勾选“查看 AOS 完整运行日志”；
3. 保存后让同事登录，确认登录响应的 `user.permissions` 包含 `monitor.logs.read`；
4. 确认该账号能读取 `/api/server-monitor/logs/states`，但不能读取 `/api/server-monitor/overview`；
5. 不把管理员账号、管理员 Token 或设备采集凭证交给 AI。

命令行示例需要 `curl` 和 `jq`；Python 示例只使用 Python 3 标准库。

## 2. 认证

### 2.1 登录

```http
POST /api/auth/login
Content-Type: application/json

{
  "username": "同事的独立账号",
  "password": "账号密码"
}
```

成功响应：

```json
{
  "success": true,
  "data": {
    "token": "<Bearer Token>",
    "user": {
      "username": "示例账号",
      "role": "operator",
      "permissions": ["monitor.logs.read"],
      "availableHome": "/server-monitor/logs"
    }
  },
  "message": "登录成功"
}
```

JWT 默认有效期为 7 天，实际有效期以生产 `JWT_EXPIRES_IN` 配置和 Token 的 `exp` 为准。Token 还绑定数据库中的活动会话；仅解析 JWT 有效期不能证明会话仍然可用。

`curl` 示例：

```bash
export AOS_BASE_URL='https://apple.godp.me'
export AOS_USERNAME='替换为独立账号'
read -r -s -p 'AOS password: ' AOS_PASSWORD

LOGIN_BODY="$(jq -n \
  --arg username "$AOS_USERNAME" \
  --arg password "$AOS_PASSWORD" \
  '{username: $username, password: $password}')"

LOGIN_RESPONSE="$(printf '%s' "$LOGIN_BODY" | \
  curl --fail-with-body --silent --show-error \
  -H 'Content-Type: application/json' \
  --data-binary @- \
  "$AOS_BASE_URL/api/auth/login")"

export AOS_TOKEN="$(printf '%s' "$LOGIN_RESPONSE" | jq -er '.data.token')"
unset AOS_PASSWORD LOGIN_BODY LOGIN_RESPONSE
```

不要把账号密码、Token 写进代码仓库、AI 提示词、命令参数、日志或共享文档。以上示例把密码从终端读取并通过标准输入发送；环境变量仍只适合受控的临时终端，任务结束后应执行 `unset AOS_TOKEN AOS_USERNAME`。

### 2.2 后续请求头

除登录外，本文全部接口都要携带：

```http
Authorization: Bearer <Token>
Accept: application/json
```

通用调用示例：

```bash
curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer $AOS_TOKEN" \
  -H 'Accept: application/json' \
  "$AOS_BASE_URL/api/server-monitor/logs/states"
```

### 2.3 登出

不再使用某个会话时，可以主动注销：

```bash
curl --fail-with-body --silent --show-error \
  -X POST \
  -H "Authorization: Bearer $AOS_TOKEN" \
  "$AOS_BASE_URL/api/auth/logout"

unset AOS_TOKEN AOS_USERNAME
```

注销只结束当前 Token 对应的会话。

## 3. 标准响应和时间口径

成功响应统一为：

```json
{
  "success": true,
  "data": {}
}
```

标准业务错误通常为：

```json
{
  "success": false,
  "error": {
    "code": "FORBIDDEN",
    "message": "当前账号无权执行此操作"
  }
}
```

登录的部分旧错误响应使用顶层 `message`。调用方应同时兼容：

```text
error.message ?? message ?? HTTP 状态说明
```

日期按北京时间解释：

- `date` 使用 `YYYY-MM-DD`；
- 只能查询北京时间今天及之前 89 天；
- `fromTime`、`toTime` 使用 `HH:mm:ss`；
- `toTime` 包含该秒，例如 `12:00:00` 会包含 12:00:00.xxx 之前归属于该秒的记录；
- API 返回的时间戳为 ISO 8601，调用方展示时自行转换为目标时区。

日志接口响应均带 `Cache-Control: no-store`。

## 4. 查询服务器、实例和可用日期

```http
GET /api/server-monitor/logs/states
```

```bash
curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer $AOS_TOKEN" \
  "$AOS_BASE_URL/api/server-monitor/logs/states" | jq
```

核心响应结构：

```json
{
  "success": true,
  "data": {
    "devices": [
      {
        "id": "<deviceId>",
        "name": "US Server No.1",
        "enabled": true,
        "heartbeatAt": "2026-10-19T08:00:00.000Z"
      }
    ],
    "instances": [
      {
        "deviceId": "<deviceId>",
        "localId": "<localId>",
        "label": "心蓝01",
        "active": true,
        "observedAt": "2026-10-19T08:00:00.000Z",
        "fresh": true,
        "snapshot": {
          "state": "ready",
          "dates": ["2026-10-19"],
          "fileCount": 1,
          "totalBytes": 1000,
          "scannedBytes": 1000,
          "pending": 0,
          "issues": 0,
          "expired": 0
        }
      }
    ],
    "first": "2026-07-22",
    "today": "2026-10-19"
  }
}
```

调用方通过 `instances[].deviceId` 关联 `devices[].id`，后续日志接口必须同时传入目标 `deviceId` 和 `localId`。

采集状态含义：

| `state` | 含义 |
| --- | --- |
| `ready` | 当前扫描已完成 |
| `catching_up` | 正在采集或补传 |
| `backpressure` | 本地上传队列积压 |
| `missing` | 未找到日志文件 |
| `unreadable` | 存在无法读取的文件 |
| `error` | 采集异常 |

`fresh=false`、`pending>0`、非 `ready` 或目标日期仍在补传时，空查询不能证明当天没有日志。历史补传可能把更早记录插入已经翻过的游标之前；需要完整分析时，应等待状态稳定后从首页重新查询。

## 5. 查询账号候选

```http
GET /api/server-monitor/logs/accounts
```

参数：

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `deviceId` | 是 | 服务器 UUID |
| `localId` | 是 | 实例 UUID |
| `date` | 是 | 北京时间日期 |
| `search` | 否 | 账号编号字面包含，最长 64 字符 |
| `after` | 否 | 上一页 `nextCursor`，不要自行解析或改写 |

示例：

```bash
curl --fail-with-body --silent --show-error --get \
  -H "Authorization: Bearer $AOS_TOKEN" \
  --data-urlencode "deviceId=$AOS_DEVICE_ID" \
  --data-urlencode "localId=$AOS_LOCAL_ID" \
  --data-urlencode "date=$AOS_DATE" \
  --data-urlencode 'search=01' \
  "$AOS_BASE_URL/api/server-monitor/logs/accounts" | jq
```

响应：

```json
{
  "success": true,
  "data": {
    "items": ["001", "010", "011"],
    "nextCursor": null
  }
}
```

每页最多 100 个账号。`nextCursor` 非空时，把它原样作为下一次请求的 `after`；前导零属于账号原值，不能转换成数字。

## 6. 分页查询日志

```http
GET /api/server-monitor/logs
```

参数：

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `deviceId` | 是 | 服务器 UUID |
| `localId` | 是 | 实例 UUID |
| `date` | 是 | 北京时间日期 |
| `account` | 否 | 账号编号；`__unassigned__` 表示未识别账号；不传表示全部 |
| `fromTime` | 否 | `HH:mm:ss` |
| `toTime` | 否 | `HH:mm:ss`，不能早于 `fromTime` |
| `keyword` | 否 | 区分大小写的字面包含，最长 200 字符，不是正则表达式 |
| `limit` | 否 | 1–100，默认 50 |
| `cursor` | 否 | 上一页 `nextCursor`；首页应省略或传空字符串 |

设置 `fromTime` 或 `toTime` 后，只返回具有明确 `loggedAt` 的记录；缺少原始时间的未识别行不会因为排序时间落入该窗口而被返回。如需同时分析这些记录，应取消时间筛选并按 `sortAt` 在调用方处理。

```bash
curl --fail-with-body --silent --show-error --get \
  -H "Authorization: Bearer $AOS_TOKEN" \
  --data-urlencode "deviceId=$AOS_DEVICE_ID" \
  --data-urlencode "localId=$AOS_LOCAL_ID" \
  --data-urlencode "date=$AOS_DATE" \
  --data-urlencode 'account=001' \
  --data-urlencode 'fromTime=08:00:00' \
  --data-urlencode 'toTime=12:00:00' \
  --data-urlencode 'keyword=下单' \
  --data-urlencode 'limit=100' \
  "$AOS_BASE_URL/api/server-monitor/logs" | jq
```

响应：

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "id": "<日志事件UUID>",
        "deviceId": "<deviceId>",
        "localId": "<localId>",
        "fileId": "<文件版本UUID>",
        "fileName": "Log20261019_example.txt",
        "businessDate": "2026-10-19",
        "loggedAt": "2026-10-19T00:00:00.123Z",
        "sortAt": "2026-10-19T00:00:00.123Z",
        "accountNumber": "001",
        "lineNumber": "100",
        "partIndex": 0,
        "byteOffset": "12345",
        "message": "<未经脱敏的原始日志片段>",
        "rawBase64": null,
        "parseState": "parsed",
        "createdAt": "2026-10-19T00:00:01.000Z",
        "updatedAt": "2026-10-19T00:00:01.000Z"
      }
    ],
    "nextCursor": "<不透明游标或null>"
  }
}
```

字段说明：

| 字段 | 说明 |
| --- | --- |
| `message` | 未经脱敏、未截断的当前片段正文 |
| `loggedAt` | 原日志明确时间；未识别时间时为 `null` |
| `sortAt` | 稳定排序时间，不一定是原始时间 |
| `accountNumber` | 第二组方括号解析出的账号；未识别时为 `null` |
| `lineNumber` | 一起始源文件物理行号；以字符串返回时不要转成低精度数字 |
| `partIndex` | 超长物理行的零起始分段号 |
| `byteOffset` | 源文件字节位置；以字符串处理 |
| `rawBase64` | 编码损坏时保留的原始字节，正常记录为 `null` |
| `parseState` | `parsed`、`continuation`、`unparsed` 或 `encoding_error` |

分页规则：

1. 首页省略 `cursor`；
2. 处理本页 `items`；
3. `nextCursor` 为 `null` 时结束；
4. 否则保持全部筛选条件完全不变，只增加下一页 `cursor`；
5. 游标绑定原筛选条件，修改任一筛选条件后必须重新从首页开始；
6. 游标是不透明值，不要解码、拼接或保存为其他数据类型；
7. 不要并发请求同一分页链的多个未知后续页。

接口不返回总条数，避免对大规模日志执行无界计数。原始重复日志会保留；调用方不要仅以 `message` 去重，若需要防止网络重试重复处理，应使用稳定的 `id`。

## 7. 查询上下文

```http
GET /api/server-monitor/logs/:id/context
```

参数：

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `scope` | 是 | `account` 或 `instance` |
| `limit` | 否 | 每个方向 1–100，默认 100 |
| `direction` | 翻页时是 | `before` 或 `after` |
| `cursor` | 翻页时是 | 上下文边界日志的 `id`，必须和 `direction` 同时传入 |

- `scope=account`：同服务器、实例、日期和账号；目标日志必须已识别账号。
- `scope=instance`：同服务器、实例和日期，包含未识别账号记录。

首次查询：

```bash
curl --fail-with-body --silent --show-error --get \
  -H "Authorization: Bearer $AOS_TOKEN" \
  --data-urlencode 'scope=instance' \
  --data-urlencode 'limit=100' \
  "$AOS_BASE_URL/api/server-monitor/logs/$AOS_LOG_ID/context" | jq
```

首次响应按顺序返回目标前文、目标记录和后文：

```json
{
  "success": true,
  "data": {
    "anchorId": "<目标日志UUID>",
    "scope": "instance",
    "direction": null,
    "items": [],
    "hasMoreBefore": true,
    "hasMoreAfter": true
  }
}
```

继续向后读取时，使用当前 `items` 最后一条的 `id`：

```bash
curl --fail-with-body --silent --show-error --get \
  -H "Authorization: Bearer $AOS_TOKEN" \
  --data-urlencode 'scope=instance' \
  --data-urlencode 'direction=after' \
  --data-urlencode "cursor=$AOS_CONTEXT_LAST_ID" \
  --data-urlencode 'limit=100' \
  "$AOS_BASE_URL/api/server-monitor/logs/$AOS_LOG_ID/context" | jq
```

继续向前读取时，使用当前 `items` 第一条的 `id`，并传 `direction=before`。翻页响应使用 `hasMore` 表示该方向是否还有数据。

### 独立日志UI的精确范围扩展（2026-11-01，本地实现）

当前主线已支持 `startAt/endAt` 无时区北京时间连续范围和90天跨日上下文，本地旧副本不能代表生产版本。本轮保留这些契约，增加可选 `timeBasis=loggedAt`：列表与账号候选按原始日志时间包含开始秒和整个结束秒，不混入原始时间为空的记录。省略口径保持既有 `sortAt`；完整自然日查询可保留按日归档的异常记录，原始时间仍为空。旧单日与导出不变。

账号候选新增与列表同形的 `startAt/endAt/timeBasis`；不得与 `date/startDate/endDate` 混用。新范围使用不透明 `cursor`，绑定资源、全部端点、口径与搜索词；改变条件须从头取候选。旧日期／日期范围接口继续使用 `after` 字符串。详见[权威API契约](../design/API设计.md#完整运行日志查询2026-09-29)。本轮只在隔离库验证，未发布生产。

## 8. 流式导出当天完整日志

```http
GET /api/server-monitor/logs/export?deviceId=&localId=&date=
```

AI 或命令行程序可以直接使用普通 Bearer Token 下载，不需要浏览器页面使用的 60 秒下载 Cookie：

```bash
curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer $AOS_TOKEN" \
  --get \
  --data-urlencode "deviceId=$AOS_DEVICE_ID" \
  --data-urlencode "localId=$AOS_LOCAL_ID" \
  --data-urlencode "date=$AOS_DATE" \
  --output "aos-$AOS_DATE.log" \
  "$AOS_BASE_URL/api/server-monitor/logs/export"
```

导出规则：

- 只接受 `deviceId`、`localId`、`date`；
- 导出该服务器、实例和日期当时已经入库的全部正文；
- 不接受账号、时间、关键词或分页筛选；
- 按日志稳定顺序流式输出 `text/plain; charset=utf-8`；
- 服务端按小页读取，不会一次性把全天日志装入内存；
- 客户端也应流式写文件，不要先把整个响应加载进 AI 上下文或内存；
- 采集仍在补传时，下载文件只代表下载时已经入库的内容；补传完成后应重新下载。

如果 AI 只需要一个时间段或关键词结果，应优先分页调用 `/logs`，不要下载整天日志后再过滤。

## 9. Python 分页示例

下面示例使用 Python 标准库登录并将查询结果逐条写为 JSON Lines。凭据和范围从环境变量读取，正文保持原样：

```python
import json
import os
import sys
import urllib.parse
import urllib.request


base_url = os.environ['AOS_BASE_URL'].rstrip('/')
username = os.environ['AOS_USERNAME']
password = os.environ['AOS_PASSWORD']


def request_json(path, *, token=None, method='GET', body=None, query=None):
    url = f'{base_url}{path}'
    if query:
        url += '?' + urllib.parse.urlencode(query)
    headers = {'Accept': 'application/json'}
    data = None
    if token:
        headers['Authorization'] = f'Bearer {token}'
    if body is not None:
        headers['Content-Type'] = 'application/json'
        data = json.dumps(body, ensure_ascii=False).encode('utf-8')
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=30) as response:
        return json.load(response)


login = request_json(
    '/api/auth/login',
    method='POST',
    body={'username': username, 'password': password},
)
token = login['data']['token']

filters = {
    'deviceId': os.environ['AOS_DEVICE_ID'],
    'localId': os.environ['AOS_LOCAL_ID'],
    'date': os.environ['AOS_DATE'],
    'limit': '100',
}
if os.environ.get('AOS_ACCOUNT'):
    filters['account'] = os.environ['AOS_ACCOUNT']
if os.environ.get('AOS_FROM_TIME'):
    filters['fromTime'] = os.environ['AOS_FROM_TIME']
if os.environ.get('AOS_TO_TIME'):
    filters['toTime'] = os.environ['AOS_TO_TIME']
if os.environ.get('AOS_KEYWORD'):
    filters['keyword'] = os.environ['AOS_KEYWORD']

cursor = None
while True:
    query = dict(filters)
    if cursor:
        query['cursor'] = cursor
    page = request_json('/api/server-monitor/logs', token=token, query=query)['data']
    for item in page['items']:
        sys.stdout.write(json.dumps(item, ensure_ascii=False) + '\n')
    cursor = page['nextCursor']
    if not cursor:
        break
```

运行示例：

```bash
export AOS_BASE_URL='https://apple.godp.me'
export AOS_USERNAME='替换为独立账号'
read -r -s -p 'AOS password: ' AOS_PASSWORD
export AOS_PASSWORD
export AOS_DEVICE_ID='替换为服务器UUID'
export AOS_LOCAL_ID='替换为实例UUID'
export AOS_DATE='2026-10-19'
export AOS_KEYWORD='下单'

python3 aos_log_export.py > aos-2026-10-19.jsonl

unset AOS_PASSWORD AOS_TOKEN AOS_USERNAME AOS_DEVICE_ID AOS_LOCAL_ID AOS_DATE AOS_KEYWORD
```

长期自动任务不应把密码直接写入脚本或命令行；第一阶段应由受控密钥存储在运行时注入。正式长期机器凭据属于后续专用 API Key 方案，不在本文范围内。

## 10. 状态码与处理建议

| HTTP 状态 | 常见原因 | AI 调用建议 |
| --- | --- | --- |
| `200` | 成功 | 按 `data` 处理 |
| `400` | 日期、时间、UUID、筛选或游标无效 | 修正请求；筛选改变后从首页重查 |
| `401` | Token 缺失、过期或活动会话失效 | 重新登录；不要无限重试旧 Token |
| `403` | 缺少 `monitor.logs.read` 或账号锁定 | 停止重试并联系管理员 |
| `404` | 日志事件不存在或已超过保留期 | 停止该事件的上下文查询 |
| `429` | 登录请求过于频繁 | 按响应头退避，不要并发反复登录 |
| `503` | 日志临时不可用或压缩块校验失败 | 有限退避重试；持续失败时记录错误码并联系管理员 |

可能遇到的日志错误码：

| 错误码 | 含义 |
| --- | --- |
| `FORBIDDEN` | 当前账号无日志读取权限 |
| `SESSION_EXPIRED` | 活动会话不存在或已失效 |
| `SESSION_REPLACED` | 当前会话已不在账号活动会话中 |
| `FULL_LOG_TEMPORARY` | 日志服务暂时不可用 |
| `FULL_LOG_CORRUPT` | 压缩日志块格式、长度或摘要校验失败 |

重试建议：

- `400`、`403`、`404` 不自动重试；
- `401` 最多重新登录一次，仍失败则停止；
- `429` 按服务端提示等待；
- `503` 可采用 1、5、15 秒有限退避，最多 3 次；
- 网络超时后重试同一页不会修改业务数据，处理端用日志 `id` 避免重复消费；
- 不要通过提高并发或去掉日期、实例条件追赶失败任务。

## 11. AI 接入检查清单

- [ ] 每位同事使用独立普通账号。
- [ ] 账号仅授予 `monitor.logs.read`，未授予 `monitor.manage` 或其他无关权限。
- [ ] AI 通过 HTTPS 和 `Authorization` 请求头传 Token，不把 Token 放在 URL。
- [ ] Token、密码和原始日志不进入 Git、普通应用日志或共享提示词。
- [ ] 首次调用 `/states` 获取真实 `deviceId`、`localId` 和日期范围。
- [ ] 分页查询保持筛选不变，使用原样 `nextCursor`，结束条件为 `null`。
- [ ] 前导零账号始终按字符串处理。
- [ ] 大范围分析逐页或流式落盘，不一次性载入全部日志。
- [ ] `catching_up`、积压或过期状态下不把空结果解释为“没有日志”。
- [ ] 任务结束后注销会话或清理本地 Token。

## 12. 相关文档

- [API 契约](../design/API设计.md#完整运行日志查询2026-09-29)
- [服务器监控](../design/服务器监控.md#完整运行日志查询2026-09-29已发布)
- [AOS 完整日志查询实施方案](../planning/AOS完整日志查询实施方案.md)
- [测试与验收指南](../testing/测试与验收指南.md)
