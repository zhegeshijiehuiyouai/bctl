import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { makeExtension, makeDaemon, deferred, flush } from "../test-support/browser-bridge.mjs";

const bind = (extension, sessionId, target = 101, force = false) => extension.send("bind", { sessionId, target, force });
const act = (sessionId, text) => ({ sessionId, actions: [{ type: "type", id: 0, text }] });
const actTexts = extension => extension.messages.filter(message => message.action === "act").map(message => message.payload.actions[0].text);

test("simultaneous bind RPCs have one winner without force", async () => {
  const extension = await makeExtension();
  const replies = await Promise.all([bind(extension, "agent-a"), bind(extension, "agent-b")]);
  assert.equal(replies.filter(reply => reply.result?.includes("已成功绑定")).length, 1);
  assert.equal(replies.filter(reply => reply.code === "BCTL_SESSION_CONFLICT").length, 1);
  assert.equal(Object.keys(extension.store.sessionBindings).length, 1);
});

test("a rejected bind is a protocol failure and does not redirect the caller's next action", async () => {
  const extension = await makeExtension();
  const daemon = makeDaemon(extension);
  await daemon.request("bind", { sessionId: "agent-a", target: 101 });
  await daemon.request("bind", { sessionId: "agent-b", target: 202 });

  const rejected = await daemon.request("bind", { sessionId: "agent-a", target: 202 });
  assert.equal(rejected.status, 500);
  assert.equal(rejected.body.code, "BCTL_SESSION_CONFLICT");

  const acted = await daemon.request("act", act("agent-a", "stay on owned tab"));
  assert.equal(acted.status, 200);
  assert.equal(extension.messages.find(message => message.action === "act").tabId, 101);
});

test("missing and ambiguous bind targets fail instead of returning success", async () => {
  const extension = await makeExtension();
  const daemon = makeDaemon(extension);

  const missing = await daemon.request("bind", { sessionId: "agent-a", target: 999 });
  assert.equal(missing.status, 500);
  assert.equal(missing.body.code, "BCTL_TARGET_NOT_FOUND");

  const ambiguous = await daemon.request("bind", { sessionId: "agent-a", target: "example.test" });
  assert.equal(ambiguous.status, 500);
  assert.equal(ambiguous.body.code, "BCTL_TARGET_AMBIGUOUS");
});

test("force revokes old access and old unbind cannot alter the new owner's tab", async () => {
  const extension = await makeExtension();
  await bind(extension, "agent-a");
  await bind(extension, "agent-b", 101, true);
  assert.equal(extension.store.sessionBindings["agent-a"], undefined);
  await extension.send("act", act("agent-a", "old"));
  const before = extension.updates.length;
  await extension.send("unbind", { sessionId: "agent-a" });
  assert.equal(extension.updates.length, before);
  await extension.send("act", act("agent-b", "new"));
  assert.deepEqual(actTexts(extension), ["new"]);
});

test("force waits for an in-flight action and blocks the previous owner's queued action", async () => {
  const gate = deferred(), started = deferred();
  const extension = await makeExtension({ onMessage: async message => {
    if (message.action === "act" && message.payload.actions[0].text === "first") {
      started.resolve();
      await gate.promise;
    }
    return "ok";
  } });
  await bind(extension, "agent-a");
  const first = extension.send("act", act("agent-a", "first"));
  await started.promise;
  const takeover = bind(extension, "agent-b", 101, true);
  await flush();
  const next = extension.send("act", act("agent-a", "second"));
  assert.equal(extension.store.sessionBindings["agent-b"], undefined);
  gate.resolve();
  await Promise.all([first, takeover, next]);
  assert.deepEqual(actTexts(extension), ["first"]);
  assert.equal(extension.store.sessionBindings["agent-a"], undefined);
  assert.equal(extension.store.sessionBindings["agent-b"].tabId, 101);
});

test("different sessions on different tabs still execute in parallel", async () => {
  const gate = deferred(), started = deferred();
  const extension = await makeExtension({ onMessage: async (message, tabId) => {
    if (message.action === "act" && tabId === 101) { started.resolve(); await gate.promise; }
    return "ok";
  } });
  await bind(extension, "agent-a", 101);
  await bind(extension, "agent-b", 202);
  const first = extension.send("act", act("agent-a", "first"));
  await started.promise;
  await extension.send("act", act("agent-b", "second"));
  assert.deepEqual(actTexts(extension), ["first", "second"]);
  gate.resolve();
  await first;
});

test("unbound look and probe cannot access another session's active tab", async () => {
  const extension = await makeExtension();
  await bind(extension, "owner");
  for (const action of ["look", "probe"]) {
    const result = await extension.send(action, { sessionId: "reader" });
    assert.match(result.error, /会话隔离拦截/);
  }
  assert.equal(extension.messages.filter(message => message.action === "look").length, 0);
  assert.equal(extension.scripts.length, 0);
});

test("unbound look remains available on an unclaimed active tab", async () => {
  const extension = await makeExtension();
  const reply = await extension.send("look", { sessionId: "reader" });
  assert.equal(reply.result, "ok");
  assert.equal(extension.messages.find(message => message.action === "look").tabId, 101);
});

test("eval and state require an explicitly bound tab", async () => {
  const extension = await makeExtension();
  const daemon = makeDaemon(extension);
  for (const [action, payload] of [
    ["eval", { sessionId: "writer", code: "window.changed = true" }],
    ["state", { sessionId: "writer", text: "changed" }]
  ]) {
    const reply = await daemon.request(action, payload);
    assert.equal(reply.status, 500);
    assert.equal(reply.body.code, "BCTL_BINDING_REQUIRED");
    assert.match(reply.body.error, /安全拦截/);
  }
  assert.equal(extension.scripts.length, 0);
  assert.equal(extension.messages.length, 0);
});

test("terminal mutation aliases require the same explicit binding as canonical actions", async () => {
  const extension = await makeExtension();
  const daemon = makeDaemon(extension);
  for (const action of ["term_switch", "subswitch", "term_connect", "jump"]) {
    const reply = await daemon.request(action, { sessionId: "writer", target: "first" });
    assert.equal(reply.status, 500);
    assert.equal(reply.body.code, "BCTL_BINDING_REQUIRED");
  }
  assert.equal(extension.scripts.length, 0);
  assert.equal(extension.messages.length, 0);
});

test("fallback ownership is rechecked after waiting for the tab lock", async () => {
  const gate = deferred();
  const extension = await makeExtension();
  extension.context.hold = gate.promise;
  const holding = vm.runInContext('enqueueTabTask(101, async () => { await hold; await bindSessionTab("owner", 101); })', extension.context);
  const reading = extension.send("look", { sessionId: "reader" });
  await flush();
  gate.resolve();
  await holding;
  const result = await reading;
  assert.match(result.error, /归属已变化/);
  assert.equal(extension.messages.filter(message => message.action === "look").length, 0);
});

test("cold concurrent tabs and bind share one storage load and preserve the binding", async () => {
  const gate = deferred();
  let reads = 0;
  const extension = await makeExtension({ onGet: async () => { reads++; await gate.promise; } });
  const listing = extension.send("tabs", { sessionId: "reader" });
  await flush();
  const binding = bind(extension, "owner");
  await flush();
  assert.equal(reads, 1);
  gate.resolve();
  await Promise.all([listing, binding]);
  assert.equal(extension.store.sessionBindings.owner.tabId, 101);
});

test("failed storage initialization can retry without publishing stale cache", async () => {
  let reads = 0;
  const extension = await makeExtension({ onGet() { if (++reads === 1) throw new Error("temporary storage failure"); } });
  assert.match((await bind(extension, "owner")).error, /temporary storage failure/);
  assert.match((await bind(extension, "owner")).result, /已成功绑定/);
  assert.equal(reads, 2);
});

test("a failed persisted claim leaves the existing owner intact", async () => {
  let fail = false;
  const extension = await makeExtension({ onSet() { if (fail) throw new Error("write failed"); } });
  await bind(extension, "agent-a");
  fail = true;
  assert.match((await bind(extension, "agent-b", 101, true)).error, /write failed/);
  fail = false;
  await extension.send("act", act("agent-a", "still owner"));
  assert.deepEqual(actTexts(extension), ["still owner"]);
  assert.equal(extension.store.sessionBindings["agent-b"], undefined);
});

for (const dropCancel of [false, true]) {
  test(`expired queued RPC is never executed (cancel ${dropCancel ? "lost" : "delivered"})`, async () => {
    const gate = deferred(), started = deferred();
    const extension = await makeExtension({ onMessage: async message => {
      if (message.action === "act" && message.payload.actions[0].text === "first") { started.resolve(); await gate.promise; }
      return "ok";
    } });
    await bind(extension, "owner");
    const daemon = makeDaemon(extension, { dropCancel });
    const first = daemon.request("act", act("owner", "first"));
    await started.promise;
    const second = daemon.request("act", act("owner", "second"));
    await flush();
    await extension.clock.advance(25000);
    const timedOut = await Promise.all([first, second]);
    assert.ok(timedOut.every(result => result.status === 500));
    assert.match(timedOut[0].body.error, /操作已经开始，结果未知/);
    assert.equal(daemon.sent.filter(message => message.type === "cancel").length, 2);
    assert.equal(daemon.pendingCount(), 0);
    gate.resolve();
    await flush();
    assert.deepEqual(actTexts(extension), ["first"]);
    const next = await daemon.request("act", act("owner", "third"));
    assert.equal(next.status, 200);
    assert.deepEqual(actTexts(extension), ["first", "third"]);
    assert.equal(daemon.pendingCount(), 0);
    assert.equal([...extension.clock.timers.values()].filter(timer => timer.delay === 25000).length, 0);
  });
}

test("cancel bypasses a busy session queue even before its deadline", async () => {
  const gate = deferred(), started = deferred();
  const extension = await makeExtension({ onMessage: async message => {
    if (message.action === "act" && message.payload.actions[0].text === "first") { started.resolve(); await gate.promise; }
    return "ok";
  } });
  await bind(extension, "owner");
  const first = extension.send("act", act("owner", "first"));
  await started.promise;
  const second = extension.dispatch("act", act("owner", "second"), { expiresAt: extension.clock.now + 60000 });
  extension.cancel(second.id);
  gate.resolve();
  await first;
  assert.equal((await second.promise).code, "BCTL_REQUEST_EXPIRED");
  assert.deepEqual(actTexts(extension), ["first"]);
});

test("force that expires waiting for the tab cannot steal ownership", async () => {
  const gate = deferred(), started = deferred();
  const extension = await makeExtension({ onMessage: async message => {
    if (message.action === "act") { started.resolve(); await gate.promise; }
    return "ok";
  } });
  await bind(extension, "agent-a");
  const first = extension.send("act", act("agent-a", "first"));
  await started.promise;
  const takeover = extension.send("bind", { sessionId: "agent-b", target: 101, force: true }, { expiresAt: extension.clock.now + 100 });
  await extension.clock.advance(100);
  gate.resolve();
  await first;
  assert.equal((await takeover).code, "BCTL_REQUEST_EXPIRED");
  assert.equal(extension.store.sessionBindings["agent-a"].tabId, 101);
  assert.equal(extension.store.sessionBindings["agent-b"], undefined);
});

test("force that expires waiting for binding storage cannot steal ownership", async () => {
  const gate = deferred(), started = deferred();
  let block = false;
  const extension = await makeExtension({ onSet: async () => {
    if (!block) return;
    block = false;
    started.resolve();
    await gate.promise;
  } });
  await bind(extension, "agent-a", 101);
  await bind(extension, "agent-b", 202);

  block = true;
  const storageTask = vm.runInContext('touchSession("agent-b")', extension.context);
  await started.promise;
  const takeover = extension.dispatch("bind", { sessionId: "agent-c", target: 101, force: true }, {
    expiresAt: extension.clock.now + 100
  });
  await flush();
  await extension.clock.advance(100);
  extension.cancel(takeover.id);

  gate.resolve();
  await storageTask;
  assert.equal((await takeover.promise).code, "BCTL_RESULT_UNKNOWN");
  assert.equal(extension.store.sessionBindings["agent-a"].tabId, 101);
  assert.equal(extension.store.sessionBindings["agent-c"], undefined);
});

test("disconnect rejects pending RPCs and prevents queued commands from executing", async () => {
  const gate = deferred(), started = deferred();
  const extension = await makeExtension({ onMessage: async message => {
    if (message.action === "act" && message.payload.actions[0].text === "first") { started.resolve(); await gate.promise; }
    return "ok";
  } });
  await bind(extension, "owner");
  const daemon = makeDaemon(extension);
  const first = daemon.request("act", act("owner", "first"));
  await started.promise;
  const second = daemon.request("act", act("owner", "second"));
  daemon.disconnect();
  const replies = await Promise.all([first, second]);
  assert.ok(replies.every(reply => reply.body.code === "BCTL_RESULT_UNKNOWN"));
  assert.equal(daemon.pendingCount(), 0);
  gate.resolve();
  await flush();
  assert.deepEqual(actTexts(extension), ["first"]);
});

test("extension execution errors produce HTTP failure rather than success", async () => {
  const extension = await makeExtension();
  await bind(extension, "owner");
  const daemon = makeDaemon(extension);
  const reply = await daemon.request("look", { sessionId: "reader" });
  assert.equal(reply.status, 500);
  assert.match(reply.body.error, /会话隔离拦截/);
});

test("simultaneous forced swaps do not deadlock or release the new owner's tabs", async () => {
  const extension = await makeExtension();
  await bind(extension, "agent-a", 101);
  await bind(extension, "agent-b", 202);
  const before = extension.updates.length;
  await Promise.all([bind(extension, "agent-a", 202, true), bind(extension, "agent-b", 101, true)]);
  assert.equal(extension.store.sessionBindings["agent-a"].tabId, 202);
  assert.equal(extension.store.sessionBindings["agent-b"].tabId, 101);
  assert.equal(extension.updates.slice(before).filter(update => update.autoDiscardable === true).length, 0);
});

test("new opens in the background, transfers the binding and restores the old tab", async () => {
  const extension = await makeExtension();
  await bind(extension, "owner");
  const opened = extension.send("new", { sessionId: "owner", url: "https://example.test/new" });
  await flush();
  await extension.clock.advance(500);
  assert.match((await opened).result, /已在后台打开新标签页 303/);
  assert.equal(extension.store.sessionBindings.owner.tabId, 303);
  assert.ok(extension.updates.some(update => update.id === 101 && update.autoDiscardable === true));
  assert.ok(extension.messages.some(message => message.tabId === 101 && message.action === "hide_control_state"));
  assert.equal((await extension.chrome.tabs.get(303)).active, false);
});

test("new that expires during loading still restores the previous tab", async () => {
  const extension = await makeExtension();
  await bind(extension, "owner");
  const opened = extension.send("new", { sessionId: "owner", url: "https://example.test/new" }, { expiresAt: extension.clock.now + 100 });
  await flush();
  await extension.clock.advance(500);
  assert.equal((await opened).code, "BCTL_RESULT_UNKNOWN");
  assert.equal(extension.store.sessionBindings.owner.tabId, 303);
  assert.ok(extension.updates.some(update => update.id === 101 && update.autoDiscardable === true));
  assert.equal(extension.messages.filter(message => message.action === "look").length, 0);
});

test("status reports the running daemon and connected extension versions", async () => {
  const extension = await makeExtension();
  const daemon = makeDaemon(extension);
  const status = await daemon.request("status", {});
  assert.equal(status.status, 200);
  assert.equal(status.body.extension_connected, true);
  assert.equal(status.body.version, extension.chrome.runtime.getManifest().version);
  assert.equal(status.body.extension_version, status.body.version);
});
