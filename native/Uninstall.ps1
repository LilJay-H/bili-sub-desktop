$ErrorActionPreference = 'Stop'
foreach ($browser in @('Google\Chrome','Microsoft\Edge')) {
    $key = "HKCU:\Software\$browser\NativeMessagingHosts\com.bilisub.desktop"
    if (Test-Path -LiteralPath $key) { Remove-Item -LiteralPath $key }
}
Write-Host '已移除本工具的原生消息登记。扩展的页内字幕仍可使用。'
