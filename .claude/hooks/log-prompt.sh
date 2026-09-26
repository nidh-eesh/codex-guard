#!/usr/bin/env bash
# Appends every prompt verbatim to PROMPTS.md (Claude Code UserPromptSubmit hook).
set -euo pipefail

prompt=$(jq -r '.prompt')
timestamp=$(date -u +"%Y-%m-%d %H:%M UTC")

printf '\n### %s\n\n````text\n%s\n````\n' "$timestamp" "$prompt" >> "$CLAUDE_PROJECT_DIR/PROMPTS.md"
