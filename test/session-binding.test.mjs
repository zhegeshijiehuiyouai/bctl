import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const backgroundSource = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
const sectionStart = backgroundSource.indexOf("// ─── 多会话绑定逻辑 (SESSION-BINDINGS BEGIN) ───");
const sectionEnd = backgroundSource.indexOf("// ─── 多会话绑定逻辑 (SESSION-BINDINGS END) ───");
assert.ok(sectionStart >= 0 && sectionEnd > sectionStart, "session binding section must be present");
const sectionSource = backgroundSource.slice(sectionStart, sectionEnd).trim();

const CONTROL_TIMEOUT_MS = 2 * 60 * 60 * 1000;

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function createBindingsApi(initial = {}) {
  const store = new Map(Object.entries(initial).map(([key, value]) => [key, clone(value)]));
  const chrome = {
    storage: {
      session: {
        async get(keys) {
          const list = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const key of list) if (store.has(key)) out[key] = clone(store.get(key));
          return out;
        },
        async set(items) {
          for (const [key, value] of Object.entries(items)) store.set(key, clone(value));
        },
        async remove(keys) {
          for (const key of (Array.isArray(keys) ? keys : [keys])) store.delete(key);
        }
      }
    }
  };
  const context = vm.createContext({ chrome, CONTROL_TIMEOUT_MS, console });
  const api = vm.runInContext(
    `(() => {\n${sectionSource}\nreturn {
      DEFAULT_SESSION_ID,
      normalizeSessionId,
      sanitizeBindings,
      readSessionBindings,
      bindSessionTab,
      clearSessionBinding,
      getBoundTabId,
      getBindingOwner,
      touchSession,
      takeStaleBindings,
      removeTabBindings,
      listBoundTabs,
      enqueueSessionTask
    };\n})()`,
    context
  );
  return { api, store };
}

test("normalizeSessionId trims control characters and falls back to the default session", () => {
  const { api } = createBindingsApi();
  assert.equal(api.normalizeSessionId("  codex:thread-1\u0007 "), "codex:thread-1");
  assert.equal(api.normalizeSessionId(""), api.DEFAULT_SESSION_ID);
  assert.equal(api.normalizeSessionId(null), api.DEFAULT_SESSION_ID);
  assert.equal(api.normalizeSessionId("x".repeat(400)).length, 160);
});

test("two agents bind different tabs without touching each other", async () => {
  const { api } = createBindingsApi();
  await api.bindSessionTab("codex:thread-a", 101);
  await api.bindSessionTab("claude:session-b", 202);

  assert.equal(await api.getBoundTabId("codex:thread-a"), 101);
  assert.equal(await api.getBoundTabId("claude:session-b"), 202);
  assert.equal(await api.getBindingOwner(202, "codex:thread-a"), "claude:session-b");
  assert.equal(await api.getBindingOwner(101, "codex:thread-a"), null);
});

test("the same tool opened twice gets two independent sessions", async () => {
  const { api } = createBindingsApi();
  await api.bindSessionTab("codex:thread-1", 11);
  await api.bindSessionTab("codex:thread-2", 22);

  assert.equal(await api.getBoundTabId("codex:thread-1"), 11);
  assert.equal(await api.getBoundTabId("codex:thread-2"), 22);

  await api.clearSessionBinding("codex:thread-1");
  assert.equal(await api.getBoundTabId("codex:thread-1"), null);
  assert.equal(await api.getBoundTabId("codex:thread-2"), 22);
});

test("unbind only releases the calling session", async () => {
  const { api } = createBindingsApi();
  await api.bindSessionTab("agent-a", 5);
  await api.bindSessionTab("agent-b", 6);

  assert.equal(await api.clearSessionBinding("agent-a"), 5);
  assert.equal(await api.clearSessionBinding("agent-a"), null);
  assert.equal(await api.getBoundTabId("agent-b"), 6);
});

test("rebinding a session releases its previous tab reference", async () => {
  const { api } = createBindingsApi();
  await api.bindSessionTab("agent-a", 5);
  assert.equal(await api.bindSessionTab("agent-a", 9), 5);
  assert.equal(await api.getBoundTabId("agent-a"), 9);
});

test("closing a tab clears every session bound to it", async () => {
  const { api } = createBindingsApi();
  await api.bindSessionTab("agent-a", 7);
  await api.bindSessionTab("agent-b", 7);

  assert.deepEqual(Array.from(await api.removeTabBindings(7)).sort(), ["agent-a", "agent-b"]);
  assert.equal(await api.getBoundTabId("agent-a"), null);
  assert.equal(await api.getBoundTabId("agent-b"), null);
});

test("legacy single-tab binding migrates into the default session", async () => {
  const { api, store } = createBindingsApi({ boundTabId: 77, lastActivityTime: 1_700_000_000_000 });
  assert.equal(await api.getBoundTabId("default"), 77);
  assert.equal(store.has("boundTabId"), false);
  assert.equal(store.has("lastActivityTime"), false);
});

test("stale bindings expire per session while fresh ones survive", async () => {
  const now = 10_000_000;
  const { api } = createBindingsApi({
    sessionBindings: {
      "agent-old": { tabId: 1, lastActivity: now - CONTROL_TIMEOUT_MS - 1 },
      "agent-new": { tabId: 2, lastActivity: now - 1000 }
    }
  });

  const expired = Array.from(await api.takeStaleBindings(now, CONTROL_TIMEOUT_MS), entry => ({ ...entry }));
  assert.deepEqual(expired, [{ sessionId: "agent-old", tabId: 1 }]);
  assert.equal(await api.getBoundTabId("agent-old"), null);
  assert.equal(await api.getBoundTabId("agent-new"), 2);
});

test("commands from one session run in order while another session runs in parallel", async () => {
  const { api } = createBindingsApi();
  const order = [];
  const first = api.enqueueSessionTask("agent-a", async () => {
    order.push("a1-start");
    await new Promise(resolve => setTimeout(resolve, 20));
    order.push("a1-end");
  });
  const second = api.enqueueSessionTask("agent-a", async () => {
    order.push("a2");
  });
  const other = api.enqueueSessionTask("agent-b", async () => {
    order.push("b");
  });

  await Promise.all([first, second, other]);
  assert.deepEqual(order, ["a1-start", "b", "a1-end", "a2"]);
});

test("a failed command does not block the rest of its session queue", async () => {
  const { api } = createBindingsApi();
  const failed = api.enqueueSessionTask("agent-a", async () => {
    throw new Error("boom");
  });
  let ran = false;
  const next = api.enqueueSessionTask("agent-a", async () => {
    ran = true;
  });

  await assert.rejects(failed, /boom/);
  await next;
  assert.equal(ran, true);
});