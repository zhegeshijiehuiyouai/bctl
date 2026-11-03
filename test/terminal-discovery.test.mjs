import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const backgroundSource = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
const functionStart = backgroundSource.indexOf("async function executeInWebTerminal(");
const functionEnd = backgroundSource.indexOf("// ─── MAIN 世界 Kibana DevTools", functionStart);
assert.ok(functionStart >= 0 && functionEnd > functionStart, "terminal injection function must be present");
const injectedFunctionSource = backgroundSource.slice(functionStart, functionEnd).trim();

class FakeElement {
  constructor({ tagName = "DIV", id = "", className = "", attrs = {}, text = "", value = "", rect, parentElement = null } = {}) {
    this.__fakeElement = true;
    this.tagName = tagName.toUpperCase();
    this.id = id;
    this.className = className;
    this.attrs = attrs;
    this.innerText = text;
    this.textContent = text;
    this.value = value;
    this.parentElement = parentElement;
    this.disabled = false;
    this.readOnly = false;
    this.isContentEditable = false;
    this.tabIndex = attrs.tabindex === undefined ? -1 : Number(attrs.tabindex);
    this.rect = rect || { left: 20, top: 20, right: 600, bottom: 400, width: 580, height: 380 };
  }

  getAttribute(name) { return this.attrs[name] ?? null; }
  getBoundingClientRect() { return this.rect; }
  querySelectorAll() { return []; }
  closest() {
    for (let current = this; current; current = current.parentElement) {
      const role = current.getAttribute("role") || "";
      const name = `${current.id} ${current.className} ${current.getAttribute("aria-label") || ""}`;
      if (/terminal|console/i.test(name) || role === "terminal" || role === "application") return current;
    }
    return null;
  }
}

class FakeHTMLElement {
  static [Symbol.hasInstance](value) { return Boolean(value?.__fakeElement); }
}

class FakeSVGElement {
  static [Symbol.hasInstance]() { return false; }
}

function makeDiscovery(elements, activeElement = null) {
  const document = {
    activeElement,
    querySelector() { return null; },
    querySelectorAll(selector) {
      if (selector.startsWith("textarea, input,")) return elements;
      return [];
    }
  };
  const window = {
    frameElement: null,
    getComputedStyle(element) {
      return {
        display: element.attrs.styleDisplay || "block",
        visibility: element.attrs.styleVisibility || "visible",
        opacity: element.attrs.styleOpacity ?? "1"
      };
    }
  };
  const context = {
    document,
    window,
    HTMLElement: FakeHTMLElement,
    SVGElement: FakeSVGElement,
    CSS: { escape: value => String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&") },
    innerWidth: 1024,
    innerHeight: 768
  };
  const executeInWebTerminal = vm.runInNewContext(`(${injectedFunctionSource})`, context);
  return executeInWebTerminal("", 0, null, true);
}

function runTerminal(elements, { cmd = "id", timeoutMs = 500, index = null, discoverOnly = false, kind = null, activeElement = null } = {}) {
  const document = {
    activeElement,
    querySelector() { return null; },
    querySelectorAll(selector) {
      if (selector.startsWith("textarea, input,")) return elements;
      return [];
    }
  };
  const window = {
    frameElement: null,
    getComputedStyle(element) {
      return {
        display: element.attrs.styleDisplay || "block",
        visibility: element.attrs.styleVisibility || "visible",
        opacity: element.attrs.styleOpacity ?? "1"
      };
    }
  };
  const context = {
    document,
    window,
    HTMLElement: FakeHTMLElement,
    SVGElement: FakeSVGElement,
    CSS: { escape: value => String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&") },
    innerWidth: 1024,
    innerHeight: 768
  };
  const executeInWebTerminal = vm.runInNewContext(`(${injectedFunctionSource})`, context);
  return executeInWebTerminal(cmd, timeoutMs, index, discoverOnly, kind);
}

test("finds an unbranded terminal from accessible context and shell prompt evidence", async () => {
  const surface = new FakeElement({
    attrs: { role: "terminal", "aria-label": "Operations console" },
    className: "remote-panel",
    text: "Connected\nops@node:/srv #"
  });
  const input = new FakeElement({ tagName: "textarea", id: "command", parentElement: surface });
  const result = await makeDiscovery([input]);

  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].kind, "generic");
  assert.equal(result.candidates[0].selector, "#command");
  assert.ok(result.candidates[0].confidence >= 75);
  assert.ok(result.candidates[0].evidence.some(item => item.includes("shell prompt")));
});

test("does not cross-dispatch to a generic candidate when selected kind was xterm", async () => {
  const surface = new FakeElement({
    attrs: { role: "terminal", "aria-label": "Operations console" },
    className: "remote-panel",
    text: "Connected\nops@node:/srv #"
  });
  const input = new FakeElement({ tagName: "textarea", id: "command", parentElement: surface });
  const result = await runTerminal([input], { cmd: "whoami", index: 0, discoverOnly: false, kind: "xterm" });

  assert.equal(result.ok, false);
  assert.match(result.error, /不存在终端候选/);
});

test("does not treat an ordinary focused form field as a confident terminal", async () => {
  const form = new FakeElement({ text: "Search users" });
  const input = new FakeElement({
    tagName: "textarea",
    id: "search",
    attrs: { autocorrect: "off" },
    parentElement: form
  });
  const result = await makeDiscovery([input], input);

  assert.equal(result.candidates.length, 1);
  assert.ok(result.candidates[0].confidence < 75);
});

test("does not guess that an unlabeled canvas is a terminal", async () => {
  const canvas = new FakeElement({ tagName: "canvas", attrs: { tabindex: "0" } });
  const result = await makeDiscovery([canvas]);

  assert.equal(result.candidates.length, 0);
});
