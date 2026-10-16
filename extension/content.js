(() => {
  // ─── 幂等防重与历史资源清理 ───
  if (window.__bctl_message_listener__) {
    try {
      chrome.runtime.onMessage.removeListener(window.__bctl_message_listener__);
    } catch (_) {}
  }
  const oldOverlay = document.getElementById("bctl-agent-overlay-root");
  if (oldOverlay) {
    oldOverlay.remove();
  }

  // --- ChatGPT 同款弹簧物理鼠标、Tab 栏光标 Favicon 与后台控制视觉层 ---
  let overlayRoot = null;
  let cursorWrapper = null;
  let cursorImg = null;
  let indicatorPill = null;

  let cursorX = window.innerWidth / 2;
  let cursorY = window.innerHeight / 2;
  let isControlling = false;

  // 1. ChatGPT 官方原版标签页图标光标（在 Chrome 原生 Tab 栏渲染鼠标箭头）
  const CHATGPT_CURSOR_PATH = "M3.04536 4.45259C2.7582 3.60299 3.60299 2.7582 4.45259 3.04536L14.1828 6.33403C15.1637 6.66558 15.0872 8.08006 14.0715 8.39045L10.2994 9.54319C9.93919 9.65327 9.65327 9.93919 9.54319 10.2994L8.39046 14.0715C8.08007 15.0872 6.66558 15.1637 6.33404 14.1828L3.04536 4.45259Z";

  // 设置并记录原始 Favicon（借鉴 ChatGPT 官方 TAB_FAVICON_BADGE 机制）
  function applyTabFaviconArrow() {
    try {
      const iconLinks = Array.from(document.querySelectorAll('link[rel~="icon"], link[rel="shortcut icon"]'));
      let originalHref = "";
      if (iconLinks.length > 0) {
        // 若此前已记录过原生 href，优先使用已保存的原生 href
        originalHref = iconLinks[0].dataset.bctlOriginalHref !== undefined
          ? iconLinks[0].dataset.bctlOriginalHref
          : (iconLinks[0].getAttribute("href") || "");
      }

      const svgIcon = `
      <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
        ${originalHref ? `<image href="${originalHref}" width="24" height="24" opacity="0.35" x="0" y="8" />` : ''}
        <path d="${CHATGPT_CURSOR_PATH}" fill="#22c55e" stroke="white" stroke-width="1.8" stroke-linejoin="round" transform="translate(1, 1) scale(1.9)" />
      </svg>`;

      const badgedDataUrl = `data:image/svg+xml,${encodeURIComponent(svgIcon.trim())}`;

      if (iconLinks.length > 0) {
        iconLinks.forEach(l => {
          if (l.dataset.bctlOriginalHref === undefined) {
            l.dataset.bctlOriginalHref = l.getAttribute("href") || "";
          }
          l.dataset.bctlFavicon = "true";
          l.href = badgedDataUrl;
          l.type = "image/svg+xml";
        });
      } else {
        const link = document.createElement("link");
        link.rel = "icon";
        link.type = "image/svg+xml";
        link.href = badgedDataUrl;
        link.dataset.bctlFavicon = "true";
        link.dataset.bctlCreated = "true";
        (document.head || document.documentElement).appendChild(link);
      }
    } catch (e) {
      console.error("[bctl] 设置标签栏光标图标失败:", e);
    }
  }

  // 还原原生 Favicon（借鉴 ChatGPT 官方 Rt() / Pe() 机制）
  function restoreTabFavicon() {
    try {
      const badgedLinks = Array.from(document.querySelectorAll('link[data-bctl-favicon="true"]'));
      badgedLinks.forEach(l => {
        if (l.dataset.bctlCreated === "true") {
          l.remove();
        } else {
          const orig = l.dataset.bctlOriginalHref;
          if (orig) {
            l.href = orig;
          } else {
            l.removeAttribute("href");
          }
          delete l.dataset.bctlOriginalHref;
          delete l.dataset.bctlFavicon;
          delete l.dataset.bctlCreated;
        }
      });
    } catch (e) {
      console.error("[bctl] 还原标签栏图标失败:", e);
    }
  }

// 2. 初始化页面内 Overlay 与光标
function ensureOverlay() {
  if (overlayRoot && document.documentElement.contains(overlayRoot)) return;

  overlayRoot = document.createElement("div");
  overlayRoot.id = "bctl-agent-overlay-root";
  overlayRoot.style.cssText = `
    position: fixed; inset: 0; z-index: 2147483646;
    pointer-events: none; overflow: hidden;
  `;

  // 顶部居中 AI 控制状态胶囊指示器
  indicatorPill = document.createElement("div");
  indicatorPill.id = "bctl-indicator-pill";
  indicatorPill.innerHTML = `
    <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#22c55e;margin-right:7px;box-shadow:0 0 8px #22c55e;animation:bctlPulse 1.8s infinite;"></span>
    <span>AI Agent 正在控制此标签页</span>
  `;
  indicatorPill.style.cssText = `
    position: fixed; top: 16px; left: 50%; transform: translateX(-50%);
    background: rgba(15, 23, 42, 0.88); backdrop-filter: blur(12px);
    border: 1px solid rgba(255, 255, 255, 0.15); border-radius: 9999px;
    color: #f8fafc; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 12px; font-weight: 500; padding: 6px 14px;
    display: flex; align-items: center; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
    opacity: 0; transition: opacity 0.35s ease, transform 0.35s cubic-bezier(0.16, 1, 0.3, 1);
    z-index: 2147483647;
  `;

  // 鼠标容器
  cursorWrapper = document.createElement("div");
  cursorWrapper.id = "bctl-agent-cursor";
  cursorWrapper.style.cssText = `
    position: absolute; top: 0; left: 0; width: 46px; height: 48px;
    pointer-events: none; will-change: transform;
    transform: translate3d(${cursorX}px, ${cursorY}px, 0);
    opacity: 0; transition: opacity 0.3s ease;
  `;

  // 采用 ChatGPT 官方原生 cursor-chat.png 资源
  cursorImg = document.createElement("img");
  cursorImg.src = chrome.runtime.getURL("images/cursor-chat.png");
  cursorImg.style.cssText = `
    width: 32px; height: 33px; display: block;
    filter: drop-shadow(0 4px 12px rgba(34, 197, 94, 0.45));
    transform-origin: 0 0;
  `;

  cursorWrapper.appendChild(cursorImg);
  overlayRoot.appendChild(indicatorPill);
  overlayRoot.appendChild(cursorWrapper);
  document.documentElement.appendChild(overlayRoot);

  if (!document.getElementById("bctl-style-rules")) {
    const style = document.createElement("style");
    style.id = "bctl-style-rules";
    style.textContent = `
      @keyframes bctlPulse {
        0%, 100% { transform: scale(1); opacity: 1; }
        50% { transform: scale(1.3); opacity: 0.65; }
      }
      @keyframes bctlRipple {
        0% { transform: scale(0.3); opacity: 1; }
        100% { transform: scale(2.6); opacity: 0; }
      }
      .bctl-badge-overlay {
        position: fixed; z-index: 2147483645;
        background: #2563eb; color: #fff; font-size: 11px; font-weight: bold;
        padding: 1px 5px; border-radius: 4px; pointer-events: none;
        box-shadow: 0 2px 6px rgba(0,0,0,0.3); font-family: monospace;
      }
    `;
    document.head.appendChild(style);
  }
}

// 隐藏控制状态：平滑淡出胶囊与光标，精准恢复原生 Tab 图标（严格对齐 ChatGPT 官方规范）
function hideControlState() {
  isControlling = false;
  if (indicatorPill) indicatorPill.style.opacity = "0";
  if (cursorWrapper) cursorWrapper.style.opacity = "0";
  restoreTabFavicon();
}

// 激活控制状态：同时在页面内和原生 Tab 栏亮起光标指示
function showControlState() {
  ensureOverlay();
  applyTabFaviconArrow();
  isControlling = true;
  if (indicatorPill) indicatorPill.style.opacity = "1";
  if (cursorWrapper) cursorWrapper.style.opacity = "1";

  // 初始置于屏幕正中央
  cursorX = window.innerWidth / 2;
  cursorY = window.innerHeight / 2;
  cursorWrapper.style.transform = `translate3d(${cursorX}px, ${cursorY}px, 0)`;
}

// 借鉴 ChatGPT 人类接管监听：如果人类主动在页面上发生交互（isTrusted 原生鼠标按下），立即解除控制态
window.addEventListener("mousedown", (e) => {
  if (e.isTrusted && isControlling) {
    hideControlState();
  }
}, { capture: true, passive: true });

// 3. 弹簧物理学模型 (Spring Physics)
// 3. 弹簧物理学模型 (Spring Physics)
function springMoveTo(toX, toY, duration = 380) {
  showControlState();
  cursorX = toX;
  cursorY = toY;
  if (cursorWrapper) {
    cursorWrapper.style.transform = `translate3d(${cursorX}px, ${cursorY}px, 0)`;
  }

  // 关键防死锁：若当前标签页处于后台（document.hidden 为 true），Chrome 会挂起 requestAnimationFrame！
  // 此时跳过视觉插帧动画直接完成，彻底解决后台多标签并发时 25 秒超时的致命 Bug！
  if (document.hidden) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const startX = cursorX;
    const startY = cursorY;
    const startTime = performance.now();

    const dx = toX - startX;
    const dy = toY - startY;
    const dist = Math.hypot(dx, dy);
    const ctrlOffset = Math.min(dist * 0.18, 60);
    const ctrlX = (startX + toX) / 2 + (dy > 0 ? -ctrlOffset : ctrlOffset);
    const ctrlY = (startY + toY) / 2 + (dx > 0 ? ctrlOffset : -ctrlOffset);

    const baseAngle = Math.atan2(dy, dx) * (180 / Math.PI);
    const tilt = Math.max(-18, Math.min(18, (baseAngle - 45) * 0.25));

    function step(now) {
      const elapsed = now - startTime;
      const t = Math.min(elapsed / duration, 1);
      const ease = 1 - Math.pow(1 - t, 4);

      const inv = 1 - ease;
      cursorX = inv * inv * startX + 2 * inv * ease * ctrlX + ease * ease * toX;
      cursorY = inv * inv * startY + 2 * inv * ease * ctrlY + ease * ease * toY;

      const speedScale = t < 0.85 ? 1 + Math.sin(t * Math.PI) * 0.08 : 1;
      const currentTilt = t < 0.9 ? tilt * Math.sin(t * Math.PI) : 0;

      cursorWrapper.style.transform = `translate3d(${cursorX}px, ${cursorY}px, 0)`;
      cursorImg.style.transform = `rotate(${currentTilt}deg) scale(${speedScale})`;

      if (t < 1) {
        requestAnimationFrame(step);
      } else {
        cursorImg.style.transform = "rotate(0deg) scale(1)";
        resolve();
      }
    }

    requestAnimationFrame(step);
  });
}

function playRipple(x, y) {
  if (document.hidden) return;
  const ripple = document.createElement("div");
  ripple.style.cssText = `
    position: fixed; left: ${x - 18}px; top: ${y - 18}px; width: 36px; height: 36px;
    border-radius: 50%; border: 2.5px solid #22c55e; background: rgba(34, 197, 94, 0.28);
    z-index: 2147483646; pointer-events: none; animation: bctlRipple 0.42s cubic-bezier(0, 0, 0.2, 1) forwards;
  `;
  document.documentElement.appendChild(ripple);
  setTimeout(() => ripple.remove(), 450);
}

// 4. React / Vue 受控输入框原生穿透
async function humanType(el, text) {
  el.focus();
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const nativeSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set;

  if (nativeSetter) nativeSetter.call(el, "");
  else el.value = "";
  el.dispatchEvent(new Event("input", { bubbles: true }));

  let current = "";
  for (const ch of text) {
    current += ch;
    if (nativeSetter) nativeSetter.call(el, current);
    else el.value = current;
    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: ch, inputType: "insertText" }));
    if (!document.hidden) {
      await new Promise((r) => setTimeout(r, 22));
    }
  }
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

async function moveToElement(el) {
  let rect = el.getBoundingClientRect();
  if (rect.top < 20 || rect.bottom > window.innerHeight - 20) {
    el.scrollIntoView({ behavior: document.hidden ? "instant" : "smooth", block: "center" });
    await new Promise((r) => setTimeout(r, document.hidden ? 50 : 350));
    rect = el.getBoundingClientRect();
  }
  const targetX = rect.left + Math.min(rect.width / 2, 80);
  const targetY = rect.top + rect.height / 2;
  await springMoveTo(targetX, targetY);
  return { targetX, targetY };
}

// --- 视口与数据感知工具函数 ---
function isInViewport(el) {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  return (
    rect.bottom > 0 &&
    rect.top < window.innerHeight &&
    rect.right > 0 &&
    rect.left < window.innerWidth
  );
}

function canElementScroll(el, dy) {
  if (!el || el === document.body || el === document.documentElement) return false;
  if (el.scrollHeight <= el.clientHeight + 2 || el.clientWidth < 50) return false;
  if (dy > 0 && el.scrollTop + el.clientHeight >= el.scrollHeight - 2) return false;
  if (dy < 0 && el.scrollTop <= 1) return false;
  const style = window.getComputedStyle(el);
  return ["auto", "scroll", "overlay"].includes(style.overflowY);
}

function getDeepElementsFromPoint(x, y) {
  const elements = document.elementsFromPoint(x, y) || [];
  const result = [];
  for (const el of elements) {
    result.push(el);
    if (el.shadowRoot && typeof el.shadowRoot.elementsFromPoint === "function") {
      result.push(...el.shadowRoot.elementsFromPoint(x, y));
    }
  }
  return result;
}

function findScrollTarget(px, py, dy) {
  const hitElements = getDeepElementsFromPoint(px, py);
  const visited = new Set();

  for (let current of hitElements) {
    while (current && current !== document.body && current !== document.documentElement) {
      if (visited.has(current)) break;
      visited.add(current);
      if (canElementScroll(current, dy)) {
        return current;
      }
      current = current.parentElement || (current.getRootNode && current.getRootNode().host);
    }
  }

  const rootScroller = document.scrollingElement || document.documentElement;
  if (
    rootScroller.scrollHeight > window.innerHeight + 2 &&
    ((dy > 0 && rootScroller.scrollTop + window.innerHeight < rootScroller.scrollHeight - 2) ||
     (dy < 0 && rootScroller.scrollTop > 1))
  ) {
    return rootScroller;
  }

  const candidates = [];
  const allContainers = document.querySelectorAll("div, main, section, article, ul, tbody");
  for (const el of allContainers) {
    if (canElementScroll(el, dy)) {
      const rect = el.getBoundingClientRect();
      if (rect.bottom > 0 && rect.top < window.innerHeight && rect.width > 150) {
        candidates.push({ el, area: rect.width * rect.height });
      }
    }
  }
  candidates.sort((a, b) => b.area - a.area);
  return candidates.length > 0 ? candidates[0].el : rootScroller;
}

function extractVisibleDashboardData() {
  const lines = [];

  // A. 抓取当前视口可见的表格行 (兼容 AntD Table / 原生 Table / 常见前端虚拟表格)
  const rows = document.querySelectorAll("tr, .ant-table-row, [role='row']");
  for (const row of rows) {
    if (!isInViewport(row)) continue;
    const cells = Array.from(row.querySelectorAll("th, td, .ant-table-cell, [role='cell'], [role='columnheader']"))
      .map(c => (c.innerText || "").replace(/\s+/g, " ").trim())
      .filter(Boolean);
    if (cells.length >= 2) {
      lines.push(`[表格行] ${cells.join(" | ")}`);
    }
    if (lines.length >= 35) break;
  }

  // B. 抓取大盘面板标题与统计卡片数值 (兼容 Nightingale / AntD Statistic / 常见图表卡片)
  const panels = document.querySelectorAll(
    ".n9e-dashboard-panel-header, .n9e-dashboard-panel-title, .ant-statistic, .ant-card-head-title, .panel-title, .chart-title"
  );
  for (const panel of panels) {
    if (!isInViewport(panel)) continue;
    const text = (panel.innerText || "").replace(/\s+/g, " ").trim();
    if (text && text.length < 120) {
      lines.push(`[面板指标] ${text}`);
    }
    if (lines.length >= 50) break;
  }

  // C. 抓取代码/Token/敏感凭据展示块
  const tokens = document.querySelectorAll("code, clipboard-copy, .token, [data-copy-text], #new-oauth-token");
  for (const t of tokens) {
    if (!isInViewport(t)) continue;
    const val = t.getAttribute("value") || t.getAttribute("data-copy-text") || t.innerText;
    if (val && val.trim().length >= 8) {
      lines.push(`[凭据/Token] ${val.trim()}`);
    }
  }

  return lines.length > 0
    ? "\n--- 当前视口可见数据摘要 ---\n" + lines.join("\n")
    : "";
}

// 扫描页面并渲染数字角标
function scanElements() {
  document.querySelectorAll(".bctl-badge-overlay").forEach(b => b.remove());
  const selector = 'a, button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [onclick]';
  const elements = Array.from(document.querySelectorAll(selector)).filter((el) => {
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return rect.width > 4 && rect.height > 4 && style.visibility !== "hidden" && style.display !== "none" && isInViewport(el);
  });

  window._bctlElements = elements;
  const lines = [`当前页面: ${document.title} (${location.href})`];

  elements.slice(0, 100).forEach((el, i) => {
    const rect = el.getBoundingClientRect();
    const badge = document.createElement("div");
    badge.className = "bctl-badge-overlay";
    badge.textContent = i;
    badge.style.left = `${Math.max(0, rect.left - 4)}px`;
    badge.style.top = `${Math.max(0, rect.top - 8)}px`;
    document.documentElement.appendChild(badge);
    setTimeout(() => badge.remove(), 2600);

    const tag = el.tagName.toLowerCase();
    const type = el.getAttribute("type") ? `:${el.getAttribute("type")}` : "";
    const label = (el.innerText || el.placeholder || el.value || el.getAttribute("aria-label") || el.title || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 40);
    lines.push(`[${i}] <${tag}${type}> ${label}`);
  });

  const dataSummary = extractVisibleDashboardData();
  if (dataSummary) lines.push(dataSummary);

  return lines.join("\n");
}

// --- 5. 监听来自 Background 的请求 ---
  const messageListener = (req, sender, sendResponse) => {
  // 关键防死锁：优先同步响应 ping 请求！
  if (req.action === "ping") {
    sendResponse({ ok: true, pong: true });
    return false;
  }

  // 主动解除或隐藏控制态
  if (req.action === "hide_control_state" || req.action === "release") {
    hideControlState();
    sendResponse({ ok: true });
    return false;
  }

  (async () => {
    try {
      if (req.action === "show_control_state") {
        showControlState();
        sendResponse({ ok: true });
      } else if (req.action === "look") {
        showControlState();
        sendResponse(scanElements());
      } else if (req.action === "act") {
        showControlState();
        const actions = req.payload.actions || [];
        const logs = [];

        for (const act of actions) {
          const { type, id, text, key, direction } = act;

          if (type === "click") {
            const el = window._bctlElements?.[id];
            if (!el) { logs.push(`未找到元素 [${id}]`); continue; }
            const { targetX, targetY } = await moveToElement(el);
            playRipple(targetX, targetY);
            el.focus();
            el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: targetX, clientY: targetY }));
            el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: targetX, clientY: targetY }));
            el.click();
            logs.push(`点击 [${id}]`);
          } else if (type === "type") {
            const el = window._bctlElements?.[id];
            if (!el) { logs.push(`未找到输入框 [${id}]`); continue; }
            const { targetX, targetY } = await moveToElement(el);
            playRipple(targetX, targetY);
            await humanType(el, text || "");
            logs.push(`在 [${id}] 输入 "${text}"`);
          } else if (type === "press") {
            const k = key || "Enter";
            const active = document.activeElement || document.body;
            active.dispatchEvent(new KeyboardEvent("keydown", { key: k, code: k, bubbles: true }));
            active.dispatchEvent(new KeyboardEvent("keyup", { key: k, code: k, bubbles: true }));
            if (k === "Enter" && active.form) active.form.requestSubmit?.();
            logs.push(`按键 ${k}`);
          } else if (type === "scroll") {
            let dy = 500;
            if (typeof act.deltaY === "number" && !Number.isNaN(act.deltaY)) {
              dy = act.deltaY;
            } else if (direction === "up" || act.direction === "up") {
              dy = -500;
            } else if (direction === "down" || act.direction === "down") {
              dy = 500;
            }

            const px = typeof act.x === "number" ? act.x : Math.round(window.innerWidth / 2);
            const py = typeof act.y === "number" ? act.y : Math.round(window.innerHeight / 2);
            const dirLabel = dy >= 0 ? "向下" : "向上";

            const target = findScrollTarget(px, py, dy);
            const beforeTop = target.scrollTop;

            // 1. 强制使用 instant 同步滚动，消除 smooth 动画导致的后续 look 读取竞态
            target.scrollBy({ top: dy, behavior: "instant" });
            const actualMoved = Math.round(target.scrollTop - beforeTop);

            // 2. 若原生 scrollTop 未发生改变（如纯虚拟列表 rc-virtual-list 或已触底），补发可取消的 WheelEvent
            if (Math.abs(actualMoved) < 1) {
              const wheelTarget = document.elementFromPoint(px, py) || target;
              wheelTarget.dispatchEvent(
                new WheelEvent("wheel", {
                  deltaY: dy,
                  clientX: px,
                  clientY: py,
                  deltaMode: 0,
                  bubbles: true,
                  cancelable: true
                })
              );
            } else {
              target.dispatchEvent(new Event("scroll", { bubbles: true }));
            }

            // 3. 等待 120ms 让 React / AntD Table / ECharts 完成虚拟 DOM 渲染
            await new Promise(resolve => setTimeout(resolve, 120));

            // 4. 生成面向大模型防死循环的闭环状态回显
            const maxScroll = Math.max(0, target.scrollHeight - target.clientHeight);
            const currentTop = Math.round(target.scrollTop);
            const tagDesc = `${target.tagName.toLowerCase()}${target.className && typeof target.className === "string" ? "." + target.className.trim().split(/\s+/)[0] : ""}`;

            if (Math.abs(actualMoved) >= 1) {
              const progress = maxScroll > 0 ? Math.min(100, Math.round((currentTop / maxScroll) * 100)) : 100;
              logs.push(
                `[Scroll 成功] 容器(${tagDesc}) ${dirLabel}实际滚动 ${Math.abs(actualMoved)}px | 当前位置: ${currentTop}/${maxScroll}px (${progress}%)`
              );
            } else {
              logs.push(
                `[Scroll 边界提示] 容器(${tagDesc})未发生物理位移(当前位置: ${currentTop}/${maxScroll}px)，已到达${dy >= 0 ? "底部" : "顶部"}或该区域为固定视图，请勿重复向同方向滚动，可直接读取当前页面数据。`
              );
            }
          } else if (type === "wait") {
            await new Promise(r => setTimeout(r, 1000));
          }
          await new Promise(r => setTimeout(r, 250));
        }

        await new Promise(r => setTimeout(r, 300));
        sendResponse(`执行结果: ${logs.join(" -> ")}\n\n${scanElements()}`);
      }
    } catch (err) {
      sendResponse(`执行出错: ${err.message}`);
    }
  })();
  return true;
};

  chrome.runtime.onMessage.addListener(messageListener);
  window.__bctl_message_listener__ = messageListener;
})();

