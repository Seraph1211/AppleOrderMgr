# AGENTS.md

## 项目与工作边界

Apple 订单管理系统已有 React 管理台、Express API、PostgreSQL/Sequelize 数据层、邮件及爬虫 Worker。当前能力和验证边界见[开发进度](docs/development/开发进度.md)，架构入口见[系统架构](docs/design/系统架构.md)。不要把历史计划或“已完成”报告当作当前生产验收。

- 每次回复以适当的 emoji 开头。
- 新增或整理文档时优先中文文件名和正文，保留代码标识符、配置项、路径、协议、第三方产品名及 README.md 等约定名称。
- 图片生成、编辑、延展、重绘或变体必须主动加载 imagegen Skill。
- 保留其他未提交工作；不为文档整理改变业务代码、数据库或线上状态。提交、推送、生产写入等遵循当前会话授权。

## 开发前必读

1. 本文件及[文档导航](docs/README.md)。
2. [编码规范](docs/development/编码规范.md)，所有代码强制遵循。
3. 前端工作阅读[前端设计规范](docs/development/前端设计规范.md)，其中已合并 Agent 执行和审查清单。
4. 数据库工作阅读[数据库架构](docs/database/数据库架构.md)，它是数据库文档权威入口。
5. 接口工作阅读[API 契约](docs/design/API设计.md)，业务工作阅读对应 design 文档。
6. 已批准需求和[优化计划](docs/planning/项目优化计划.md)的相关任务、依赖和验收条件。
7. 新增文档、功能变更和 Bug 修复阅读[文档管理规范](docs/development/文档管理规范.md)，按目录归属和模块对照表维护文档。

## 强制编码规则

- 变量、函数 camelCase，类与模型 PascalCase，常量 UPPER_SNAKE_CASE。新普通 JS 文件使用 camelCase；模型遵循 PascalCase；历史 order_parser.js 为例外。
- 所有 async 函数处理错误，使用 try-catch；结构化 Winston 日志包含必要上下文，不使用 console.log，不记录敏感明文。
- 外部输入先验证；多表操作使用事务；避免 N+1，使用关联预加载。
- 默认单引号；允许 Prettier 对包含多个单引号的字符串采用双引号以减少转义。使用分号和 2 空格缩进。
- 导出函数编写 JSDoc。核心业务逻辑补充单元测试，目标覆盖率 >70%；真实数据库、邮箱、官网、代理、浏览器及生产验收单独记录。
- 爬虫请求间隔 5–10 秒，代理池轮换，HTTP 541 废弃/切换代理，最多尝试 3 次；细节见[爬虫说明](docs/design/订单爬虫.md)。
- 表结构通过正式 Migration 演进，禁止用启动时 sync/alter 代替迁移。

## 前端强制规则

- 浅色蓝色系，白色表格/卡片、浅灰页面，禁止新增深色主题类。
- 数据展示采用表格列表；仪表板统计允许卡片，不采用业务数据卡片网格。
- 主色 #1E3A8A，主色浅背景 #EFF6FF；正文和辅助文字使用规范中的灰阶。
- 使用 btn/btn-primary/btn-secondary、input、badge 系列标准组件样式。
- 使用 Lucide React；按钮图标 w-4 h-4，导航/列表 w-5 h-5，规范图标背景 w-10 h-10。
- 统一加载、空数据、错误、交互及响应式状态；隐藏列不等同于敏感数据权限保护。
- 示例入口 Orders.jsx、AppleIds.jsx、Recipients.jsx、Dashboard.jsx 均位于 frontend/src/pages；具体规则只在前端设计规范维护。

## 文件变更级联

| 变更类型                 | 顺序与要求                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| 数据库字段/类型/约束     | 先讨论并更新数据库架构，再模型、新 Migration（含 up/down）、涉及的 API 文档和控制器、前端类型/调用、测试、开发进度 |
| API 增删或请求响应变化   | 先 API 文档，再 Router/Controller、API 测试、前端调用、开发进度                                                    |
| 邮件、爬虫、数据处理逻辑 | 先对应设计文档，再实现、业务测试、开发进度                                                                         |
| 编码规范或工具规则       | 先规范，再 ESLint/Prettier、AGENTS 相关约定及存量调整任务                                                          |
| 文档增删合并迁移         | 明确去向，保留独有规则与历史证据，更新文档索引、相关文档、提示词、脚本和 CI 引用                                   |

权威规范的语义变更先讨论达成一致；已在当前会话批准的方案可以按授权执行，不重复索要确认。明确的文档事实纠错不授权改变业务规则。

## 文档维护强制速查

以下是执行摘要，详细目录、模块和报告要求统一以[文档管理规范](docs/development/文档管理规范.md)为准，不在本文件重复维护完整映射。

| 任务                   | 必须执行                                                                                                                                              |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 新增文档               | 先查已有主题，按[放置规则](docs/development/文档管理规范.md#新增文档放置规则)选择目录；有效文档更新总导航，历史记录更新历史索引                       |
| 修改或优化功能         | 按[模块对照表](docs/development/文档管理规范.md#功能变更对应文档)更新受影响的规范、契约、说明与用例，记录开发进度；接口或数据变更继续执行上方级联规则 |
| 修复普通 Bug           | 记录现象、根因、修复和验证；核心逻辑补回归测试，其他改动做相称验证；恢复既有正确行为时不修改正确规范，不强制新建报告                                  |
| 修复改变规则或操作方式 | 先确认授权范围内的语义变化，再更新对应文档和用例，不能只记录“已修复”                                                                                  |
| 重大故障或需追溯的修复 | 按[Bug 修复规则](docs/development/文档管理规范.md#bug-修复文档规则)保存有日期的报告，进度链接证据，可复用排障方法更新故障排查                         |
| 完成任务               | 更新开发进度和涉及的计划任务状态；新增、移动、删除或入口变化时同步索引，运行文档检查                                                                  |

## 进度与验证

每个开发阶段结束及会话完成前更新[开发进度](docs/development/开发进度.md)：当前阶段、已完成功能、关键决策、验证证据、下一步、阻塞问题。该文件只保留当前结论和近期摘要，旧过程进入 archive。

```bash
docker compose -f docker-compose.dev.yml exec api npm run lint
docker compose -f docker-compose.dev.yml exec api npm test -- --runInBand
docker compose -f docker-compose.dev.yml exec api npm run docs:check
docker compose -f docker-compose.dev.yml exec frontend npm run lint
docker compose -f docker-compose.dev.yml exec frontend npx vite build
```

本地开发和检查默认在 `docker-compose.dev.yml` 容器内执行，邮件与爬虫 Worker 只通过 profile 显式启动。按变更范围执行相关检查；提交前代码规范与测试必须通过。格式化使用指定文件，避免覆盖其他工作；npm run format 会改写全仓，使用前确认范围。CLI 脚本在 package.json 定义，检查边界见[测试指南](docs/testing/测试与验收指南.md)。

本项目已有文档检查和质量 CI，维护现有入口，不复制历史 Husky/CI 脚手架。完整文档生命周期规则见[文档管理规范](docs/development/文档管理规范.md)。
