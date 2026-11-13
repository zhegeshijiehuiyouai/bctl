# 把 bctl 装进当前用户的 PATH。Windows 上 bctl 只支持 PowerShell 7：
# bctl.cmd 会被 cmd.exe 再解析一次（JSON 参数里的引号会被吃掉），所以这里生成
# .ps1 转发脚本，由 PowerShell 7 把参数数组原样交给 node.exe。
$ErrorActionPreference = "Stop"

if ($PSVersionTable.PSVersion.Major -lt 7) {
  Write-Error "Windows 上 bctl 只支持 PowerShell 7，请用 pwsh 运行本脚本。"
  exit 1
}

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Script = Join-Path $Root "bctl.mjs"
if (-not (Test-Path $Script)) { Write-Error "找不到 $Script" }

$DestDir = Join-Path $env:APPDATA "npm"
New-Item -ItemType Directory -Force -Path $DestDir | Out-Null
$Shim = Join-Path $DestDir "bctl.ps1"

$Literal = $Script.Replace("'", "''")
$ShimBody = @"
# 由 scripts\install-cli.ps1 生成。Windows 上 bctl 只支持 PowerShell 7。
if (`$PSVersionTable.PSVersion.Major -lt 7) {
    Write-Error 'bctl 需要 PowerShell 7（pwsh），请勿用 powershell.exe 调用。' -ErrorAction Continue
    exit 1
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error 'PATH 中找不到 node。' -ErrorAction Continue
    exit 1
}
`$PSNativeCommandArgumentPassing = 'Standard'
& node '$Literal' @args
exit `$LASTEXITCODE
"@

# 带 BOM：两个文件都可能被 powershell.exe 5.1 读取，无 BOM 时中文会乱码成解析错误，
# 而不是给出上面的明确提示。
$utf8 = New-Object System.Text.UTF8Encoding $true
[System.IO.File]::WriteAllText($Shim, $ShimBody + "`r`n", $utf8)

# 旧的 bctl.exe / bctl.home / bctl.cmd 留着会让人误以为还在用 exe，一并备份。
foreach ($Name in @("bctl.exe", "bctl.home", "bctl.cmd")) {
  $Old = Join-Path $DestDir $Name
  if (Test-Path $Old) { Move-Item -Force $Old "$Old.bak" }
}

Write-Output "已安装 $Shim"
Write-Output "脚本路径 $Script"
if (($env:PATH -split ';') -notcontains $DestDir) {
  Write-Output "提示：$DestDir 不在当前 PATH 中，请加入用户 PATH 后重开终端。"
}