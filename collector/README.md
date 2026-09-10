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

`artifacts/`、`bin/`、`obj/` 和 SQLite 文件不纳入 Git。发布前在目标 Windows 验证源码构建产物和 SHA-256；当前未签名，不能把编译成功当作 Windows 实机验收。安装／升级保留配置和队列；卸载默认保留本地数据和程序文件。

依赖许可：.NET 与 WinForms 见各自 [dotnet/runtime](https://github.com/dotnet/runtime/blob/main/LICENSE.TXT)、[dotnet/winforms](https://github.com/dotnet/winforms/blob/main/LICENSE.TXT)；SQLitePCLRaw 见 [项目许可](https://github.com/ericsink/SQLitePCL.raw/blob/master/LICENSE.TXT)，SQLite 核心为公有领域。分发包须附运行时与依赖的许可及第三方声明。
