import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import vm from "node:vm";

const backgroundSource = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
const daemonSource = readFileSync(new URL("../bctl.mjs", import.meta.url), "utf8");
const packageVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const extensionVersion = JSON.parse(readFileSync(new URL("../extension/manifest.json", import.meta.url), "utf8")).version;
const daemonStart = daemonSource.indexOf("function startDaemon()");
const daemonEnd = daemonSource.indexOf("// 自动后台拉起守护进程", daemonStart);
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const event = () => {
  const listeners = new Set();
  return { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn), listeners };
};
export const flush = () => new Promise(resolve => setImmediate(resolve));
export function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function makeClock() {
  const clock = { now: 1_800_000_000_000, timers: new Map(), sequence: 0 };
  clock.Date = class extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.now])); }
    static now() { return clock.now; }
  };
  clock.setTimeout = (fn, delay) => {
    const id = ++clock.sequence;
    clock.timers.set(id, { fn, at: clock.now + delay, delay });
    return id;
  };
  clock.clearTimeout = id => clock.timers.delete(id);
  clock.advance = async ms => {
    clock.now += ms;
    for (const [id, timer] of clock.timers) {
      if (timer.at <= clock.now) {
        clock.timers.delete(id);
        timer.fn();
      }
    }
    await flush();
  };
  return clock;
}

export async function makeExtension({ initial = {}, tabs = null, onGet, onSet, onMessage, onScript } = {}) {
  const store = clone(initial), messages = [], scripts = [], updates = [], sent = [], waiters = new Map();
  const clock = makeClock();
  const sockets = [];
  class MockWebSocket {
    static OPEN = 1;
    static CONNECTING = 0;
    constructor() { this.readyState = 1; sockets.push(this); }
    send(raw) {
      if (this.readyState !== 1) throw new Error("socket is closed");
      const msg = JSON.parse(raw);
      sent.push(msg);
      if (Object.hasOwn(msg, "result") || msg.error) waiters.get(msg.id)?.(msg);
    }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  const browserTabs = tabs || [
    { id: 101, title: "first", url: "https://example.test/first", active: true, status: "complete" },
    { id: 202, title: "second", url: "https://example.test/second", active: false, status: "complete" }
  ];
  const chrome = {
    alarms: { create() {}, onAlarm: event() }, runtime: { reload() {}, getManifest: () => ({ version: extensionVersion }) },
    storage: { session: {
      async get(keys) {
        const snapshot = Object.fromEntries(keys.filter(key => key in store).map(key => [key, clone(store[key])]));
        if (onGet) await onGet();
        return snapshot;
      },
      async set(items) { if (onSet) await onSet(items); Object.assign(store, clone(items)); },
      async remove(keys) { for (const key of keys) delete store[key]; }
    } },
    tabs: {
      async query(query) { return clone(browserTabs.filter(tab => !query.active || tab.active)); },
      async get(id) { const tab = browserTabs.find(tab => tab.id === id); if (!tab) throw new Error("tab closed"); return clone(tab); },
      async update(id, properties) { updates.push({ id, ...properties }); Object.assign(browserTabs.find(tab => tab.id === id), properties); },
      async create(properties) { const tab = { id: 303, title: "new", status: "complete", ...properties }; browserTabs.push(tab); return clone(tab); },
      async sendMessage(tabId, msg) {
        messages.push({ tabId, ...clone(msg) });
        if (onMessage) return onMessage(msg, tabId);
        return "ok";
      },
      onActivated: event(), onRemoved: event(), onUpdated: event()
    },
    scripting: { async executeScript(options) { scripts.push(options); return onScript ? onScript(options) : []; } }
  };
  const context = vm.createContext({
    chrome, WebSocket: MockWebSocket, Date: clock.Date, AbortSignal,
    fetch: async () => ({ ok: true }), console: { log() {}, error() {} },
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, setInterval() {}, clearInterval() {}
  });
  vm.runInContext(backgroundSource, context);
  await flush();
  sockets[0].onopen();
  let sequence = 0;
  const socket = () => sockets.at(-1);
  function dispatch(action, payload = {}, extra = {}) {
    const id = "req-" + (++sequence);
    const promise = new Promise(resolve => waiters.set(id, resolve));
    socket().onmessage({ data: JSON.stringify({ id, action, payload, ...extra }) });
    return { id, promise };
  }
  return {
    store, messages, scripts, updates, sent, clock, context, chrome, socket, dispatch,
    send: (action, payload, extra) => dispatch(action, payload, extra).promise,
    cancel: id => socket().onmessage({ data: JSON.stringify({ type: "cancel", id }) }),
    disconnect: () => socket().close()
  };
}

export function makeDaemon(extension, { dropCancel = false } = {}) {
  let handleHttp;
  const server = new EventEmitter(), socket = new EventEmitter(), sent = [];
  socket.readyState = 1;
  socket.send = raw => {
    const msg = JSON.parse(raw);
    sent.push(msg);
    if (dropCancel && msg.type === "cancel") return;
    extension.socket().onmessage({ data: raw });
  };
  const browserSocket = extension.socket();
  const originalSend = browserSocket.send;
  browserSocket.send = raw => { originalSend.call(browserSocket, raw); socket.emit("message", raw); };
  const { clock } = extension;
  const context = vm.createContext({
    http: { createServer(handler) { handleHttp = handler; return { listen() {} }; } },
    WebSocketServer: function () { return server; }, randomUUID, URL, Date: clock.Date, BCTL_VERSION: packageVersion,
    console: { log() {}, error() {} }, process: { exit() {} }, setInterval() {},
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout
  });
  vm.runInContext(`const WS_PORT=9223, HTTP_PORT=9224; let activeSocket=null; const pendingRequests=new Map();\n${daemonSource.slice(daemonStart, daemonEnd)}\nstartDaemon();`, context);
  server.emit("connection", socket);
  browserSocket.onopen();
  function request(action, payload) {
    const req = new EventEmitter();
    req.url = "/" + action;
    const result = new Promise(resolve => {
      handleHttp(req, { statusCode: 200, setHeader() {}, end(body) { resolve({ status: this.statusCode, body: JSON.parse(body) }); } });
    });
    req.emit("data", JSON.stringify(payload));
    req.emit("end");
    return result;
  }
  return {
    request, sent,
    pendingCount: () => vm.runInContext("pendingRequests.size", context),
    disconnect() { socket.readyState = 3; socket.emit("close"); extension.disconnect(); }
  };
}
