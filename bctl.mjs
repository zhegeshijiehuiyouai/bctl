#!/usr/bin/env node
import http from "node:http";
import { WebSocketServer } from "ws";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { resolveClientSession } from "./lib/client-session.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BCTL_VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8")).version;

const WS_PORT = 9223;
const HTTP_PORT = 9224;

let activeSocket = null;
let pendingRequests = new Map();

// --- 1. 守护进程 (Daemon / Master) ---
function startDaemon() {
  const wss = new WebSocketServer({ port: WS_PORT });

  wss.on("listening", () => {
    console.log(`[bctl] 守护进程已启动: WebSocket ws://127.0.0.1:${WS_PORT}`);
  });

  wss.on("connection", (ws) => {
    activeSocket = ws;
    console.log("[bctl] Chrome 扩展已成功建立连接");

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "pong") return; // 扩展心跳包
        if (msg.type === "hello") {
          ws.bctlVersion = typeof msg.version === "string" ? msg.version : null;
          return;
        }
        if (msg.id && pendingRequests.has(msg.id)) {
          const pending = pendingRequests.get(msg.id);
          if (pending.socket !== ws) return;
          if (msg.type === "started") {
            pending.started = true;
            return;
          }
          clearTimeout(pending.timer);
          pendingRequests.delete(msg.id);
          if (msg.error) {
            pending.reject(Object.assign(new Error(msg.error), { code: msg.code }));
          } else {
            pending.resolve(msg.result);
          }
        }
      } catch (e) {
        console.error("[bctl] 消息解析异常:", e);
      }
    });

    ws.on("close", () => {
      if (activeSocket === ws) activeSocket = null;
      for (const [id, pending] of pendingRequests) {
        if (pending.socket !== ws) continue;
        clearTimeout(pending.timer);
        pendingRequests.delete(id);
        pending.reject(Object.assign(new Error("Chrome 扩展连接已断开，已下发操作的结果未知；请先检查页面或终端状态"), { code: "BCTL_RESULT_UNKNOWN" }));
      }
      console.log("[bctl] Chrome 扩展连接已断开");
    });
  });

  wss.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.log(`[bctl] 端口 ${WS_PORT} 已被占用，已有守护进程在运行`);
      process.exit(0);
    }
  });

  // 15 秒心跳保活
  setInterval(() => {
    if (activeSocket && activeSocket.readyState === 1) {
      activeSocket.send(JSON.stringify({ type: "ping" }));
    }
  }, 15000);

  // 本地 HTTP RPC 服务
  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${HTTP_PORT}`);
    res.setHeader("Content-Type", "application/json; charset=utf-8");

    if (url.pathname === "/status") {
      res.end(JSON.stringify({
        daemon: true,
        version: BCTL_VERSION,
        extension_connected: !!activeSocket && activeSocket.readyState === 1,
        extension_version: activeSocket?.bctlVersion || null
      }));
      return;
    }

    if (!activeSocket || activeSocket.readyState !== 1) {
      res.statusCode = 503;
      res.end(JSON.stringify({ error: "Chrome 扩展未连接！请确保日常 Chrome 已打开并加载了 Ghost Cursor 扩展" }));
      return;
    }

    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        let payload = {};
        if (body) payload = JSON.parse(body);

        let action = url.pathname.replace(/^\//, "");
        const id = randomUUID();
        const socket = activeSocket;
        if (!socket || socket.readyState !== 1) throw new Error("Chrome 扩展未连接");
        const timeoutLimit = Number.isFinite(payload.timeoutMs) && payload.timeoutMs > 0 ? payload.timeoutMs + 3000 : 25000;
        const expiresAt = Date.now() + timeoutLimit;

        const promise = new Promise((resolve, reject) => {
          const pending = { resolve, reject, socket, started: false, timer: null };
          pendingRequests.set(id, pending);
          pending.timer = setTimeout(() => {
            if (pendingRequests.has(id)) {
              pendingRequests.delete(id);
              // 取消绕过扩展执行队列；expiresAt 也能在取消消息丢失时阻止过期请求。
              try {
                if (socket.readyState === 1) socket.send(JSON.stringify({ type: "cancel", id }));
              } catch (_) {}
              const detail = pending.started
                ? "操作已经开始，结果未知；请先检查页面或终端状态"
                : "已取消排队请求；若浏览器已开始执行，结果未知，请先检查页面或终端状态";
              reject(Object.assign(new Error(`操作超时（${timeoutLimit / 1000} 秒内未收到浏览器响应）；${detail}`), { code: "BCTL_RESULT_UNKNOWN" }));
            }
          }, timeoutLimit);
          try {
            socket.send(JSON.stringify({ id, action, payload, expiresAt }));
          } catch (err) {
            clearTimeout(pending.timer);
            pendingRequests.delete(id);
            reject(err);
          }
        });

        const result = await promise;
        res.end(JSON.stringify({ success: true, result }));
      } catch (err) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: err.message, code: err.code }));
      }
    });
  });

  httpServer.listen(HTTP_PORT, "127.0.0.1", () => {
    console.log(`[bctl] 本地控制端口: http://127.0.0.1:${HTTP_PORT}`);
  });
}

// 自动后台拉起守护进程
function ensureDaemonRunning() {
  const logFile = path.join(__dirname, "daemon.log");
  const out = fs.openSync(logFile, "a");
  const err = fs.openSync(logFile, "a");
  const child = spawn(process.execPath, [__filename, "daemon"], {
    detached: true,
    stdio: ["ignore", out, err]
  });
  child.unref();
}

// --- 2. CLI 客户端转发逻辑 ---
async function sendCommand(action, payload = {}, retries = 1) {
  try {
    const res = await fetch(`http://127.0.0.1:${HTTP_PORT}/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, sessionId: CLIENT_SESSION_ID })
    });
    const data = await res.json();
    if (!res.ok) {
      console.error(`[bctl 错误] ${data.error || "请求失败"}`);
      process.exit(1);
    }
    return data.result;
  } catch (err) {
    if (retries > 0 && (err.cause?.code === "ECONNREFUSED" || err.message.includes("fetch failed"))) {
      ensureDaemonRunning();
      await new Promise(r => setTimeout(r, 1200));
      return sendCommand(action, payload, retries - 1);
    }
    console.error(`[bctl 错误] 无法连接到守护进程: ${err.message}`);
    process.exit(1);
  }
}

function formatTerminalScreen(result) {
  if (!result || typeof result !== "object") {
    console.log(result);
    return;
  }
  if (!result.ok && result.error) {
    console.error(`[终端错误] ${result.error}`);
    return;
  }
  const cols = result.cols || "?";
  const rows = result.rows || "?";
  const curX = result.cursor ? result.cursor.x : "?";
  const curY = result.cursor ? result.cursor.y : "?";
  const bufType = result.bufferType || "normal";
  const actionSummary = result.sentKeys ? ` (按键: ${result.sentKeys})` : result.cmd ? ` (启动: ${result.cmd})` : "";
  console.log(`[Terminal Screen${actionSummary}] ${cols}x${rows} | 光标: (${curX}, ${curY}) | 缓冲: ${bufType}`);
  console.log("--------------------------------------------------------------------------------");
  console.log(result.screen || "(屏幕内容为空)");
  console.log("--------------------------------------------------------------------------------");
}

// --- 3. 命令行入口 ---
const args = process.argv.slice(2);
const cmd = args[0];
const CLIENT_SESSION_ID = cmd === "daemon" ? "daemon" : resolveClientSession();

if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
  console.log(`
bctl - 极简日常 Chrome 控制工具 (支持 Web 终端与 DevTools 直连及后台并发)

命令列表:
  bctl tabs                查看所有已打开的标签页（列出 TabID、标题、URL）
  bctl session             查看当前 Agent 的独立会话 ID（可用 BCTL_SESSION 环境变量覆盖）
  bctl bind <ID或关键词> [--force]  将本会话控制目标锁定在指定标签页（后台并发，不夺取前台焦点；--force 可接管其它会话占用的标签页）
  bctl unbind / release    解除控制并释放绑定的标签页（立即平滑淡出胶囊并恢复原生 Tab 栏图标）
  bctl new <url>           在后台静默打开新标签页并自动绑定（人类前台零干扰）
  bctl open <url>          在当前绑定的标签页打开指定网址并返回元素列表
  bctl subtabs / terms     查看当前页面内嵌的终端标签列表与连接状态 (JumpServer 等多标签终端)
  bctl switch <IP|序号>    在当前页面一键切换到指定的内嵌终端标签页 (不重新打开)
  bctl connect <IP> [--new] 智能连接主机 (优先复用已连接终端，断开自动重连，支持 --new 强制新开)
  bctl exec [--target frameId:index] "<shell命令>"  在已识别的 Web 终端中执行命令
  bctl screen [--target frameId:index] [--json]     获取 Web 终端当前可视屏幕文本网格与光标位置
  bctl key [--target frameId:index] "<按键序列>"   向 Web 终端发送交互按键 (如 <Ctrl-C>, <Up>, :pods<Enter>)
  bctl start [--target frameId:index] "<交互命令>" 启动交互式 TUI 程序 (如 k9s, top, vim)，不等待退出并返回首屏
  bctl devtools "<查询>"   在绑定的 Kibana DevTools / 自研 ES 控制台 / 代码编辑器中填充并执行查询
  bctl probe               一键嗅探当前页面所有就绪终端、编辑器 (Monaco / Ace / CodeMirror) 与表单
  bctl look                静默感知当前页面所有可交互元素与可见数据，返回紧凑索引摘要
  bctl act '<JSON动作数组>' 驱动 ChatGPT 同款弹簧物理鼠标执行动作（支持 click, type, press, scroll, wait）
  bctl state "<描述>"      在受控页面顶部悬浮胶囊打印当前操作描述（如 "正在排查报警..."）
  bctl reload              热重载 Chrome 扩展（开发调试时刷新 content.js 与 background.js）
  bctl status              查看 Chrome 扩展与守护进程连接状态

多 Agent 并发（互不串台）:
  每个 Agent 会话自动隔离：Codex 线程 ID、Claude/Cursor 等会话变量、终端窗口、TTY、进程树依次判定。
  不同会话各绑各的标签页并行操作；同一工具开两个窗口也会得到两个独立会话。
  查看当前会话: bctl session      手动指定: BCTL_SESSION=my-agent bctl bind <TabID>

使用场景:
  1. 后台操作堡垒机或自研 K8s 容器终端 (不影响你在前台浏览其它网页):
     bctl tabs
     bctl bind <tabs 输出中的数字 TabID>
     bctl probe
     bctl exec "ps -ef | grep multica"

  2. 后台操作 Kibana DevTools / 自研 ES 查询控制台:
     bctl tabs
     bctl bind <TabID>
     bctl devtools "GET _cat/indices?v"

  3. 普通网页自动化 (带拟人光标与动画):
     bctl open https://github.com
     bctl act '[{"type":"type","id":1,"text":"antigravity"},{"type":"press","key":"Enter"}]'
`);
  process.exit(0);
}

if (cmd === "daemon") {
  startDaemon();
} else if (cmd === "status") {
  try {
    const res = await fetch(`http://127.0.0.1:${HTTP_PORT}/status`);
    const data = await res.json();
    console.log(JSON.stringify({ ...data, session: CLIENT_SESSION_ID }, null, 2));
  } catch (e) {
    ensureDaemonRunning();
    await new Promise(r => setTimeout(r, 1000));
    try {
      const res = await fetch(`http://127.0.0.1:${HTTP_PORT}/status`);
      const data = await res.json();
      console.log(JSON.stringify({ ...data, session: CLIENT_SESSION_ID }, null, 2));
    } catch {
      console.log(JSON.stringify({ daemon: false, extension_connected: false, session: CLIENT_SESSION_ID }, null, 2));
    }
  }
} else if (cmd === "session") {
  console.log(CLIENT_SESSION_ID);
} else if (cmd === "tabs") {
  const result = await sendCommand("tabs");
  console.log(result);
} else if (cmd === "bind") {
  const bindArgs = args.slice(1).filter(a => a !== "--force" && a !== "-f");
  const force = bindArgs.length !== args.slice(1).length;
  const target = bindArgs[0];
  if (!target) {
    console.error("用法: bctl bind <TabID 或 标题/URL关键词，如 jumpserver> [--force]");
    process.exit(1);
  }
  const result = await sendCommand("bind", { target, force });
  console.log(result);
} else if (cmd === "subtabs" || cmd === "terms" || cmd === "term-tabs") {
  const result = await sendCommand("term_tabs");
  console.log(result);
} else if (cmd === "switch" || cmd === "term-switch") {
  const target = args[1];
  if (!target) {
    console.error("用法: bctl switch <终端序号、IP或主机名关键词>");
    process.exit(1);
  }
  const result = await sendCommand("term_switch", { target });
  console.log(result);
} else if (cmd === "connect" || cmd === "jump") {
  const target = args[1];
  if (!target) {
    console.error("用法: bctl connect <IP或主机名关键词> [--new]");
    process.exit(1);
  }
  const forceNew = args.includes("--new") || args.includes("-f") || args.includes("--force-new");
  const result = await sendCommand("term_connect", { target, forceNew, timeoutMs: 15000 });
  console.log(result);
} else if (cmd === "exec" || cmd === "term-exec") {
  let commandArgs = args.slice(1);
  let candidateTarget = null;
  if (commandArgs[0] === "--target") {
    const target = commandArgs[1] || "";
    const match = target.match(/^(\d+):(\d+)$/);
    if (!match) {
      console.error("用法: bctl exec --target <frameId>:<候选序号> '<shell命令>'");
      process.exit(1);
    }
    candidateTarget = { frameId: Number(match[1]), index: Number(match[2]) };
    commandArgs = commandArgs.slice(2);
  }
  const commandToRun = commandArgs.join(" ");
  if (!commandToRun) {
    console.error("用法: bctl exec [--target <frameId>:<候选序号>] '<shell命令>'");
    process.exit(1);
  }
  const result = await sendCommand("term_exec", { cmd: commandToRun, timeoutMs: 20000, candidateTarget });
  console.log(result);
} else if (cmd === "screen" || cmd === "term-screen") {
  let commandArgs = args.slice(1);
  let candidateTarget = null;
  const isJson = commandArgs.includes("--json");
  commandArgs = commandArgs.filter(a => a !== "--json");
  if (commandArgs[0] === "--target") {
    const target = commandArgs[1] || "";
    const match = target.match(/^(\d+):(\d+)$/);
    if (!match) {
      console.error("用法: bctl screen [--target <frameId>:<候选序号>] [--json]");
      process.exit(1);
    }
    candidateTarget = { frameId: Number(match[1]), index: Number(match[2]) };
  }
  const result = await sendCommand("term_screen", { candidateTarget });
  if (isJson || typeof result !== "object") {
    console.log(typeof result === "object" ? JSON.stringify(result, null, 2) : result);
  } else {
    formatTerminalScreen(result);
  }
} else if (cmd === "key" || cmd === "term-key") {
  let commandArgs = args.slice(1);
  let candidateTarget = null;
  const isJson = commandArgs.includes("--json");
  commandArgs = commandArgs.filter(a => a !== "--json");
  if (commandArgs[0] === "--target") {
    const target = commandArgs[1] || "";
    const match = target.match(/^(\d+):(\d+)$/);
    if (!match) {
      console.error("用法: bctl key [--target <frameId>:<候选序号>] [--json] '<按键序列>'");
      process.exit(1);
    }
    candidateTarget = { frameId: Number(match[1]), index: Number(match[2]) };
    commandArgs = commandArgs.slice(2);
  }
  const keySequence = commandArgs.join(" ");
  if (!keySequence) {
    console.error("用法: bctl key [--target <frameId>:<候选序号>] '<按键序列，如 <Ctrl-C>、<Up>、:pods<Enter>>'");
    process.exit(1);
  }
  const result = await sendCommand("term_key", { keys: keySequence, candidateTarget, settleMs: 150 });
  if (isJson || typeof result !== "object") {
    console.log(typeof result === "object" ? JSON.stringify(result, null, 2) : result);
  } else {
    formatTerminalScreen(result);
  }
} else if (cmd === "start" || cmd === "term-start" || cmd === "term-run") {
  let commandArgs = args.slice(1);
  let candidateTarget = null;
  const isJson = commandArgs.includes("--json");
  commandArgs = commandArgs.filter(a => a !== "--json");
  if (commandArgs[0] === "--target") {
    const target = commandArgs[1] || "";
    const match = target.match(/^(\d+):(\d+)$/);
    if (!match) {
      console.error("用法: bctl start [--target <frameId>:<候选序号>] [--json] '<交互命令>'");
      process.exit(1);
    }
    candidateTarget = { frameId: Number(match[1]), index: Number(match[2]) };
    commandArgs = commandArgs.slice(2);
  }
  const commandToRun = commandArgs.join(" ");
  if (!commandToRun) {
    console.error("用法: bctl start [--target <frameId>:<候选序号>] '<交互命令，如 k9s、top、vim>'");
    process.exit(1);
  }
  const result = await sendCommand("term_start", { cmd: commandToRun, candidateTarget, settleMs: 800 });
  if (isJson || typeof result !== "object") {
    console.log(typeof result === "object" ? JSON.stringify(result, null, 2) : result);
  } else {
    formatTerminalScreen(result);
  }
} else if (cmd === "devtools" || cmd === "query" || cmd === "console") {
  const queryToRun = args.slice(1).join(" ");
  if (!queryToRun) {
    console.error("用法: bctl devtools \"<在 Kibana DevTools / Monaco / Ace / ES 控制台中执行的查询语句>\"");
    process.exit(1);
  }
  const result = await sendCommand("devtools_exec", { query: queryToRun, timeoutMs: 25000 });
  console.log(result);
} else if (cmd === "probe") {
  const result = await sendCommand("probe");
  console.log(result);
} else if (cmd === "look") {
  const result = await sendCommand("look");
  console.log(result);
} else if (cmd === "new") {
  const url = args[1];
  if (!url) {
    console.error("用法: bctl new <url> (在后台打开新标签页并自动绑定)");
    process.exit(1);
  }
  const result = await sendCommand("new", { url });
  console.log(result);
} else if (cmd === "open") {
  const url = args[1];
  if (!url) {
    console.error("用法: bctl open <url>");
    process.exit(1);
  }
  const result = await sendCommand("open", { url });
  console.log(result);
} else if (cmd === "act") {
  const actionJson = args.slice(1).join(" ");
  if (!actionJson) {
    console.error("用法: bctl act '<JSON动作数组>'");
    process.exit(1);
  }
  let parsed = null;
  try {
    parsed = JSON.parse(actionJson);
  } catch (e) {
    console.error("JSON 格式错误，请传入合法的 JSON 动作数组，例如: '[{\"type\":\"click\",\"id\":1}]'");
    process.exit(1);
  }
  const result = await sendCommand("act", { actions: Array.isArray(parsed) ? parsed : [parsed] });
  console.log(result);
} else if (cmd === "state" || cmd === "status-pill") {
  const text = args.slice(1).join(" ");
  if (!text) {
    console.error("用法: bctl state \"<要显示在受控页面悬浮胶囊中的状态描述>\"");
    process.exit(1);
  }
  const result = await sendCommand("state", { text });
  console.log(result);
} else if (cmd === "unbind" || cmd === "release") {
  const result = await sendCommand("unbind");
  console.log(result);
} else if (cmd === "reload") {
  const result = await sendCommand("reload");
  console.log(result);
} else if (cmd === "eval") {
  const code = args.slice(1).join(" ");
  if (!code) {
    console.error("用法: bctl eval \"<js代码>\"");
    process.exit(1);
  }
  const result = await sendCommand("eval", { code });
  console.log(result);
} else {
  console.error(`未知命令: ${cmd}。运行 bctl help 查看帮助。`);
  process.exit(1);
}
