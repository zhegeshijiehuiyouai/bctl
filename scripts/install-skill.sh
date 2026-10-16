#!/usr/bin/env bash
# 把仓库里的 chrome-control skill 链到各 Agent 的个人 skills 目录。
# 技能本体只保留一份：本仓库 skills/chrome-control。git pull 后各 Agent 读到的是同一份。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/skills/chrome-control"

if [[ ! -f "$SRC/SKILL.md" ]]; then
  echo "找不到 $SRC/SKILL.md" >&2
  exit 1
fi

link_skill() {
  local dir="$1"
  local dest="$dir/chrome-control"
  mkdir -p "$dir"
  if [[ -L "$dest" ]]; then
    ln -sfn "$SRC" "$dest"
  elif [[ -e "$dest" ]]; then
    echo "已存在真实目录，未覆盖: $dest" >&2
    echo "确认可以替换后执行: rm -rf \"$dest\" && ln -sfn \"$SRC\" \"$dest\"" >&2
    return 1
  else
    ln -sfn "$SRC" "$dest"
  fi
  echo "已链接 $dest -> $SRC"
}

failed=0
for dir in \
  "$HOME/.agents/skills" \
  "$HOME/.cursor/skills" \
  "$HOME/.claude/skills" \
  "$HOME/.codex/skills" \
  "$HOME/.trae/skills" \
  "$HOME/.trae-cn/skills" \
  "$HOME/.gemini/config/skills"
do
  link_skill "$dir" || failed=1
done

if [[ "$failed" -ne 0 ]]; then
  exit 1
fi

echo "安装完成。新开一轮 Agent 对话后，操作浏览器或 JumpServer 终端时会加载 chrome-control。"
