#!/usr/bin/env bash
# agent-attn TUI in the current terminal.
set -euo pipefail
cd "$(dirname "$0")"
exec bun tui.ts "$@"
