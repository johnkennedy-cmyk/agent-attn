// agent-attn TUI: one colored circle — green idle, orange working, red an
// agent is waiting on you — plus one row per live agent session.
// Run: bun tui.ts   (q quits, --once prints one frame)
// Sources: Claude Code via hook.mjs state files (precise); Claude Desktop
// Cowork via coworkd.log freshness (working-only — no reliable "waiting"
// signal exists for it yet); Cursor IDE via hook.mjs state files; Cursor
// agents via the self-hosted worker log; Cursor cloud sessions via
// state.vscdb (usePrivateWorker false); gemini-cli / Antigravity: stubs.
declare const Bun: any;
import { open, readdir, readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Database } from "bun:sqlite";

const HOME = process.env.HOME ?? "";
const STATE_DIR = join(HOME, ".agent-attn", "state");
const POLL_MS = 2000;
const STALE_MS = 24 * 3600_000; // drop sessions with no signal for a day
const COWORK_LOG = join(HOME, "Library", "Logs", "Claude", "coworkd.log");
const COWORK_FRESH_MS = 60_000;
// Self-hosted `cursor-agent worker` processes. ~/.cursor/hooks.json is not
// re-read after the worker starts, and cloud/My Machines agents do not use it
// for the session anyway. The worker log is the local signal.
const CURSOR_AGENT_DIR = join(HOME, "Library", "Application Support", "Cursor", "User", "globalStorage", "anysphere.cursor-agent-worker");
const CURSOR_AGENT_WORKING_MS = 120_000; // quieter than this, a live claim is waiting
const CURSOR_AGENT_TAIL = 2_000_000;
// Cloud agents that are not on a My Machines worker never appear in the worker
// log. Cursor keeps their name and last activity in state.vscdb.
const CURSOR_STATE_DB = join(HOME, "Library/Application Support/Cursor/User/globalStorage/state.vscdb");
const CURSOR_CLOUD_FRESH_MS = 10 * 60_000;

const E = "\x1b[";
const C = { reset: `${E}0m`, bold: `${E}1m`, grey: `${E}90m`, green: `${E}92m`, orange: `${E}93m`, red: `${E}91m` };

type Row = { id: string; label: string; source: string; state: "working" | "waiting"; ts: number };

async function claudeCodeRows(): Promise<Row[]> {
  const rows: Row[] = [];
  for (const f of await readdir(STATE_DIR).catch(() => [] as string[])) {
    if (!f.endsWith(".json")) continue; // skip the hook's .tmp staging files
    const path = join(STATE_DIR, f);
    try {
      const s = JSON.parse(await readFile(path, "utf8"));
      const ts = Date.parse(s.ts);
      if (Date.now() - ts > STALE_MS) {
        unlink(path).catch(() => {});
        continue;
      }
      rows.push({ id: f, label: String(s.label), source: String(s.source), state: s.state, ts });
    } catch {
      /* partial write; next poll gets it */
    }
  }
  return rows;
}

function lineTs(line: string): number | null {
  const m = line.match(/^(\d{2}):(\d{2}):(\d{2})\.(\d{1,3})/);
  if (!m) return null;
  const d = new Date();
  d.setHours(+m[1], +m[2], +m[3], +m[4].padEnd(3, "0").slice(0, 3));
  let ts = d.getTime();
  if (ts - Date.now() > 2 * 60_000) {
    d.setDate(d.getDate() - 1);
    ts = d.getTime();
  }
  return ts;
}

function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// One row per background-composer claim still open on a live worker.
// Heartbeat frames ("Received frame") do not count: an idle worker writes
// those forever and must stay off the light.
async function cursorAgentRows(): Promise<Row[]> {
  const names = await readdir(CURSOR_AGENT_DIR).catch(() => [] as string[]);
  const rows: Row[] = [];
  for (const name of names) {
    if (!/^cursor-agent-worker-.*\.log$/.test(name)) continue;
    const logPath = join(CURSOR_AGENT_DIR, name);
    // Pid files are "<worker>.<pid>.pid", not "<worker>.pid".
    const prefix = name.slice(0, -".log".length);
    const pidName = names.find((n) => n.startsWith(prefix + ".") && n.endsWith(".pid"));
    if (!pidName) continue;
    let pid = Number.NaN;
    try {
      pid = Number((await readFile(join(CURSOR_AGENT_DIR, pidName), "utf8")).trim());
    } catch {
      continue;
    }
    if (!pidAlive(pid)) continue;
    let label = "cursor-agent";
    try {
      const meta = JSON.parse(await readFile(join(CURSOR_AGENT_DIR, prefix + ".restart.json"), "utf8"));
      const root = String((meta.roots ?? [])[0] ?? "");
      label = root.split("/").filter(Boolean).pop() || label;
    } catch {
      /* label stays generic */
    }
    let text = "";
    try {
      const fh = await open(logPath, "r");
      try {
        const st = await fh.stat();
        const start = Math.max(0, st.size - CURSOR_AGENT_TAIL);
        const buf = Buffer.alloc(st.size - start);
        await fh.read(buf, 0, buf.length, start);
        text = buf.toString("utf8");
      } finally {
        await fh.close();
      }
    } catch {
      continue;
    }
    const active = new Map<string, number>();
    for (const line of text.split("\n")) {
      const ts = lineTs(line);
      if (ts === null) continue;
      const id = line.match(/bc-[0-9a-f-]{8,}/)?.[0];
      if (line.includes("Worker claimed by background composer") || line.includes("Agent Store opened for private worker claim")) {
        if (id) active.set(id, ts);
      } else if (line.includes("Agent Store parked for private worker claim") || line.includes("Released Agent Store claim")) {
        if (id) active.delete(id);
      } else if (line.includes("Shell stream:") || line.includes("computeRequestContext")) {
        for (const [k, prev] of active) if (ts >= prev) active.set(k, ts);
      }
    }
    const now = Date.now();
    for (const [id, ts] of active) {
      const age = now - ts;
      if (age > STALE_MS) continue;
      rows.push({
        id: `cursor-agent-${id}`,
        label,
        source: "cursor-agent",
        state: age <= CURSOR_AGENT_WORKING_MS ? "working" : "waiting",
        ts,
      });
    }
  }
  return rows;
}

// Sessions such as the project coordinator run in Cursor's cloud
// (usePrivateWorker false), so the worker log has no claim to show.
function cloudAgentRows(seenBcIds: Set<string>): Row[] {
  let db: Database | null = null;
  try {
    db = new Database(CURSOR_STATE_DB, { readonly: true });
    const key = db.query("select key from ItemTable where key like ?").get("cloudAgentRepository.agents.%") as { key: string } | null;
    if (!key) return [];
    const rec = db.query("select value from ItemTable where key = ?").get(key.key) as { value: string } | null;
    const agents = JSON.parse(String(rec?.value ?? "[]")) as Array<Record<string, unknown>>;
    const now = Date.now();
    const rows: Row[] = [];
    for (const a of agents) {
      if (a.usePrivateWorker || a.isArchived || a.isKilled) continue;
      const id = String(a.bcId ?? "");
      if (!id.startsWith("bc-") || seenBcIds.has(id)) continue;
      const ts = Number(a.lastMessageActivityAtMs || a.updatedAt || 0);
      if (!Number.isFinite(ts) || ts <= 0) continue;
      const age = now - ts;
      if (age > STALE_MS) continue;
      const pending = Boolean(a.hasPendingInteraction);
      if (!pending && age > CURSOR_CLOUD_FRESH_MS) continue;
      rows.push({
        id: `cursor-cloud-${id}`,
        label: String(a.name || "cloud").slice(0, 48),
        source: "cursor-cloud",
        state: pending ? "waiting" : "working",
        ts,
      });
    }
    return rows;
  } catch {
    return [];
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
}

async function coworkRow(): Promise<Row | null> {
  // ponytail: log freshness only — says "working", can never say "waiting";
  // upgrade path is a real Cowork signal if one ever ships.
  const st = await stat(COWORK_LOG).catch(() => null);
  if (!st || Date.now() - st.mtimeMs > COWORK_FRESH_MS) return null;
  return { id: "cowork", label: "cowork", source: "claude-desktop", state: "working", ts: st.mtimeMs };
}

// Probe stubs — neither tool is installed on this machine today.
// gemini-cli: likely ~/.gemini session files; Antigravity: unknown surface.
async function geminiRows(): Promise<Row[]> { return []; }
async function antigravityRows(): Promise<Row[]> { return []; }

const ago = (ts: number) => {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  return s < 90 ? `${Math.round(s)}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
};

let notified = new Set<string>();
// `c` acknowledges log-derived waiting rows (they have no state file to unlink).
const ackedWaiting = new Map<string, number>();

// A filled circle drawn in block cells, diameter `diam` rows, centered in
// `cols` columns (terminal cells are ~2:1 tall, so width = 2× the row span).
function circleArt(diam: number, color: string, cols: number): string[] {
  const lines: string[] = [];
  const r = diam / 2;
  for (let y = 0; y < diam; y++) {
    const dy = (y + 0.5 - r) / r;
    const w = Math.round(Math.sqrt(Math.max(0, 1 - dy * dy)) * diam * 2);
    if (w === 0) { lines.push(""); continue; }
    const pad = Math.max(0, Math.floor((cols - w) / 2));
    lines.push(" ".repeat(pad) + color + "█".repeat(Math.min(w, cols)) + C.reset);
  }
  return lines;
}

function buildFrame(rows: Row[], cols: number, rowsAvail: number, phase = 0): string {
  const waiting = rows.filter((r) => r.state === "waiting");
  const working = rows.filter((r) => r.state === "working");
  const color = waiting.length ? C.red : working.length ? C.orange : C.green;
  const word = waiting.length ? `WAITING (${waiting.length})` : working.length ? `working (${working.length})` : "idle";
  const hint = `${C.grey}c=clear q=quit${C.reset}`;
  const head = `${color}${C.bold}●  ${word}${C.reset}`;
  const lines = [head + " ".repeat(Math.max(1, cols - (word.length + 3) - 14)) + hint];
  // The list keeps at most half the window so the light below stays large;
  // a non-interactive snapshot (--once without a TTY) never drops rows.
  const listMax = process.stdout.isTTY ? Math.max(1, Math.floor(rowsAvail / 2) - 1) : rows.length;
  for (const r of [...waiting, ...working].slice(0, listMax)) {
    const mark = r.state === "waiting" ? `${C.red}●${C.reset}` : `${C.orange}●${C.reset}`;
    const tail = r.state === "waiting" ? `${C.red}waiting ${ago(r.ts)}${C.reset}` : `${C.grey}working${C.reset}`;
    lines.push(`${mark} ${r.source} ${C.bold}${r.label}${C.reset} — ${tail}`.slice(0, cols + 40));
  }
  // The big light: fill whatever is left, capped by the width it needs (2:1).
  const spare = rowsAvail - lines.length - 1;
  const full = Math.min(spare, Math.floor(cols / 2));
  if (full >= 3) {
    // Red state pulses: alternate 100% / 90% diameter, padded so the light
    // throbs in place instead of shifting the layout.
    const shrink = waiting.length > 0 && phase % 2 === 1;
    const diam = shrink ? Math.max(3, Math.round(full * 0.9)) : full;
    const padTop = Math.floor((full - diam) / 2);
    lines.push("");
    for (let i = 0; i < padTop; i++) lines.push("");
    lines.push(...circleArt(diam, color, cols));
    for (let i = 0; i < full - diam - padTop; i++) lines.push("");
  }
  return lines.join("\r\n");
}

function notifyNewWaiting(rows: Row[]) {
  // Keyed by unique session id, so same-label sessions each get their alert.
  const waiting = rows.filter((r) => r.state === "waiting");
  const current = new Set(waiting.map((r) => r.id));
  for (const r of waiting) {
    if (!notified.has(r.id)) {
      const msg = `${r.source} ${r.label}`.replace(/["\\]/g, "");
      Bun.spawn(["osascript", "-e", `display notification "${msg} is waiting for you" with title "agent-attn"`]);
    }
  }
  notified = current;
}

async function processAlive(pattern: string): Promise<boolean> {
  const p = Bun.spawn(["pgrep", "-f", pattern], { stdout: "ignore", stderr: "ignore" });
  return (await p.exited) === 0;
}

async function collect(): Promise<Row[]> {
  const [state, cw, agents, gm, ag] = await Promise.all([claudeCodeRows(), coworkRow(), cursorAgentRows(), geminiRows(), antigravityRows()]);
  const seenBc = new Set(agents.map((r) => r.id.replace(/^cursor-agent-/, "")));
  let rows = [...state, ...(cw ? [cw] : []), ...agents, ...cloudAgentRows(seenBc), ...gm, ...ag].filter((r) => ackedWaiting.get(r.id) !== r.ts);
  // A quit app can't send its "session end" hook — drop its leftover rows.
  if (rows.some((r) => r.source === "cursor") && !(await processAlive("Cursor.app/Contents/MacOS"))) {
    for (const r of rows.filter((r) => r.source === "cursor")) unlink(join(STATE_DIR, r.id)).catch(() => {});
    rows = rows.filter((r) => r.source !== "cursor");
  }
  return rows;
}

const once = process.argv.includes("--once");
const out = (s: string) => process.stdout.write(s);

if (once) {
  out(buildFrame(await collect(), process.stdout.columns ?? 52, process.stdout.rows ?? 16) + "\n");
  process.exit(0);
}

let rows: Row[] = [];
let phase = 0;

async function refresh() {
  rows = await collect();
  notifyNewWaiting(rows);
}

function render() {
  phase++;
  out(`${E}H${E}2J` + buildFrame(rows, process.stdout.columns ?? 80, process.stdout.rows ?? 24, phase));
}

function cleanup() {
  out(`${E}?25h${E}?1049l`);
  process.exit(0);
}

out(`${E}?1049h${E}?25l`);
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
process.stdout.on("resize", render);
// Acknowledge: a session closed back to the main menu never fires SessionEnd,
// so its final Stop leaves a red row forever. `c` clears current waiting rows.
async function clearWaiting() {
  for (const r of rows.filter((r) => r.state === "waiting" && !r.id.endsWith(".json"))) ackedWaiting.set(r.id, r.ts);
  for (const r of rows.filter((r) => r.state === "waiting" && r.id.endsWith(".json"))) {
    const path = join(STATE_DIR, r.id);
    try {
      // Re-read: the session may have gone back to working since the last poll.
      const current = JSON.parse(await readFile(path, "utf8"));
      if (current.state === "waiting") await unlink(path);
    } catch {
      /* already gone or mid-rewrite — leave it */
    }
  }
  await refresh();
  render();
}

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.on("data", (d: Buffer) => {
    const ch = d.toString();
    if (ch === "q" || ch === "\x03") cleanup();
    if (ch === "c") void clearWaiting();
  });
}
await refresh();
render();
setInterval(refresh, POLL_MS);
setInterval(render, 500); // animation tick — pulses the light when red
