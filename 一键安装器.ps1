$ErrorActionPreference = 'Stop'

# 只登记随包的 Native Messaging 宿主，然后打开浏览器扩展管理页。
# 不扫描浏览器资料，不读取账号信息，也不会自动改动 B 站页面。
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$installScript = Join-Path $root 'native\Install.ps1'
if (-not (Test-Path -LiteralPath $installScript)) {
    throw '找不到 native\Install.ps1，请确认压缩包已经完整解压。'
}

& $installScript

$browserPath = $null
$runningChrome = Get-Process -Name chrome -ErrorAction SilentlyContinue | Select-Object -First 1
$runningEdge = Get-Process -Name msedge -ErrorAction SilentlyContinue | Select-Object -First 1
$extensionPage = if ($runningChrome) {
    try { $browserPath = $runningChrome.Path } catch { $browserPath = $null }
    'chrome://extensions/'
} elseif ($runningEdge) {
    try { $browserPath = $runningEdge.Path } catch { $browserPath = $null }
    'edge://extensions/'
} else {
    $chromePath = Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'
    $edgePath = Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'
    $chromeLocalPath = Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe'
    $edgeLocalPath = Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\Application\msedge.exe'
    $browserPath = @($chromePath, $chromeLocalPath, $edgePath, $edgeLocalPath) |
        Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if ($browserPath) {
        if ($browserPath -match '\\Edge\\') { 'edge://extensions/' } else { 'chrome://extensions/' }
        $null
    } else {
        Start-Process (Join-Path $root '请先看教程-一键安装与使用.html')
        $null
    }
}

if ($extensionPage) {
    try {
        if ($browserPath) {
            Start-Process -FilePath $browserPath -ArgumentList $extensionPage
        } elseif ($extensionPage -like 'edge:*') {
            Start-Process -FilePath 'msedge.exe' -ArgumentList $extensionPage
        } else {
            Start-Process -FilePath 'chrome.exe' -ArgumentList $extensionPage
        }
    } catch {
        Start-Process (Join-Path $root '请先看教程-一键安装与使用.html')
    }
}

Write-Host '透明桌面助手登记完成。扩展管理页已经打开；请加载当前解压目录。'
