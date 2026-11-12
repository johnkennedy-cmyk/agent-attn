#!/usr/bin/env node
// agent-attn Claude Code hook: reads the hook event JSON on stdin and keeps
// one state file per session under ~/.agent-attn/state/.
//   UserPromptSubmit        -> working   (you handed it work)
//   Stop | Notification     -> waiting   (turn ended / it needs you)
//   SessionEnd              -> file removed
// Wire it (same command) under those four events in ~/.claude/settings.json.
import { writeFileSync, mkdirSync, unlinkSync, renameSync } from "node:fs";
import { basename, join } from "node:path";

const dir = join(process.env.HOME ?? "", ".agent-attn", "state");

let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  let evt;
  try {
    evt = JSON.parse(raw);
  } catch {
    process.exit(0); // never block the agent over a malformed event
  }
  // Filename-safe: a spoofed session_id must not traverse out of STATE_DIR.
  const session = String(evt.session_id ?? "unknown").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
  const file = join(dir, `claude-code-${session}.json`);
  const event = String(evt.hook_event_name ?? "");

  try {
    if (event === "SessionEnd") {
      unlinkSync(file);
    } else {
      const state =
        event === "UserPromptSubmit" ? "working" :
        event === "Stop" || event === "Notification" ? "waiting" :
        null;
      if (state === null) process.exit(0);
      mkdirSync(dir, { recursive: true });
      // Atomic publish: the TUI must never read a half-written file.
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({
        source: "claude-code",
        label: basename(String(evt.cwd ?? "")) || "~",
        state,
        ts: new Date().toISOString(),
      }));
      renameSync(tmp, file);
    }
  } catch {
    // state is advisory; never fail the hook
  }
  process.exit(0);
});
