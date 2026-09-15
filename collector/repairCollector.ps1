# 在旧托盘所在的 Windows 交互桌面，以管理员 PowerShell 执行。
# 从签名安装包目录运行；不下载或执行任意远程脚本，不更换设备身份。
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ExpectedSha256,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ExpectedPublicKeySha256,
  [string]$Executable = (Join-Path $PSScriptRoot 'AosCollector.exe'),
  [ValidatePattern('^\d+\.\d+\.\d+$')][string]$TargetVersion = '1.2.1'
)
$ErrorActionPreference = 'Stop'
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw '请以管理员身份运行。' }
$installRoot = Join-Path $env:ProgramFiles 'AppleOrderMgr\AosCollector'
$keyFile = Join-Path $installRoot 'Updater\release-public.pem'
$configFile = Join-Path $env:ProgramData 'AppleOrderMgr\AosCollector\config.enc'
$installed = Join-Path $installRoot 'AosCollector.exe'
$updater = Join-Path $installRoot 'Updater\AosUpdater.exe'
if ((Get-FileHash -LiteralPath $Executable -Algorithm SHA256).Hash -ne $ExpectedSha256) { throw '安装程序摘要不匹配，已停止。' }
if ((Get-FileHash -LiteralPath $keyFile -Algorithm SHA256).Hash -ne $ExpectedPublicKeySha256) { throw '原公钥不匹配，已停止。' }
if ([Diagnostics.FileVersionInfo]::GetVersionInfo($Executable).ProductVersion.Split('+')[0] -ne $TargetVersion) { throw '安装程序版本不匹配。' }
$beforeHash = (Get-FileHash -LiteralPath $configFile -Algorithm SHA256).Hash
$wasRunning = (Get-Service AppleOrderMgrAosCollector).Status -eq 'Running'
$process = Start-Process -FilePath $Executable -ArgumentList @('--install-silent', '--update-public-key', ('"' + $keyFile + '"')) -Wait -PassThru
if ($process.ExitCode -ne 0) { throw '安装失败，原配置和队列保留。请核对旧托盘所在登录会话。' }
if ((Get-FileHash -LiteralPath $configFile -Algorithm SHA256).Hash -ne $beforeHash) { throw '配置摘要变化，需要核查。' }
foreach ($file in @($installed, $updater)) {
  if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $ExpectedSha256) { throw '主程序或更新组件摘要校验失败。' }
}
if (-not $wasRunning) { Stop-Service AppleOrderMgrAosCollector }
Start-Process -FilePath $installed
Write-Output ('升级完成：' + $TargetVersion + '；主程序及更新组件摘要一致，原配置保持。')
