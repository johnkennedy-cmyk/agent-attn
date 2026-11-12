#!/usr/bin/env bash
# Login Item launcher: small terminal window with the agent status circle.
set -u
cd "$(dirname "$0")"
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
printf '\e[8;6;52t'
while true; do
  if bun tui.ts; then break; fi
  echo "agent-attn exited abnormally — restarting in 3s (Ctrl-C to stop)"
  sleep 3 || break
done
