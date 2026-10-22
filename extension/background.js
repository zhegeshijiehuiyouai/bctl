let ws = null;
const WS_URL = "ws://127.0.0.1:9223";

const CONTROL_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 小时超时兜底（避免长任务/等待人工操作时误解绑）

// 1. 保活报警器（MV3 Service Worker 闲置 30 秒休眠防断连，兼顾 2 小时闲置超时兜底）
chrome.alarms.create("keepAlive", { periodInMinutes: 0.3 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "keepAlive") {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      connectWS();
    } else {
      ws.send(JSON.stringify({ type: "pong" }));
    }

    // 2 小时超时兜底：检查是否超过 2 小时未收到大模型任何操作
    try {
      const { boundTabId, lastActivityTime } = await chrome.storage.session.get(["boundTabId", "lastActivityTime"]);
      if (boundTabId && lastActivityTime && (Date.now() - lastActivityTime > CONTROL_TIMEOUT_MS)) {
        console.log(`[bctl] 超过 2 小时无大模型操作，触发超时兜底自动解绑标签页: ${boundTabId}`);
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
        const rawTarget = (payload.target || "").toString().trim();
        const targetLower = rawTarget.toLowerCase();
        const allTabs = await chrome.tabs.query({});
        let matchedTab = null;

        // 1. 若输入为纯数字，严格按 Tab ID 精确匹配
        if (/^\d+$/.test(rawTarget)) {
          const targetId = parseInt(rawTarget, 10);
          matchedTab = allTabs.find(t => t.id === targetId);
          if (!matchedTab) {
            ws.send(JSON.stringify({ id, result: `未找到 TabID 为 [${targetId}] 的标签页，请先运行 bctl tabs 查看当前可用标签页` }));
            return;
          }
        } else if (rawTarget) {
          // 2. 输入为关键词，按标题/URL 模糊匹配；若匹配到多个则报错拦截，彻底杜绝串台
          const matchedTabs = allTabs.filter(t =>
            (t.title && t.title.toLowerCase().includes(targetLower)) ||
            (t.url && t.url.toLowerCase().includes(targetLower))
          );

          if (matchedTabs.length > 1) {
            const listStr = matchedTabs.map(t => `  - [${t.id}] ${t.title || "(无标题)"} (${t.url || ""})`).join("\n");
            ws.send(JSON.stringify({
              id,
              result: `[多实例冲突拦截] 关键词 "${rawTarget}" 匹配到 ${matchedTabs.length} 个标签页！为防止串台误操作，请使用精准 TabID 绑定：\n${listStr}\n\n示例: bctl bind ${matchedTabs[0].id}`
            }));
            return;
          }
          matchedTab = matchedTabs[0] || null;
        }

        if (!matchedTab) {
          ws.send(JSON.stringify({ id, result: `未找到匹配 "${rawTarget}" 的标签页，请先运行 bctl tabs 查看当前标签列表` }));
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

      // 强校验：执行与终端交互类动作必须严格绑定后台标签页，严禁盲目降级回退到前台活动标签
      const REQUIRE_BOUND_ACTIONS = new Set([
        "term_exec",
        "devtools_exec",
        "act",
        "open",
        "term_connect",
        "term_switch",
        "term_tabs",
        "subtabs"
      ]);

      const needBound = REQUIRE_BOUND_ACTIONS.has(action);
      const targetTab = await getTargetTab(needBound);
      if (!targetTab) {
        if (needBound) {
          ws.send(JSON.stringify({
            id,
            result: `[安全拦截] 当前未绑定任何后台标签页！为防止向人类前台正在浏览的页面或其它终端误发命令，执行与终端交互类操作严禁未绑定运行。请先使用 bctl tabs 查看并用 bctl bind <TabID> 显式锁定目标。`
          }));
          return;
        }
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
        const frameHealthResults = await chrome.scripting.executeScript({
          target: { tabId: targetTab.id, allFrames: true },
          world: "MAIN",
          func: () => {
            const allXtermEls = Array.from(document.querySelectorAll(".xterm, .xterm-helper-textarea, [class*='terminal' i], [id*='terminal' i]"))
              .filter(el => !(el instanceof SVGElement));
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
async function getTargetTab(requireBound = false) {
  const { boundTabId } = await chrome.storage.session.get("boundTabId");
  if (boundTabId) {
    try {
      const tab = await chrome.tabs.get(boundTabId);
      if (tab) return tab;
    } catch (e) {
      await chrome.storage.session.remove(["boundTabId", "lastActivityTime"]);
    }
  }
  if (requireBound) {
    return null;
  }
  // 未绑定时回退到当前活动窗口的标签页 (仅供 look/probe 等只读探测兜底使用)
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

// ─── MAIN 世界通用 Web 终端 (Xterm / Guacamole / 云堡垒机 / JumpServer / DOPS / K8s / 任意自研终端) 注入函数 ───
async function executeInWebTerminal(cmd, timeoutMs) {
  try {
    if (window.frameElement && window.frameElement.getBoundingClientRect().width === 0) {
      return { matched: false };
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

  // 1. 过滤掉 <symbol id="icon-yab_h_terminal"> 等 SVG 图标元素，避免假阳性
  const allXtermEls = Array.from(
    document.querySelectorAll(".xterm, .xterm-helper-textarea, [class*='terminal' i], [id*='terminal' i]")
  ).filter(el => !(el instanceof SVGElement));
  const xtermEl = allXtermEls.find(el => el.offsetParent !== null) || allXtermEls[0];

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

  const term = findXtermInstance(xtermEl);

  // ─── 分支 A (Level 1A): 找到 Xterm.js 内存实例，走高精度 Buffer 解析模式 ───
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
  if (guacCtx) {
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

  // ─── 分支 C (Level 2 & 3): 启发式通用终端输入陷阱嗅探 + 点击唤醒 + 多模自适应派发兜底 ───
  // 专为世间千奇百态的非标 Web 终端设计：不依赖固定 class，通过物理特征定位输入口
  function discoverUniversalTerminalTarget() {
    // 1. 寻找可视终端渲染画布/容器（用于判断是否终端页及点击唤醒焦点）
    const surfaceCandidates = Array.from(
      document.querySelectorAll("canvas, .xterm, .xterm-screen, pre, [class*='term' i], [id*='term' i], [class*='guac' i], [id*='guac' i], [class*='console' i], [class*='shell' i], [class*='ssh' i], [class*='tty' i]")
    ).filter(el => {
      if (el instanceof SVGElement) return false;
      const r = el.getBoundingClientRect();
      return r.width >= 160 && r.height >= 100;
    });
    surfaceCandidates.sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return (rb.width * rb.height) - (ra.width * ra.height);
    });
    const primarySurface = surfaceCandidates[0] || null;

    // 2. 扫描全文档所有潜在文本接收控件（突破视口限制！专门纳入 left<0 或 opacity:0 的隐藏输入陷阱）
    function scoreInputTrap(el) {
      if (!el || el.disabled || el.readOnly) return -1;
      const tag = el.tagName;
      if (tag === "INPUT") {
        const type = (el.getAttribute("type") || "text").toLowerCase();
        if (["checkbox", "radio", "button", "submit", "reset", "file", "hidden", "range", "color", "image"].includes(type)) {
          return -1;
        }
      } else if (tag !== "TEXTAREA" && el.getAttribute("contenteditable") !== "true") {
        return -1;
      }

      let score = 0;
      const val = el.value || "";
      const idCls = `${el.id || ""} ${typeof el.className === "string" ? el.className : ""} ${el.parentElement?.className || ""} ${el.parentElement?.parentElement?.className || ""}`;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);

      if (style.display === "none" || style.visibility === "hidden") return -1;

      // 特征 1: 包含零宽空格 \u200b (Guacamole / 远程终端经典光标陷阱特征)
      if (val.includes("\u200b")) score += 65;

      // 特征 2: 经典终端类名/ID 命中
      if (/xterm-helper-textarea|inputArea|guac|term|tty|ssh|shell|console|cmd|clipboard|ime/i.test(idCls)) {
        score += 40;
      }

      // 特征 3: 当前正持有浏览器焦点 (Web 终端初始化后常驻锁定焦点)
      if (el === document.activeElement) score += 35;

      // 特征 4: 禁用自动纠错/首字母大写 (所有 Web 终端隐藏输入框标配)
      if (el.getAttribute("autocorrect") === "off" || el.getAttribute("autocapitalize") === "off" || el.getAttribute("spellcheck") === "false") {
        score += 25;
      }

      // 特征 5: 位于视口外 (left<0 / top<0) 或全透明/极小尺寸的 TEXTAREA (专用于拦截键盘与输入法事件的 Input Trap)
      const isOffscreenOrHiddenTrap = rect.right <= 0 || rect.bottom <= 0 || rect.left < -10 || parseFloat(style.opacity) === 0 || (rect.width <= 4 && rect.height <= 4);
      if (tag === "TEXTAREA" && isOffscreenOrHiddenTrap) {
        score += 30;
      }

      return score;
    }

    const allInputs = Array.from(document.querySelectorAll("textarea, input, [contenteditable='true']"));
    let scored = allInputs.map(el => ({ el, score: scoreInputTrap(el) })).filter(x => x.score > 0);
    scored.sort((a, b) => b.score - a.score);

    if (scored.length > 0 && scored[0].score >= 35) {
      return { inputEl: scored[0].el, surfaceEl: primarySurface, score: scored[0].score, method: "heuristic-trap" };
    }

    // 3. 主动点击唤醒探测 (Click-to-Wake Focus Probing)：
    // 若未直接找到高置信度输入框，模拟点击主终端画布中心，诱发终端组件自动 focus 其隐藏输入框
    if (primarySurface) {
      const r = primarySurface.getBoundingClientRect();
      const cx = Math.round(r.left + r.width / 2);
      const cy = Math.round(r.top + r.height / 2);
      const hitEl = document.elementFromPoint(cx, cy) || primarySurface;
      ["mousedown", "mouseup", "click"].forEach(type => {
        hitEl.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: cx, clientY: cy, view: window }));
      });

      const active = document.activeElement;
      if (active && active !== document.body && active !== document.documentElement) {
        const s = scoreInputTrap(active);
        if (s >= 0) {
          return { inputEl: active, surfaceEl: primarySurface, score: s + 40, method: "click-woken-activeElement" };
        }
      }

      // 退化为直接向画布/当前焦点派发物理键盘事件流
      return { inputEl: primarySurface, surfaceEl: primarySurface, score: 20, method: "surface-keyevent-stream" };
    }

    return null;
  }

  const universalTarget = discoverUniversalTerminalTarget();
  if (!universalTarget) return { matched: false };

  function dispatchUniversalTerminalInput(targetEl, commandText) {
    const val = targetEl.value || "";

    // 模式 1: 零宽字符哨兵输入框 (如 Guacamole v-guacTextInput)
    if (typeof targetEl.value === "string" && val.includes("\u200b")) {
      targetEl.focus();
      const zwsp = "\u200b\u200b\u200b\u200b";
      targetEl.value = `${zwsp}${commandText}\n${zwsp}`;
      targetEl.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }

    // 模式 2: 隐藏或标准 Textarea / Input
    if (targetEl.tagName === "TEXTAREA" || targetEl.tagName === "INPUT") {
      targetEl.focus();
      let sent = false;
      try {
        sent = document.execCommand("insertText", false, `${commandText}\r`);
      } catch (_) {}
      if (!sent) {
        targetEl.value = `${commandText}\r`;
        targetEl.dispatchEvent(new InputEvent("input", { bubbles: true, data: `${commandText}\r`, inputType: "insertText" }));
        targetEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
        targetEl.dispatchEvent(new KeyboardEvent("keypress", { key: "Enter", code: "Enter", keyCode: 13, which: 13, charCode: 13, bubbles: true }));
        targetEl.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
      }
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

    dispatchUniversalTerminalInput(universalTarget.inputEl, cleanCmd);

    // 若页面为纯 Canvas 且无 DOM 文本行，等待短暂执行后返回明确状态
    if (beforeLines.length === 0) {
      setTimeout(() => {
        const afterLines = getScreenLines();
        if (afterLines.length === 0) {
          resolve({
            matched: true,
            ok: true,
            output: `[已通过通用终端通道 (${universalTarget.method}: <${universalTarget.inputEl.tagName.toLowerCase()}${universalTarget.inputEl.id ? "#" + universalTarget.inputEl.id : ""}>) 下发命令: ${cleanCmd}] (当前终端采用纯画布渲染无 DOM 文本节点)`
          });
        }
      }, 600);
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

  // 1. Xterm 探测 (过滤 SVG <symbol> 假阳性)
  const xtermEls = Array.from(
    document.querySelectorAll(".xterm, .xterm-helper-textarea, .xterm-screen")
  ).filter(el => !(el instanceof SVGElement));
  if (xtermEls.length > 0 || window.term || window.terminal) {
    result.terminals.push({
      type: "Xterm.js Web Terminal",
      count: xtermEls.length,
      visible: isFrameVisible && xtermEls.some(el => el.offsetParent !== null),
      instruction: "可用 `bctl exec '<cmd>'` 穿透执行命令"
    });
  }

  // 2. Apache Guacamole / 华为云堡垒机 (yabProxyGuac) 探测
  const yabRoot = document.querySelector(".yab-proxy-root")?.__vue__;
  const baseGuac = yabRoot && typeof yabRoot.getCurrentBaseGuac === "function" ? yabRoot.getCurrentBaseGuac() : null;
  const guacClient = baseGuac?.client || baseGuac?.managedClient?.client;
  if (guacClient && typeof guacClient.sendKeyEvent === "function") {
    const mc = baseGuac.managedClient;
    const disp = baseGuac.display || guacClient.getDisplay?.();
    result.terminals.push({
      type: "Apache Guacamole / 云堡垒机 (Canvas + X11 Keysym)",
      host: mc?.connectData ? `${mc.connectData.accountName || ""}@${mc.connectData.address || ""} (${mc.connectData.name || ""})` : document.title,
      connectionState: mc?.clientState?.connectionState || "CONNECTED",
      canvasSize: disp ? `${disp.getWidth()}x${disp.getHeight()}` : "unknown",
      inputTrapSelector: "#inputArea.target",
      visible: isFrameVisible,
      instruction: "可用 `bctl exec '<cmd>'` 穿透执行命令（自动通过 X11 Keysym 输入并经剪贴板流读取回显）"
    });
  }

  // 3. 通用隐藏输入陷阱 (Universal Terminal Input Trap) 启发式探测兜底
  const trapCandidates = Array.from(document.querySelectorAll("textarea, input:not([type='hidden']):not([type='checkbox']):not([type='radio']), [contenteditable='true']"))
    .map(el => {
      const val = el.value || "";
      const rect = el.getBoundingClientRect();
      const idCls = `${el.id || ""} ${typeof el.className === "string" ? el.className : ""} ${el.parentElement?.className || ""}`;
      let score = 0;
      if (val.includes("\u200b")) score += 65;
      if (/xterm-helper-textarea|inputArea|guac|term|tty|ssh|shell|console|cmd|clipboard|ime/i.test(idCls)) score += 40;
      if (el === document.activeElement) score += 35;
      if (el.getAttribute("autocorrect") === "off" || el.getAttribute("autocapitalize") === "off") score += 25;
      if (el.tagName === "TEXTAREA" && (rect.right <= 0 || rect.bottom <= 0 || rect.left < -10)) score += 30;
      return {
        el,
        score,
        selector: `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}${typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\s+/).join(".") : ""}`,
        isFocused: el === document.activeElement,
        isOffscreen: rect.right <= 0 || rect.bottom <= 0 || rect.left < 0,
        hasZeroWidthTrap: val.includes("\u200b")
      };
    })
    .filter(x => x.score >= 40)
    .sort((a, b) => b.score - a.score);

  if (trapCandidates.length > 0 && result.terminals.length === 0) {
    const top = trapCandidates[0];
    result.terminals.push({
      type: "Universal Web Terminal (启发式捕获隐藏输入陷阱)",
      inputSelector: top.selector,
      focused: top.isFocused,
      offscreenTrap: top.isOffscreen,
      zeroWidthMode: top.hasZeroWidthTrap,
      score: top.score,
      visible: isFrameVisible,
      instruction: "可用 `bctl exec '<cmd>'` 执行命令，或在 `bctl look` 中对该终端输入口执行 `bctl act` type 操作"
    });
  } else if (trapCandidates.length > 0 && result.terminals.length > 0) {
    result.terminals[0].discoveredInputTrap = {
      selector: trapCandidates[0].selector,
      focused: trapCandidates[0].isFocused,
      offscreenTrap: trapCandidates[0].isOffscreen,
      zeroWidthMode: trapCandidates[0].hasZeroWidthTrap
    };
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
