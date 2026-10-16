# 把仓库里的 chrome-control skill 接到各 Agent 的个人 skills 目录。
# Windows 使用目录联接（mklink /J），不需要管理员权限。
# 技能本体只保留一份：本仓库 skills\chrome-control。git pull 后各 Agent 读到的是同一份。
$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Src = Join-Path $Root "skills\chrome-control"

if (-not (Test-Path (Join-Path $Src "SKILL.md"))) {
  Write-Error "找不到 $Src\SKILL.md"
}

function Link-Skill([string]$Dir) {
  New-Item -ItemType Directory -Force -Path $Dir | Out-Null
  $Dest = Join-Path $Dir "chrome-control"
  if (Test-Path $Dest) {
    $item = Get-Item $Dest -Force
    $isLink = [bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint)
    if (-not $isLink) {
      Write-Error "已存在真实目录，未覆盖: $Dest`n确认可以替换后执行: Remove-Item -Recurse -Force '$Dest'，然后重新运行本脚本。"
    }
    cmd /c "rmdir `"$Dest`"" | Out-Null
  }
  cmd /c "mklink /J `"$Dest`" `"$Src`"" | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Write-Error "创建目录联接失败: $Dest"
  }
  Write-Output "已链接 $Dest -> $Src"
}

$targets = @(
  "$env:USERPROFILE\.agents\skills",
  "$env:USERPROFILE\.cursor\skills",
  "$env:USERPROFILE\.claude\skills",
  "$env:USERPROFILE\.codex\skills",
  "$env:USERPROFILE\.trae\skills",
  "$env:USERPROFILE\.trae-cn\skills",
  "$env:USERPROFILE\.gemini\config\skills"
)

foreach ($dir in $targets) {
  Link-Skill $dir
}

Write-Output "安装完成。新开一轮 Agent 对话后，操作浏览器或 JumpServer 终端时会加载 chrome-control。"
