#!/usr/bin/env node
import http from "node:http";
import { WebSocketServer } from "ws";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
        if (msg.id && pendingRequests.has(msg.id)) {
          const { resolve } = pendingRequests.get(msg.id);
          pendingRequests.delete(msg.id);
          resolve(msg.result);
        }
      } catch (e) {
        console.error("[bctl] 消息解析异常:", e);
      }
    });

    ws.on("close", () => {
      if (activeSocket === ws) activeSocket = null;
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
        extension_connected: !!activeSocket && activeSocket.readyState === 1
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
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const timeoutLimit = payload.timeoutMs ? payload.timeoutMs + 3000 : 25000;

        const promise = new Promise((resolve, reject) => {
          pendingRequests.set(id, { resolve, reject });
          setTimeout(() => {
            if (pendingRequests.has(id)) {
              pendingRequests.delete(id);
              reject(new Error(`操作超时（${timeoutLimit / 1000} 秒内未收到浏览器响应）`));
            }
          }, timeoutLimit);
        });

        activeSocket.send(JSON.stringify({ id, action, payload }));
        const result = await promise;
        res.end(JSON.stringify({ success: true, result }));
      } catch (err) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: err.message }));
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
      body: JSON.stringify(payload)
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

// --- 3. 命令行入口 ---
const args = process.argv.slice(2);
const cmd = args[0];

if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
  console.log(`
bctl - 极简日常 Chrome 控制工具 (支持 JumpServer 终端直连与后台并发)

命令列表:
  bctl tabs                查看所有已打开的标签页（列出 TabID、标题、URL）
  bctl bind <ID或关键词>   将大模型控制目标锁定在指定标签页（后台并发，不夺取前台焦点）
  bctl unbind / release    解除控制并释放绑定的标签页（立即平滑淡出胶囊并恢复原生 Tab 栏图标）
  bctl new <url>           在后台静默打开新标签页并自动绑定（人类前台零干扰）
  bctl open <url>          在当前绑定的标签页打开指定网址并返回元素列表
  bctl exec "<shell命令>"  在绑定的 JumpServer Web 终端中执行命令并获取输出
  bctl look                静默感知当前页面所有可交互元素与可见数据，返回紧凑索引摘要（不再在页面渲染数字角标）
  bctl act '<JSON动作数组>' 驱动 ChatGPT 同款弹簧物理鼠标执行动作（支持 click, type, press, scroll, wait）
  bctl state "<描述>"      在受控页面顶部悬浮胶囊打印当前操作描述（如 "正在排查报警..."）
  bctl reload              热重载 Chrome 扩展（开发调试时刷新 content.js 与 background.js）
  bctl status              查看 Chrome 扩展与守护进程连接状态

使用场景:
  1. 后台操作堡垒机 (不影响你在前台浏览其它网页):
     bctl tabs
     bctl bind jumpserver
     bctl exec "ps -ef | grep jenkins"
     bctl exec "systemctl status jenkins"

  2. 普通网页自动化 (带拟人光标与动画):
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
    console.log(JSON.stringify(data, null, 2));
  } catch (e) {
    ensureDaemonRunning();
    await new Promise(r => setTimeout(r, 1000));
    try {
      const res = await fetch(`http://127.0.0.1:${HTTP_PORT}/status`);
      const data = await res.json();
      console.log(JSON.stringify(data, null, 2));
    } catch {
      console.log(JSON.stringify({ daemon: false, extension_connected: false }, null, 2));
    }
  }
} else if (cmd === "tabs") {
  const result = await sendCommand("tabs");
  console.log(result);
} else if (cmd === "bind") {
  const target = args[1];
  if (!target) {
    console.error("用法: bctl bind <TabID 或 标题/URL关键词，如 jumpserver>");
    process.exit(1);
  }
  const result = await sendCommand("bind", { target });
  console.log(result);
} else if (cmd === "exec" || cmd === "term-exec") {
  const commandToRun = args.slice(1).join(" ");
  if (!commandToRun) {
    console.error("用法: bctl exec \"<在 JumpServer 终端中执行的 shell 命令>\"");
    process.exit(1);
  }
  const result = await sendCommand("term_exec", { cmd: commandToRun, timeoutMs: 20000 });
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
