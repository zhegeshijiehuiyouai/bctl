import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveClientSession } from "../lib/client-session.mjs";

function resolve(overrides = {}) {
  return resolveClientSession({ env: {}, ancestry: [], tty: "", ...overrides });
}

test("BCTL_SESSION wins over every automatic signal", () => {
  assert.equal(
    resolve({ env: { BCTL_SESSION: " my-agent ", CODEX_SESSION_ID: "abc" } }),
    "my-agent"
  );
});

test("two windows of the same tool resolve to different sessions", () => {
  const first = resolve({ env: { CODEX_SESSION_ID: "thread-1" } });
  const second = resolve({ env: { CODEX_SESSION_ID: "thread-2" } });
  assert.equal(first, "codex:thread-1");
  assert.equal(second, "codex:thread-2");
  assert.notEqual(first, second);
});

test("different agents resolve to different namespaces", () => {
  assert.equal(resolve({ env: { CODEX_SESSION_ID: "t" } }), "codex:t");
  assert.equal(resolve({ env: { CLAUDE_SESSION_ID: "s" } }), "claude:s");
  assert.equal(resolve({ env: { CURSOR_TRACE_ID: "c" } }), "cursor:c");
});

test("falls back to the terminal window, then the tty, then the process tree", () => {
  assert.equal(resolve({ env: { TERM_SESSION_ID: "w1" } }), "terminal:w1");
  assert.equal(resolve({ tty: "/dev/ttys003" }), "tty:/dev/ttys003");
  assert.equal(
    resolve({
      ancestry: [
        { pid: 42, ppid: 41, command: "/bin/zsh" },
        { pid: 41, ppid: 1, command: "/usr/local/bin/node" }
      ]
    }),
    "process:41"
  );
});

test("tmux panes stay isolated even when they share an outer terminal session", () => {
  const first = resolve({ env: { TERM_SESSION_ID: "outer-window", TMUX_PANE: "%1" } });
  const second = resolve({ env: { TERM_SESSION_ID: "outer-window", TMUX_PANE: "%2" } });
  assert.equal(first, "terminal:%1");
  assert.equal(second, "terminal:%2");
  assert.notEqual(first, second);
});

test("ignores a tty that is not attached", () => {
  assert.equal(resolve({ tty: "not a tty", ancestry: [] }), "default");
});

test("strips control characters and caps the session id length", () => {
  const value = resolve({ env: { BCTL_SESSION: "a\u0000b\u001fc" } });
  assert.equal(value, "abc");
  assert.equal(resolve({ env: { BCTL_SESSION: "x".repeat(400) } }).length, 160);
});

test("returns default when nothing identifies the caller", () => {
  assert.equal(resolve(), "default");
});
