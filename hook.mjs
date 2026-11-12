#!/usr/bin/env node
// agent-attn hook: reads an agent's hook event JSON on stdin and keeps one
// state file per session under ~/.agent-attn/state/.
//
// Usage: node hook.mjs [source]   (source: claude-code [default] | cursor)
//
// claude-code (~/.claude/settings.json):
//   UserPromptSubmit -> working; Stop | Notification -> waiting; SessionEnd -> gone
// cursor (~/.cursor/hooks.json, hook input per cursor.com/docs/agent/hooks):
//   beforeSubmitPrompt -> working; stop -> waiting; sessionEnd -> gone
import { writeFileSync, mkdirSync, unlinkSync, renameSync } from "node:fs";
import { basename, join } from "node:path";

const dir = join(process.env.HOME ?? "", ".agent-attn", "state");

const SOURCES = {
  "claude-code": {
    working: ["UserPromptSubmit"],
    waiting: ["Stop", "Notification"],
    end: ["SessionEnd"],
    id: (e) => e.session_id,
    label: (e) => basename(String(e.cwd ?? "")),
  },
  cursor: {
    working: ["beforeSubmitPrompt"],
    waiting: ["stop"],
    end: ["sessionEnd"],
    id: (e) => e.conversation_id,
    label: (e) => basename(String((e.workspace_roots ?? [])[0] ?? "")),
  },
};

const source = process.argv[2] ?? "claude-code";
const map = SOURCES[source];

let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  let evt;
  try {
    evt = JSON.parse(raw);
  } catch {
    process.exit(0); // never block the agent over a malformed event
  }
  if (!map) process.exit(0);
  // Filename-safe: a spoofed id must not traverse out of STATE_DIR.
  const session = String(map.id(evt) ?? "unknown").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
  const file = join(dir, `${source}-${session}.json`);
  const event = String(evt.hook_event_name ?? "");

  try {
    if (map.end.includes(event)) {
      unlinkSync(file);
    } else {
      const state = map.working.includes(event) ? "working" : map.waiting.includes(event) ? "waiting" : null;
      if (state === null) process.exit(0);
      mkdirSync(dir, { recursive: true });
      // Atomic publish: the TUI must never read a half-written file.
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({
        source,
        label: map.label(evt) || "~",
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
