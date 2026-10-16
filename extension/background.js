let ws = null;
const WS_URL = "ws://127.0.0.1:9223";

// 1. 保活报警器（MV3 Service Worker 闲置 30 秒休眠防断连）
chrome.alarms.create("keepAlive", { periodInMinutes: 0.3 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepAlive") {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      connectWS();
    } else {
      ws.send(JSON.stringify({ type: "pong" }));
    }
  }
});

function connectWS() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  try {
    ws = new WebSocket(WS_URL);
  } catch (e) {
    setTimeout(connectWS, 2000);
    return;
  }

  ws.onopen = () => {
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

        // 保存至 session 存储，防止 Service Worker 唤醒时丢失
        await chrome.storage.session.set({ boundTabId: matchedTab.id });
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
        await chrome.storage.session.set({ boundTabId: newTab.id });
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
          await chrome.storage.session.remove("boundTabId");
        }
        ws.send(JSON.stringify({ id, result: "已成功解除标签页绑定，指示胶囊与 Tab 栏图标已恢复正常" }));
        return;
      }

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
    ws = null;
    setTimeout(connectWS, 2500);
  };
  ws.onerror = () => {
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
// 包含了 Gemini 4 确认的 5 项关键边界防御：
// 1. 鸭子类型递归探查 Vue 2 / Vue 3 / window.term
// 2. printf 动态 Token 防回显截断与退出码捕获
// 3. isWrapped 软折行拼接还原
// 4. term.onWriteParsed 事件监听防后台休眠节流
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

  // 动态 Marker 防回显碰撞
  const token = Math.random().toString(36).slice(2, 8);
  const startMarker = `__BCTL_S_${token}__`;
  const endPrefix = `__BCTL_E_${token}_`;
  const wrappedCmd = `printf "\\n__BCTL_S_%s__\\n" "${token}"; ${cmd}; printf "\\n__BCTL_E_%s_%d__\\n" "${token}" $?\r`;

  function extractBufferLines(buffer, startLineIdx) {
    const totalLines = buffer.length;
    const logicalLines = [];
    let currentLine = "";

    for (let i = Math.max(0, startLineIdx); i < totalLines; i++) {
      const line = buffer.getLine(i);
      if (!line) continue;
      const nextLine = i + 1 < totalLines ? buffer.getLine(i + 1) : null;
      const isNextWrapped = nextLine && nextLine.isWrapped;

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

  const startBaseLine = Math.max(0, term.buffer.active.baseY + term.buffer.active.cursorY - 2);

  return new Promise((resolve) => {
    let disposable = null;
    const timer = setTimeout(() => {
      if (disposable) disposable.dispose();
      const partial = extractBufferLines(term.buffer.active, startBaseLine).join("\n");
      resolve({
        matched: true,
        ok: false,
        error: `指令在 ${timeoutMs}ms 内未执行完（可能卡在交互式输入或耗时命令）`,
        partialOutput: partial.slice(-2000),
      });
    }, timeoutMs);

    const checkBuffer = () => {
      const lines = extractBufferLines(term.buffer.active, startBaseLine);
      const startIdx = lines.findIndex((l) => l.trim() === startMarker);
      if (startIdx === -1) return;

      for (let i = startIdx + 1; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (trimmed.startsWith(endPrefix) && trimmed.endsWith("__")) {
          clearTimeout(timer);
          if (disposable) disposable.dispose();

          const exitCodeStr = trimmed.slice(endPrefix.length, -2);
          const output = lines.slice(startIdx + 1, i).join("\n");
          resolve({
            matched: true,
            ok: true,
            exitCode: Number(exitCodeStr),
            output: output.trim(),
          });
          return;
        }
      }
    };

    if (typeof term.onWriteParsed === "function") {
      disposable = term.onWriteParsed(checkBuffer);
    }

    // 优先使用底层 triggerDataEvent 绕过 Bracketed Paste 陷阱
    if (term._core?.coreService?.triggerDataEvent) {
      term._core.coreService.triggerDataEvent(wrappedCmd, true);
    } else {
      term.paste(wrappedCmd);
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
      await chrome.storage.session.remove("boundTabId");
    }
  } catch (_) {}
});

connectWS();
