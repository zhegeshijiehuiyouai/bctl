let ws = null;
const WS_URL = "ws://127.0.0.1:9223";
const ACTION_ALIASES = new Map([
  ["subswitch", "term_switch"],
  ["jump", "term_connect"]
]);

const CONTROL_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 小时超时兜底（避免长任务/等待人工操作时误解绑）

// ─── 多会话绑定逻辑 (SESSION-BINDINGS BEGIN) ───
// 每个 Agent 会话（Codex 线程、Claude 会话、终端窗口、进程…）各自持有一个后台绑定，
// 同一标签页最多归属一个会话，从而保证多个大模型并发操作互不串台。
const DEFAULT_SESSION_ID = "default";
const SESSION_BINDINGS_KEY = "sessionBindings";
const LEGACY_BINDING_KEYS = ["boundTabId", "lastActivityTime"];

function normalizeSessionId(value) {
  const normalized = String(value ?? "").replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 160);
  return normalized || DEFAULT_SESSION_ID;
}

function sanitizeBindings(raw) {
  const bindings = {};
  if (!raw || typeof raw !== "object") return bindings;
  for (const [sessionId, entry] of Object.entries(raw)) {
    const tabId = Number(entry && typeof entry === "object" ? entry.tabId : entry);
    if (!Number.isInteger(tabId) || tabId <= 0) continue;
    bindings[normalizeSessionId(sessionId)] = {
      tabId,
      lastActivity: Number(entry && typeof entry === "object" ? entry.lastActivity : 0) || 0
    };
  }
  return bindings;
}

let sessionBindingsCache = null;
let sessionBindingsLoad = null;
let sessionBindingsChain = Promise.resolve();

async function loadSessionBindings() {
  if (sessionBindingsCache) return sessionBindingsCache;
  if (!sessionBindingsLoad) {
    sessionBindingsLoad = (async () => {
      const stored = await chrome.storage.session.get([SESSION_BINDINGS_KEY, ...LEGACY_BINDING_KEYS]);
      const bindings = sanitizeBindings(stored[SESSION_BINDINGS_KEY]);
      // 兼容升级前的全局单绑定：归入默认会话，避免老标签页失联
      if (stored.boundTabId && !bindings[DEFAULT_SESSION_ID]) {
        bindings[DEFAULT_SESSION_ID] = {
          tabId: Number(stored.boundTabId),
          lastActivity: Number(stored.lastActivityTime) || Date.now()
        };
      }
      // 清理旧版本并发绑定留下的重复归属，保留最近活跃的会话。
      const owners = new Map();
      for (const [sessionId, entry] of Object.entries(bindings)) {
        const owner = owners.get(entry.tabId);
        if (owner && bindings[owner].lastActivity > entry.lastActivity) {
          delete bindings[sessionId];
        } else {
          if (owner) delete bindings[owner];
          owners.set(entry.tabId, sessionId);
        }
      }
      await chrome.storage.session.set({ [SESSION_BINDINGS_KEY]: bindings });
      if (stored.boundTabId !== undefined || stored.lastActivityTime !== undefined) {
        await chrome.storage.session.remove(LEGACY_BINDING_KEYS);
      }
      sessionBindingsCache = bindings;
      return bindings;
    })().finally(() => { sessionBindingsLoad = null; });
  }
  return sessionBindingsLoad;
}

async function readSessionBindings() {
  await sessionBindingsChain.catch(() => {});
  const bindings = await loadSessionBindings();
  return { ...bindings };
}

async function mutateSessionBindings(mutator, assertActive = null) {
  const run = sessionBindingsChain.then(async () => {
    assertActive?.();
    const bindings = { ...await loadSessionBindings() };
    assertActive?.();
    const outcome = await mutator(bindings);
    assertActive?.();
    await chrome.storage.session.set({ [SESSION_BINDINGS_KEY]: bindings });
    sessionBindingsCache = bindings;
    return outcome;
  });
  sessionBindingsChain = run.catch(() => {});
  return run;
}

async function getBoundTabId(sessionId) {
  const bindings = await readSessionBindings();
  return bindings[normalizeSessionId(sessionId)]?.tabId ?? null;
}

async function getBindingOwner(tabId, sessionId) {
  const bindings = await readSessionBindings();
  const current = normalizeSessionId(sessionId);
  for (const [owner, entry] of Object.entries(bindings)) {
    if (owner !== current && entry.tabId === tabId) return owner;
  }
  return null;
}

async function bindSessionTab(sessionId, tabId, force = false, assertActive = null) {
  return mutateSessionBindings(bindings => {
    const key = normalizeSessionId(sessionId);
    const owner = Object.keys(bindings).find(other => other !== key && bindings[other].tabId === tabId);
    if (owner && !force) return { ok: false, owner };
    const previousTabId = bindings[key]?.tabId ?? null;
    for (const other of Object.keys(bindings)) {
      if (other !== key && bindings[other].tabId === tabId) delete bindings[other];
    }
    bindings[key] = { tabId, lastActivity: Date.now() };
    return { ok: true, owner: owner || null, previousTabId };
  }, assertActive);
}

async function clearSessionBinding(sessionId) {
  return mutateSessionBindings(bindings => {
    const key = normalizeSessionId(sessionId);
    const tabId = bindings[key]?.tabId ?? null;
    delete bindings[key];
    return tabId;
  });
}

async function touchSession(sessionId) {
  const key = normalizeSessionId(sessionId);
  return mutateSessionBindings(bindings => {
    if (bindings[key]) bindings[key] = { ...bindings[key], lastActivity: Date.now() };
  });
}

async function takeStaleBindings(now = Date.now(), timeoutMs = CONTROL_TIMEOUT_MS) {
  return mutateSessionBindings(current => {
    const removed = [];
    for (const [sessionId, entry] of Object.entries(current)) {
      if (entry.lastActivity && now - entry.lastActivity > timeoutMs) {
        delete current[sessionId];
        removed.push({ sessionId, tabId: entry.tabId });
      }
    }
    return removed;
  });
}

async function removeTabBindings(tabId) {
  return mutateSessionBindings(bindings => {
    const removed = [];
    for (const [sessionId, entry] of Object.entries(bindings)) {
      if (entry.tabId === tabId) {
        delete bindings[sessionId];
        removed.push(sessionId);
      }
    }
    return removed;
  });
}

async function listBoundTabs() {
  const bindings = await readSessionBindings();
  const owners = new Map();
  for (const [sessionId, entry] of Object.entries(bindings)) owners.set(entry.tabId, sessionId);
  return owners;
}

// 同一会话的命令串行执行，不同会话并行，避免同一会话内的 bind/exec 互相踩踏
const sessionTaskQueues = new Map();
const tabTaskQueues = new Map();
function enqueueTask(queues, key, task) {
  const previous = queues.get(key) || Promise.resolve();
  const run = previous.then(task, task);
  const tail = run.catch(() => {});
  queues.set(key, tail);
  tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return run;
}
function enqueueSessionTask(sessionId, task) {
  return enqueueTask(sessionTaskQueues, normalizeSessionId(sessionId), task);
}
function enqueueTabTask(tabId, task) {
  return enqueueTask(tabTaskQueues, tabId, task);
}
// ─── 多会话绑定逻辑 (SESSION-BINDINGS END) ───

async function releaseUnownedTab(tabId) {
  if (!tabId || (await listBoundTabs()).has(tabId)) return;
  await enqueueTabTask(tabId, async () => {
    if ((await listBoundTabs()).has(tabId)) return;
    await chrome.tabs.sendMessage(tabId, { action: "hide_control_state" }).catch(() => {});
    await chrome.tabs.update(tabId, { autoDiscardable: true }).catch(() => {});
  });
}

// 1. 保活报警器（MV3 Service Worker 闲置 30 秒休眠防断连，兼顾 2 小时闲置超时兜底）
chrome.alarms.create("keepAlive", { periodInMinutes: 0.3 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "keepAlive") {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      connectWS();
    } else {
      ws.send(JSON.stringify({ type: "pong" }));
    }

    // 2 小时超时兜底：逐个会话检查是否超过 2 小时未收到大模型任何操作
    try {
      const expired = await takeStaleBindings(Date.now(), CONTROL_TIMEOUT_MS);
      for (const { sessionId, tabId } of expired) {
        console.log(`[bctl] 会话 ${sessionId} 超过 2 小时无操作，触发超时兜底自动解绑标签页: ${tabId}`);
        await releaseUnownedTab(tabId);
      }
    } catch (_) {}
  }
});

let isConnecting = false;

async function connectWS() {
  if (isConnecting || (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING))) {
    return;
  }
  isConnecting = true;

  try {
    // 关键优化：先做轻量 fetch 静默探活，避免在 daemon 重启或未就绪时触发底层 net::ERR_CONNECTION_REFUSED
    const isDaemonUp = await fetch("http://127.0.0.1:9224/status", { signal: AbortSignal.timeout(600) })
      .then(res => res.ok)
      .catch(() => false);

    if (!isDaemonUp) {
      isConnecting = false;
      setTimeout(connectWS, 2500);
      return;
    }

    ws = new WebSocket(WS_URL);
  } catch (e) {
    isConnecting = false;
    setTimeout(connectWS, 2500);
    return;
  }

  const socket = ws;
  const requests = new Map();
  const replyError = (id, err, request) => {
    if (!id || socket.readyState !== WebSocket.OPEN) return;
    const unknown = request?.started && err.code === "BCTL_REQUEST_EXPIRED";
    socket.send(JSON.stringify({
      id,
      error: unknown ? "请求已过期，操作可能已经执行，结果未知；请先检查页面或终端状态" : err.message,
      code: unknown ? "BCTL_RESULT_UNKNOWN" : (err.code || "BCTL_EXTENSION_ERROR")
    }));
  };

  ws.onopen = () => {
    isConnecting = false;
    socket.send(JSON.stringify({ type: "hello", version: chrome.runtime.getManifest().version }));
    console.log("[Extension] 成功连接至本地 bctl 守护进程");
  };

  ws.onmessage = (e) => {
    let msg = null;
    try {
      msg = JSON.parse(e.data);
    } catch (err) {
      console.error("[Extension] 消息解析异常:", err);
      return;
    }

    if (msg.type === "ping") {
      socket.send(JSON.stringify({ type: "pong" }));
      return;
    }
    // 取消消息绕过会话队列，阻止仍在排队的请求稍后执行。
    if (msg.type === "cancel") {
      const request = requests.get(msg.id);
      if (request) request.cancelled = true;
      return;
    }

    const sessionId = normalizeSessionId(msg.payload?.sessionId);
    const request = { cancelled: false, started: false, expiresAt: Number.isFinite(msg.expiresAt) ? msg.expiresAt : Infinity };
    requests.set(msg.id, request);
    // 不同会话并行执行，同一会话内串行，避免并发命令互相踩踏
    enqueueSessionTask(sessionId, () => handleMessage(msg, request)).catch((err) => {
      console.error("[Extension] 处理异常:", err);
      replyError(msg.id, err, request);
    }).finally(() => requests.delete(msg.id));
  };

  const handleMessage = async (msg, request) => {
    const ws = socket;
    const assertRequestActive = () => {
      if (request.cancelled || Date.now() >= request.expiresAt || socket.readyState !== WebSocket.OPEN) {
        const err = new Error("请求在执行前已过期或取消，操作未执行");
        err.code = "BCTL_REQUEST_EXPIRED";
        throw err;
      }
    };
    const startRequest = () => {
      assertRequestActive();
      if (!request.started) {
        request.started = true;
        ws.send(JSON.stringify({ type: "started", id: msg.id }));
      }
    };
    try {
      assertRequestActive();
      const { id } = msg;
      const action = ACTION_ALIASES.get(msg.action) || msg.action;
      const payload = msg.payload && typeof msg.payload === "object" ? msg.payload : {};
      const sessionId = normalizeSessionId(payload.sessionId);

      if (action === "reload") {
        startRequest();
        ws.send(JSON.stringify({ id, result: "Chrome 扩展已成功触发重载" }));
        setTimeout(() => {
          chrome.runtime.reload();
        }, 100);
        return;
      }

      // ─── 动作 1: 列出所有标签页 (bctl tabs) ───
      if (action === "tabs") {
        startRequest();
        const owners = await listBoundTabs();
        const allTabs = await chrome.tabs.query({});
        const lines = allTabs.map(t => {
          const owner = owners.get(t.id);
          const isBound = owner
            ? (owner === sessionId ? " [★ 本会话绑定]" : ` [★ 已被会话 ${owner} 绑定]`)
            : "";
          const isActive = t.active ? " [当前前台]" : "";
          return `[${t.id}] ${t.title || "(无标题)"} (${t.url || "about:blank"})${isBound}${isActive}`;
        });
        ws.send(JSON.stringify({ id, result: lines.join("\n") || "未找到打开的标签页" }));
        return;
      }

      // ─── 动作 2: 绑定指定标签页 (bctl bind <id|keyword>) ───
      if (action === "bind") {
        const rawTarget = (payload.target || "").toString().trim();
        const targetLower = rawTarget.toLowerCase();
        const allTabs = await chrome.tabs.query({});
        let matchedTab = null;

        // 1. 若输入为纯数字，严格按 Tab ID 精确匹配
        if (/^\d+$/.test(rawTarget)) {
          const targetId = parseInt(rawTarget, 10);
          matchedTab = allTabs.find(t => t.id === targetId);
          if (!matchedTab) {
            throw Object.assign(new Error(`未找到 TabID 为 [${targetId}] 的标签页，请先运行 bctl tabs 查看当前可用标签页`), {
              code: "BCTL_TARGET_NOT_FOUND"
            });
          }
        } else if (rawTarget) {
          // 2. 输入为关键词，按标题/URL 模糊匹配；若匹配到多个则报错拦截，彻底杜绝串台
          const matchedTabs = allTabs.filter(t =>
            (t.title && t.title.toLowerCase().includes(targetLower)) ||
            (t.url && t.url.toLowerCase().includes(targetLower))
          );

          if (matchedTabs.length > 1) {
            const listStr = matchedTabs.map(t => `  - [${t.id}] ${t.title || "(无标题)"} (${t.url || ""})`).join("\n");
            throw Object.assign(new Error(`[多实例冲突拦截] 关键词 "${rawTarget}" 匹配到 ${matchedTabs.length} 个标签页！为防止串台误操作，请使用精准 TabID 绑定：\n${listStr}\n\n示例: bctl bind ${matchedTabs[0].id}`), {
              code: "BCTL_TARGET_AMBIGUOUS"
            });
          }
          matchedTab = matchedTabs[0] || null;
        }

        if (!matchedTab) {
          throw Object.assign(new Error(`未找到匹配 "${rawTarget}" 的标签页，请先运行 bctl tabs 查看当前标签列表`), {
            code: "BCTL_TARGET_NOT_FOUND"
          });
        }

        // 会话隔离：同一标签页只归属一个会话，防止两个 Agent 抢同一页面互相串台
        const binding = await enqueueTabTask(matchedTab.id, async () => {
          startRequest();
          const claimed = await bindSessionTab(sessionId, matchedTab.id, payload.force === true, assertRequestActive);
          if (!claimed.ok) return claimed;
          await chrome.tabs.update(matchedTab.id, { autoDiscardable: false }).catch(() => {});
          await ensureContentScript(matchedTab.id);
          await chrome.tabs.sendMessage(matchedTab.id, {
            action: "set_status",
            payload: { text: "AI Agent 已接管此标签页", autoResetDelay: 2500 }
          }).catch(() => {});
          return claimed;
        });
        const { owner, previousTabId } = binding;
        if (!binding.ok) {
          throw Object.assign(new Error(`[会话隔离拦截] 标签页 [${matchedTab.id}] "${matchedTab.title}" 当前由会话 "${owner}" 控制。\n如需接管，请让该会话先执行 bctl unbind，或使用 bctl bind ${matchedTab.id} --force 显式抢占。`), {
            code: "BCTL_SESSION_CONFLICT"
          });
        }

        if (previousTabId && previousTabId !== matchedTab.id) {
          await releaseUnownedTab(previousTabId);
        }

        const takeoverNote = owner ? `\n已从会话 "${owner}" 显式接管该标签页。` : "";
        ws.send(JSON.stringify({
          id,
          result: `已成功绑定目标标签页 [${matchedTab.id}] "${matchedTab.title}"（会话: ${sessionId}）${takeoverNote}\n后续操作将在该标签页后台独立运行，不抢占前台焦点！`
        }));
        return;
      }

      // ─── 动作 2.5: 在后台静默打开新标签页 (bctl new <url>) ───
      if (action === "new") {
        startRequest();
        const newTab = await chrome.tabs.create({ url: payload.url, active: false });
        let previousTabId = null;
        let res;
        try {
          res = await enqueueTabTask(newTab.id, async () => {
            assertRequestActive();
            const claimed = await bindSessionTab(sessionId, newTab.id);
            if (!claimed.ok) throw new Error(`新标签页 [${newTab.id}] 已被会话 "${claimed.owner}" 绑定`);
            previousTabId = claimed.previousTabId;
            await chrome.tabs.update(newTab.id, { autoDiscardable: false }).catch(() => {});
            await waitForTabLoad(newTab.id);
            await ensureContentScript(newTab.id);
            assertRequestActive();
            chrome.tabs.sendMessage(newTab.id, {
              action: "set_status",
              payload: { text: "正在加载并感知新页面..." }
            }).catch(() => {});
            return chrome.tabs.sendMessage(newTab.id, { action: "look" });
          });
        } finally {
          if (previousTabId && previousTabId !== newTab.id) await releaseUnownedTab(previousTabId);
        }
        ws.send(JSON.stringify({ id, result: `[已在后台打开新标签页 ${newTab.id}: ${payload.url}]\n\n${res}` }));
        return;
      }

      // ─── 动作 2.6: 解除绑定与释放控制 (bctl unbind / bctl release) ───
      if (action === "unbind" || action === "release") {
        startRequest();
        const releasedTabId = await clearSessionBinding(sessionId);
        await releaseUnownedTab(releasedTabId);
        ws.send(JSON.stringify({
          id,
          result: releasedTabId
            ? `已解除会话 "${sessionId}" 对标签页 [${releasedTabId}] 的绑定，指示胶囊与 Tab 栏图标已恢复正常`
            : `会话 "${sessionId}" 当前未绑定任何标签页`
        }));
        return;
      }

      // 刷新当前会话的活跃时间戳
      await touchSession(sessionId);

      // 强校验：执行与终端交互类动作必须严格绑定后台标签页，严禁盲目降级回退到前台活动标签
      const REQUIRE_BOUND_ACTIONS = new Set([
        "term_exec",
        "devtools_exec",
        "act",
        "open",
        "term_connect",
        "term_switch",
        "term_tabs",
        "subtabs",
        "term_screen",
        "term_key",
        "term_start",
        "eval",
        "state",
        "set_status"
      ]);

      const needBound = REQUIRE_BOUND_ACTIONS.has(action);
      const expectedBinding = await getBoundTabId(sessionId);
      const targetTab = await getTargetTab(sessionId, needBound);
      if (!targetTab) {
        if (needBound) {
          throw Object.assign(new Error(`[安全拦截] 会话 "${sessionId}" 当前未绑定任何后台标签页！为防止向人类前台正在浏览的页面或其它终端误发命令，执行与终端交互类操作严禁未绑定运行。请先使用 bctl tabs 查看并用 bctl bind <TabID> 显式锁定目标。`), {
            code: "BCTL_BINDING_REQUIRED"
          });
        }
        ws.send(JSON.stringify({ id, result: "未找到可用标签页！请先执行 bctl tabs 查看并用 bctl bind 绑定" }));
        return;
      }

      return await enqueueTabTask(targetTab.id, async () => {
        // 锁定标签页后重验归属；force 接管等待正在执行的操作完成。
        assertRequestActive();
        const currentBinding = await getBoundTabId(sessionId);
        const owner = await getBindingOwner(targetTab.id, sessionId);
        if (owner || (expectedBinding && currentBinding !== targetTab.id) || (needBound && currentBinding !== targetTab.id)) {
          throw new Error(`[会话隔离拦截] 标签页 [${targetTab.id}] 的归属已变化，请重新查看 bctl tabs 并绑定目标`);
        }
        startRequest();

        // ─── 动作 3: Web 终端命令穿透执行 (bctl exec) ───
        if (action === "term_exec") {
          const cmd = payload.cmd || "";
          const timeoutMs = payload.timeoutMs || 20000;
          const candidateTarget = payload.candidateTarget || null;
          await ensureContentScript(targetTab.id);
          const cmdSummary = cmd.length > 28 ? cmd.slice(0, 28) + "..." : cmd;
          chrome.tabs.sendMessage(targetTab.id, {
            action: "set_status",
            payload: { text: `正在执行命令: ${cmdSummary}` }
          }).catch(() => {});

          const { selected, error: selectionError } = await resolveSelectedTerminal(targetTab.id, candidateTarget);

          if (!selected) {
            chrome.tabs.sendMessage(targetTab.id, {
              action: "set_status",
              payload: { text: "终端目标未确认，命令未发送", autoResetDelay: 2500 }
            }).catch(() => {});
            ws.send(JSON.stringify({
              id,
              result: `${selectionError}。命令未发送。请运行 bctl probe；若候选可辨认，用 bctl exec --target <frameId>:<候选序号> '<命令>' 明确选择。对于没有可访问名称或键盘输入节点的纯像素画布，浏览器脚本无法可靠识别输入位置。`
            }));
            return;
          }

          assertRequestActive();
          const executionResults = await chrome.scripting.executeScript({
            target: { tabId: targetTab.id, frameIds: [selected.frameId] },
            world: "MAIN",
            args: [cmd, timeoutMs, selected.index, false, selected.kind],
            func: executeInWebTerminal
          });
          const execution = executionResults?.find(frame => frame?.result?.matched === true);
          if (!execution) {
            chrome.tabs.sendMessage(targetTab.id, {
              action: "set_status",
              payload: { text: "终端目标已变化，命令未确认", autoResetDelay: 2500 }
            }).catch(() => {});
            ws.send(JSON.stringify({ id, result: "候选在执行前已变化，因此未能确认命令发送。请重新运行 bctl probe 后再试。" }));
            return;
          }
          const hit = execution.result;

          chrome.tabs.sendMessage(targetTab.id, {
            action: "set_status",
            payload: { text: hit.ok ? "终端命令执行完成" : "终端命令结果待确认", autoResetDelay: 2500 }
          }).catch(() => {});

          if (hit.ok) {
            ws.send(JSON.stringify({ id, result: hit.output }));
          } else {
            ws.send(JSON.stringify({
              id,
              result: `[执行异常/超时] ${hit.error || "未知错误"}\n${hit.partialOutput || ""}`
            }));
          }
          return;
        }

        // ─── 动作 3.1: 终端全屏字符网格快照 (bctl screen / term_screen) ───
        if (action === "term_screen") {
          const candidateTarget = payload.candidateTarget || null;
          await ensureContentScript(targetTab.id);
          const { selected, error: selectionError } = await resolveSelectedTerminal(targetTab.id, candidateTarget);
          if (!selected) {
            ws.send(JSON.stringify({ id, result: { ok: false, error: selectionError } }));
            return;
          }

          assertRequestActive();
          const results = await chrome.scripting.executeScript({
            target: { tabId: targetTab.id, frameIds: [selected.frameId] },
            world: "MAIN",
            args: ["", 0, selected.index, false, selected.kind, { mode: "screen" }],
            func: executeInWebTerminal
          });
          const execution = results?.find(frame => frame?.result?.matched === true);
          if (!execution || !execution.result) {
            ws.send(JSON.stringify({ id, result: { ok: false, error: "未能读取目标终端屏幕" } }));
            return;
          }
          ws.send(JSON.stringify({ id, result: execution.result }));
          return;
        }

        // ─── 动作 3.2: 终端交互按键与转义序列发送 (bctl key / term_key) ───
        if (action === "term_key") {
          const keys = payload.keys || "";
          const candidateTarget = payload.candidateTarget || null;
          const settleMs = payload.settleMs || 150;
          await ensureContentScript(targetTab.id);
          const { selected, error: selectionError } = await resolveSelectedTerminal(targetTab.id, candidateTarget);
          if (!selected) {
            ws.send(JSON.stringify({ id, result: { ok: false, error: selectionError } }));
            return;
          }

          chrome.tabs.sendMessage(targetTab.id, {
            action: "set_status",
            payload: { text: `发送按键: ${keys.slice(0, 20)}` }
          }).catch(() => {});

          assertRequestActive();
          const results = await chrome.scripting.executeScript({
            target: { tabId: targetTab.id, frameIds: [selected.frameId] },
            world: "MAIN",
            args: ["", 0, selected.index, false, selected.kind, { mode: "key", keys, settleMs }],
            func: executeInWebTerminal
          });
          const execution = results?.find(frame => frame?.result?.matched === true);
          if (!execution || !execution.result) {
            ws.send(JSON.stringify({ id, result: { ok: false, error: "向目标终端发送按键失败" } }));
            return;
          }
          ws.send(JSON.stringify({ id, result: execution.result }));
          return;
        }

        // ─── 动作 3.3: 启动交互式 TUI 程序 (bctl start / term_start) ───
        if (action === "term_start") {
          const cmd = payload.cmd || "";
          const candidateTarget = payload.candidateTarget || null;
          const settleMs = payload.settleMs || 800;
          await ensureContentScript(targetTab.id);
          const { selected, error: selectionError } = await resolveSelectedTerminal(targetTab.id, candidateTarget);
          if (!selected) {
            ws.send(JSON.stringify({ id, result: { ok: false, error: selectionError } }));
            return;
          }

          chrome.tabs.sendMessage(targetTab.id, {
            action: "set_status",
            payload: { text: `启动交互程序: ${cmd.slice(0, 24)}` }
          }).catch(() => {});

          assertRequestActive();
          const results = await chrome.scripting.executeScript({
            target: { tabId: targetTab.id, frameIds: [selected.frameId] },
            world: "MAIN",
            args: [cmd, 0, selected.index, false, selected.kind, { mode: "start", settleMs }],
            func: executeInWebTerminal
          });
          const execution = results?.find(frame => frame?.result?.matched === true);
          if (!execution || !execution.result) {
            ws.send(JSON.stringify({ id, result: { ok: false, error: "启动目标交互程序失败" } }));
            return;
          }
          ws.send(JSON.stringify({ id, result: execution.result }));
          return;
        }

        // ─── 动作 3.5: Kibana DevTools / 自研代码编辑器查询执行 (bctl devtools) ───
        if (action === "devtools_exec") {
          const query = payload.query || "";
          const timeoutMs = payload.timeoutMs || 25000;
          await ensureContentScript(targetTab.id);
          const qSummary = query.length > 28 ? query.slice(0, 28).replace(/\n/g, " ") + "..." : query.replace(/\n/g, " ");
          chrome.tabs.sendMessage(targetTab.id, {
            action: "set_status",
            payload: { text: `正在执行查询: ${qSummary}` }
          }).catch(() => {});

          assertRequestActive();
          const results = await chrome.scripting.executeScript({
            target: { tabId: targetTab.id, allFrames: true },
            world: "MAIN",
            args: [query, timeoutMs],
            func: executeInDevTools
          });

          const hit = results?.find(r => r?.result && r.result.matched === true);
          if (!hit) {
            chrome.tabs.sendMessage(targetTab.id, {
              action: "set_status",
              payload: { text: "未找到编辑器", autoResetDelay: 2500 }
            }).catch(() => {});
            ws.send(JSON.stringify({
              id,
              result: `在标签页 [${targetTab.id}] "${targetTab.title}" 中未找到支持的代码/查询编辑器 (支持 Monaco / Ace / CodeMirror / Kibana DevTools)！`
            }));
            return;
          }

          chrome.tabs.sendMessage(targetTab.id, {
            action: "set_status",
            payload: { text: "查询执行完成", autoResetDelay: 2500 }
          }).catch(() => {});

          if (hit.result.ok) {
            ws.send(JSON.stringify({ id, result: hit.result.output }));
          } else {
            ws.send(JSON.stringify({
              id,
              result: `[查询异常/超时] ${hit.result.error || "未知错误"}\n${hit.result.partialOutput || ""}`
            }));
          }
          return;
        }

        // ─── 动作 3.8: 控制台/终端/编辑器一键探测 (bctl probe) ───
        if (action === "probe") {
          await ensureContentScript(targetTab.id);
          assertRequestActive();
          const [terminalResults, editorResults] = await Promise.all([
            chrome.scripting.executeScript({
              target: { tabId: targetTab.id, allFrames: true },
              world: "MAIN",
              args: ["", 0, null, true],
              func: executeInWebTerminal
            }),
            chrome.scripting.executeScript({
              target: { tabId: targetTab.id, allFrames: true },
              world: "MAIN",
              func: probePageInteractiveCapabilities
            })
          ]);
          const terminals = (terminalResults || []).flatMap(frame =>
            (frame?.result?.candidates || []).map(candidate => ({
              ...candidate,
              frameId: frame.frameId,
              candidateId: `${frame.frameId}:${candidate.index}`
            }))
          );
          const editors = (editorResults || []).flatMap(frame =>
            (frame?.result?.editors || []).map(editor => ({ ...editor, frameId: frame.frameId }))
          );
          const inputCount = (editorResults || []).reduce((sum, frame) => sum + (frame?.result?.inputsCount || 0), 0);
          const finalReport = { url: targetTab.url, terminals, editors, inputsCount: inputCount };
          ws.send(JSON.stringify({ id, result: JSON.stringify(finalReport, null, 2) }));
          return;
        }

        // ─── 动作 4: 打开新网址 (bctl open) ───
        if (action === "open") {
          await ensureContentScript(targetTab.id);
          chrome.tabs.sendMessage(targetTab.id, {
            action: "set_status",
            payload: { text: `正在打开网址: ${payload.url}...` }
          }).catch(() => {});
          assertRequestActive();
          await chrome.tabs.update(targetTab.id, { url: payload.url });
          await waitForTabLoad(targetTab.id);
          await ensureContentScript(targetTab.id);
          assertRequestActive();
          const res = await chrome.tabs.sendMessage(targetTab.id, { action: "look" });
          ws.send(JSON.stringify({ id, result: res }));
          return;
        }

        // ─── 动作 4.5: 设置状态描述 (bctl state <描述>) ───
        if (action === "state" || action === "set_status") {
          await ensureContentScript(targetTab.id);
          assertRequestActive();
          await chrome.tabs.sendMessage(targetTab.id, {
            action: "set_status",
            payload: { text: payload.text, autoResetDelay: payload.autoResetDelay || 0 }
          });
          ws.send(JSON.stringify({ id, result: `已更新受控页面状态提示: "${payload.text}"` }));
          return;
        }

        // ─── 动作 4.6: JS 表达式诊断评估 (bctl eval <js>) ───
        if (action === "eval") {
          await ensureContentScript(targetTab.id);
          assertRequestActive();
          const results = await chrome.scripting.executeScript({
            target: { tabId: targetTab.id },
            world: "MAIN",
            args: [payload.code],
            func: async (code) => {
              try {
                const res = await (0, eval)(code);
                return typeof res === "object" ? JSON.stringify(res, null, 2) : String(res);
              } catch (e) {
                return "[Eval Error] " + e.message;
              }
            }
          });
          ws.send(JSON.stringify({ id, result: results?.[0]?.result }));
          return;
        }

        // ─── 动作 4.7: 内嵌终端标签页列表 (bctl subtabs / bctl terms) ───
        if (action === "term_tabs" || action === "subtabs") {
          await ensureContentScript(targetTab.id);

          // 探测所有 frame 内终端的真实健康状态 (从 buffer 判定断开)
          assertRequestActive();
          const frameHealthResults = await chrome.scripting.executeScript({
            target: { tabId: targetTab.id, allFrames: true },
            world: "MAIN",
            func: () => {
              const allXtermEls = Array.from(document.querySelectorAll(".xterm, .xterm-helper-textarea, [class*='terminal' i], [id*='terminal' i]"))
                .filter(el => !(el instanceof SVGElement));
              const isTermFrame = location.pathname.includes("/koko/") || allXtermEls.length > 0 || window.term || window.terminal;
              if (!isTermFrame) return null;

              const isTerm = (obj) => obj && (typeof obj.paste === "function" || typeof obj.write === "function") && obj.buffer && obj.buffer.active;
              const pickTerm = (obj) => {
                if (!obj || typeof obj !== "object") return null;
                if (isTerm(obj)) return obj;
                if (isTerm(obj.terminal)) return obj.terminal;
                if (isTerm(obj.term)) return obj.term;
                if (isTerm(obj.value)) return obj.value;
                if (isTerm(obj._value)) return obj._value;
                return null;
              };
              let term = isTerm(window.term) ? window.term : (isTerm(window.terminal) ? window.terminal : null);
              if (!term) {
                let el = allXtermEls[0];
                while (el) {
                  if (isTerm(el._terminal)) { term = el._terminal; break; }
                  if (isTerm(el.term)) { term = el.term; break; }
                  el = el.parentElement;
                }
              }
              if (!term) {
                try {
                  const pinia = document.querySelector("#app")?.__vue_app__?.config?.globalProperties?.$pinia;
                  const state = pinia?.state?.value;
                  if (state) {
                    term = pickTerm(state.connection?.terminal) || pickTerm(state.connection);
                    if (!term) {
                      const map = state.tree?.terminalMap;
                      if (map && typeof map.forEach === "function") {
                        map.forEach((entry) => { if (!term) term = pickTerm(entry); });
                      }
                    }
                  }
                } catch (_) {}
              }

              let isDisconnected = false;
              let tail = "";
              if (term && term.buffer && term.buffer.active) {
                const buf = term.buffer.active;
                let lines = [];
                for (let r = Math.max(0, buf.baseY + buf.cursorY - 4); r <= buf.baseY + buf.cursorY; r++) {
                  const line = buf.getLine(r);
                  if (line) lines.push(line.translateToString(true));
                }
                tail = lines.join("\n");
                isDisconnected = /Connection websocket closed|Connection closed|会话已断开|连接已关闭/i.test(tail);
              }
              return { href: location.href, isDisconnected, tail };
            }
          });

          const healthMap = new Map();
          for (const item of (frameHealthResults || [])) {
            if (item?.result?.href) {
              healthMap.set(item.result.href, item.result.isDisconnected);
            }
          }

          assertRequestActive();
          const results = await chrome.scripting.executeScript({
            target: { tabId: targetTab.id },
            world: "MAIN",
            func: () => {
              // 1. 华为云堡垒机 / 云匣子 (yabProxyGuac) 多会话列表感知
              const yabRoot = document.querySelector(".yab-proxy-root")?.__vue__;
              if (yabRoot && Array.isArray(yabRoot.batchLoginConnectData) && yabRoot.batchLoginConnectData.length > 0) {
                const curId = yabRoot.connectDetailData?.id;
                const list = yabRoot.batchLoginConnectData.map((item, idx) => {
                  const baseGuac = typeof yabRoot.getBaseGuac === "function" ? yabRoot.getBaseGuac(item) : null;
                  const connState = baseGuac?.managedClient?.clientState?.connectionState;
                  const isDisc = connState && connState !== "CONNECTED" && connState !== "WAITING" && connState !== "CONNECTING";
                  return {
                    idx,
                    id: item.id,
                    title: `${item.name || "Host"} (${item.accountName ? item.accountName + "@" : ""}${item.address || ""})`,
                    active: item.id === curId,
                    src: item.id,
                    disconnected: Boolean(isDisc)
                  };
                });
                return { type: "yab_guac", tabs: list };
              }

              // 2. JumpServer Luna 多标签感知
              const lunaTabs = Array.from(document.querySelectorAll(".tabs li, elements-content-tab li"));
              const windows = Array.from(document.querySelectorAll(".window"));
              if (lunaTabs.length === 0) {
                const hasTerm = !!document.querySelector(".xterm, .xterm-helper-textarea, #yabProxyGuac, #inputArea.target");
                return {
                  type: hasTerm ? "single" : "none",
                  tabs: hasTerm ? [{ idx: 0, title: document.title || "Web Terminal", active: true, status: "connected" }] : []
                };
              }
              const list = lunaTabs.map((li, idx) => {
                const title = li.getAttribute("title") || li.innerText.replace("×", "").trim();
                const active = li.classList.contains("active");
                const win = windows[idx];
                const iframe = win?.querySelector("iframe");
                const src = iframe?.src || "";
                return { idx, id: li.id, title, active, src };
              });
              return { type: "jumpserver", tabs: list };
            }
          });

          const report = results?.[0]?.result;
          if (!report || report.tabs.length === 0) {
            ws.send(JSON.stringify({ id, result: "当前页面未检测到支持的 Web 终端标签页" }));
            return;
          }

          const lines = report.tabs.map(t => {
            const isDisconnected = t.disconnected === true || healthMap.get(t.src) === true;
            const activeTag = t.active ? " [当前激活]" : "";
            const statusTag = isDisconnected ? " (连接已断开: Connection closed)" : " (已连接)";
            return `[${t.idx}] ${t.title}${activeTag}${statusTag}`;
          });

          const header = `Web 终端标签页 (共 ${report.tabs.length} 个):`;
          ws.send(JSON.stringify({ id, result: `${header}\n${lines.join("\n")}\n\n* 可使用 \`bctl switch <IP|标题|序号>\` 快速切换终端\n* 可使用 \`bctl connect <IP>\` 智能按需连接 (优先复用已连接标签)` }));
          return;
        }

        // ─── 动作 4.8: 内嵌终端标签页切换 (bctl switch <目标>) ───
        if (action === "term_switch" || action === "subswitch") {
          const target = payload.target || "";
          await ensureContentScript(targetTab.id);
          assertRequestActive();
          const results = await chrome.scripting.executeScript({
            target: { tabId: targetTab.id },
            world: "MAIN",
            args: [target],
            func: (query) => {
              const q = String(query).toLowerCase().trim();

              // 1. 华为云堡垒机 / 云匣子多会话切换
              const yabRoot = document.querySelector(".yab-proxy-root")?.__vue__;
              if (yabRoot && Array.isArray(yabRoot.batchLoginConnectData) && yabRoot.batchLoginConnectData.length > 0) {
                const list = yabRoot.batchLoginConnectData;
                let matchIndex = -1;
                if (/^\d+$/.test(q)) {
                  matchIndex = parseInt(q, 10);
                } else {
                  matchIndex = list.findIndex(item =>
                    (item.name || "").toLowerCase().includes(q) ||
                    (item.address || "").toLowerCase().includes(q)
                  );
                }
                if (matchIndex < 0 || matchIndex >= list.length) {
                  const titles = list.map((item, i) => `[${i}] ${item.name} (${item.address})`).join("\n");
                  return { ok: false, error: `未找到匹配 "${query}" 的终端标签！当前可用终端：\n${titles}` };
                }
                const targetItem = list[matchIndex];
                yabRoot.$store?.commit("SET_H5_CONNECT_DETAIL", targetItem);
                return { ok: true, idx: matchIndex, title: `${targetItem.name} (${targetItem.address})` };
              }

              // 2. JumpServer Luna 多标签切换
              const lunaTabs = Array.from(document.querySelectorAll(".tabs li, elements-content-tab li"));
              if (lunaTabs.length === 0) return { ok: false, error: "当前页面未检测到支持切换的多终端标签栏" };

              let matchIndex = -1;
              if (/^\d+$/.test(q)) {
                matchIndex = parseInt(q, 10);
              } else {
                matchIndex = lunaTabs.findIndex(li => {
                  const title = (li.getAttribute("title") || li.innerText || "").toLowerCase();
                  return title.includes(q);
                });
              }

              if (matchIndex < 0 || matchIndex >= lunaTabs.length) {
                const titles = lunaTabs.map((li, i) => `[${i}] ${li.getAttribute("title") || li.innerText.replace("×", "").trim()}`).join("\n");
                return { ok: false, error: `未找到匹配 "${query}" 的终端标签！当前可用终端：\n${titles}` };
              }

              const targetLi = lunaTabs[matchIndex];
              const title = targetLi.getAttribute("title") || targetLi.innerText.replace("×", "").trim();
              const clickEl = targetLi.querySelector("span") || targetLi;
              clickEl.click();

              return { ok: true, idx: matchIndex, title };
            }
          });

          const r = results?.[0]?.result;
          if (!r?.ok) {
            ws.send(JSON.stringify({ id, result: `[切换失败] ${r?.error || "未知错误"}` }));
          } else {
            ws.send(JSON.stringify({ id, result: `已成功切换到终端标签页 [${r.idx}] "${r.title}"` }));
          }
          return;
        }

        // ─── 动作 4.9: 智能按需连接 (bctl connect <IP|主机名> [--new]) ───
        if (action === "term_connect" || action === "jump") {
          const target = payload.target || "";
          const forceNew = !!payload.forceNew;
          await ensureContentScript(targetTab.id);

          // 1. 探测各 frame 真实连接状态与已有终端标签
          assertRequestActive();
          const frameHealthResults = await chrome.scripting.executeScript({
            target: { tabId: targetTab.id, allFrames: true },
            world: "MAIN",
            func: () => {
              const allXtermEls = Array.from(document.querySelectorAll(".xterm, .xterm-helper-textarea, [class*='terminal' i], [id*='terminal' i]"));
              const isTermFrame = location.pathname.includes("/koko/") || allXtermEls.length > 0 || window.term || window.terminal;
              if (!isTermFrame) return null;

              const isTerm = (obj) => obj && (typeof obj.paste === "function" || typeof obj.write === "function") && obj.buffer && obj.buffer.active;
              const pickTerm = (obj) => {
                if (!obj || typeof obj !== "object") return null;
                if (isTerm(obj)) return obj;
                if (isTerm(obj.terminal)) return obj.terminal;
                if (isTerm(obj.term)) return obj.term;
                if (isTerm(obj.value)) return obj.value;
                if (isTerm(obj._value)) return obj._value;
                return null;
              };
              let term = isTerm(window.term) ? window.term : (isTerm(window.terminal) ? window.terminal : null);
              if (!term) {
                let el = allXtermEls[0];
                while (el) {
                  if (isTerm(el._terminal)) { term = el._terminal; break; }
                  if (isTerm(el.term)) { term = el.term; break; }
                  el = el.parentElement;
                }
              }
              if (!term) {
                try {
                  const pinia = document.querySelector("#app")?.__vue_app__?.config?.globalProperties?.$pinia;
                  const state = pinia?.state?.value;
                  if (state) {
                    term = pickTerm(state.connection?.terminal) || pickTerm(state.connection);
                    if (!term) {
                      const map = state.tree?.terminalMap;
                      if (map && typeof map.forEach === "function") {
                        map.forEach((entry) => { if (!term) term = pickTerm(entry); });
                      }
                    }
                  }
                } catch (_) {}
              }

              let isDisconnected = false;
              if (term && term.buffer && term.buffer.active) {
                const buf = term.buffer.active;
                let lines = [];
                for (let r = Math.max(0, buf.baseY + buf.cursorY - 4); r <= buf.baseY + buf.cursorY; r++) {
                  const line = buf.getLine(r);
                  if (line) lines.push(line.translateToString(true));
                }
                const tail = lines.join("\n");
                isDisconnected = /Connection websocket closed|Connection closed|会话已断开|连接已关闭/i.test(tail);
              }
              return { href: location.href, isDisconnected };
            }
          });

          const healthMap = new Map();
          for (const item of (frameHealthResults || [])) {
            if (item?.result?.href) {
              healthMap.set(item.result.href, item.result.isDisconnected);
            }
          }

          assertRequestActive();
          const checkRes = await chrome.scripting.executeScript({
            target: { tabId: targetTab.id },
            world: "MAIN",
            func: () => {
              const lunaTabs = Array.from(document.querySelectorAll(".tabs li, elements-content-tab li"));
              const windows = Array.from(document.querySelectorAll(".window"));
              return lunaTabs.map((li, idx) => {
                const title = li.getAttribute("title") || li.innerText.replace("×", "").trim();
                const active = li.classList.contains("active");
                const win = windows[idx];
                const iframe = win?.querySelector("iframe");
                const src = iframe?.src || "";
                return { idx, id: li.id, title, active, src };
              });
            }
          });

          const existingTabs = (checkRes?.[0]?.result || []).map(t => ({
            ...t,
            status: healthMap.get(t.src) === true ? "disconnected" : "connected"
          }));
          const q = String(target).toLowerCase().trim();
          const matched = existingTabs.find(t => t.title.toLowerCase().includes(q));

          // 如果找到已有标签
          if (matched && !forceNew) {
            if (matched.status !== "disconnected") {
              // 连接存活：直接切换复用！
              await chrome.scripting.executeScript({
                target: { tabId: targetTab.id },
                world: "MAIN",
                args: [matched.idx],
                func: (idx) => {
                  const lunaTabs = Array.from(document.querySelectorAll(".tabs li, elements-content-tab li"));
                  const targetLi = lunaTabs[idx];
                  if (targetLi && !targetLi.classList.contains("active")) {
                    (targetLi.querySelector("span") || targetLi).click();
                  }
                }
              });
              ws.send(JSON.stringify({
                id,
                result: `[复用现有终端] 发现已连接的终端标签页 [${matched.idx}] "${matched.title}"，已直接切换复用（未新开）！`
              }));
              return;
            } else {
              // 已断开连接：关闭旧标签，继续新建
              await chrome.scripting.executeScript({
                target: { tabId: targetTab.id },
                world: "MAIN",
                args: [matched.id],
                func: (id) => {
                  const oldTab = document.getElementById(id);
                  oldTab?.querySelector(".close")?.click();
                }
              });
              await new Promise(r => setTimeout(r, 600));
            }
          }

          // 2. 在 JumpServer 资产树中搜索并新建连接
          chrome.tabs.sendMessage(targetTab.id, {
            action: "set_status",
            payload: { text: `正在连接主机: ${target}...` }
          }).catch(() => {});

          assertRequestActive();
          const createRes = await chrome.scripting.executeScript({
            target: { tabId: targetTab.id },
            world: "MAIN",
            args: [target],
            func: async (keyword) => {
              const searchInput = document.querySelector("#assetsSearchInput, #AssetTreeSearchInput, .tree-input");
              if (!searchInput) return { ok: false, error: "未在当前页面找到 JumpServer 资产搜索框 (#assetsSearchInput / #AssetTreeSearchInput)" };

              searchInput.value = keyword;
              searchInput.dispatchEvent(new Event("input", { bubbles: true }));
              searchInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, bubbles: true }));
              searchInput.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", keyCode: 13, bubbles: true }));

              // 等待搜索结果出现
              const startTime = Date.now();
              let matchedNode = null;
              while (Date.now() - startTime < 3500) {
                const nodes = Array.from(document.querySelectorAll("#assetsTree a, .ztree a"));
                matchedNode = nodes.find(a => a.getBoundingClientRect().width > 0 && a.innerText && a.innerText.toLowerCase().includes(keyword.toLowerCase()));
                if (matchedNode) break;
                await new Promise(r => setTimeout(r, 200));
              }

              if (!matchedNode) {
                return { ok: false, error: `在 JumpServer 资产树中未找到匹配 "${keyword}" 的主机节点` };
              }

              // 点击节点触发连接
              matchedNode.click();

              // 监听并自动点击确认弹窗 (mat-dialog / modal)
              const modalStartTime = Date.now();
              while (Date.now() - modalStartTime < 2500) {
                const dialog = document.querySelector("mat-dialog-container, .modal, .dialog");
                if (dialog) {
                  const btns = Array.from(dialog.querySelectorAll("button"));
                  const confirmBtn = btns.find(b => b.innerText && (b.innerText.includes("确认") || b.innerText.includes("确定") || b.innerText.includes("OK")));
                  if (confirmBtn) {
                    const rect = confirmBtn.getBoundingClientRect();
                    const x = rect.left + rect.width / 2;
                    const y = rect.top + rect.height / 2;
                    const topEl = document.elementFromPoint(x, y) || confirmBtn.querySelector("span") || confirmBtn;
                    ["mousedown", "mouseup", "click"].forEach(type => {
                      topEl.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y }));
                    });
                    confirmBtn.click();
                    break;
                  }
                }
                const activeTab = document.querySelector(".tabs li.active");
                if (activeTab && activeTab.innerText.toLowerCase().includes(keyword.toLowerCase())) break;
                await new Promise(r => setTimeout(r, 200));
              }

              // 等待新标签页渲染
              await new Promise(r => setTimeout(r, 1500));
              const finalTab = document.querySelector(".tabs li.active");
              const title = finalTab ? (finalTab.getAttribute("title") || finalTab.innerText.replace("×", "").trim()) : keyword;
              return { ok: true, title };
            }
          });

          const r = createRes?.[0]?.result;
          chrome.tabs.sendMessage(targetTab.id, {
            action: "set_status",
            payload: { text: "终端就绪", autoResetDelay: 2500 }
          }).catch(() => {});

          if (!r?.ok) {
            ws.send(JSON.stringify({ id, result: `[连接失败] ${r?.error || "未知异常"}` }));
          } else {
            ws.send(JSON.stringify({ id, result: `[新开终端就绪] 已在 JumpServer 连接并切换至终端标签页: "${r.title}"` }));
          }
          return;
        }

        // ─── 动作 5: 常规 look / act（穿透至 content.js） ───
        await ensureContentScript(targetTab.id);
        assertRequestActive();
        const res = await chrome.tabs.sendMessage(targetTab.id, { action, payload });
        ws.send(JSON.stringify({ id, result: res }));
      });

    } catch (err) {
      console.error("[Extension] 处理异常:", err);
      // 关键：任何异常立即回包，彻底根除 CLI 15 秒挂死超时
      replyError(msg?.id, err, request);
    }
  };

  ws.onclose = () => {
    for (const request of requests.values()) request.cancelled = true;
    isConnecting = false;
    if (ws === socket) ws = null;
    setTimeout(connectWS, 2500);
  };
  ws.onerror = () => {
    isConnecting = false;
    if (ws) ws.close();
  };
}

// 获取操作目标 Tab
async function getTargetTab(sessionId, requireBound = false) {
  const sessionKey = normalizeSessionId(sessionId);
  const boundTabId = await getBoundTabId(sessionKey);
  if (boundTabId) {
    try {
      const tab = await chrome.tabs.get(boundTabId);
      if (tab) return tab;
    } catch (e) {
      await clearSessionBinding(sessionKey);
    }
  }
  if (requireBound) {
    return null;
  }
  // 未绑定时回退到当前活动窗口的标签页 (仅供 look/probe 等只读探测兜底使用)
  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (activeTab) {
    if (await getBindingOwner(activeTab.id, sessionKey)) {
      throw new Error(`[会话隔离拦截] 当前前台标签页 [${activeTab.id}] 已由其它会话控制，请先使用 bctl tabs 和 bctl bind <TabID> 选择目标`);
    }
    return activeTab;
  }
  const [anyActive] = await chrome.tabs.query({ active: true });
  if (anyActive && await getBindingOwner(anyActive.id, sessionKey)) {
    throw new Error(`[会话隔离拦截] 当前活动标签页 [${anyActive.id}] 已由其它会话控制，请先绑定目标`);
  }
  return anyActive || null;
}

// 确保 content.js 已在目标标签页就绪 (带 1 秒超时防挂死)
async function ensureContentScript(tabId) {
  try {
    await Promise.race([
      chrome.tabs.sendMessage(tabId, { action: "ping" }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("ping timeout")), 1000))
    ]);
  } catch (e) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"]
    }).catch(() => {});
    await new Promise(r => setTimeout(r, 200));
  }
}

function waitForTabLoad(tabId) {
  return new Promise(async (resolve) => {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab && tab.status === "complete") {
        setTimeout(resolve, 500);
        return;
      }
    } catch {}

    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 7000);

    function listener(id, info) {
      if (id === tabId && info.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(resolve, 500);
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// ─── 统一解析并选择最佳 Web 终端候选 (支持 Xterm/Guacamole/通用输入框优先级排序) ───
async function resolveSelectedTerminal(targetTabId, candidateTarget = null) {
  const discoveryResults = await chrome.scripting.executeScript({
    target: { tabId: targetTabId, allFrames: true },
    world: "MAIN",
    args: ["", 0, null, true],
    func: executeInWebTerminal
  });
  const candidates = (discoveryResults || []).flatMap(frame =>
    (frame?.result?.candidates || []).map(candidate => ({
      ...candidate,
      frameId: frame.frameId,
      candidateId: `${frame.frameId}:${candidate.index}`
    }))
  );

  if (candidateTarget) {
    const selected = candidates.find(c => c.frameId === candidateTarget.frameId && c.index === candidateTarget.index) || null;
    return {
      selected,
      candidates,
      error: selected ? "" : `目标 ${candidateTarget.frameId}:${candidateTarget.index} 已不存在；页面可能已变化，请重新运行 bctl probe。`
    };
  }

  const getKindWeight = (kind) => {
    if (kind === "xterm") return 100;
    if (kind === "guac") return 90;
    return 50;
  };

  const credible = candidates.filter(c => c.confidence >= 75);
  if (credible.length === 0) {
    return {
      selected: null,
      candidates,
      error: candidates.length
        ? `没有足够证据自动选择终端，候选 ${candidates.map(c => `${c.candidateId} ${c.selector} (${c.confidence}%)`).join("；")}`
        : "没有发现可信的终端输入目标"
    };
  }

  // 若存在高置信度的 xterm 或 guac 真实终端实例，优先选择，防止父级页面通用搜索框干扰
  const runtimeTerms = credible.filter(c => (c.kind === "xterm" || c.kind === "guac") && c.confidence >= 80);
  const pool = runtimeTerms.length > 0 ? runtimeTerms : credible;

  pool.sort((a, b) => {
    const diffWeight = getKindWeight(b.kind) - getKindWeight(a.kind);
    if (diffWeight !== 0) return diffWeight;
    return b.confidence - a.confidence;
  });

  if (pool.length > 1 && pool[0].kind === pool[1].kind && pool[0].confidence - pool[1].confidence < 15) {
    return {
      selected: null,
      candidates,
      error: `发现多个同等可信的终端候选：${pool.map(c => `${c.candidateId} ${c.selector} (${c.confidence}%)`).join("；")}`
    };
  }

  return { selected: pool[0], candidates, error: "" };
}

// ─── MAIN 世界通用 Web 终端 (Xterm / Guacamole / 云堡垒机 / JumpServer / DOPS / K8s / 任意自研终端) 注入函数 ───
async function executeInWebTerminal(cmd, timeoutMs, targetCandidateIndex = null, discoverOnly = false, targetCandidateKind = null, interactiveOptions = null) {
  try {
    const frameElement = window.frameElement;
    if (frameElement) {
      const rect = frameElement.getBoundingClientRect();
      const parentWidth = frameElement.ownerDocument?.documentElement?.clientWidth || 0;
      const parentHeight = frameElement.ownerDocument?.documentElement?.clientHeight || 0;
      const intersectsParent = rect.right > 0 && rect.bottom > 0 && rect.left < parentWidth && rect.top < parentHeight;
      if (rect.width <= 0 || rect.height <= 0 || !intersectsParent) return { matched: false, candidates: [] };
    }
  } catch (e) {}

  const cleanCmd = cmd.replace(/[\r\n]+$/, "");
  const cmdLines = cleanCmd.split(/\r?\n/);
  const firstCmdLine = (cmdLines[0] || "").trim();
  const rawInput = `${cleanCmd}\r`;

  function isInteractivePrompt(trimmed) {
    if (!trimmed) return false;
    if (/(?:password|passphrase)(?:\s+for\s+[^\s:]+)?\s*:\s*$/i.test(trimmed)) return true;
    if (/密码\s*[：:]\s*$/.test(trimmed)) return true;
    if (/\((?:yes\/no(?:\/\[fingerprint\])?|y\/n)\)\??\s*:?\s*$/i.test(trimmed)) return true;
    return false;
  }

  function isShellPrompt(trimmed, initPrompt) {
    if (!trimmed) return false;
    if (initPrompt && trimmed === initPrompt) return true;
    if (/^(?:\([^)]+\)\s*)*\[[^\]]+@[^\]]+\]\s*[#$%>]\s*$/.test(trimmed)) return true;
    if (/^(?:\([^)]+\)\s*)*[^\s@]+@[^\s:]+:[^\s]*\s*[#$%>]\s*$/.test(trimmed)) return true;
    if (/^(?:sh|bash|zsh|csh|ksh|dash|ash)(?:-[\d.]+)?\s*[#$%>]\s*$/.test(trimmed)) return true;
    if (/[#$%>]\s*$/.test(trimmed) && !trimmed.endsWith("==")) return true;
    if (/^(?:mysql|redis[^›>]*|postgres[^›>]*|sqlite3?)\s*>\s*$/i.test(trimmed)) return true;
    if (isInteractivePrompt(trimmed)) return true;
    return false;
  }

  // 辅助：基于执行前尾部锚点 (anchorLines) 在最新屏幕行中定位本次命令回显行索引
  function findNewCommandEchoIdx(beforeLines, currentLines) {
    let searchFrom = 0;
    const anchorEnd = Math.max(0, beforeLines.length - 1);
    const anchorStart = Math.max(0, anchorEnd - 3);
    const anchors = beforeLines.slice(anchorStart, anchorEnd);

    if (anchors.length > 0) {
      for (let i = Math.min(currentLines.length - 1, beforeLines.length + 10); i >= anchors.length - 1; i--) {
        let match = true;
        for (let k = 0; k < anchors.length; k++) {
          if (currentLines[i - anchors.length + 1 + k] !== anchors[k]) {
            match = false;
            break;
          }
        }
        if (match) {
          searchFrom = i + 1;
          break;
        }
      }
    }

    if (!firstCmdLine) return searchFrom;
    for (let i = currentLines.length - 2; i >= searchFrom; i--) {
      if (currentLines[i].includes(firstCmdLine)) {
        return i;
      }
    }
    return -1;
  }

  function parseKeySequence(str) {
    if (!str) return "";
    const KEY_MAP = {
      "<enter>": "\r",
      "<cr>": "\r",
      "<return>": "\r",
      "<esc>": "\x1b",
      "<escape>": "\x1b",
      "<tab>": "\t",
      "<backspace>": "\x7f",
      "<bs>": "\x7f",
      "<delete>": "\x1b[3~",
      "<del>": "\x1b[3~",
      "<up>": "\x1b[A",
      "<down>": "\x1b[B",
      "<right>": "\x1b[C",
      "<left>": "\x1b[D",
      "<home>": "\x1b[H",
      "<end>": "\x1b[F",
      "<pageup>": "\x1b[5~",
      "<pgup>": "\x1b[5~",
      "<pagedown>": "\x1b[6~",
      "<pgdn>": "\x1b[6~",
      "<space>": " ",
      "<f1>": "\x1bOP",
      "<f2>": "\x1bOQ",
      "<f3>": "\x1bOR",
      "<f4>": "\x1bOS",
      "<f5>": "\x1b[15~",
      "<f6>": "\x1b[17~",
      "<f7>": "\x1b[18~",
      "<f8>": "\x1b[19~",
      "<f9>": "\x1b[20~",
      "<f10>": "\x1b[21~",
      "<f11>": "\x1b[23~",
      "<f12>": "\x1b[24~",
    };

    let result = "";
    let i = 0;
    while (i < str.length) {
      if (str[i] === "<") {
        const endIdx = str.indexOf(">", i);
        if (endIdx !== -1) {
          const token = str.slice(i, endIdx + 1);
          const lowerToken = token.toLowerCase();
          if (KEY_MAP[lowerToken]) {
            result += KEY_MAP[lowerToken];
            i = endIdx + 1;
            continue;
          }
          // 支持 <ctrl-c>, <ctrl+c>, <ctrl-d>, <ctrl-z>, <ctrl-[> 等
          const ctrlMatch = lowerToken.match(/^<ctrl[-+]([a-z@\[\\\]^_])>$/);
          if (ctrlMatch) {
            const char = ctrlMatch[1];
            let code = 0;
            if (char >= 'a' && char <= 'z') {
              code = char.charCodeAt(0) - 96; // 'a' 为 1
            } else if (char === '@') code = 0;
            else if (char === '[') code = 27; // Esc
            else if (char === '\\') code = 28;
            else if (char === ']') code = 29;
            else if (char === '^') code = 30;
            else if (char === '_') code = 31;
            result += String.fromCharCode(code);
            i = endIdx + 1;
            continue;
          }
        }
      }
      result += str[i];
      i++;
    }
    return result;
  }

  function getXtermScreen(term) {
    const buf = term.buffer.active;
    const cols = term.cols || 80;
    const rows = term.rows || 24;
    const cursorX = buf.cursorX !== undefined ? buf.cursorX : 0;
    const cursorY = buf.cursorY !== undefined ? buf.cursorY : 0;
    const bufferType = buf.type || (term.buffer.normal === buf ? "normal" : "alternate");
    const viewportY = buf.viewportY !== undefined ? buf.viewportY : Math.max(0, buf.baseY);

    const lines = [];
    for (let y = 0; y < rows; y++) {
      const line = buf.getLine(viewportY + y);
      lines.push(line ? line.translateToString(true) : "");
    }

    return {
      cols,
      rows,
      cursor: { x: cursorX, y: cursorY },
      bufferType,
      screen: lines.join("\n")
    };
  }

  function sendRawToXterm(term, rawBytes) {
    if (term._clientSend) {
      term._clientSend(rawBytes);
    } else if (term._core?.coreService?.triggerDataEvent) {
      term._core.coreService.triggerDataEvent(rawBytes, true);
    } else if (typeof term.input === "function") {
      term.input(rawBytes);
    } else if (typeof term.paste === "function") {
      term.paste(rawBytes);
    }
  }

  // 1. 过滤掉 <symbol id="icon-yab_h_terminal"> 等 SVG 图标元素，避免假阳性
  const allXtermEls = Array.from(
    document.querySelectorAll(".xterm, .xterm-helper-textarea, [class*='terminal' i], [id*='terminal' i]")
  ).filter(el => !(el instanceof SVGElement));
  const hasVisibleTerminalAncestor = (el) => {
    let current = el;
    for (let depth = 0; current && depth < 7; depth++, current = current.parentElement) {
      const rect = current.getBoundingClientRect();
      const style = window.getComputedStyle(current);
      if (style.display !== "none" && style.visibility !== "hidden" && rect.width >= 80 && rect.height >= 40 &&
          rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight) return true;
    }
    return false;
  };
  const xtermEl = allXtermEls.find(hasVisibleTerminalAncestor) || null;

  function findXtermInstance(startEl) {
    const isTerm = (obj) => obj && (typeof obj.paste === "function" || typeof obj.write === "function") && obj.buffer && obj.buffer.active;
    const seen = new Set();
    const candidates = [];

    const consider = (obj) => {
      if (!obj || typeof obj !== "object" || seen.has(obj)) return;
      seen.add(obj);
      if (isTerm(obj)) candidates.push(obj);
      if (isTerm(obj.terminal)) candidates.push(obj.terminal);
      if (isTerm(obj.term)) candidates.push(obj.term);
      if (isTerm(obj.value)) candidates.push(obj.value);
      if (isTerm(obj._value)) candidates.push(obj._value);
    };

    const walkValue = (val, depth) => {
      if (!val || depth > 4 || typeof val !== "object") return;
      if (seen.has(val)) return;
      consider(val);
      if (typeof val.forEach === "function" && (val instanceof Map || typeof val.get === "function")) {
        try { val.forEach((entry) => consider(entry)); } catch (_) {}
        return;
      }
      if (Array.isArray(val)) {
        for (const item of val) consider(item);
        return;
      }
      let n = 0;
      for (const k of Object.keys(val)) {
        if (n++ > 40) break;
        if (k === "buffer" || k === "_core" || k === "element") continue;
        try { consider(val[k]); } catch (_) {}
      }
    };

    const searchVue3VNode = (vnode, depth) => {
      if (!vnode || depth > 14) return;
      const inst = vnode.component;
      if (inst) {
        const pools = [inst.setupState, inst.ctx, inst.exposed, inst.data, inst.props].filter(Boolean);
        for (const pool of pools) walkValue(pool, 0);
      }
      const kids = vnode.children;
      if (Array.isArray(kids)) {
        for (const kid of kids) searchVue3VNode(kid, depth + 1);
      } else if (kids && typeof kids === "object") {
        searchVue3VNode(kids, depth + 1);
      }
    };

    consider(window.term);
    consider(window.terminal);
    consider(window.xterm);
    consider(window._term);

    // 支持 Dva / UmiJS / JumpServer H5 (window.g_app) Web 终端
    try {
      const conns = window.g_app?._store?.getState()?.operation_global?.clientConnections;
      if (conns) {
        for (const conn of Object.values(conns)) {
          const client = conn?.connectionClient;
          if (client) {
            const core = typeof client.getCoreObject === "function" ? client.getCoreObject() : (client.term || client.terminal);
            if (core) {
              if (typeof client.sendTerminalData === "function") {
                core._clientSend = (data) => client.sendTerminalData(data);
              }
              consider(core);
            }
          }
        }
      }
    } catch (_) {}

    const scanEl = (el) => {
      if (!el) return;
      consider(el._terminal);
      consider(el.term);
      consider(el._xterm);
      consider(el.terminal);
      consider(el.__xterm__);
      if (el.__vue__) {
        consider(el.__vue__.term);
        consider(el.__vue__.xterm);
        consider(el.__vue__._terminal);
        consider(el.__vue__.$store?.state?.terminal);
        walkValue(el.__vue__, 0);
      }
      const v3 = el.__vueParentComponent;
      if (v3) {
        for (const pool of [v3.ctx, v3.exposed, v3.setupState, v3.data].filter(Boolean)) {
          walkValue(pool, 0);
        }
        try { searchVue3VNode(v3.vnode || v3.subTree, 0); } catch (_) {}
      }
      try {
        const app = el.__vue_app__;
        const pinia = app?.config?.globalProperties?.$pinia;
        const state = pinia?.state?.value;
        if (state && typeof state === "object") {
          for (const bucket of Object.values(state)) walkValue(bucket, 0);
        }
        const vuex = app?.config?.globalProperties?.$store?.state;
        if (vuex) walkValue(vuex, 0);
      } catch (_) {}
      for (const k in el) {
        if (k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$")) {
          let cur = el[k];
          let depth = 0;
          while (cur && depth < 12) {
            if (cur.stateNode) {
              consider(cur.stateNode.term);
              consider(cur.stateNode.xterm);
              consider(cur.stateNode._terminal);
            }
            if (cur.memoizedState) {
              let s = cur.memoizedState;
              while (s) {
                consider(s.memoizedState?.current);
                consider(s.memoizedState);
                s = s.next;
              }
            }
            cur = cur.return;
            depth++;
          }
        }
      }
    };

    let el = startEl;
    while (el) {
      scanEl(el);
      el = el.parentElement;
    }

    const roots = document.querySelectorAll("#app, [data-v-app], .modal, .modal-mask, [class*='modal'], [class*='dialog'], [role='dialog']");
    for (const m of roots) scanEl(m);

    if (candidates.length === 0) return null;
    const visible = candidates.find((t) => {
      const node = t.element || t.textarea;
      if (!node || typeof node.getBoundingClientRect !== "function") return false;
      const r = node.getBoundingClientRect();
      return node.offsetParent !== null && r.width > 0 && r.height > 0;
    });
    return visible || candidates[0];
  }

  const term = xtermEl ? findXtermInstance(xtermEl) : null;

  if (term && discoverOnly) {
    const rect = (term.element || term.textarea || xtermEl)?.getBoundingClientRect?.();
    return {
      matched: true,
      candidates: [{
        index: 0,
        kind: "xterm",
        type: "Xterm-compatible terminal instance",
        confidence: 100,
        selector: xtermEl?.id ? `#${xtermEl.id}` : (xtermEl?.className || ".xterm"),
        surface: rect ? `${Math.round(rect.width)}x${Math.round(rect.height)}` : "unknown",
        evidence: ["terminal instance exposes a readable buffer and input API"]
      }]
    };
  }

  // ─── 分支 A (Level 1A): 找到 Xterm.js 内存实例，走高精度 Buffer 解析模式 ───
  if (term && (targetCandidateIndex === null || (targetCandidateIndex === 0 && (!targetCandidateKind || targetCandidateKind === "xterm")))) {
    function extractLogicalLines(buffer, fromRow, toRow) {
      const maxIdx = Math.min(buffer.length - 1, toRow);
      const logicalLines = [];
      let currentLine = "";

      for (let i = Math.max(0, fromRow); i <= maxIdx; i++) {
        const line = buffer.getLine(i);
        if (!line) continue;
        const nextLine = i + 1 <= maxIdx ? buffer.getLine(i + 1) : null;
        const isNextWrapped = Boolean(nextLine && nextLine.isWrapped);

        currentLine += line.translateToString(!isNextWrapped);
        if (!isNextWrapped) {
          logicalLines.push(currentLine);
          currentLine = "";
        }
      }
      if (currentLine) logicalLines.push(currentLine);
      return logicalLines;
    }

    const activeBuf = term.buffer.active;
    let startRow = activeBuf.baseY + activeBuf.cursorY;
    while (startRow > 0 && activeBuf.getLine(startRow)?.isWrapped) {
      startRow--;
    }

    const initialPromptLines = extractLogicalLines(activeBuf, Math.max(0, startRow - 2), activeBuf.baseY + activeBuf.cursorY);
    const tailText = initialPromptLines.join("\n");
    if (/Connection websocket closed|Connection closed|会话已断开|连接已关闭/i.test(tailText)) {
      return {
        matched: true,
        tier: 1,
        ok: false,
        error: "当前 Web 终端连接已断开 (Connection closed)，请重新连接后再执行命令",
        partialOutput: tailText,
      };
    }
    const initialPrompt = (extractLogicalLines(activeBuf, startRow, activeBuf.baseY + activeBuf.cursorY)[0] || "").trim();

    // ─── 交互模式分流处理 (screen / key / start) ───
    if (interactiveOptions && interactiveOptions.mode === "screen") {
      const info = getXtermScreen(term);
      return {
        matched: true,
        tier: 1,
        ok: true,
        ...info
      };
    }

    if (interactiveOptions && interactiveOptions.mode === "key") {
      const rawBytes = parseKeySequence(interactiveOptions.keys || "");
      sendRawToXterm(term, rawBytes);
      const settleMs = interactiveOptions.settleMs || 150;
      await new Promise(r => setTimeout(r, settleMs));
      const info = getXtermScreen(term);
      return {
        matched: true,
        tier: 1,
        ok: true,
        sentKeys: interactiveOptions.keys,
        ...info
      };
    }

    if (interactiveOptions && interactiveOptions.mode === "start") {
      const cleanCmd = (cmd || "").replace(/[\r\n]+$/, "");
      sendRawToXterm(term, `${cleanCmd}\r`);
      const settleMs = interactiveOptions.settleMs || 800;
      await new Promise(r => setTimeout(r, settleMs));
      const info = getXtermScreen(term);
      return {
        matched: true,
        tier: 1,
        ok: true,
        cmd: cleanCmd,
        ...info
      };
    }

    return new Promise((resolve) => {
      let writeDisposable = null;
      let trimDisposable = null;
      let settleTimer = null;
      let pollTimer = null;
      let finished = false;

      const cleanup = () => {
        finished = true;
        clearTimeout(timeoutTimer);
        if (settleTimer) clearTimeout(settleTimer);
        if (pollTimer) clearInterval(pollTimer);
        if (writeDisposable && typeof writeDisposable.dispose === "function") writeDisposable.dispose();
        if (trimDisposable && typeof trimDisposable.dispose === "function") trimDisposable.dispose();
      };

      const rawLineList =
        term._core?._bufferService?.buffer?.lines ||
        term._core?.buffer?.lines ||
        term.buffer?.active?._buffer?.lines;
      if (rawLineList && typeof rawLineList.onTrim === "function") {
        trimDisposable = rawLineList.onTrim((amount) => {
          startRow = Math.max(0, startRow - amount);
        });
      }

      const sliceCleanOutput = (lines) => {
        if (lines.length === 0) return "";
        let outStart = 1;
        for (let k = 1; k < cmdLines.length && outStart < lines.length - 1; k++) {
          const rawEcho = lines[outStart];
          const strippedEcho = rawEcho.replace(/^>\s?/, "").trim();
          const expected = cmdLines[k].trim();
          if (strippedEcho === expected || rawEcho.trim() === expected) {
            outStart++;
          } else {
            break;
          }
        }
        const lastTrimmed = lines[lines.length - 1].trim();
        const outEnd = isInteractivePrompt(lastTrimmed) ? lines.length : Math.max(outStart, lines.length - 1);
        return lines.slice(outStart, outEnd).join("\n").trim();
      };

      const timeoutTimer = setTimeout(() => {
        if (finished) return;
        const buf = term.buffer.active;
        const curY = buf.baseY + buf.cursorY;
        const lines = extractLogicalLines(buf, Math.max(0, startRow - 5), curY);
        const partial = lines.join("\n");
        cleanup();

        let diagnostic = "";
        const lastLine = lines.length ? (lines[lines.length - 1] || "").trim() : "";
        const isAlt = buf.type === "alternate" || (term.buffer.normal && term.buffer.normal !== buf);

        if (isAlt) {
          diagnostic = "\n\n[终端诊断] 检测到终端已进入全屏 TUI 交互模式 (Alternate Buffer，如 k9s/vim/top/less)！\n提示：该程序仍在后台持续运行中。请使用 `bctl screen` 查看当前全屏画面，使用 `bctl key` 发送交互按键（如 `bctl key ':q<Enter>'` 或 `bctl key '<Ctrl-C>'` 退出）。";
        } else if (/(?:>|quote>|dquote>|subshell>|heredoc>)$/.test(lastLine)) {
          diagnostic = `\n\n[终端诊断] 检测到终端处于多行输入未闭合状态 (末尾提示符为 '${lastLine}')！\n大模型注意：上一条命令可能存在未闭合的 EOF、单双引号或多行输入语法。请勿盲目继续发送普通命令！建议先执行 \`bctl key '<Ctrl-C>'\` 强制中断退出未完成的多行输入。`;
        } else if (isInteractivePrompt(lastLine)) {
          diagnostic = `\n\n[终端诊断] 检测到终端正在等待交互式凭证或输入确认 (末尾提示符为 '${lastLine}')。\n提示：请使用 \`bctl key '${lastLine.includes("yes/no") ? "yes<Enter>" : "<输入内容><Enter>"}'\` 发送交互数据。`;
        }

        resolve({
          matched: true,
          tier: 1,
          ok: false,
          error: `指令在 ${timeoutMs}ms 内未执行完（可能卡在交互式输入或耗时命令）${diagnostic}`,
          partialOutput: partial.slice(-2000),
        });
      }, timeoutMs);

      const finalizeIfReady = () => {
        if (finished) return;
        const buf = term.buffer.active;
        const curY = buf.baseY + buf.cursorY;
        const lines = extractLogicalLines(buf, startRow, curY);
        if (lines.length < cmdLines.length + 1) return;

        const lastTrimmed = lines[lines.length - 1].trim();
        if (!isShellPrompt(lastTrimmed, initialPrompt)) return;

        const output = sliceCleanOutput(lines);
        cleanup();
        resolve({
          matched: true,
          tier: 1,
          ok: true,
          exitCode: 0,
          output,
        });
      };

      const checkBuffer = () => {
        if (finished) return;
        if (settleTimer) {
          clearTimeout(settleTimer);
          settleTimer = null;
        }

        const buf = term.buffer.active;
        const curY = buf.baseY + buf.cursorY;
        if (startRow > curY) startRow = curY;

        const lines = extractLogicalLines(buf, startRow, curY);
        if (lines.length < cmdLines.length + 1) return;

        const lastTrimmed = lines[lines.length - 1].trim();
        if (isShellPrompt(lastTrimmed, initialPrompt)) {
          settleTimer = setTimeout(finalizeIfReady, 120);
        }
      };

      if (typeof term.onWriteParsed === "function") {
        writeDisposable = term.onWriteParsed(checkBuffer);
      }
      pollTimer = setInterval(() => {
        if (!settleTimer) checkBuffer();
      }, 150);

      if (term._clientSend) {
        term._clientSend(rawInput);
      } else if (term._core?.coreService?.triggerDataEvent) {
        term._core.coreService.triggerDataEvent(rawInput, true);
      } else if (typeof term.input === "function") {
        term.input(rawInput);
      } else {
        term.paste(rawInput);
      }
    });
  }

  // ─── 分支 B (Level 1B): Apache Guacamole / 华为云堡垒机 (yabProxyGuac) Canvas 协议穿透 ───
  function findGuacContext() {
    const isGuacClient = (obj) =>
      obj &&
      typeof obj === "object" &&
      typeof obj.sendKeyEvent === "function" &&
      typeof obj.sendMouseState === "function" &&
      typeof obj.getDisplay === "function";

    // 1. 华为云堡垒机 / 云匣子 (.yab-proxy-root)
    const yabRoot = document.querySelector(".yab-proxy-root")?.__vue__;
    if (yabRoot && typeof yabRoot.getCurrentBaseGuac === "function") {
      const baseGuac = yabRoot.getCurrentBaseGuac();
      const client = baseGuac?.client || baseGuac?.managedClient?.client;
      if (isGuacClient(client)) {
        return {
          rootVue: yabRoot,
          baseGuac,
          client,
          managedClient: baseGuac.managedClient || null,
          display: baseGuac.display || client.getDisplay()
        };
      }
    }

    // 2. 通用 Guacamole 实例扫描 (遍历 DOM Vue/React 与 window)
    const allEls = document.querySelectorAll("#connect, [class*='guac' i], [id*='guac' i], .display");
    for (const el of allEls) {
      const v = el.__vue__;
      if (v) {
        const c = v.client || v.managedClient?.client || v.guacClient;
        if (isGuacClient(c)) {
          return {
            rootVue: v.$root || v,
            baseGuac: v,
            client: c,
            managedClient: v.managedClient || null,
            display: v.display || c.getDisplay()
          };
        }
      }
    }

    for (const k of Object.keys(window)) {
      try {
        const val = window[k];
        if (isGuacClient(val)) {
          return { rootVue: null, baseGuac: null, client: val, managedClient: null, display: val.getDisplay() };
        }
      } catch (_) {}
    }
    return null;
  }

  const guacCtx = findGuacContext();
  if (guacCtx && discoverOnly) {
    const display = guacCtx.display;
    return {
      matched: true,
      candidates: [{
        index: 0,
        kind: "guac",
        type: "Remote desktop terminal surface",
        confidence: 100,
        selector: "canvas / remote display",
        surface: display && typeof display.getWidth === "function" ? `${display.getWidth()}x${display.getHeight()}` : "unknown",
        evidence: ["recognized remote-display client with keyboard and display APIs"]
      }]
    };
  }
  if (guacCtx && (targetCandidateIndex === null || (targetCandidateIndex === 0 && (!targetCandidateKind || targetCandidateKind === "guac")))) {
    const { rootVue, client, managedClient, display } = guacCtx;
    const connState = managedClient?.clientState?.connectionState;
    if (connState && ["DISCONNECTED", "CLIENT_ERROR", "TUNNEL_ERROR", "FORCE_CLOSE"].includes(connState)) {
      return {
        matched: true,
        ok: false,
        error: `当前 Guacamole/云堡垒机终端连接已断开 (${connState})，请点击重连后再执行命令`,
        partialOutput: ""
      };
    }

    // 通过静默全屏划选 + 拦截 onclipboard 流读取 Guacamole 服务端终端缓冲文本
    async function readGuacScreenLines() {
      const w = typeof display?.getWidth === "function" ? display.getWidth() : 0;
      const h = typeof display?.getHeight === "function" ? display.getHeight() : 0;
      if (w <= 0 || h <= 0) return [];

      const origShowToast = rootVue ? rootVue.showToast : null;
      if (rootVue) rootVue.showToast = function () {};

      const origOnClipboard = client.onclipboard;
      let resolved = false;

      return new Promise((resolve) => {
        const finish = (rawText) => {
          if (resolved) return;
          resolved = true;
          clearTimeout(timer);
          client.onclipboard = origOnClipboard;
          if (rootVue && origShowToast) {
            setTimeout(() => {
              rootVue.showToast = origShowToast;
            }, 60);
          }
          const lines = String(rawText || "")
            .split(/\r?\n/)
            .map(l => l.replace(/\u00a0/g, " ").trimEnd())
            .filter(l => l.trim().length > 0);
          resolve(lines);
        };

        const timer = setTimeout(() => {
          finish(managedClient ? managedClient.clipboardData : "");
        }, 420);

        client.onclipboard = function (stream, mimetype) {
          if (origOnClipboard) {
            try { origOnClipboard.call(this, stream, mimetype); } catch (_) {}
          }
          if (mimetype === "text/plain" && stream) {
            let customBuf = "";
            const prevOnBlob = stream.onblob;
            const prevOnEnd = stream.onend;
            stream.onblob = function (b64) {
              if (prevOnBlob) {
                prevOnBlob.apply(this, arguments);
              } else {
                try {
                  const bin = atob(b64);
                  const bytes = new Uint8Array(bin.length);
                  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                  customBuf += new TextDecoder("utf-8").decode(bytes, { stream: true });
                  stream.sendAck?.("Received", 0);
                } catch (_) {}
              }
            };
            stream.onend = function () {
              if (prevOnEnd) prevOnEnd.apply(this, arguments);
              const text = (managedClient && managedClient.clipboardData) ? managedClient.clipboardData : customBuf;
              finish(text);
            };
          }
        };

        // 避开右侧 64px 宽的 Canvas 滚动条，划选终端字符区域触发 guacd 剪贴板流下发
        const endX = Math.max(20, w - 80);
        const endY = Math.max(20, h - 10);
        client.sendMouseState({ x: 5, y: 5, left: false, middle: false, right: false, up: false, down: false, dblclick: false });
        client.sendMouseState({ x: 5, y: 5, left: true, middle: false, right: false, up: false, down: false, dblclick: false });
        client.sendMouseState({ x: Math.floor(endX / 2), y: Math.floor(endY / 2), left: true, middle: false, right: false, up: false, down: false, dblclick: false });
        client.sendMouseState({ x: endX, y: endY, left: true, middle: false, right: false, up: false, down: false, dblclick: false });
        client.sendMouseState({ x: endX, y: endY, left: false, middle: false, right: false, up: false, down: false, dblclick: false });
        if (typeof client.yabCleanLayerMouseChoose === "function") {
          client.yabCleanLayerMouseChoose(managedClient?.protocol || 1);
        }
      });
    }

    function sendGuacCommand(text) {
      const toKeysym = (cp) => {
        if (cp === 10 || cp === 13) return 65293; // X11 Return (0xFF0D)
        if (cp <= 31 || (cp >= 127 && cp <= 159)) return 65280 | cp;
        if (cp >= 0 && cp <= 255) return cp;
        if (cp >= 256 && cp <= 1114111) return 16777216 | cp;
        return null;
      };
      for (const ch of text) {
        const ks = toKeysym(ch.codePointAt(0));
        if (ks !== null) {
          client.sendKeyEvent(1, ks);
          client.sendKeyEvent(0, ks);
        }
      }
      client.sendKeyEvent(1, 65293);
      client.sendKeyEvent(0, 65293);
    }

    const beforeLines = await readGuacScreenLines();
    const beforeSnapshot = beforeLines.join("\n");
    const initialPrompt = (beforeLines[beforeLines.length - 1] || "").trim();
    const wasInteractive = isInteractivePrompt(initialPrompt);

    if (interactiveOptions && interactiveOptions.mode === "screen") {
      return {
        matched: true,
        tier: 1,
        ok: true,
        cols: 80,
        rows: beforeLines.length,
        cursor: { x: 0, y: Math.max(0, beforeLines.length - 1) },
        bufferType: "guac",
        screen: beforeLines.join("\n")
      };
    }

    if (interactiveOptions && (interactiveOptions.mode === "key" || interactiveOptions.mode === "start")) {
      const keysToSend = interactiveOptions.mode === "key"
        ? parseKeySequence(interactiveOptions.keys || "")
        : `${(cmd || "").replace(/[\r\n]+$/, "")}\r`;
      const toKeysym = (cp) => {
        if (cp === 10 || cp === 13) return 65293;
        if (cp <= 31 || (cp >= 127 && cp <= 159)) return 65280 | cp;
        if (cp >= 0 && cp <= 255) return cp;
        if (cp >= 256 && cp <= 1114111) return 16777216 | cp;
        return null;
      };
      for (const ch of keysToSend) {
        const ks = toKeysym(ch.codePointAt(0));
        if (ks !== null) {
          client.sendKeyEvent(1, ks);
          client.sendKeyEvent(0, ks);
        }
      }
      const settleMs = interactiveOptions.settleMs || 300;
      await new Promise(r => setTimeout(r, settleMs));
      const afterLines = await readGuacScreenLines();
      return {
        matched: true,
        tier: 1,
        ok: true,
        cols: 80,
        rows: afterLines.length,
        cursor: { x: 0, y: Math.max(0, afterLines.length - 1) },
        bufferType: "guac",
        screen: afterLines.join("\n")
      };
    }

    sendGuacCommand(cleanCmd);

    return new Promise((resolve) => {
      let finished = false;
      let polling = false;
      let stableMatchCount = 0;
      let lastMatchedSnapshot = "";

      const timeoutTimer = setTimeout(async () => {
        if (finished) return;
        finished = true;
        clearInterval(pollTimer);
        const afterLines = await readGuacScreenLines();
        resolve({
          matched: true,
          ok: false,
          error: `指令在 ${timeoutMs}ms 内未执行完（可能卡在交互式输入或耗时命令）`,
          partialOutput: afterLines.slice(-20).join("\n")
        });
      }, timeoutMs);

      const pollTimer = setInterval(async () => {
        if (finished || polling) return;
        polling = true;
        try {
          const currentLines = await readGuacScreenLines();
          if (currentLines.length === 0) return;

          const currentSnapshot = currentLines.join("\n");
          if (currentSnapshot === beforeSnapshot) return;

          const lastLine = (currentLines[currentLines.length - 1] || "").trim();
          const echoIdx = findNewCommandEchoIdx(beforeLines, currentLines);

          // 确认命令已回显（或此前处于 Password: 等无回显交互态）且最后一行已回到提示符
          const echoReady = wasInteractive || (echoIdx >= 0 && echoIdx < currentLines.length - 1);
          if (echoReady && isShellPrompt(lastLine, initialPrompt)) {
            if (currentSnapshot === lastMatchedSnapshot) {
              stableMatchCount++;
            } else {
              stableMatchCount = 1;
              lastMatchedSnapshot = currentSnapshot;
            }

            if (stableMatchCount >= 1) {
              // 再做一次短延时复核确保输出流稳定
              await new Promise(r => setTimeout(r, 160));
              const finalLines = await readGuacScreenLines();
              const finalLast = (finalLines[finalLines.length - 1] || "").trim();
              if (!isShellPrompt(finalLast, initialPrompt)) {
                stableMatchCount = 0;
                return;
              }

              finished = true;
              clearInterval(pollTimer);
              clearTimeout(timeoutTimer);

              const finalEchoIdx = findNewCommandEchoIdx(beforeLines, finalLines);
              const outStart = finalEchoIdx >= 0
                ? finalEchoIdx + cmdLines.length
                : Math.max(0, beforeLines.length);
              const outEnd = isInteractivePrompt(finalLast)
                ? finalLines.length
                : Math.max(outStart, finalLines.length - 1);
              const output = finalLines.slice(outStart, outEnd).map(l => l.trimEnd()).join("\n").trim();

              resolve({
                matched: true,
                ok: true,
                exitCode: 0,
                output
              });
            }
          } else {
            stableMatchCount = 0;
          }
        } finally {
          polling = false;
        }
      }, 220);
    });
  }

  // ─── 分支 C: 通用候选发现 ───
  // 只用可观察的 DOM 语义、焦点、终端提示符和输入控件结构；探测阶段不点击页面。
  function discoverUniversalTerminalCandidates() {
    const terminalWords = /(?:terminal|web.?shell|shell|console|command line|command prompt|ssh|tty|终端|命令行|控制台|堡垒机)/i;
    const shellPrompt = /(?:^|\n)\s*(?:\[[^\]\n]+@[^\]\n]+\]\s*[#$%>]|[^\s@]+@[^\s:]+:[^\n]*[#$%>]|(?:bash|sh|zsh|ksh)\s*[#$%>]|[#$%>])\s*$/im;
    const isDisplayed = (el) => {
      const style = window.getComputedStyle(el);
      return style.display !== "none" && style.visibility !== "hidden";
    };
    const selectorFor = (el) => {
      if (el.id) return `#${CSS.escape(el.id)}`;
      const classes = typeof el.className === "string" ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2) : [];
      return `${el.tagName.toLowerCase()}${classes.map(name => `.${CSS.escape(name)}`).join("")}`;
    };
    const contextFor = (el) => {
      const parts = [];
      let cur = el;
      for (let depth = 0; cur && depth < 5; depth++, cur = cur.parentElement) {
        parts.push([
          cur.getAttribute?.("aria-label"), cur.getAttribute?.("title"), cur.getAttribute?.("role"),
          cur.id, typeof cur.className === "string" ? cur.className : "",
          depth < 2 ? (cur.innerText || cur.textContent || "").slice(0, 1200) : "",
          Array.from(cur.querySelectorAll?.("canvas, [role='application'], [role='terminal'], [aria-label]") || [])
            .slice(0, 5).map(child => `${child.getAttribute("aria-label") || ""} ${child.getAttribute("role") || ""}`).join(" ")
        ].filter(Boolean).join(" "));
      }
      return parts.join(" ").slice(0, 5000);
    };
    const elements = Array.from(document.querySelectorAll("textarea, input, [contenteditable='true'], [role='textbox'], canvas[tabindex], [role='application'][tabindex]"));
    const candidates = [];
    for (const el of elements) {
      if (!(el instanceof HTMLElement) || el.disabled || el.readOnly || !isDisplayed(el)) continue;
      const tag = el.tagName;
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (tag === "INPUT" && ["checkbox", "radio", "button", "submit", "reset", "file", "hidden", "range", "color", "image", "password"].includes(type)) continue;
      const isSurface = tag === "CANVAS" || el.getAttribute("role") === "application";
      const isEditable = tag === "TEXTAREA" || tag === "INPUT" || el.isContentEditable || el.getAttribute("role") === "textbox";
      if (!isSurface && !isEditable) continue;

      const context = contextFor(el);
      if (/watermark/i.test(context)) continue;
      const value = typeof el.value === "string" ? el.value : "";
      const label = [el.getAttribute("aria-label"), el.getAttribute("placeholder"), el.getAttribute("title"), el.id].filter(Boolean).join(" ");
      const rect = el.getBoundingClientRect();
      const offscreen = rect.right <= 0 || rect.bottom <= 0 || rect.left < 0 || rect.top < 0 || rect.width <= 4 || rect.height <= 4;
      const inViewport = rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight;
      if (!inViewport && tag !== "TEXTAREA") continue;
      const evidence = [];
      let score = 0;
      const sentinel = value.includes("\u200b");
      const named = terminalWords.test(`${label} ${context}`);
      const promptContext = [el.parentElement?.innerText, el.parentElement?.parentElement?.innerText].filter(Boolean).join("\n").slice(-3000);
      const prompt = shellPrompt.test(promptContext);
      const terminalInputName = /(?:xterm-helper-textarea|inputArea|guac|xterm|terminal|web.?shell|(?:^|[^a-z])(?:term|tty|ssh|shell|console|cmd|clipboard|ime)(?:$|[^a-z]))/i.test(label);
      const hasTerminalSurface = el.closest(".xterm, [role='terminal'], [role='application'], [aria-label*='terminal' i], [aria-label*='console' i], [aria-label*='终端' i], [aria-label*='命令行' i], [class*='terminal' i], [class*='console' i], [id*='terminal' i], [id*='console' i], canvas") !== null;

      if (sentinel) { score += 100; evidence.push("input contains a zero-width terminal sentinel"); }
      if (terminalInputName) { score += 45; evidence.push("input has terminal-oriented semantics"); }
      if (named) { score += 35; evidence.push("nearby accessible text identifies a terminal or command surface"); }
      if (prompt) { score += 35; evidence.push("nearby rendered text resembles a shell prompt"); }
      if (hasTerminalSurface && isEditable) { score += 25; evidence.push("input is structurally inside a terminal-like interactive surface"); }
      if (el === document.activeElement && isEditable) { score += 15; evidence.push("input currently owns page focus"); }
      if (el.getAttribute("autocorrect") === "off" || el.getAttribute("autocapitalize") === "off" || el.getAttribute("spellcheck") === "false") {
        score += 15; evidence.push("input disables text correction, common for command input");
      }
      if (offscreen && tag === "TEXTAREA") { score += 15; evidence.push("offscreen textarea can be a terminal keyboard sink"); }
      if (isSurface && named) { score += 45; evidence.push("focusable surface has an explicit terminal-related accessible name"); }
      if (isSurface && !named) continue;
      if (score < 20) continue;

      const confidence = Math.min(99, score);
      candidates.push({
        element: el,
        kind: "generic",
        score,
        confidence,
        selector: selectorFor(el),
        method: isSurface ? "surface-keyevent-stream" : sentinel ? "zero-width-input" : "generic-text-input",
        type: isSurface ? "Accessible terminal surface" : "Terminal input candidate",
        evidence,
        offscreen
      });
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates.map((candidate, index) => ({ ...candidate, index }));
  }

  const universalCandidates = discoverUniversalTerminalCandidates();
  const publicCandidates = universalCandidates.map(({ element, score, confidence, selector, method, type, evidence, offscreen, index, kind }) => ({
    index, kind, type, confidence, score, selector, method, offscreen, evidence
  }));
  if (discoverOnly) return { matched: true, candidates: publicCandidates };

  let universalTarget = null;
  if (targetCandidateIndex !== null && targetCandidateIndex !== undefined) {
    universalTarget = universalCandidates.find(candidate => candidate.index === targetCandidateIndex && (!targetCandidateKind || candidate.kind === targetCandidateKind)) || null;
    if (!universalTarget) {
      return { matched: true, ok: false, confidence: 100, error: `当前 frame 中不存在终端候选 ${targetCandidateIndex}；页面可能已变化，请重新运行 bctl probe。` };
    }
  } else {
    const credible = universalCandidates.filter(candidate => candidate.confidence >= 75);
    if (credible.length > 1 && credible[0].confidence - credible[1].confidence < 15) {
      return {
        matched: true,
        ok: false,
        confidence: credible[0].confidence,
        error: `识别到多个可能的终端输入目标：${credible.map(candidate => `${candidate.index} ${candidate.selector} (${candidate.confidence}%)`).join("；")}。请运行 bctl probe 后通过 --target 明确选择。`
      };
    }
    universalTarget = credible[0] || null;
  }
  if (!universalTarget) return { matched: false, candidates: publicCandidates };

  if (interactiveOptions && interactiveOptions.mode === "screen") {
    const el = universalTarget.element;
    const text = el.value !== undefined ? el.value : (el.innerText || "");
    return {
      matched: true,
      tier: 2,
      ok: true,
      cols: 80,
      rows: text.split("\n").length,
      cursor: { x: 0, y: 0 },
      bufferType: "generic",
      screen: text
    };
  }

  if (interactiveOptions && (interactiveOptions.mode === "key" || interactiveOptions.mode === "start")) {
    const textToSend = interactiveOptions.mode === "key"
      ? parseKeySequence(interactiveOptions.keys || "")
      : `${(cmd || "").replace(/[\r\n]+$/, "")}\n`;
    dispatchUniversalTerminalInput(universalTarget.element, textToSend);
    const settleMs = interactiveOptions.settleMs || 200;
    await new Promise(r => setTimeout(r, settleMs));
    const el = universalTarget.element;
    const text = el.value !== undefined ? el.value : (el.innerText || "");
    return {
      matched: true,
      tier: 2,
      ok: true,
      cols: 80,
      rows: text.split("\n").length,
      cursor: { x: 0, y: 0 },
      bufferType: "generic",
      screen: text
    };
  }

  function dispatchUniversalTerminalInput(targetEl, commandText) {
    const val = targetEl.value || "";

    // 模式 1: 零宽字符哨兵输入框 (如 Guacamole v-guacTextInput)
    if (typeof targetEl.value === "string" && val.includes("\u200b")) {
      targetEl.focus();
      const zwsp = "\u200b\u200b\u200b\u200b";
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      if (nativeSetter) nativeSetter.call(targetEl, `${zwsp}${commandText}\n${zwsp}`);
      else targetEl.value = `${zwsp}${commandText}\n${zwsp}`;
      targetEl.dispatchEvent(new InputEvent("input", { bubbles: true, data: commandText, inputType: "insertText" }));
      return;
    }

    // 模式 2: 隐藏或标准 Textarea / Input
    // xterm 的 _inputEvent 只接受 inputType=insertText 且 data 非空；execCommand("insertText")
    // 会把 \r 拆成 insertLineBreak 且 data=null，命令或回车会被丢掉。composed 必须为 false，
    // 否则在刚发生过 keydown 时会被 _keyDownSeen 丢弃。
    if (targetEl.tagName === "TEXTAREA" || targetEl.tagName === "INPUT") {
      targetEl.focus();
      targetEl.dispatchEvent(new Event("focus"));
      targetEl.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift", code: "ShiftLeft", keyCode: 16, which: 16, bubbles: true }));
      const inputEvt = new InputEvent("input", {
        bubbles: true,
        cancelable: true,
        composed: false,
        data: `${commandText}\r`,
        inputType: "insertText"
      });
      targetEl.dispatchEvent(inputEvt);
      if (inputEvt.defaultPrevented || targetEl.classList?.contains("xterm-helper-textarea")) return;
      try {
        document.execCommand("insertText", false, commandText);
      } catch (_) {}
      targetEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
      targetEl.dispatchEvent(new KeyboardEvent("keypress", { key: "Enter", code: "Enter", keyCode: 13, which: 13, charCode: 13, bubbles: true }));
      targetEl.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
      return;
    }

    // 模式 3: Canvas / 容器逐字符物理键盘事件流兜底
    if (targetEl.tabIndex < 0) targetEl.tabIndex = 0;
    targetEl.focus();
    const targets = [targetEl, document.activeElement, document, window].filter(Boolean);
    for (const ch of commandText) {
      const code = ch.charCodeAt(0);
      for (const t of targets) {
        t.dispatchEvent?.(new KeyboardEvent("keydown", { key: ch, keyCode: code, which: code, bubbles: true, cancelable: true }));
        t.dispatchEvent?.(new KeyboardEvent("keypress", { key: ch, keyCode: code, which: code, charCode: code, bubbles: true, cancelable: true }));
        t.dispatchEvent?.(new KeyboardEvent("keyup", { key: ch, keyCode: code, which: code, bubbles: true, cancelable: true }));
      }
    }
    for (const t of targets) {
      t.dispatchEvent?.(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
      t.dispatchEvent?.(new KeyboardEvent("keypress", { key: "Enter", code: "Enter", keyCode: 13, which: 13, charCode: 13, bubbles: true, cancelable: true }));
      t.dispatchEvent?.(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    }
  }

  function getScreenLines() {
    // 1. 标准 Xterm DOM 行
    const xtermRows = Array.from(document.querySelectorAll(".xterm-rows > div"))
      .map(d => d.innerText.replace(/\u00a0/g, " ").trim())
      .filter(Boolean);
    if (xtermRows.length > 0) return xtermRows;

    // 2. 通用 DOM 终端容器行 (pre, .terminal-output, [class*="term"] 等)
    const domContainers = Array.from(
      document.querySelectorAll(".terminal-output, .terminal-content, pre, [class*='terminal' i], [class*='console' i]")
    ).filter(el => !(el instanceof SVGElement) && el.offsetParent !== null && (el.innerText || "").trim().length > 0);

    if (domContainers.length > 0) {
      const best = domContainers.sort((a, b) => (b.innerText || "").length - (a.innerText || "").length)[0];
      return (best.innerText || "")
        .split(/\r?\n/)
        .map(l => l.replace(/\u00a0/g, " ").trim())
        .filter(Boolean);
    }
    return [];
  }

  return new Promise((resolve) => {
  const beforeLines = getScreenLines();
    const beforeSnapshot = beforeLines.join("\n");
    const initialPrompt = (beforeLines[beforeLines.length - 1] || "").trim();
    const wasInteractive = isInteractivePrompt(initialPrompt);

  if (universalTarget.method === "surface-keyevent-stream") {
    if (universalTarget.element.tabIndex < 0) universalTarget.element.tabIndex = 0;
  }
  dispatchUniversalTerminalInput(universalTarget.element, cleanCmd);

    let settleTimer = null;
    let finished = false;

  // 纯画布无法从 DOM 验证命令回显；明确报告“已尝试下发、结果未知”，避免调用方误以为成功或盲目重放。
  if (beforeLines.length === 0) {
    setTimeout(() => {
      if (finished) return;
      const afterLines = getScreenLines();
      if (afterLines.length === 0) {
        finished = true;
        clearInterval(pollInterval);
        clearTimeout(timeoutTimer);
        resolve({
          matched: true,
          ok: false,
          confidence: universalTarget.confidence,
          candidateIndex: universalTarget.index,
          error: `命令已尝试下发到 ${universalTarget.selector}，但页面没有可读取的输出；执行结果未知。请先查看终端状态，不要直接重放命令。`
        });
      }
    }, 600);
  }

    const timeoutTimer = setTimeout(() => {
      if (finished) return;
      finished = true;
      clearInterval(pollInterval);
      const after = getScreenLines();
      resolve({
        matched: true,
        ok: false,
        confidence: universalTarget.confidence,
        candidateIndex: universalTarget.index,
        error: `指令在 ${timeoutMs}ms 内未执行完`,
        partialOutput: after.slice(-15).join("\n")
      });
    }, timeoutMs);

    const pollInterval = setInterval(() => {
      if (finished) return;
      const currentLines = getScreenLines();
      if (currentLines.length === 0) return;
      if (currentLines.join("\n") === beforeSnapshot) return;

      const lastLine = currentLines[currentLines.length - 1] || "";
      const echoIdx = findNewCommandEchoIdx(beforeLines, currentLines);
      const echoReady = wasInteractive || (echoIdx >= 0 && echoIdx < currentLines.length - 1);

      if (echoReady && isShellPrompt(lastLine, initialPrompt)) {
        if (!settleTimer) {
          settleTimer = setTimeout(() => {
            finished = true;
            clearInterval(pollInterval);
            clearTimeout(timeoutTimer);
            const finalLines = getScreenLines();
            const finalEchoIdx = findNewCommandEchoIdx(beforeLines, finalLines);
            const startIdx = finalEchoIdx >= 0 ? finalEchoIdx + cmdLines.length : Math.max(0, beforeLines.length);
            const outLines = finalLines.slice(startIdx, Math.max(startIdx, finalLines.length - 1));
            resolve({
              matched: true,
              ok: true,
              confidence: universalTarget.confidence,
              candidateIndex: universalTarget.index,
              output: outLines.join("\n").trim()
            });
          }, 200);
        }
      } else {
        if (settleTimer) {
          clearTimeout(settleTimer);
          settleTimer = null;
        }
      }
    }, 150);
  });
}

// ─── MAIN 世界 Kibana DevTools / Monaco / Ace / CodeMirror 查询执行注入函数 ───
async function executeInDevTools(query, timeoutMs) {
  function triggerRun(activeEl) {
    const playBtn = Array.from(document.querySelectorAll('button, a.btn, [role="button"], span, i')).find(b => {
      if (b.offsetParent === null) return false;
      const text = (b.innerText || b.getAttribute("title") || b.getAttribute("aria-label") || "").trim();
      return /^(运行|执行|查询|Run|Submit|Search)$/i.test(text) ||
             /play|submit|execute/i.test(b.className);
    }) || document.querySelector('.euiButtonIcon--primary, button[title*="Submit" i], button[title*="运行"], button[title*="执行"], button[title*="查询"]');

    if (playBtn && playBtn.offsetParent !== null) {
      playBtn.click();
      return;
    }
    const target = activeEl || document.activeElement || document.body;
    const isMac = navigator.platform.toUpperCase().includes("MAC");
    const evt = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
    if (isMac) evt.metaKey = true;
    else evt.ctrlKey = true;
    target.dispatchEvent(new KeyboardEvent("keydown", evt));
    target.dispatchEvent(new KeyboardEvent("keyup", evt));
  }

  function getConsoleResponseText() {
    // 1. Monaco 只读响应编辑器
    if (window.monaco?.editor?.getEditors()?.length > 1) {
      const eds = window.monaco.editor.getEditors();
      const readOnlyEd = eds.find(ed => ed.getOption?.(monaco.editor.EditorOption.readOnly)) || eds[1];
      if (readOnlyEd) return readOnlyEd.getValue();
    }
    // 2. Ace 只读响应编辑器
    const aceEls = document.querySelectorAll(".ace_editor");
    if (aceEls.length > 1 && window.ace?.edit) {
      return window.ace.edit(aceEls[1]).getValue();
    }
    // 3. CodeMirror 响应视口
    const cmEls = document.querySelectorAll(".cm-editor, .CodeMirror");
    if (cmEls.length > 1) {
      return (cmEls[1].innerText || "").trim();
    }
    // 4. 通用输出视口
    const out = document.querySelector('.response, [class*="response" i], [class*="result-pane" i], [class*="result" i], [class*="output" i], .json-viewer, pre, code');
    return out ? (out.innerText || "").trim() : "";
  }

  async function waitForChange(initialText, limitMs) {
    const start = Date.now();
    let prev = initialText;
    while (Date.now() - start < limitMs) {
      await new Promise(r => setTimeout(r, 200));
      const cur = getConsoleResponseText();
      if (cur && cur !== initialText && cur.length > 0) {
        await new Promise(r => setTimeout(r, 150));
        return getConsoleResponseText();
      }
    }
    return getConsoleResponseText();
  }

  // 1. Monaco Editor 探测 (现代 Kibana / 自研 ES 控制台)
  if (window.monaco?.editor?.getEditors()?.length > 0) {
    const editors = window.monaco.editor.getEditors();
    const targetEditor = editors.find(ed => {
      const dom = ed.getDomNode?.();
      return dom && dom.offsetParent !== null && !ed.getOption?.(monaco.editor.EditorOption.readOnly);
    }) || editors[0];

    const initialOutput = getConsoleResponseText();
    targetEditor.setValue(query);
    targetEditor.focus();
    triggerRun(targetEditor.getDomNode());

    const result = await waitForChange(initialOutput, timeoutMs);
    return { matched: true, ok: true, output: result || "已执行查询" };
  }

  // 2. Ace Editor 探测 (经典版 Kibana DevTools)
  const aceEl = document.querySelector(".ace_editor");
  if (aceEl && window.ace?.edit) {
    const editor = window.ace.edit(aceEl);
    const initialOutput = getConsoleResponseText();
    editor.setValue(query);
    editor.clearSelection();
    editor.focus();
    triggerRun(aceEl);

    const result = await waitForChange(initialOutput, timeoutMs);
    return { matched: true, ok: true, output: result || "已执行查询" };
  }

  // 3. CodeMirror 5 探测
  const cmEl = document.querySelector(".CodeMirror");
  if (cmEl && cmEl.CodeMirror) {
    const cm = cmEl.CodeMirror;
    const initialOutput = getConsoleResponseText();
    cm.setValue(query);
    cm.focus();
    triggerRun(cmEl);

    const result = await waitForChange(initialOutput, timeoutMs);
    return { matched: true, ok: true, output: result || "已执行查询" };
  }

  // 4. CodeMirror 6 探测
  const cm6El = document.querySelector(".cm-editor .cm-content");
  if (cm6El) {
    const initialOutput = getConsoleResponseText();
    cm6El.focus();
    document.execCommand("selectAll", false, null);
    document.execCommand("insertText", false, query);
    triggerRun(cm6El);

    const result = await waitForChange(initialOutput, timeoutMs);
    return { matched: true, ok: true, output: result || "已执行查询" };
  }

  // 5. 自研控制台常见 query textarea 探测
  const queryTa = document.querySelector('textarea[class*="query" i], textarea[class*="editor" i], textarea[placeholder*="query" i], textarea[placeholder*="DSL" i], textarea[placeholder*="JSON" i], textarea[placeholder*="查询" i]');
  if (queryTa && queryTa.offsetParent !== null) {
    const initialOutput = getConsoleResponseText();
    queryTa.focus();
    queryTa.value = query;
    queryTa.dispatchEvent(new Event("input", { bubbles: true }));
    queryTa.dispatchEvent(new Event("change", { bubbles: true }));
    triggerRun(queryTa);

    const result = await waitForChange(initialOutput, timeoutMs);
    return { matched: true, ok: true, output: result || "已执行查询" };
  }

  return { matched: false };
}

// ─── MAIN 世界控制台/终端一键探测注入函数 ───
function probePageInteractiveCapabilities() {
  const result = {
    url: location.href,
    editors: [],
    inputsCount: document.querySelectorAll("input:not([type='hidden']), textarea, [contenteditable='true']").length
  };

  if (window.monaco?.editor?.getEditors()?.length > 0 || document.querySelector(".monaco-editor")) {
    result.editors.push({
      type: "Monaco (Kibana / 自研 DevTools)",
      instances: window.monaco?.editor?.getEditors()?.length || document.querySelectorAll(".monaco-editor").length,
      instruction: "可用 `bctl devtools '<query>'` 填充并执行查询"
    });
  }

  if (document.querySelector(".ace_editor") || window.ace?.edit) {
    result.editors.push({
      type: "Ace Editor (Kibana 经典版)",
      instruction: "可用 `bctl devtools '<query>'` 填充并执行查询"
    });
  }

  if (document.querySelector(".CodeMirror")?.CodeMirror || document.querySelector(".cm-editor")) {
    result.editors.push({
      type: document.querySelector(".cm-editor") ? "CodeMirror 6" : "CodeMirror",
      instruction: "可用 `bctl devtools '<query>'` 填充并执行查询"
    });
  }

  const queryTa = document.querySelector('textarea[class*="query" i], textarea[class*="editor" i], textarea[placeholder*="query" i], textarea[placeholder*="DSL" i], textarea[placeholder*="JSON" i], textarea[placeholder*="查询" i]');
  if (queryTa && queryTa.offsetParent !== null) {
    result.editors.push({
      type: "Query Textarea (自研控制台输入框)",
      selector: queryTa.className || queryTa.id,
      instruction: "可用 `bctl devtools '<query>'` 填充并执行查询"
    });
  }

  return result;
}

// 借鉴 ChatGPT handleTabActivated 机制：人类主动切入标签页时，平滑恢复正常
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const owners = await listBoundTabs();
    if (owners.has(activeInfo.tabId)) {
      chrome.tabs.sendMessage(activeInfo.tabId, { action: "hide_control_state" }).catch(() => {});
    }
  } catch (_) {}
});

// 标签页关闭时清理所有会话对它的绑定
chrome.tabs.onRemoved.addListener(async (closedTabId) => {
  try {
    await removeTabBindings(closedTabId);
  } catch (_) {}
});

connectWS();
