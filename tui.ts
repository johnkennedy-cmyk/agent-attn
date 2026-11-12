// agent-attn TUI: one colored circle — green idle, orange working, red an
// agent is waiting on you — plus one row per live agent session.
// Run: bun tui.ts   (q quits, --once prints one frame)
// Sources: Claude Code via hook.mjs state files (precise); Claude Desktop
// Cowork via coworkd.log freshness (working-only — no reliable "waiting"
// signal exists for it yet); gemini-cli / Antigravity: probe stubs below.
declare const Bun: any;
import { readdir, readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

const HOME = process.env.HOME ?? "";
const STATE_DIR = join(HOME, ".agent-attn", "state");
const POLL_MS = 2000;
const STALE_MS = 24 * 3600_000; // drop sessions with no signal for a day
const COWORK_LOG = join(HOME, "Library", "Logs", "Claude", "coworkd.log");
const COWORK_FRESH_MS = 60_000;

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

function buildFrame(rows: Row[], cols: number, rowsAvail: number): string {
  const waiting = rows.filter((r) => r.state === "waiting");
  const working = rows.filter((r) => r.state === "working");
  const color = waiting.length ? C.red : working.length ? C.orange : C.green;
  const word = waiting.length ? `WAITING (${waiting.length})` : working.length ? `working (${working.length})` : "idle";
  const lines = [`${color}${C.bold}●  ${word}${C.reset}`];
  for (const r of [...waiting, ...working].slice(0, rowsAvail - 1)) {
    const mark = r.state === "waiting" ? `${C.red}●${C.reset}` : `${C.orange}●${C.reset}`;
    const tail = r.state === "waiting" ? `${C.red}waiting ${ago(r.ts)}${C.reset}` : `${C.grey}working${C.reset}`;
    lines.push(`${mark} ${r.source} ${C.bold}${r.label}${C.reset} — ${tail}`.slice(0, cols + 40));
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

async function collect(): Promise<Row[]> {
  const [cc, cw, gm, ag] = await Promise.all([claudeCodeRows(), coworkRow(), geminiRows(), antigravityRows()]);
  return [...cc, ...(cw ? [cw] : []), ...gm, ...ag];
}

const once = process.argv.includes("--once");
const out = (s: string) => process.stdout.write(s);

if (once) {
  out(buildFrame(await collect(), process.stdout.columns ?? 80, 9999) + "\n");
  process.exit(0);
}

async function render() {
  const rows = await collect();
  notifyNewWaiting(rows);
  out(`${E}H${E}2J` + buildFrame(rows, process.stdout.columns ?? 80, process.stdout.rows ?? 24));
}

function cleanup() {
  out(`${E}?25h${E}?1049l`);
  process.exit(0);
}

out(`${E}?1049h${E}?25l`);
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
process.stdout.on("resize", render);
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.on("data", (d: Buffer) => {
    const ch = d.toString();
    if (ch === "q" || ch === "\x03") cleanup();
  });
}
await render();
setInterval(render, POLL_MS);
