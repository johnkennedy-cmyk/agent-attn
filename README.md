# agent-attn

One circle that answers "is any agent waiting on me?"

```
●  WAITING (1)
● claude-code cloudv2 — waiting 4m
● claude-desktop cowork — working
```

- **green** — nothing happening
- **orange** — agents working
- **red** — an agent stopped and is waiting for your input (also fires a
  macOS notification the moment a session turns red)

## Sources

| Agent | Signal | Fidelity |
| --- | --- | --- |
| Claude Code | `hook.mjs` on UserPromptSubmit / Stop / Notification / SessionEnd, writing `~/.agent-attn/state/` | precise |
| Claude Desktop (Cowork) | `coworkd.log` freshness | working-only — no reliable "waiting" signal exists |
| gemini-cli | stub (not installed here) | — |
| Antigravity | stub (not installed here) | — |

State files are advisory JSON (`{source,label,state,ts}`); any agent that can
run a command on turn boundaries can join by writing one.

## Setup

1. Wire the hook into `~/.claude/settings.json` under each of
   `UserPromptSubmit`, `Stop`, `Notification`, `SessionEnd`:
   ```json
   {"hooks": [{"type": "command", "command": "\"/usr/local/bin/node\" \"<repo>/hook.mjs\"", "timeout": 5}]}
   ```
2. `./run.sh` in a small terminal window (6×52 is plenty), or add
   `agent-attn.command` to Login Items for a window at every login.

Keys: `q` quit. `./run.sh --once` prints one frame. Requires bun + node.
