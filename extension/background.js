let ws = null;
const WS_URL = "ws://127.0.0.1:9223";

const CONTROL_TIMEOUT_MS = 10 * 60 * 1000; // 10 分钟超时兜底

// 1. 保活报警器（MV3 Service Worker 闲置 30 秒休眠防断连，兼顾 10 分钟闲置超时兜底）
chrome.alarms.create("keepAlive", { periodInMinutes: 0.3 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "keepAlive") {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      connectWS();
    } else {
      ws.send(JSON.stringify({ type: "pong" }));
    }

    // 10 分钟超时兜底：检查是否超过 10 分钟未收到大模型任何操作
    try {
      const { boundTabId, lastActivityTime } = await chrome.storage.session.get(["boundTabId", "lastActivityTime"]);
      if (boundTabId && lastActivityTime && (Date.now() - lastActivityTime > CONTROL_TIMEOUT_MS)) {
        console.log(`[bctl] 超过 10 分钟无大模型操作，触发超时兜底自动解绑标签页: ${boundTabId}`);
        chrome.tabs.sendMessage(boundTabId, { action: "hide_control_state" }).catch(() => {});
        await chrome.tabs.update(boundTabId, { autoDiscardable: true }).catch(() => {});
        await chrome.storage.session.remove(["boundTabId", "lastActivityTime"]);
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

  ws.onopen = () => {
    isConnecting = false;
    console.log("[Extension] 成功连接至本地 bctl 守护进程");
  };

  ws.onmessage = async (e) => {
    let msg = null;
    try {
      msg = JSON.parse(e.data);
      if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
        return;
      }

      const { id, action, payload } = msg;

      if (action === "reload") {
        ws.send(JSON.stringify({ id, result: "Chrome 扩展已成功触发重载" }));
        setTimeout(() => {
          chrome.runtime.reload();
        }, 100);
        return;
      }

      // ─── 动作 1: 列出所有标签页 (bctl tabs) ───
      if (action === "tabs") {
        const { boundTabId } = await chrome.storage.session.get("boundTabId");
        const allTabs = await chrome.tabs.query({});
        const lines = allTabs.map(t => {
          const isBound = t.id === boundTabId ? " [★ 绑定后台]" : "";
          const isActive = t.active ? " [当前前台]" : "";
          return `[${t.id}] ${t.title || "(无标题)"} (${t.url || "about:blank"})${isBound}${isActive}`;
        });
        ws.send(JSON.stringify({ id, result: lines.join("\n") || "未找到打开的标签页" }));
        return;
      }

      // ─── 动作 2: 绑定指定标签页 (bctl bind <id|keyword>) ───
      if (action === "bind") {
        const target = (payload.target || "").toString().trim().toLowerCase();
        const allTabs = await chrome.tabs.query({});
        let matchedTab = null;

        // 先按 ID 匹配，再按标题/URL 关键词模糊匹配
        const targetId = parseInt(target, 10);
        if (!isNaN(targetId)) {
          matchedTab = allTabs.find(t => t.id === targetId);
        }
        if (!matchedTab && target) {
          matchedTab = allTabs.find(t =>
            (t.title && t.title.toLowerCase().includes(target)) ||
            (t.url && t.url.toLowerCase().includes(target))
          );
        }

        if (!matchedTab) {
          ws.send(JSON.stringify({ id, result: `未找到匹配 "${target}" 的标签页，请先运行 bctl tabs 查看当前标签列表` }));
          return;
        }

        // 保存至 session 存储，防止 Service Worker 唤醒时丢失，同时记录当前活跃时间戳
        await chrome.storage.session.set({ boundTabId: matchedTab.id, lastActivityTime: Date.now() });
        // 禁止 Chrome 后台休眠丢弃该标签页
        await chrome.tabs.update(matchedTab.id, { autoDiscardable: false }).catch(() => {});
        // 激活 ChatGPT 同款中央光标与控制胶囊 + Tab 图标光标
        await ensureContentScript(matchedTab.id);
        chrome.tabs.sendMessage(matchedTab.id, { action: "show_control_state" }).catch(() => {});

        ws.send(JSON.stringify({
          id,
          result: `已成功绑定目标标签页 [${matchedTab.id}] "${matchedTab.title}"\n后续操作将在该标签页后台独立运行，不抢占前台焦点！`
        }));
        return;
      }

      // ─── 动作 2.5: 在后台静默打开新标签页 (bctl new <url>) ───
      if (action === "new") {
        const newTab = await chrome.tabs.create({ url: payload.url, active: false });
        await chrome.storage.session.set({ boundTabId: newTab.id, lastActivityTime: Date.now() });
        await chrome.tabs.update(newTab.id, { autoDiscardable: false }).catch(() => {});

        await waitForTabLoad(newTab.id);
        await ensureContentScript(newTab.id);
        chrome.tabs.sendMessage(newTab.id, { action: "show_control_state" }).catch(() => {});
        const res = await chrome.tabs.sendMessage(newTab.id, { action: "look" });
        ws.send(JSON.stringify({ id, result: `[已在后台打开新标签页 ${newTab.id}: ${payload.url}]\n\n${res}` }));
        return;
      }

      // ─── 动作 2.6: 解除绑定与释放控制 (bctl unbind / bctl release) ───
      if (action === "unbind" || action === "release") {
        const { boundTabId } = await chrome.storage.session.get("boundTabId");
        if (boundTabId) {
          chrome.tabs.sendMessage(boundTabId, { action: "hide_control_state" }).catch(() => {});
          await chrome.tabs.update(boundTabId, { autoDiscardable: true }).catch(() => {});
          await chrome.storage.session.remove(["boundTabId", "lastActivityTime"]);
        }
        ws.send(JSON.stringify({ id, result: "已成功解除标签页绑定，指示胶囊与 Tab 栏图标已恢复正常" }));
        return;
      }

      // 刷新活跃时间戳
      chrome.storage.session.set({ lastActivityTime: Date.now() }).catch(() => {});

      // 获取当前控制目标 Tab（优先使用绑定的后台 Tab）
      const targetTab = await getTargetTab();
      if (!targetTab) {
        ws.send(JSON.stringify({ id, result: "未找到可用标签页！请先执行 bctl tabs 查看并用 bctl bind 绑定" }));
        return;
      }

      // ─── 动作 3: JumpServer 终端命令穿透执行 (bctl exec) ───
      if (action === "term_exec") {
        const cmd = payload.cmd || "";
        const timeoutMs = payload.timeoutMs || 15000;

        const results = await chrome.scripting.executeScript({
          target: { tabId: targetTab.id, allFrames: true },
          world: "MAIN",
          args: [cmd, timeoutMs],
          func: executeInKokoTerminal
        });

        const hit = results?.find(r => r?.result && r.result.matched === true);
        if (!hit) {
          ws.send(JSON.stringify({
            id,
            result: `在标签页 [${targetTab.id}] "${targetTab.title}" 中未找到处于可见/激活状态的 JumpServer (Koko) xterm 终端！`
          }));
          return;
        }

        if (hit.result.ok) {
          ws.send(JSON.stringify({ id, result: hit.result.output }));
        } else {
          ws.send(JSON.stringify({
            id,
            result: `[执行异常/超时] ${hit.result.error || "未知错误"}\n${hit.result.partialOutput || ""}`
          }));
        }
        return;
      }

      // ─── 动作 4: 打开新网址 (bctl open) ───
      if (action === "open") {
        await chrome.tabs.update(targetTab.id, { url: payload.url });
        await waitForTabLoad(targetTab.id);
        await ensureContentScript(targetTab.id);
        const res = await chrome.tabs.sendMessage(targetTab.id, { action: "look" });
        ws.send(JSON.stringify({ id, result: res }));
        return;
      }

      // ─── 动作 5: 常规 look / act（穿透至 content.js） ───
      await ensureContentScript(targetTab.id);
      const res = await chrome.tabs.sendMessage(targetTab.id, { action, payload });
      ws.send(JSON.stringify({ id, result: res }));

    } catch (err) {
      console.error("[Extension] 处理异常:", err);
      // 关键：任何异常立即回包，彻底根除 CLI 15 秒挂死超时
      if (msg && msg.id) {
        ws.send(JSON.stringify({ id: msg.id, result: `[扩展执行异常] ${err.message}` }));
      }
    }
  };

  ws.onclose = () => {
    isConnecting = false;
    ws = null;
    setTimeout(connectWS, 2500);
  };
  ws.onerror = () => {
    isConnecting = false;
    if (ws) ws.close();
  };
}

// 获取操作目标 Tab
async function getTargetTab() {
  const { boundTabId } = await chrome.storage.session.get("boundTabId");
  if (boundTabId) {
    try {
      const tab = await chrome.tabs.get(boundTabId);
      if (tab) return tab;
    } catch (e) {
      await chrome.storage.session.remove("boundTabId");
    }
  }
  // 未绑定时回退到当前活动窗口的标签页
  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (activeTab) return activeTab;
  const [anyActive] = await chrome.tabs.query({ active: true });
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

// ─── MAIN 世界直连 JumpServer (Koko) xterm 实例的注入函数 ───
// 关键边界防御：
// 1. 鸭子类型递归探查 Vue 2 / Vue 3 / window.term
// 2. 纯净原样命令下发（零 __BCTL_S_ / __BCTL_E_ 标记污染），基于光标行与提示符静默稳定检测完成态
// 3. isWrapped 软折行拼接还原 + 环形缓冲区 onTrim 滚屏偏移追踪
// 4. term.onWriteParsed 事件监听配合轮询防后台休眠节流
// 5. triggerDataEvent 绕过 Bracketed Paste 陷阱
async function executeInKokoTerminal(cmd, timeoutMs) {
  const isKokoFrame = location.pathname.includes("/koko/") || document.querySelector(".xterm");
  if (!isKokoFrame) return { matched: false };

  const xtermEl = document.querySelector(".xterm");
  if (!xtermEl || xtermEl.offsetParent === null) return { matched: false };

  function findXtermInstance(startEl) {
    const isTerm = (obj) => obj && typeof obj.paste === "function" && obj.buffer && obj.buffer.active;
    let el = startEl;
    while (el) {
      // Vue 2 探测
      if (el.__vue__) {
        if (isTerm(el.__vue__.term)) return el.__vue__.term;
        if (isTerm(el.__vue__.xterm)) return el.__vue__.xterm;
        for (const val of Object.values(el.__vue__)) {
          if (isTerm(val)) return val;
        }
      }
      // Vue 3 探测
      const v3 = el.__vueParentComponent;
      if (v3) {
        const pools = [v3.ctx, v3.exposed, v3.setupState, v3.data].filter(Boolean);
        for (const pool of pools) {
          if (isTerm(pool?.term)) return pool.term;
          for (const val of Object.values(pool)) {
            if (isTerm(val)) return val;
          }
        }
      }
      el = el.parentElement;
    }
    return window.term && isTerm(window.term) ? window.term : null;
  }

  const term = findXtermInstance(xtermEl);
  if (!term) return { matched: false };

  const cleanCmd = cmd.replace(/[\r\n]+$/, "");
  const cmdLines = cleanCmd.split(/\r?\n/);
  const rawInput = `${cleanCmd}\r`;

  function extractLogicalLines(buffer, fromRow, toRow) {
    const maxIdx = Math.min(buffer.length - 1, toRow);
    const logicalLines = [];
    let currentLine = "";

    for (let i = Math.max(0, fromRow); i <= maxIdx; i++) {
      const line = buffer.getLine(i);
      if (!line) continue;
      const nextLine = i + 1 <= maxIdx ? buffer.getLine(i + 1) : null;
      const isNextWrapped = Boolean(nextLine && nextLine.isWrapped);

      // 软折行还原
      currentLine += line.translateToString(!isNextWrapped);
      if (!isNextWrapped) {
        logicalLines.push(currentLine);
        currentLine = "";
      }
    }
    if (currentLine) logicalLines.push(currentLine);
    return logicalLines;
  }

  function isInteractivePrompt(trimmed) {
    if (!trimmed) return false;
    if (/(?:password|passphrase)(?:\s+for\s+[^\s:]+)?\s*:\s*$/i.test(trimmed)) return true;
    if (/\((?:yes\/no(?:\/\[fingerprint\])?|y\/n)\)\??\s*:?\s*$/i.test(trimmed)) return true;
    return false;
  }

  function isShellPrompt(trimmed, initPrompt) {
    if (!trimmed) return false;
    if (initPrompt && trimmed === initPrompt) return true;
    // 常见 Linux/Unix Shell 提示符: [user@host dir]# / $ 或 user@host:dir# / $ 等
    if (/^(?:\([^)]+\)\s*)*\[[^\]]+@[^\]]+\]\s*[#$%>]\s*$/.test(trimmed)) return true;
    if (/^(?:\([^)]+\)\s*)*[^\s@]+@[^\s:]+:[^\s]*\s*[#$%>]\s*$/.test(trimmed)) return true;
    if (/^(?:sh|bash|zsh|csh|ksh|dash|ash)(?:-[\d.]+)?\s*[#$%>]\s*$/.test(trimmed)) return true;
    if (/^(?:mysql|redis[^›>]*|postgres[^›>]*|sqlite3?)\s*>\s*$/i.test(trimmed)) return true;
    if (isInteractivePrompt(trimmed)) return true;
    return false;
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
      ok: false,
      error: "当前 JumpServer Web 终端连接已断开 (Connection websocket closed)，请重新连接资产后再执行命令",
      partialOutput: tailText,
    };
  }
  const initialPrompt = (extractLogicalLines(activeBuf, startRow, activeBuf.baseY + activeBuf.cursorY)[0] || "").trim();

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

    // 追踪环形缓冲区满载时的顶部裁剪行数，保持 startRow 精确对齐
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
      resolve({
        matched: true,
        ok: false,
        error: `指令在 ${timeoutMs}ms 内未执行完（可能卡在交互式输入或耗时命令）`,
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
        // 提示符出现后等待 120ms 静默稳定期，确保多段输出或长回显完全落盘
        settleTimer = setTimeout(finalizeIfReady, 120);
      }
    };

    if (typeof term.onWriteParsed === "function") {
      writeDisposable = term.onWriteParsed(checkBuffer);
    }
    pollTimer = setInterval(() => {
      if (!settleTimer) checkBuffer();
    }, 150);

    // 优先使用底层 triggerDataEvent 绕过 Bracketed Paste 陷阱，直接下发纯净明文命令
    if (term._core?.coreService?.triggerDataEvent) {
      term._core.coreService.triggerDataEvent(rawInput, true);
    } else {
      term.paste(rawInput);
    }
  });
}

// 借鉴 ChatGPT handleTabActivated 机制：人类主动切入标签页时，平滑恢复正常
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const { boundTabId } = await chrome.storage.session.get("boundTabId");
    if (activeInfo.tabId === boundTabId) {
      chrome.tabs.sendMessage(activeInfo.tabId, { action: "hide_control_state" }).catch(() => {});
    }
  } catch (_) {}
});

// 标签页关闭时清理 session 中的绑定 ID
chrome.tabs.onRemoved.addListener(async (closedTabId) => {
  try {
    const { boundTabId } = await chrome.storage.session.get("boundTabId");
    if (closedTabId === boundTabId) {
      await chrome.storage.session.remove(["boundTabId", "lastActivityTime"]);
    }
  } catch (_) {}
});

connectWS();
