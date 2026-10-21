---
name: chrome-control
description: 通过 bctl CLI 控制用户当前运行的 Chrome 浏览器（复用现有 Cookie 与登录态、后台标签页并发操作），支持各类 Web 终端（JumpServer、DOPS、K8s 容器终端、自研 Xterm 终端）直连执行命令，以及 Kibana DevTools / 自研代码编辑器（Monaco/Ace/CodeMirror）查询执行。当用户需要操作网页、查询内部后台、在各类 Web 终端执行命令或在 DevTools/代码编辑器中运行查询时使用。
---

# Chrome 浏览器控制 (bctl)

使用全局 CLI `bctl` 在后台标签页驱动用户正在使用的 Chrome，复用当前 Cookie 与登录态，不抢占前台焦点。

## 工作流与命令速查

1. **打开新页面**：用 `bctl new "<url>"` 在后台新建并自动绑定标签页。
2. **接管已有页面 / 终端 / 控制台**：先 `bctl tabs` 查列表，再 `bctl bind <关键词|TabID>` 锁定目标。
3. **嗅探可交互能力**：如遇非标 Web 终端或复杂控制台，运行 `bctl probe` 快速探测终端与编辑器实例。
4. **释放控制权**：所有网页操作完成后，**最后必须执行 `bctl unbind`**。

| 命令 | 说明 |
| :--- | :--- |
| `bctl new "<url>"` | 后台新建标签页、自动绑定并返回页面元素摘要 |
| `bctl tabs` | 列出所有标签页（TabID、标题、URL、绑定与前台状态） |
| `bctl bind <关键词\|TabID>` | 绑定指定标签页并关闭后台休眠（如 `bctl bind jumpserver`、`bctl bind dops`） |
| `bctl subtabs` / `terms` | 列出当前页面内嵌的终端标签列表与健康状态（支持 JumpServer 等多标签终端） |
| `bctl switch <IP\|序号>` | 在当前页面直接切换到指定的内嵌终端标签页（如切浏览器标签一样无缝切换） |
| `bctl connect <IP> [--new]` | 智能按需连接（优先复用已有未断开终端，断开自动重连，支持 `--new` 强制新开） |
| `bctl probe` | 一键嗅探页面当前就绪的终端（Xterm）、编辑器（Monaco/Ace/CodeMirror）与主表单 |
| `bctl exec '<shell命令>'` | 在绑定的 Web 终端 (JumpServer/DOPS/K8s/自研 Xterm) 穿透执行命令并返回标准输出 |
| `bctl devtools "<查询>"` | 在绑定的 Kibana DevTools / 自研 ES 控制台 / 代码编辑器填充并执行查询 |
| `bctl look` | 扫描当前视口可交互元素与可见表格/指标数据，返回 `[0]`, `[1]`... 编号摘要 |
| `bctl act '<JSON数组>'` | 执行交互动作并返回最新页面摘要 |
| `bctl open "<url>"` | 在当前绑定标签页跳转网址并返回页面元素摘要 |
| `bctl state "<描述>"` | 在受控页面顶部胶囊更新当前任务进度描述 |
| `bctl unbind` | 解除当前标签页绑定并恢复原生状态 |
| `bctl status` / `bctl reload` | 检查守护进程与扩展连接状态 / 热重载扩展 |

> `bctl new`、`bctl open`、`bctl act` 执行后均已自动返回最新 `look` 页面摘要，无需紧接着重复调用 `bctl look`。

### `bctl act` 动作格式

传入 JSON 数组，常用动作类型：
- 点击元素或坐标：`{"type":"click","id":0}` 或 `{"type":"click","x":320,"y":240}`
- 输入文本：`{"type":"type","id":1,"text":"关键词"}`
- 按键提交：`{"type":"press","key":"Enter"}`
- 容器/页面滚动：`{"type":"scroll","deltaY":500}`（正数向下，负数向上；可选 `"target":"modal"|"inner"|"outer"|0|1` 精准指定弹窗/内层/外层滚动条，或通过 `"id"` 关联元素、`"selector"` 指定选择器、`"x"`,`"y"` 指定坐标；弹窗激活时默认智能优先滚动弹窗）
- 悬停 / 等待：`{"type":"move","id":0}`、`{"type":"wait"}`

## 页面操作原则

- **确认控件状态**：`bctl look` 仅列出当前视口可见元素。输入前确认控件已展开且可编辑；需展开或激活的控件先点击触发，观察状态变化后再操作。
- **依据最新编号定位**：DOM 变化后元素会重新编号，严禁沿用旧编号或盲猜无标签元素；摘要无法区分目标时配合截图或坐标定位。
- **按状态边界拆分动作**：同一表单内已确认的输入与提交可批量传入 `bctl act`；涉及展开菜单、弹窗、页面跳转或异步加载时，必须在状态边界停顿读取新结果。页面未按预期变化时先重新观察，禁止盲目重复同一动作；区分工具连接报错与网站自身错误。

## Web 终端与 DevTools 执行规范

### 1. 快速嗅探页面交互环境 (`bctl probe`)
在面对非标运维后台、容器终端（如 DOPS、自研 WebShell）或数据查询页面（Kibana DevTools、自研 ES 控制台）时：
- 先运行 `bctl probe`，即可一键返回页面内探测到的：
  - **终端实例**：DOM 容器路径、行列规格、以及当前终端最新内容快照；
  - **编辑器实例**：Monaco Editor、Ace Editor、CodeMirror 及其绑定的当前文本与执行按钮；
  - **活跃表单输入控件**。
- `bctl look` 也会在底部自动附带 `[页面内嵌代码/查询编辑器]` 与 `[页面内嵌 Web 终端]` 的状态标识。

### 2. Web 终端连接与命令下发 (`bctl connect` / `bctl switch` / `bctl exec`)
- **多标签感知与智能复用（严禁盲目新开）**：
  - 访问 JumpServer 资产时，**严禁无端在资产树重复打开新标签**。
  - 先运行 `bctl subtabs` 查看已有终端标签，或直接使用 `bctl connect <IP>`。
  - `bctl connect <IP>` 会优先检测并复用现有活跃终端标签；仅当标签不存在、或已断开连接（`Connection closed`）时才自动重连；如确需同时打开多个终端，显式传入 `--new`。
  - 需要在已有终端间切换时，执行 `bctl switch <IP|标题|序号>` 瞬间无缝切换。
- **Web 终端命令穿透**：
  - 支持 JumpServer (Luna/Koko)、K8s 容器终端 (DOPS / Rancher / Kubernetes Dashboard)、基于 Xterm.js 的各类自研 Web 终端。
  - 自动递归 iframe、穿透 Vue/React 虚拟 DOM 挂载的 `term` 实例；当 JavaScript 内存变量未暴露时，自动退化为极速聚焦 `.xterm-helper-textarea` + 拟真键入驱动，兼顾所有非标终端。
  - 终端连接目标服务器后，直接调用 `bctl exec '<shell命令>'`。

### 3. Kibana DevTools 与代码编辑器查询 (`bctl devtools`)
- 支持 Kibana DevTools、自研 ES 查询平台、Monaco Editor、Ace Editor 与 CodeMirror。
- 自动识别编辑器实例，填充查询语句（保留或替换当前代码），触发原生执行快捷键（`Cmd+Enter` / `Ctrl+Enter`）或点击就近的绿色三角/执行按钮，并等待右侧响应面板或输出区域更新后抓取结果返回。
- 示例：`bctl devtools "GET _cat/indices?v"` 或 `bctl devtools 'GET multica-logs-*/_search\n{"query":{"match_all":{}}}'`。

### 4. JumpServer 生产主机安全与审计硬门槛（前置条件）

1. **root 状态感知与按需切换（严禁重复切 root）**：
   - **已处于 root 态时直接执行业务**：终端连接未中断且此前已切换为 root（或当前终端已处于 root shell，UID 为 0），**直接执行目标业务命令，严禁重复执行 `sudo su -`**（避免产生多层 `su` 嵌套）。
   - **仅在首次登录或断连重连后切 root**：仅在**首次登录接入主机**、**切换资产**、或**终端断开重连**且**当前身份为普通用户**时，才需要切 root：第一条命令单独执行 `sudo su -`，第二条命令单独执行 `whoami; id -u` 验证输出为 `root` 和 `0`。验证未通过立即停止，严禁用 `sudo xxx` 代替 root shell。
   - **身份未知时先确认再决定**：接管已有终端且无法确认身份时，先根据提示符（如 `#`）或执行单步 `id -u` 确认；输出已为 `0` 则直接执行后续命令，切勿盲目 `sudo su -`。
2. **禁止破坏顶层交互 shell**：严禁在交互式 shell 顶层执行 `set -e`、`set -o errexit`、`exit`、`logout` 或替换当前 shell 的 `exec`（如 `set -e` 遇到 `nginx -t` 非零会直接退出 shell 导致会话断开）。需 fail-fast 时只能放入独立子 shell（`sh -c 'set -e; ...'`），优先拆为多条短命令。
3. **单步短命令执行**：每次 `bctl exec` 只做一个短步骤并在状态边界读取结果。配置备份、编辑、语法检查、reload、HTTP 验证必须分开执行；禁止把 `sleep`、大段 `cat/grep/find`、变更与验证串成单条长命令，输出控制在必要行数内。
4. **20 秒超时与断连恢复**：`bctl exec` 等待上限固定约 20 秒，超时不代表远端未执行。**超时后严禁立即重放任何变更命令**，必须先观察终端是否仍在运行、是否已回到提示符，并检查文件/进程状态确认未执行后方可继续。若返回 `Connection websocket closed`，必须先重连资产并按第 1 条规范确认并在非 root 时切 root。
5. **本地单引号防提前展开**：调用 `bctl exec` 优先使用本地外层单引号（如 `bctl exec 'printf "%s\n" "$HOSTNAME"'`），防止本机 shell 提前展开远程命令中的 `$()`、变量或反引号。
6. **全程明文可审计**：所有终端命令与配置文件写入（如 `cat << 'EOF' > ...`、`sed`）必须保持人类直接可读的明文；**严禁**使用 `base64`、十六进制或混淆编码下发，**严禁**手动拼接 `BCTL_S_` / `BCTL_E_` 等起止探测标记。
