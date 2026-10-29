$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
Write-Host '正在安装 B站字幕桌面助手……'

# 只登记随包的 Native Messaging 宿主，然后打开浏览器扩展管理页。
# 不扫描浏览器资料，不读取账号信息，也不会自动改动 B 站页面。
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$installScript = Join-Path $root 'native\Install.ps1'
if (-not (Test-Path -LiteralPath $installScript)) {
    throw '找不到 native\Install.ps1，请确认压缩包已经完整解压。'
}

& $installScript
Write-Host '桌面助手已安装。已加载扩展的用户，请刷新 B站视频页，再点击“桌面置顶”。'

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
    $edgeX86Path = if (${env:ProgramFiles(x86)}) { Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe' }
    $chromeX86Path = if (${env:ProgramFiles(x86)}) { Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe' }
    $chromeLocalPath = Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe'
    $edgeLocalPath = Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\Application\msedge.exe'
    $browserPath = @($chromePath, $chromeLocalPath, $chromeX86Path, $edgePath, $edgeLocalPath, $edgeX86Path) |
        Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
    if ($browserPath) {
        if ($browserPath -match '\\Edge\\') { 'edge://extensions/' } else { 'chrome://extensions/' }
    } else {
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
        Write-Host '已请求打开扩展管理页。首次安装请开启开发者模式，加载以下文件夹：'
        Write-Host $root
    } catch {
        Write-Host '助手已安装。请手动打开 chrome://extensions/ 或 edge://extensions/ 加载扩展。'
    }
} else {
    Write-Host '助手已安装。请手动打开 Chrome 或 Edge 的扩展管理页加载扩展。'
}
