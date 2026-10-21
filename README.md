# bctl (Browser Control CLI)

> **极简日常 Chrome 控制工具**：专为本地 AI Agent（Claude Code、Codex、Gemini、Trae、Antigravity）打造的无干扰后台并发浏览器控制工具，支持 JumpServer 堡垒机 Web 终端直连与 ChatGPT 官方同款原生弹簧鼠标。

---

## 📖 诞生背景

在日常开发与运维中，我们常常需要大模型协同操作浏览器（查阅监控大盘、登录内部系统、在堡垒机服务器执行命令）。以往面临两大痛点：

1. **ChatGPT 官方扩展生态封闭**：OpenAI 的 Chrome 扩展（Work with Apps）体验极佳（具备后台并发、原生光标与控制态指示），但加了严格限制——**仅限 OpenAI 官方模型使用，禁止第三方模型与本地 CLI 接入**。
2. **传统自动化方案（Puppeteer / Playwright / Selenium）局限明显**：
   - 通常只能启动全新的“白板”无痕浏览器，丢失了日常 Chrome 中宝贵的 Cookie、已登录 SSO、密码与会话；
   - 运行时强占人类用户的前台鼠标与焦点，大模型操作网页时人类无法继续工作；
   - 无法穿透 JumpServer (Luna/Koko) 的 Web 终端（xterm.js）在服务器上执行运维排查。

**`bctl` 由此诞生**：逆向拆解了 ChatGPT 扩展的核心设计，彻底去除了模型账号限制。它直接复用你日常正在使用的真实 Chrome，支持后台多标签独立静默操作、JumpServer 终端秒级直连，并适配了现代复杂前端大盘（SPA 内部容器滚动与虚拟列表）。

---

## ✨ 核心特性

- **👥 双人并发与后台多标签隔离 (True Background Concurrency)**：
  - 使用 `bctl new <url>` 在后台静默创建标签页并自动绑定，前台人类正在浏览的网页**绝不切页、绝不夺取焦点**。
  - 大模型在后台标签页自由执行点击、滚动、表单提交，人类在前台正常打字聊天，互不干扰。
- **⚡ 全类型 Web 终端直连穿透 (`bctl exec`)**：
  - 直连 JumpServer (Luna/Koko)、DOPS / Rancher K8s 容器终端、自研 WebShell 等基于 xterm.js 的各类 Web 终端。支持跨 iframe 递归探测、Vue/React 深度实例穿透、DOM 极速拟真键入回退、软折行（isWrapped）还原拼接、防后台休眠与纯净原样命令下发，毫秒级返回干净的标准输出。
- **🔍 智能页面环境嗅探与 DevTools 直连 (`bctl probe` / `bctl devtools`)**：
  - 一键嗅探页面当前就绪的终端、Monaco / Ace / CodeMirror 代码编辑器与主表单；
  - 穿透 Kibana DevTools 与自研 ES 控制台，自动注入查询语句并模拟触发原生快捷键提交，毫秒级抓取响应输出。
- **🎯 ChatGPT 同款视觉与弹簧阻尼光标**：
  - 复刻 ChatGPT 原版 `cursor-chat` 鼠标图标与顶部 `[AI Agent 正在控制此标签页]` 状态胶囊，大模型当前动作（观察页面、点击目标、输入文字、滚动、终端命令）实时打印至顶部胶囊，不再在页面组件上贴数字角标，保持界面干净美观。
  - 动态在 Chrome 原生 Tab 栏 Favicon 上绘制绿色鼠标箭头，受控状态一目了然。
  - 基于**弹簧阻尼物理动力学（Spring Physics）**呈现极其丝滑的贝塞尔曲线移动与拟人打字机输入。
- **🌊 生产级 SPA 智能容器滚动与视口遥测 (Gemini 4 审核优化)**：
  - **坐标穿透与 Shadow DOM 递归**：自动穿透透明水印、Fixed 吸顶栏与 Tooltip 遮罩，精准捕获实际滚动容器；
  - **抗死锁方向余量校验**：嵌套容器触顶/触底时自动向外层滚动容器回溯，防止死循环；
  - **同步 instant 滚动**：强制同步位移消除平滑滚动动画引起的异步读写竞态；位移未发生时自动补发 `WheelEvent` 驱动虚拟列表（Virtual List）；
  - **闭环遥测反馈**：实时回显精确物理位移、容器名、滚动进度百分比与边界提示；
  - **`look` 视口感知与表格数据提取（无感无标号）**：过滤非视口元素，静默感知可交互元素与可见数据，彻底摒弃打扰视觉的数字角标；自动提取视口内 `<table>` 行与指标卡片，解决“大模型盲滚看不见表格数据”的问题。
- **🔄 热重载支持 (`bctl reload`)**：
  - 支持直接在终端通过 CLI 触发 Chrome 扩展热重载，插件代码开发调试无需手动去扩展页面点击刷新。

---

## 🛠️ 系统架构与依赖

### 运行依赖
- **操作系统**：macOS / Linux / Windows
- **运行时**：Node.js >= 18.0.0
- **浏览器**：Google Chrome 或其他基于 Chromium 的现代浏览器
- **Node 依赖**：`ws`（WebSocket 协议支持）

### 架构示意
```text
┌──────────────────────────────────────────────┐
│  AI Agent (Codex / Trae / Claude Code)       │
└──────────────────────┬───────────────────────┘
                       │ CLI 执行 (如 bctl look, bctl act)
                       ▼
┌──────────────────────────────────────────────┐
│  bctl CLI (Node.js Client)                   │
└──────────────────────┬───────────────────────┘
                       │ HTTP RPC (http://127.0.0.1:9224)
                       ▼
┌──────────────────────────────────────────────┐
│  bctl Daemon (WebSocket Server :9223)        │
│  - 自动后台拉起，端口冲突自动复用              │
│  - 15秒心跳保活与自动重连                     │
└──────────────────────┬───────────────────────┘
                       │ WebSocket (全双工通信)
                       ▼
┌──────────────────────────────────────────────┐
│  Chrome MV3 扩展 (Ghost Cursor Bridge)       │
│  - background.js (MV3 Service Worker/保活器) │
│  - content.js (页面视口裁剪、弹簧光标、容器滚动)│
└──────────────────────────────────────────────┘
```

---

## 🚀 安装部署指南

### 1. 克隆代码并安装依赖
```bash
git clone https://github.com/zhegeshijiehuiyouai/bctl.git
cd bctl
npm install
```

### 2. 配置全局软链接
将 `bctl.mjs` 软链接至系统的可执行路径（如 `~/.local/bin` 或 `/usr/local/bin`）：
```bash
mkdir -p ~/.local/bin
ln -sf $(pwd)/bctl.mjs ~/.local/bin/bctl

# 确保 ~/.local/bin 在 PATH 环境变量中（一般在 ~/.zshrc 中）
# export PATH="$HOME/.local/bin:$PATH"
```

### 3. 在 Chrome 中加载扩展
1. 打开日常使用的 Google Chrome，访问：`chrome://extensions`；
2. 开启右上角的 **「开发者模式」**；
3. 点击左上角 **「加载已解压的扩展程序」**；
4. 选择本项目中的 `extension` 目录；
5. 加载成功后，看到 `Ghost Cursor Browser Bridge Pro` 扩展即安装完毕。

### 4. 验证运行状态
在终端中执行：
```bash
bctl status
```
返回如下 JSON 即说明连接就绪（守护进程会自动后台拉起并与 Chrome 建立 WebSocket 握手）：
```json
{
  "daemon": true,
  "extension_connected": true
}
```

### 5. 安装 Agent Skill

大模型通过仓库里的 [`skills/chrome-control/SKILL.md`](skills/chrome-control/SKILL.md) 学会使用 `bctl`。技能只有这一份，安装脚本把它链接到 Cursor、Claude Code、Codex、Trae、Gemini 的个人 skills 目录。`git pull` 更新仓库后，各 Agent 读到的仍是这一份。

在仓库根目录执行：

macOS / Linux：

```bash
bash scripts/install-skill.sh
```

Windows（PowerShell，目录联接不需要管理员）：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-skill.ps1
```

脚本会把 `skills/chrome-control` 链到下面这些目录。Claude Code 或 Gemini 的 `skills` 目录如果已经整体指向 `~/.agents/skills`，对应的那一次链接和共用目录是同一个位置。

| Agent | macOS / Linux | Windows |
| :--- | :--- | :--- |
| 共用目录 | `~/.agents/skills/chrome-control` | `%USERPROFILE%\.agents\skills\chrome-control` |
| Cursor | `~/.cursor/skills/chrome-control` | `%USERPROFILE%\.cursor\skills\chrome-control` |
| Claude Code | `~/.claude/skills/chrome-control` | `%USERPROFILE%\.claude\skills\chrome-control` |
| Codex | `~/.codex/skills/chrome-control` | `%USERPROFILE%\.codex\skills\chrome-control` |
| Trae 国际版 | `~/.trae/skills/chrome-control` | `%USERPROFILE%\.trae\skills\chrome-control` |
| Trae 国内版 | `~/.trae-cn/skills/chrome-control` | `%USERPROFILE%\.trae-cn\skills\chrome-control` |
| Gemini | `~/.gemini/config/skills/chrome-control` | `%USERPROFILE%\.gemini\config\skills\chrome-control` |

装好后新开一轮对话。之后让 Agent 操作浏览器或 JumpServer 终端时，它会按这个 skill 调用 `bctl`。

---

## 💻 常用命令与速查表

| 命令 | 用法示例 | 说明 |
| :--- | :--- | :--- |
| **查看标签页** | `bctl tabs` | 查看 Chrome 当前所有已打开的标签（包含 TabID、标题、URL、绑定状态） |
| **后台打开网页** | `bctl new "https://github.com"` | **强烈推荐**：在后台静默创建标签页并自动绑定，前台人类视角 0 干扰 |
| **锁定控制目标** | `bctl bind jumpserver` 或 `bctl bind 947878209` | 将后续操作锁定在指定标签页，禁止该标签页后台休眠 |
| **内嵌终端标签列表** | `bctl subtabs` (或 `terms`) | 查看当前页面内嵌的终端标签列表与连接健康状态 (JumpServer 等多标签终端) |
| **内嵌终端标签切换** | `bctl switch <IP\|序号>` | 在当前页面像切浏览器标签一样直接切换内嵌终端，零重复新开 |
| **智能按需连接** | `bctl connect <IP> [--new]` | 智能按需连接主机（优先复用已有未断开终端，断开自动重连，支持 `--new` 强制新开） |
| **页面环境嗅探** | `bctl probe` | 一键嗅探页面当前就绪的终端（Xterm）、编辑器（Monaco/Ace/CodeMirror）与主表单 |
| **Web 终端执行** | `bctl exec "ps -ef \| grep es"` | 穿透各类 Web 终端 (JumpServer/DOPS/K8s/Xterm) 执行命令并返回标准输出 |
| **DevTools 执行** | `bctl devtools "GET _cat/indices?v"` | 在 Kibana DevTools / 自研 ES 控制台 / 代码编辑器填充并执行查询 |
| **感知视口元素** | `bctl look` | 静默感知当前页面所有可交互元素与可见数据，返回紧凑索引摘要（不再渲染数字角标） |
| **执行鼠标/键盘动作** | `bctl act '<JSON动作数组>'` | 执行点击、输入、按键、智能容器滚动（实时在顶部胶囊打印具体动作） |
| **打印操作状态** | `bctl state "<描述>"` | 在受控页面顶部悬浮胶囊自定义打印当前操作状态（向用户提供清晰的进度回显） |
| **当前标签页导航** | `bctl open "https://github.com"` | 在当前已绑定的标签页中打开新网址并返回元素列表 |
| **解除控制恢复标签页** | `bctl unbind` (或 `release`) | 解除当前标签页控制，立即平滑淡出胶囊并复原原生 Tab 栏图标与标题 |
| **热重载扩展** | `bctl reload` | 修改扩展代码后无需手动切扩展页面刷新，一键重载 |
| **状态检查** | `bctl status` | 检查守护进程与 Chrome 扩展的实时连接状态 |

---

## 🎯 典型使用场景示例

### 场景一：后台操控 JumpServer 堡垒机执行运维命令
```bash
# 1. 查找已打开的 JumpServer 页面并绑定
bctl tabs
bctl bind jumpserver

# 2. 在后台静默执行 Linux 命令（不影响你前台打字看网页）
bctl exec "ps -ef | grep jenkins"
bctl exec "systemctl status jenkins"
bctl exec "df -h"
```

### 场景二：后台自动化普通网站（带弹簧鼠标与打字机动画）
```bash
# 1. 后台静默打开 GitHub
bctl new "https://github.com"

# 2. 观察返回的页面元素，假设搜索框为 [25]
# 驱动弹簧光标移动至 [25] 输入关键词并回车
bctl act '[{"type":"type","id":25,"text":"bctl"},{"type":"press","key":"Enter"}]'

# 3. 搜索结果返回后，向下滚动浏览
bctl act '[{"type":"scroll","deltaY":600}]'

# 4. 点击搜索结果中的目标项目
bctl act '[{"type":"click","id":4}]'
```

### 场景三：大盘监控与表格数据分析
```bash
# 1. 绑定监控大盘
bctl bind monitor

# 2. 滚动并触发虚拟列表渲染
bctl act '[{"type":"scroll","deltaY":800}]'

# 3. 查看当前视口提取的表格数据与图表指标
bctl look
```

### 场景四：DOPS/K8s 容器终端与 Kibana/ES 控制台执行
```bash
# 1. 一键嗅探页面内是否有活跃的终端或编辑器
bctl bind dops
bctl probe

# 2. 在非标容器终端 (DOPS / 自研终端) 中直接执行命令
bctl exec "uname -a"
bctl exec "ls -la /app"

# 3. 在 Kibana DevTools / 自研 ES 控制台执行 DSL 查询
bctl bind elasticsearch
bctl devtools "GET _cat/indices?v"
bctl devtools 'GET k8s-logs-*/_search\n{"size":5,"query":{"match_all":{}}}'
```

---

## 📄 开源许可证

[MIT License](LICENSE)
