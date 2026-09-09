# Excel 导入规范

> 状态：当前有效
>
> 最近核对：2026-09-06
>
> 基线：main@0fd7f80 与当前未提交工作树
>
> 验证范围：本地工作树静态核对；未验证真实数据库、邮箱、官网和生产环境

## 文件与权限

Excel 读写依赖使用 SheetJS 官方发布的 0.20.3，不再使用 npm registry 的旧 0.18.5。固定制品随仓库保存在 `vendor/xlsx-0.20.3.tgz`，来源、许可和校验规则见[第三方依赖说明](../../vendor/README.md)。CommonJS 调用、模板和导入导出协议保持不变。

支持 Apple ID 和取机人导入，type 分别为 apple_ids、recipients。只接受 `.xlsx`，上传大小上限 10MB、非空数据最多 1000 行。工作表必须分别命名为 Apple IDs、Recipients。

模板下载、预览、执行都经过全局认证与会话有效性校验检查；预览和执行还要求 write 权限。模板下载使用带认证的 API 客户端，不能直接打开未认证链接。

## 模板列

| 类型       | 列名                                                                                  |
| ---------- | ------------------------------------------------------------------------------------- |
| Apple IDs  | Apple ID、密码、备注名称、国家地区、是否已修改、状态、密保问题1/2/3、密保答案1/2/3    |
| Recipients | 姓、名、身份证号、手机号、邮箱、省、市、区、街道地址、绑定 Apple ID、标签、状态、备注 |

列映射及验证见[importService.js](../../src/services/importService.js)。Apple ID 与密码为必填，密保如填写需三个问题和答案完整；取机人字段格式及必填以该服务验证为准。未知列不映射，空行忽略，错误保留原 Excel 行号。

## 当前协议

1. `GET /api/import/template/:type` 下载模板。
2. `POST /api/import/preview` 使用 multipart/form-data，字段为 file 和 type。
3. 服务端保存解析结果，返回 sessionToken、expiresInSeconds、summary 和错误列表，不返回可由客户端改写后执行的完整预览行。
4. `POST /api/import/execute` 只提交令牌：

```json
{ "sessionToken": "服务端预览返回的令牌" }
```

服务端会话绑定用户，有效期 15 分钟，在执行前消费，不能重放。失败后需重新上传预览。旧的 type + data 执行协议已退出当前文档。

## 写入与结果

执行在事务内处理服务端会话中的行。校验不通过及已存在记录按实现计入 skipped/errors；成功插入计入 imported。返回 success/data，data 内为 imported、skipped、errors；不能只依据 HTTP 200 判断全部行导入成功。

身份证使用标准化盲索引判断重复，敏感字段经模型加密。上传临时文件在预览 finally 中清理。

## 当前限制

会话保存在 API 进程内 Map，重启或跨实例请求可能失效；不具备持久化任务队列与跨实例导入保证。文件内容类型深度检测、完整真实数据库回滚与 E2E 验证仍待完善。

代码入口：[路由](../../src/routes/importRoutes.js)、[控制器](../../src/controllers/importController.js)、[前端调用](../../frontend/src/api/importApi.js)。验收见[测试指南](../testing/测试与验收指南.md)。

## 身份核验名单与结果

此模块独立于 `/api/import`，不创建或修改取机人和订单。权限为 `identity.read` 加 `identity.batch`，导出另需 `identity.export`；管理员全部可见，普通用户仅本人批次。

- 使用[身份核验模板](../../templates/identity_verification_template.xlsx)，列名为「姓名」「身份证号」；工作表优先选择「身份核验」，否则读取首个工作表。
- 仅 `.xlsx`，文件最多 10MB，非空数据最多 1000 行；模板两列均为文本。解析范围超过 10000 行／100 列时拒绝。
- 身份证数字单元格与公式一律拒绝，不猜测 Excel 丢失的低位；保留原始行号与输入文本。先验证姓名、18 位大陆身份证、出生日期和校验位。
- `POST /api/identity-verifications/preview` 接受唯一 file 字段，保存加密草稿，15 分钟内通过批次 start 开始；上传不会调用供应商。
- 同一批次按去首尾空白的姓名及大写身份证组合去重，保留每个原始行，共用首次出现行的结果；相同证件不同姓名分开核验。格式错误不外呼。
- 结果下载将原始姓名、身份证号、说明和返回业务信息全部写为文本单元格，避免证件精度丢失与公式注入。查看与导出均保留原文，这是用户明确批准的身份核验规则。

接口、状态、暂停与恢复见[API 契约](API设计.md)，背景和验收边界见[接入方案](../planning/身份核验接入方案.md)。
