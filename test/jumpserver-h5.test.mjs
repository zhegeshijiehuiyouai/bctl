import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const backgroundSource = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
const functionStart = backgroundSource.indexOf("async function executeInWebTerminal(");
const functionEnd = backgroundSource.indexOf("// ─── MAIN 世界 Kibana DevTools", functionStart);
assert.ok(functionStart >= 0 && functionEnd > functionStart, "terminal injection function must be present");
const injectedFunctionSource = backgroundSource.slice(functionStart, functionEnd).trim();

class FakeSVGElement {
  static [Symbol.hasInstance]() { return false; }
}

class FakeHTMLElement {
  static [Symbol.hasInstance](value) { return Boolean(value?.__fakeElement); }
}

function makeXtermElement() {
  return {
    __fakeElement: true,
    tagName: "DIV",
    id: "",
    className: "xterm",
    attrs: {},
    parentElement: null,
    offsetParent: {},
    getAttribute(name) { return this.attrs[name] ?? null; },
    getBoundingClientRect() { return { left: 20, top: 20, right: 600, bottom: 400, width: 580, height: 380 }; },
    querySelectorAll() { return []; },
    closest() { return null; }
  };
}

function makeTerm() {
  const screenLine = "[root@web01 ~]# ";
  const triggered = [];
  const term = {
    cols: 80,
    rows: 24,
    __triggered: triggered,
    buffer: {
      length: 1,
      active: {
        baseY: 0,
        cursorY: 0,
        cursorX: screenLine.length,
        viewportY: 0,
        type: "normal",
        getLine(index) {
          if (index !== 0) return null;
          return { isWrapped: false, length: screenLine.length, translateToString: () => screenLine };
        }
      }
    },
    write() {},
    paste() {},
    _core: { coreService: { triggerDataEvent: (data) => triggered.push(data) } }
  };
  return term;
}

// 模拟 JumpServer H5 (Dva/UmiJS) 的 window.g_app 结构
function makeGApp(term, sent) {
  return {
    _store: {
      getState: () => ({
        operation_global: {
          clientConnections: {
            "conn-1": {
              connectionClient: {
                getCoreObject: () => term,
                sendTerminalData: (data) => sent.push(data)
              }
            }
          }
        }
      })
    }
  };
}

async function runTerminal({ gApp = null, term = makeTerm(), domTerm = null, cmd = "", mode = null, keys = "", discoverOnly = false } = {}) {
  const xtermEl = makeXtermElement();
  if (domTerm) xtermEl._terminal = domTerm;
  const document = {
    activeElement: null,
    querySelector() { return null; },
    querySelectorAll(selector) {
      if (selector.includes(".xterm")) return [xtermEl];
      return [];
    }
  };
  const window = {
    frameElement: null,
    g_app: gApp,
    getComputedStyle() { return { display: "block", visibility: "visible", opacity: "1" }; }
  };
  const context = {
    document,
    window,
    HTMLElement: FakeHTMLElement,
    SVGElement: FakeSVGElement,
    CSS: { escape: value => String(value) },
    innerWidth: 1024,
    innerHeight: 768,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval
  };
  const executeInWebTerminal = vm.runInNewContext(`(${injectedFunctionSource})`, context);
  const interactiveOptions = mode ? { mode, keys, settleMs: 0 } : null;
  const result = await executeInWebTerminal(cmd, 0, mode ? 0 : null, discoverOnly, mode ? "xterm" : null, interactiveOptions);
  return { result, term };
}

test("discovers the terminal exposed through JumpServer H5 g_app and wires its own send channel", async () => {
  const term = makeTerm();
  const sent = [];
  const { result } = await runTerminal({ gApp: makeGApp(term, sent), term, discoverOnly: true });

  assert.equal(result.matched, true);
  assert.equal(result.candidates[0].kind, "xterm");
  assert.equal(typeof term._clientSend, "function");

  term._clientSend("probe");
  assert.deepEqual(sent, ["probe"]);
});

test("key injection on the H5 terminal goes through connectionClient.sendTerminalData", async () => {
  const term = makeTerm();
  const sent = [];
  const { result } = await runTerminal({ gApp: makeGApp(term, sent), term, mode: "key", keys: "<Ctrl-C>" });

  assert.equal(result.ok, true);
  assert.deepEqual(sent, ["\x03"]);
  assert.deepEqual(term.__triggered, []);
});

test("start mode on the H5 terminal sends the command through the same channel", async () => {
  const term = makeTerm();
  const sent = [];
  const { result } = await runTerminal({ gApp: makeGApp(term, sent), term, cmd: "k9s", mode: "start" });

  assert.equal(result.ok, true);
  assert.deepEqual(sent, ["k9s\r"]);
  assert.deepEqual(term.__triggered, []);
});

test("falls back to client.term when getCoreObject is unavailable", async () => {
  const term = makeTerm();
  const sent = [];
  const gApp = {
    _store: {
      getState: () => ({
        operation_global: {
          clientConnections: {
            "conn-1": { connectionClient: { term, sendTerminalData: data => sent.push(data) } }
          }
        }
      })
    }
  };
  const { result } = await runTerminal({ gApp, term, discoverOnly: true });

  assert.equal(result.matched, true);
  assert.equal(typeof term._clientSend, "function");
});

test("classic xterm terminals still use triggerDataEvent when g_app is absent", async () => {
  const term = makeTerm();
  const { result } = await runTerminal({ gApp: null, term, domTerm: term, mode: "key", keys: "<Up>" });

  assert.equal(result.ok, true);
  assert.deepEqual(term.__triggered, ["\x1b[A"]);
});

test("a malformed g_app state does not break normal terminal discovery", async () => {
  const term = makeTerm();
  const gApp = { _store: { getState: () => ({ operation_global: null }) } };
  const { result } = await runTerminal({ gApp, term, domTerm: term, discoverOnly: true });

  assert.equal(result.matched, true);
  assert.equal(result.candidates[0].kind, "xterm");
});