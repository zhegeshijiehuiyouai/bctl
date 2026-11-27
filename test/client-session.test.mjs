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
  const tmux = "/tmp/tmux-1000/default,101,0";
  const first = resolve({ env: { TERM_SESSION_ID: "outer-window", TMUX: tmux, TMUX_PANE: "%1" } });
  const second = resolve({ env: { TERM_SESSION_ID: "outer-window", TMUX: tmux, TMUX_PANE: "%2" } });
  assert.match(first, /^terminal:tmux:%1:/);
  assert.match(second, /^terminal:tmux:%2:/);
  assert.notEqual(first, second);
});

test("the same tmux pane number on different servers stays isolated", () => {
  const first = resolve({ env: { TMUX: "/tmp/tmux-1000/work,101,0", TMUX_PANE: "%0" } });
  const second = resolve({ env: { TMUX: "/tmp/tmux-1000/personal,202,0", TMUX_PANE: "%0" } });
  assert.notEqual(first, second);
});

test("window-scoped terminal ids are subdivided by tty", () => {
  const first = resolve({ env: { WT_SESSION: "shared-window" }, tty: "/dev/pts/1" });
  const second = resolve({ env: { WT_SESSION: "shared-window" }, tty: "/dev/pts/2" });
  assert.equal(first, "terminal:shared-window:tty:/dev/pts/1");
  assert.equal(second, "terminal:shared-window:tty:/dev/pts/2");
  assert.notEqual(first, second);
});

test("window-scoped terminal ids use the shell when no tty is available", () => {
  const first = resolve({
    env: { WT_SESSION: "shared-window" },
    ancestry: [{ pid: 41, ppid: 1, command: "pwsh.exe" }]
  });
  const second = resolve({
    env: { WT_SESSION: "shared-window" },
    ancestry: [{ pid: 42, ppid: 1, command: "pwsh.exe" }]
  });
  assert.equal(first, "terminal:shared-window:shell:41");
  assert.equal(second, "terminal:shared-window:shell:42");
});

test("ignores a tty that is not attached", () => {
  assert.equal(resolve({ tty: "not a tty", ancestry: [] }), "default");
  assert.equal(resolve({ env: { TMUX_PANE: "%0" }, tty: "not a tty", ancestry: [] }), "terminal:%0");
});

test("strips control characters and caps the session id length", () => {
  const value = resolve({ env: { BCTL_SESSION: "a\u0000b\u001fc" } });
  assert.equal(value, "abc");
  assert.equal(resolve({ env: { BCTL_SESSION: "x".repeat(400) } }).length, 160);
});

test("returns default when nothing identifies the caller", () => {
  assert.equal(resolve(), "default");
});
