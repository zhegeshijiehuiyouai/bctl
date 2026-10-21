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
        chrome.tabs.sendMessage(matchedTab.id, {
          action: "set_status",
          payload: { text: "AI Agent 已接管此标签页", autoResetDelay: 2500 }
        }).catch(() => {});

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
        chrome.tabs.sendMessage(newTab.id, {
          action: "set_status",
          payload: { text: "正在加载并感知新页面..." }
        }).catch(() => {});
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

      // ─── 动作 3: Web 终端命令穿透执行 (bctl exec) ───
      if (action === "term_exec") {
        const cmd = payload.cmd || "";
        const timeoutMs = payload.timeoutMs || 20000;
        await ensureContentScript(targetTab.id);
        const cmdSummary = cmd.length > 28 ? cmd.slice(0, 28) + "..." : cmd;
        chrome.tabs.sendMessage(targetTab.id, {
          action: "set_status",
          payload: { text: `正在执行命令: ${cmdSummary}` }
        }).catch(() => {});

        const results = await chrome.scripting.executeScript({
          target: { tabId: targetTab.id, allFrames: true },
          world: "MAIN",
          args: [cmd, timeoutMs],
          func: executeInWebTerminal
        });

        const hit = results?.find(r => r?.result && r.result.matched === true);
        if (!hit) {
          chrome.tabs.sendMessage(targetTab.id, {
            action: "set_status",
            payload: { text: "未找到激活终端", autoResetDelay: 2500 }
          }).catch(() => {});
          ws.send(JSON.stringify({
            id,
            result: `在标签页 [${targetTab.id}] "${targetTab.title}" 中未找到处于可见/激活状态的 Web 终端 (支持 JumpServer / DOPS / K8s 容器 / Xterm)！`
          }));
          return;
        }

        chrome.tabs.sendMessage(targetTab.id, {
          action: "set_status",
          payload: { text: "终端命令执行完成", autoResetDelay: 2500 }
        }).catch(() => {});

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
        const results = await chrome.scripting.executeScript({
          target: { tabId: targetTab.id, allFrames: true },
          world: "MAIN",
          func: probePageInteractiveCapabilities
        });
        const combined = results?.map(r => r.result).filter(Boolean) || [];
        const active = combined.filter(c => (c.terminals && c.terminals.length > 0) || (c.editors && c.editors.length > 0));
        const finalReport = active.length > 0 ? (active.length === 1 ? active[0] : active) : (combined[0] || { url: targetTab.url, terminals: [], editors: [], inputsCount: 0 });
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
        await chrome.tabs.update(targetTab.id, { url: payload.url });
        await waitForTabLoad(targetTab.id);
        await ensureContentScript(targetTab.id);
        const res = await chrome.tabs.sendMessage(targetTab.id, { action: "look" });
        ws.send(JSON.stringify({ id, result: res }));
        return;
      }

      // ─── 动作 4.5: 设置状态描述 (bctl state <描述>) ───
      if (action === "state" || action === "set_status") {
        await ensureContentScript(targetTab.id);
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
        const results = await chrome.scripting.executeScript({
          target: { tabId: targetTab.id },
          world: "MAIN",
          args: [payload.code],
          func: (code) => {
            try {
              const res = (0, eval)(code);
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
        const frameHealthResults = await chrome.scripting.executeScript({
          target: { tabId: targetTab.id, allFrames: true },
          world: "MAIN",
          func: () => {
            const allXtermEls = Array.from(document.querySelectorAll(".xterm, .xterm-helper-textarea, [class*='terminal' i], [id*='terminal' i]"));
            const isTermFrame = location.pathname.includes("/koko/") || allXtermEls.length > 0 || window.term || window.terminal;
            if (!isTermFrame) return null;

            const isTerm = (obj) => obj && typeof obj.paste === "function" && obj.buffer && obj.buffer.active;
            let term = isTerm(window.term) ? window.term : (isTerm(window.terminal) ? window.terminal : null);
            if (!term) {
              let el = allXtermEls[0];
              while (el) {
                if (isTerm(el._terminal)) { term = el._terminal; break; }
                if (isTerm(el.term)) { term = el.term; break; }
                el = el.parentElement;
              }
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

        const results = await chrome.scripting.executeScript({
          target: { tabId: targetTab.id },
          world: "MAIN",
          func: () => {
            const lunaTabs = Array.from(document.querySelectorAll(".tabs li, elements-content-tab li"));
            const windows = Array.from(document.querySelectorAll(".window"));
            if (lunaTabs.length === 0) {
              const hasTerm = !!document.querySelector(".xterm, .xterm-helper-textarea");
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
          const isDisconnected = healthMap.get(t.src) === true;
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
        const results = await chrome.scripting.executeScript({
          target: { tabId: targetTab.id },
          world: "MAIN",
          args: [target],
          func: (query) => {
            const lunaTabs = Array.from(document.querySelectorAll(".tabs li, elements-content-tab li"));
            if (lunaTabs.length === 0) return { ok: false, error: "当前页面未检测到支持切换的多终端标签栏" };

            let matchIndex = -1;
            const q = String(query).toLowerCase().trim();
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
        const frameHealthResults = await chrome.scripting.executeScript({
          target: { tabId: targetTab.id, allFrames: true },
          world: "MAIN",
          func: () => {
            const allXtermEls = Array.from(document.querySelectorAll(".xterm, .xterm-helper-textarea, [class*='terminal' i], [id*='terminal' i]"));
            const isTermFrame = location.pathname.includes("/koko/") || allXtermEls.length > 0 || window.term || window.terminal;
            if (!isTermFrame) return null;

            const isTerm = (obj) => obj && typeof obj.paste === "function" && obj.buffer && obj.buffer.active;
            let term = isTerm(window.term) ? window.term : (isTerm(window.terminal) ? window.terminal : null);
            if (!term) {
              let el = allXtermEls[0];
              while (el) {
                if (isTerm(el._terminal)) { term = el._terminal; break; }
                if (isTerm(el.term)) { term = el.term; break; }
                el = el.parentElement;
              }
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

        const createRes = await chrome.scripting.executeScript({
          target: { tabId: targetTab.id },
          world: "MAIN",
          args: [target],
          func: async (keyword) => {
            const searchInput = document.querySelector("#assetsSearchInput, .tree-input");
            if (!searchInput) return { ok: false, error: "未在当前页面找到 JumpServer 资产搜索框 (#assetsSearchInput)" };

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

// ─── MAIN 世界通用 Web 终端 (Xterm / JumpServer / DOPS / K8s) 注入函数 ───
async function executeInWebTerminal(cmd, timeoutMs) {
  try {
    if (window.frameElement && window.frameElement.getBoundingClientRect().width === 0) {
      return { matched: false };
    }
  } catch (e) {}

  const allXtermEls = Array.from(document.querySelectorAll(".xterm, .xterm-helper-textarea, [class*='terminal' i], [id*='terminal' i]"));
  const isTermFrame = location.pathname.includes("/koko/") || location.pathname.includes("/luna/") || allXtermEls.length > 0 || window.term || window.terminal;
  if (!isTermFrame) return { matched: false };

  const xtermEl = allXtermEls.find(el => el.offsetParent !== null) || allXtermEls[0];
  if (!xtermEl && !window.term && !window.terminal) return { matched: false };

  function findXtermInstance(startEl) {
    const isTerm = (obj) => obj && typeof obj.paste === "function" && obj.buffer && obj.buffer.active;
    
    // 0. 全局 window 探测
    if (isTerm(window.term)) return window.term;
    if (isTerm(window.terminal)) return window.terminal;
    if (isTerm(window.xterm)) return window.xterm;
    if (isTerm(window._term)) return window._term;

    let el = startEl;
    while (el) {
      // 1. DOM 属性直接挂载探测 (DOPS / 自研平台常见: modal._terminal, el.term, el._xterm)
      if (isTerm(el._terminal)) return el._terminal;
      if (isTerm(el.term)) return el.term;
      if (isTerm(el._xterm)) return el._xterm;
      if (isTerm(el.terminal)) return el.terminal;
      if (isTerm(el.__xterm__)) return el.__xterm__;

      // 2. Vue 2 探测
      if (el.__vue__) {
        if (isTerm(el.__vue__.term)) return el.__vue__.term;
        if (isTerm(el.__vue__.xterm)) return el.__vue__.xterm;
        if (isTerm(el.__vue__._terminal)) return el.__vue__._terminal;
        for (const val of Object.values(el.__vue__)) {
          if (isTerm(val)) return val;
        }
      }
      // 3. Vue 3 探测
      const v3 = el.__vueParentComponent;
      if (v3) {
        const pools = [v3.ctx, v3.exposed, v3.setupState, v3.data].filter(Boolean);
        for (const pool of pools) {
          if (isTerm(pool?.term)) return pool.term;
          if (isTerm(pool?.xterm)) return pool.xterm;
          if (isTerm(pool?._terminal)) return pool._terminal;
          for (const val of Object.values(pool)) {
            if (isTerm(val)) return val;
          }
        }
      }
      // 4. React Fiber 探测 (现代 React 弹窗/容器)
      for (const k in el) {
        if (k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$")) {
          let cur = el[k];
          let depth = 0;
          while (cur && depth < 12) {
            if (cur.stateNode) {
              if (isTerm(cur.stateNode.term)) return cur.stateNode.term;
              if (isTerm(cur.stateNode.xterm)) return cur.stateNode.xterm;
              if (isTerm(cur.stateNode._terminal)) return cur.stateNode._terminal;
            }
            if (cur.memoizedState) {
              let s = cur.memoizedState;
              while (s) {
                if (isTerm(s.memoizedState?.current)) return s.memoizedState.current;
                if (isTerm(s.memoizedState)) return s.memoizedState;
                s = s.next;
              }
            }
            cur = cur.return;
            depth++;
          }
        }
      }

      el = el.parentElement;
    }

    // 5. 页面弹窗容器集中探查
    const modals = document.querySelectorAll('.modal, .modal-mask, [class*="modal"], [class*="dialog"], [role="dialog"]');
    for (const m of modals) {
      if (isTerm(m._terminal)) return m._terminal;
      if (isTerm(m.term)) return m.term;
      if (isTerm(m._xterm)) return m._xterm;
      if (isTerm(m.terminal)) return m.terminal;
    }

    return null;
  }

  const cleanCmd = cmd.replace(/[\r\n]+$/, "");
  const cmdLines = cleanCmd.split(/\r?\n/);
  const rawInput = `${cleanCmd}\r`;

  function isInteractivePrompt(trimmed) {
    if (!trimmed) return false;
    if (/(?:password|passphrase)(?:\s+for\s+[^\s:]+)?\s*:\s*$/i.test(trimmed)) return true;
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

  const term = findXtermInstance(xtermEl);

  // ─── 分支 A: 找到 term 实例，走高精度 Buffer 解析模式 ───
  if (term) {
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
        ok: false,
        error: "当前 Web 终端连接已断开 (Connection closed)，请重新连接后再执行命令",
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
          settleTimer = setTimeout(finalizeIfReady, 120);
        }
      };

      if (typeof term.onWriteParsed === "function") {
        writeDisposable = term.onWriteParsed(checkBuffer);
      }
      pollTimer = setInterval(() => {
        if (!settleTimer) checkBuffer();
      }, 150);

      if (term._core?.coreService?.triggerDataEvent) {
        term._core.coreService.triggerDataEvent(rawInput, true);
      } else {
        term.paste(rawInput);
      }
    });
  }

  // ─── 分支 B: 未暴露 term 实例时，走通用 DOM 模拟降级模式 ───
  const helper = document.querySelector(".xterm-helper-textarea");
  if (!helper) return { matched: false };

  return new Promise((resolve) => {
    function getScreenLines() {
      return Array.from(document.querySelectorAll(".xterm-rows > div"))
        .map(d => d.innerText.replace(/\u00a0/g, " ").trim())
        .filter(Boolean);
    }

    const beforeLines = getScreenLines();
    const initialPrompt = (beforeLines[beforeLines.length - 1] || "").trim();

    helper.focus();
    let sent = false;
    try {
      sent = document.execCommand("insertText", false, rawInput);
    } catch (_) {}
    if (!sent) {
      helper.value = rawInput;
      helper.dispatchEvent(new InputEvent("input", { bubbles: true, data: rawInput, inputType: "insertText" }));
      helper.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
    }

    let settleTimer = null;
    let finished = false;

    const timeoutTimer = setTimeout(() => {
      if (finished) return;
      finished = true;
      clearInterval(pollInterval);
      const after = getScreenLines();
      resolve({
        matched: true,
        ok: false,
        error: `指令在 ${timeoutMs}ms 内未执行完`,
        partialOutput: after.slice(-15).join("\n")
      });
    }, timeoutMs);

    const pollInterval = setInterval(() => {
      if (finished) return;
      const currentLines = getScreenLines();
      if (currentLines.length === 0) return;
      const lastLine = currentLines[currentLines.length - 1] || "";
      if (isShellPrompt(lastLine, initialPrompt)) {
        if (!settleTimer) {
          settleTimer = setTimeout(() => {
            finished = true;
            clearInterval(pollInterval);
            clearTimeout(timeoutTimer);
            const finalLines = getScreenLines();
            let startIdx = 0;
            for (let i = 0; i < finalLines.length; i++) {
              if (finalLines[i].includes(cleanCmd)) {
                startIdx = i + 1;
                break;
              }
            }
            const outLines = finalLines.slice(startIdx, Math.max(startIdx, finalLines.length - 1));
            resolve({
              matched: true,
              ok: true,
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
    terminals: [],
    editors: [],
    inputsCount: document.querySelectorAll("input:not([type='hidden']), textarea, [contenteditable='true']").length
  };

  const isFrameVisible = (() => {
    try {
      return window.frameElement ? window.frameElement.getBoundingClientRect().width > 0 : true;
    } catch (e) {
      return true;
    }
  })();

  const xtermEls = document.querySelectorAll(".xterm, .xterm-helper-textarea, [class*='terminal' i], [id*='terminal' i]");
  if (xtermEls.length > 0 || window.term || window.terminal) {
    result.terminals.push({
      type: "Xterm / Web Terminal",
      count: xtermEls.length,
      visible: isFrameVisible && Array.from(xtermEls).some(el => el.offsetParent !== null),
      instruction: "可用 `bctl exec '<cmd>'` 穿透执行命令"
    });
  }

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
