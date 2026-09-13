# Windows AOS 采集器

本地开发实现，已在 Windows 10 专业版 22H2（19045.6456）、x64、管理员权限下通过关键合成验收；范围和剩余业务项见[Windows 实机记录](../docs/archive/2026-09/2026-09-10-AOS-Windows实机验收记录.md)。使用方式见[采集与入库说明](../docs/design/AOS文件采集与入库.md)。

## 构建与测试

需要 .NET 10 SDK。依赖使用 `packages.lock.json` 固定；SQLite 原生依赖显式升级，不抑制安全告警。

```bash
dotnet restore collector/AosCollector.Windows --locked-mode
dotnet run --project collector/AosCollector.Tests -c Release
dotnet publish collector/AosCollector.Windows -c Release -r win-x64 --self-contained true -o collector/artifacts/win-x64
```

从仓库根目录执行。macOS 可构建 Windows 制品、运行 Core 合成测试；GUI、LocalService、DPAPI、安装／修复／卸载只能在 Windows 验证。`AosCollector.exe` 自包含，首次运行安装向导；`--install` 修复，`--uninstall` 卸载，`--tray` 进入托盘，`--service` 由 SCM 启动。

Core 包括严格编码与行识别、SQLite WAL/FULL 加密队列、稳定事件和 HMAC 指纹、文件事件加周期核对、HTTPS 和逐条回执。Windows 层负责配置、DPAPI、服务、本机命名管道、安装与 GUI。Tests 是不连接真实系统的可执行合成测试，包含响应丢失、跨日重启及文件替换，不用真实账号／订单样本写数据库。

## 制品与数据

`artifacts/`、`bin/`、`obj/` 和 SQLite 文件不纳入 Git。发布前在目标 Windows 验证源码构建产物和 SHA-256；1.1.0 使用独立 RSA 发布清单签名，尚无 Windows Authenticode 代码签名，不能把编译成功当作 Windows 实机验收。安装／升级保留配置和队列；卸载默认保留本地数据和程序文件。

依赖许可：.NET 与 WinForms 见各自 [dotnet/runtime](https://github.com/dotnet/runtime/blob/main/LICENSE.TXT)、[dotnet/winforms](https://github.com/dotnet/winforms/blob/main/LICENSE.TXT)；SQLitePCLRaw 见 [项目许可](https://github.com/ericsink/SQLitePCL.raw/blob/master/LICENSE.TXT)，SQLite 核心为公有领域。分发包须附运行时与依赖的许可及第三方声明。

## 1.1.0 付款码与统一更新（采集器候选版）

同时读取 `AOS订单记录-*.txt` 和 `AOS成功记录-*.txt`。先按订单号和来源字段核对，微信 PNG 独立进入加密补码队列；缺少订单时保存成功记录等待，不阻断正常订单入库。支付宝日志只有 Apple 订单链接，不作为付款码上传。平台两页点击“查看付款码”时仅提示“支付宝暂无法获取付款码”。

本地新增 SQLite 表属于兼容扩展，旧版本忽略付款码表；升级与回滚不恢复旧队列快照，避免覆盖更新期间产生的数据。本机 GUI 分开显示付款码待上传／异常数量；坏图、身份冲突保留异常，不无限自动重试。修正源记录后产生新的独立事件。每目录最多保存 20000 条付款码候选，达到上限显示错误，需安排受控归档而非静默删除。

### 首次引导

候选包包括 `AosCollector.exe`、`release-public.pem`、签名清单与许可文件。当前只完成 macOS 构建和 Core 合成回归，安装、无人登录运行和断电恢复尚需 Windows 实机验收。

1. 先保存配置并退出旧托盘；保持设备身份和原 `%ProgramData%\AppleOrderMgr\AosCollector` 数据目录。
2. 不需要卸载旧程序。在每台现有 Windows 上通过 RDP 解压完整新版包，在解压目录用管理员 PowerShell 执行 `.\AosCollector.exe --install`，再点击“安装 / 修复”。已有服务时，直接双击 EXE 只打开配置窗口，不执行覆盖升级。图形安装检测旁边的 `release-public.pem` 后，自动安装更新组件。同机升级沿用原 HTTPS 地址、设备凭证、采集目录和队列，不重新注册设备；换机、重装 Windows 或凭证失效需要单独处理。也可执行非交互入口：

   ```powershell
   .\AosCollector.exe --install-silent --update-public-key .\release-public.pem
   ```

3. `Program Files\AppleOrderMgr\AosCollector\Updater` 保存独立更新副本、公钥及恢复日志，仅管理员和 SYSTEM 可写。固定计划任务 `AppleOrderMgr AOS Update` 每分钟以 SYSTEM 运行一次，互斥防止重叠；采集服务仍为 LocalService。
4. 后续在平台“订单数据源 → 采集设备 → 采集器统一更新”选择已验签版本和设备下发，先一台验证，再逐批更新。离线设备上线后领取。安装后核对运行版本、心跳、扫描和队列，失败恢复旧程序；原托盘运行时按原登录任务恢复。
5. 首次失败或旧托盘未退出时，非交互入口返回非零退出码；保留配置和队列，检查服务与安装目录后重试。通过 RDP 运行仍是首次每台一次操作，旧版不能凭平台上传安装包自行更新。

### 签名发布配置

可信构建机维护至少 2048 位 RSA 私钥，并离线保管。构建机运行：

```bash
npm run collector:package -- /path/AosCollector.exe /secure/signing-private.pem 1.1.0 /path/releases
```

先创建 `/path/releases`；工具创建不可覆盖的版本子目录，写入制品、`manifest.json` 和公钥，私钥绝不进入制品。签名覆盖产品、版本、平台、SHA-256、大小及兼容队列版本。服务端配置 `COLLECTOR_RELEASE_DIR` 指向只读挂载的发布根目录，`COLLECTOR_UPDATE_PUBLIC_KEY_FILE` 指向与引导包相同的公钥文件；没有配置时更新列表提示未配置，订单采集不受影响。部署必须将上述两个路径映射进 API 容器，不能只填写宿主机路径。实际上传制品、生产迁移与安装另按发布授权执行。

本次本地签名私钥保存于构建机项目外目录 `~/.local/share/AppleOrderMgr/release-signing/signing-private.pem`（权限 600，目录 700），不挂载到应用或 Worker 运行容器。后续发布必须继续使用同一受信密钥；公钥轮换、更新组件本身升级及非兼容 SQLite 结构升级需要重新设计引导步骤，当前不通过任意命令通道执行。当前只允许同版修复或向更高版本更新，失败时可恢复该次更新前的本机副本。

真实付款码图片及完整成功原文不作为测试夹具或诊断包分发；合成测试只验证协议与状态，不证明真实支付有效。
