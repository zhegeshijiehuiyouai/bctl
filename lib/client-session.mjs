import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const SESSION_ENV_VARS = [
  ["CODEX_THREAD_ID", "codex"],
  ["CODEX_SESSION_ID", "codex"],
  ["CLAUDE_CODE_SESSION_ID", "claude"],
  ["CLAUDE_SESSION_ID", "claude"],
  ["CURSOR_SESSION_ID", "cursor"],
  ["CURSOR_TRACE_ID", "cursor"],
  ["TRAE_SESSION_ID", "trae"],
  ["GEMINI_CLI_SESSION_ID", "gemini"]
];

const WINDOW_ENV_VARS = [
  // Pane identifiers must win over their outer terminal's shared session.
  ["WEZTERM_PANE", "terminal"],
  ["KITTY_WINDOW_ID", "terminal"],
  ["WT_SESSION", "terminal"],
  ["KONSOLE_SESSION_ID", "terminal"],
  ["ITERM_SESSION_ID", "terminal"],
  ["TERM_SESSION_ID", "terminal"],
  ["WINDOWID", "window"]
];

const WINDOW_SCOPED_ENV_VARS = new Set(["WT_SESSION", "WINDOWID"]);

function normalizeSessionId(value) {
  if (value === undefined || value === null) return "";
  return String(value).replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 160);
}

function parseProcessList(output) {
  return output.split(/\r?\n/).flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }] : [];
  });
}

function readProcessAncestry(platform, parentPid) {
  try {
    if (platform === "win32") {
      const script = `
$currentPid = [int]$args[0]
for ($i = 0; $i -lt 32 -and $currentPid -gt 0; $i++) {
  $item = Get-CimInstance Win32_Process -Filter "ProcessId = $currentPid"
  if ($null -eq $item) { break }
  Write-Output ("{0} {1} {2}" -f $item.ProcessId, $item.ParentProcessId, $item.Name)
  $currentPid = [int]$item.ParentProcessId
}`;
      for (const executable of ["pwsh", "powershell"]) {
        try {
          const output = execFileSync(executable, ["-NoProfile", "-NonInteractive", "-Command", script, String(parentPid)], {
            encoding: "utf8",
            timeout: 1500,
            stdio: ["ignore", "pipe", "ignore"]
          });
          return parseProcessList(output);
        } catch {}
      }
      return [];
    }

    const output = execFileSync("ps", ["-Ao", "pid=,ppid=,comm="], {
      encoding: "utf8",
      timeout: 1000,
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"]
    });
    const processes = new Map(parseProcessList(output).map(item => [item.pid, item]));
    const ancestry = [];
    const visited = new Set();
    let pid = parentPid;
    while (processes.has(pid) && !visited.has(pid) && ancestry.length < 32) {
      const item = processes.get(pid);
      ancestry.push(item);
      visited.add(pid);
      pid = item.ppid;
    }
    return ancestry;
  } catch {
    return [];
  }
}

function isTransientShell(command) {
  const executable = (command.replace(/\\/g, "/").split("/").pop() || "").toLowerCase();
  return /^(?:-)?(?:ba|z|fi|da|k|c|tc)?sh(?:\.exe)?$/.test(executable)
    || /^(?:pwsh|cmd|login)(?:\.exe)?$/.test(executable);
}

function readTty() {
  try {
    if (!process.stdin.isTTY) return "";
    return execFileSync("tty", {
      encoding: "utf8",
      timeout: 500,
      stdio: ["inherit", "pipe", "ignore"]
    }).trim();
  } catch {
    return "";
  }
}

function resolveTmuxSession(env, getTtyName) {
  const pane = normalizeSessionId(env.TMUX_PANE);
  if (!pane) return "";

  const [socket, serverPid] = normalizeSessionId(env.TMUX).split(",");
  if (socket) {
    // Pane numbers are only unique within one tmux server.
    const server = createHash("sha256").update(`${socket}\0${serverPid || ""}`).digest("hex").slice(0, 16);
    return `terminal:tmux:${pane}:${server}`;
  }

  const ttyName = getTtyName();
  const outer = normalizeSessionId(env.TERM_SESSION_ID || env.ITERM_SESSION_ID)
    || (ttyName !== "not a tty" ? ttyName : "");
  return outer ? `terminal:${outer}:tmux:${pane}` : `terminal:${pane}`;
}

export function resolveClientSession({
  env = process.env,
  platform = process.platform,
  parentPid = process.ppid,
  ancestry = null,
  tty = null
} = {}) {
  const explicit = normalizeSessionId(env.BCTL_SESSION);
  if (explicit) return explicit;

  for (const [variable, agent] of SESSION_ENV_VARS) {
    const value = normalizeSessionId(env[variable]);
    if (value) return `${agent}:${value}`;
  }

  let ttyName = null;
  const getTtyName = () => {
    if (ttyName === null) ttyName = normalizeSessionId(tty === null ? readTty() : tty);
    return ttyName;
  };
  let processes = ancestry;
  const getProcesses = () => {
    if (!processes) processes = readProcessAncestry(platform, parentPid);
    return processes;
  };

  const tmuxSession = resolveTmuxSession(env, getTtyName);
  if (tmuxSession) return tmuxSession;

  for (const [variable, context] of WINDOW_ENV_VARS) {
    const value = normalizeSessionId(env[variable]);
    if (!value) continue;
    if (WINDOW_SCOPED_ENV_VARS.has(variable)) {
      const ttyName = getTtyName();
      if (ttyName && ttyName !== "not a tty") return `${context}:${value}:tty:${ttyName}`;
      const shell = getProcesses().find(item => isTransientShell(item.command || ""));
      if (shell) return `${context}:${value}:shell:${shell.pid}`;
    }
    return `${context}:${value}`;
  }

  const attachedTty = getTtyName();
  if (attachedTty && attachedTty !== "not a tty") return `tty:${attachedTty}`;

  for (const item of getProcesses()) {
    if (!isTransientShell(item.command || "")) return `process:${item.pid}`;
  }
  return "default";
}
