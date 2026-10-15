/**
 * 生成仅包含占位参数的 API 使用说明，不接收任何令牌或证件值。
 * @param {string} origin 当前系统来源。
 * @returns {string} 可复制的使用说明。
 */
export function buildIdentityApiGuide(origin) {
  const url = new URL('/api/internal/v1/identity/verify', origin);
  url.protocol = 'https:';
  return `身份核验 API 使用说明

HTTPS GET ${url.origin}${url.pathname}?name=<URL编码后的姓名>&idCardNumber=<18位身份证号>&token=<本人API令牌>
仅接受 name、idCardNumber、token 三个单值参数，不允许重复键、数组、对象或其他参数。令牌从“API”页单独复制，不能使用后台登录 JWT。
使用 URLSearchParams 或等价参数构造器编码全部参数；禁止拼接未经 URL 编码的姓名。不要把含真实令牌、证件的完整 URL 分享到聊天或浏览器地址栏。

返回 JSON：
一致：HTTP 200，success=true，data.status="matched"，data.matched=true。
不一致：HTTP 200，success=true，data.status="mismatched"，data.matched=false。不一致也是确定的核验结果。
未知：success=false，error.code="RESULT_UNKNOWN"，status="unknown"、matched=null；不得解释为不一致。保留 requestId 和 verificationId 交管理员核查。
响应含 requestId；确定结果含 verificationId、verifiedAt、reused。接口不返回完整姓名或身份证。

额度：每人每分钟最多 50 次请求；每天最多 100 次新供应商调用（北京时间），不是供应商套餐余额。已发出的超时调用也占次数。
本人相同姓名和身份证的确定结果在完成后 600 秒内复用，reused=true，不增加新供应商调用次数。窗口外再次请求可能重新计费。未知结果不会自动重新核验。
令牌默认有效期 90 天，重置立即使旧令牌失效；停用、过期、账号停用或权限撤销后不可调用。

错误与处理：错误统一为 success=false、requestId、error.code/message；按返回错误码处理。
400 VALIDATION_ERROR 参数或证件格式错误：修改输入。HTTPS_REQUIRED：必须首次使用 HTTPS 请求，不能通过 HTTP 跳转。
401 UNAUTHORIZED 令牌缺失、无效、过期或撤销：检查或重置本人令牌。
403 FORBIDDEN 账号或权限不可用：联系管理员。
405 METHOD_NOT_ALLOWED 方法错误：仅允许 GET，HEAD 也不允许。
429 RATE_LIMIT / DAILY_LIMIT / SERVICE_BUSY：频率、每日额度、并发槽位或相同请求正在处理：按错误码和 Retry-After 人工处理；本次未新增供应商调用。
409 UNRESOLVED_RESULT 已有未知结果尚未处理：联系管理员核查，保留 verificationId。
502/504 RESULT_UNKNOWN：供应商响应无法解释、超时或连接中断，结果未知。
503 IDENTITY_NOT_READY / SERVICE_PAUSED / PROVIDER_AUTH / PROVIDER_QUOTA / PROVIDER_RATE_LIMIT / INTERNAL_ERROR：服务关闭、暂停、供应商鉴权/额度或基础设施异常：联系管理员，依据返回码确认是否已发出调用。
禁止自动重试、自动预取和批量打开链接；网络失败或结果未知时也不要重试。响应禁止缓存（no-store），请妥善保管令牌与核验资料。`;
}
