$ErrorActionPreference = 'Stop'

# 固定 ID 来自扩展公钥，与解压路径无关；不读取浏览器资料或手填 ID。
$extensionManifestPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'manifest.json'
if (-not (Test-Path -LiteralPath $extensionManifestPath)) { throw '找不到项目根目录的 manifest.json，请完整解压后重新运行。' }
try { $extensionManifest = Get-Content -LiteralPath $extensionManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json }
catch { throw 'manifest.json 无法解析，请重新解压完整版本。' }
$publicKey = $extensionManifest.key
if ($publicKey -isnot [string] -or $publicKey -cnotmatch '\A[A-Za-z0-9+/]+={0,2}\z') {
    throw 'manifest.json 缺少有效公钥，尚未修改本地登记。请使用完整的 v0.6 或更新版本。'
}
try { [byte[]]$keyBytes = [Convert]::FromBase64String($publicKey) }
catch { throw '扩展公钥编码无效，尚未修改本地登记。' }

# 本项目仅接受 RSA-2048、指数 65537 的标准 SPKI DER 公钥。
# 检查 ASN.1 外层、算法、位串、整数长度及符号，拒绝普通 base64 文本冒充公钥。
[byte[]]$prefix = @(0x30,0x82,0x01,0x22,0x30,0x0d,0x06,0x09,0x2a,0x86,0x48,0x86,0xf7,0x0d,0x01,0x01,0x01,0x05,0x00,0x03,0x82,0x01,0x0f,0x00,0x30,0x82,0x01,0x0a,0x02,0x82,0x01,0x01,0x00)
[byte[]]$suffix = @(0x02,0x03,0x01,0x00,0x01)
$validKey = $keyBytes.Length -eq 294
if ($validKey) {
    for ($i = 0; $i -lt $prefix.Length; $i++) { if ($keyBytes[$i] -ne $prefix[$i]) { $validKey = $false; break } }
    for ($i = 0; $i -lt $suffix.Length; $i++) { if ($keyBytes[289 + $i] -ne $suffix[$i]) { $validKey = $false; break } }
    if ($keyBytes[33] -lt 128 -or ($keyBytes[288] -band 1) -ne 1) { $validKey = $false }
}
if (-not $validKey) { throw '扩展公钥不是受支持的 RSA-2048 SPKI 格式，尚未修改本地登记。' }
$hasher = [Security.Cryptography.SHA256]::Create()
try { $digest = $hasher.ComputeHash($keyBytes) } finally { $hasher.Dispose() }
$alphabet = 'abcdefghijklmnop'
$extensionId = -join (0..15 | ForEach-Object { $alphabet[($digest[$_] -shr 4)]; $alphabet[($digest[$_] -band 15)] })
$origins = New-Object 'System.Collections.Generic.List[string]'
$origins.Add("chrome-extension://$extensionId/")

# 只读取本项目自己已有的宿主清单，最多保留两个严格合法的旧 ID。
$manifestPath = Join-Path $PSScriptRoot 'com.bilisub.desktop.json'
if (Test-Path -LiteralPath $manifestPath) {
    try {
        if ((Get-Item -LiteralPath $manifestPath).Length -le 65536) {
            $previous = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($previous.name -ceq 'com.bilisub.desktop') {
                foreach ($origin in @($previous.allowed_origins)) {
                    if ($origin -is [string] -and $origin -cmatch '\Achrome-extension://[a-p]{32}/\z' -and -not $origins.Contains($origin)) {
                        $origins.Add($origin)
                        if ($origins.Count -ge 3) { break }
                    }
                }
            }
        }
    } catch { Write-Host '旧版宿主清单不可用，将只登记当前固定 ID。' }
}

$exe = Join-Path $PSScriptRoot 'BiliSubDesktop.exe'
if (-not (Test-Path -LiteralPath $exe)) { & (Join-Path $PSScriptRoot 'Build.ps1') }
if (-not (Test-Path -LiteralPath $exe)) { throw '未找到透明窗口程序，本次未登记。' }
$manifest = @{ name='com.bilisub.desktop'; description='B站字幕本地透明置顶窗口'; path=$exe; type='stdio'; allowed_origins=$origins.ToArray() }
[IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 3), (New-Object Text.UTF8Encoding($false)))
foreach ($browser in @('Google\Chrome','Microsoft\Edge')) {
    $registryPath = "HKCU:\Software\$browser\NativeMessagingHosts\com.bilisub.desktop"
    New-Item -Path $registryPath -Force | Out-Null
    Set-Item -Path $registryPath -Value $manifestPath
}
Write-Host "固定扩展 ID：$extensionId"
Write-Host '本地透明窗口已登记到当前用户的 Chrome / Edge。无需输入 ID，无需管理员权限。'
Write-Host '请重新加载扩展并刷新视频页，全局字幕将自动打开。此文件夹须保留。'
