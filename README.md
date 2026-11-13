# agent-attn

One circle that answers "is any agent waiting on me?"

```
●  WAITING (1)
● claude-code my-project — waiting 4m
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
| Claude Desktop (Cowork) | the job's live Claude Code SDK process (`pgrep`) | working-only — no reliable "waiting" signal exists |
| Cursor IDE | `hook.mjs cursor` on beforeSubmitPrompt / stop / sessionEnd via `~/.cursor/hooks.json` | precise — rows dropped when Cursor.app isn't running |
| Cursor agents | self-hosted worker log, one row per open claim on a live worker | `cursor-agent <project> — working` while a shell or context line is under 2 minutes old; `waiting` after that until the claim is parked or released (dropped after a day). Heartbeat `Received frame` lines do not count |
| Cursor cloud agents | `cloudAgentRepository.agents` in `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` | `cursor-cloud <name> — working` when last activity is under 10 minutes; `waiting` when `hasPendingInteraction` is set (dropped after a day). Private-worker sessions are left to the worker log |
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
2. For Cursor, create `~/.cursor/hooks.json` (Cursor reloads it automatically):
   ```json
   {
     "version": 1,
     "hooks": {
       "beforeSubmitPrompt": [{ "command": "/usr/local/bin/node \"<repo>/hook.mjs\" cursor" }],
       "stop": [{ "command": "/usr/local/bin/node \"<repo>/hook.mjs\" cursor" }],
       "sessionEnd": [{ "command": "/usr/local/bin/node \"<repo>/hook.mjs\" cursor" }]
     }
   }
   ```
   That hook is the Cursor IDE path. It does not cover a self-hosted My
   Machines worker (the worker reads hooks once at start) or a cloud session
   with `usePrivateWorker` false. Those two are read directly by `tui.ts`.
3. `./run.sh` in a small terminal window (16×52 is plenty), or add
   `agent-attn.command` to Login Items for a window at every login.

Keys: `q` quit, `c` clear (acknowledge) all waiting rows. `./run.sh --once`
prints one frame, `bun tui.ts --selftest` runs the unit checks. Requires bun +
node.

Why `c` exists: a Claude Code session closed back to the main menu never fires
`SessionEnd`, so its final Stop event leaves a red row until you either resume
that session or acknowledge it. The same key acknowledges a waiting Cursor row.

## Confirm a Cursor session

`./run.sh --once` while the session is live.

A My Machines worker prints one row per open claim. The label is the worker's
directory name:

```
● cursor-agent local-agent-memory-layer — working
```

It stays `working` while the worker log has a `Shell stream:` or
`computeRequestContext` line under 2 minutes old, then turns `waiting`.
`Worker claimed` / `Agent Store opened` open the row; `Released Agent Store
claim` and `Agent Store parked` remove it. A worker that only logs
`Received frame` stays off the light.

A cloud session that is not on a private worker prints the name Cursor has
stored for it:

```
● cursor-cloud Local Memory layer — working
```

That row is `working` when `lastMessageActivityAtMs` is under 10 minutes, and
`waiting` when `hasPendingInteraction` is set. A session already shown from
the worker log is not repeated.
