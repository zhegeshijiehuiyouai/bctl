# 把 bctl 装进当前用户的 PATH，Windows 上用 exe 转发参数，避免 bctl.cmd 的 %* 被 cmd 再次解析。
$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Script = Join-Path $Root "bctl.mjs"
$Source = Join-Path $Root "scripts\bctl-launch.cs"
if (-not (Test-Path $Script)) { Write-Error "找不到 $Script" }
if (-not (Test-Path $Source)) { Write-Error "找不到 $Source" }

$Csc = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $Csc)) {
  $Csc = Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe"
}
if (-not (Test-Path $Csc)) { Write-Error "找不到 csc.exe，无法编译 Windows 启动器。" }

$DestDir = Join-Path $env:APPDATA "npm"
New-Item -ItemType Directory -Force -Path $DestDir | Out-Null
$Exe = Join-Path $DestDir "bctl.exe"

& $Csc /nologo /target:exe /optimize+ "/out:$Exe" $Source
if ($LASTEXITCODE -ne 0) { Write-Error "编译 bctl.exe 失败" }

$utf8 = New-Object System.Text.UTF8Encoding $true
[System.IO.File]::WriteAllText((Join-Path $DestDir "bctl.home"), $Script, $utf8)

$Cmd = Join-Path $DestDir "bctl.cmd"
if (Test-Path $Cmd) {
  Move-Item -Force $Cmd (Join-Path $DestDir "bctl.cmd.bak")
}

Write-Output "已安装 $Exe"
Write-Output "脚本路径 $Script"
Write-Output "PATHEXT 中 .EXE 先于 .CMD，之后执行 bctl 不会再经过 cmd.exe。"
