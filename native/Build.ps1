$ErrorActionPreference = 'Stop'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
$framework = Split-Path $compiler
$wpf = Join-Path $framework 'WPF'
if (-not (Test-Path -LiteralPath $compiler)) { throw '需要 Windows 自带的 .NET Framework 4.x。' }
& $compiler /nologo /target:winexe /optimize+ /platform:anycpu ("/out:" + (Join-Path $PSScriptRoot 'BiliSubDesktop.exe')) "/reference:$wpf\WindowsBase.dll" "/reference:$wpf\PresentationCore.dll" "/reference:$wpf\PresentationFramework.dll" "/reference:$framework\System.Web.Extensions.dll" "/reference:$framework\System.Drawing.dll" "/reference:$framework\System.Xaml.dll" (Join-Path $PSScriptRoot 'DesktopHost.cs')
if ($LASTEXITCODE -ne 0) { throw '本地透明窗口编译失败。' }
Write-Host '已生成 native/BiliSubDesktop.exe，不需要下载依赖。'
