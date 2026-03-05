# build_script — Claude Code Plugin

**Document-as-System**: Automatically maintains `BUILD_SCRIPT.md` and `BUILD_SCRIPT_FULL.md` as you code with Claude Code. Optionally syncs to Google Docs for mobile editing with instant same-session injection.

## Features

- **Auto-maintained spec files** — Every code response silently updates `BUILD_SCRIPT.md` (current state paragraph) and `BUILD_SCRIPT_FULL.md` (full prompt history)
- **GitHub auto-push** — Commits and pushes spec updates automatically when a repo is configured
- **Google Docs sync** — Bidirectional sync with a Google Doc; changes from your phone are injected into the active Claude session within ~11 seconds
- **HMAC-signed queue** — Secure prompt injection using HMAC-SHA256 signatures with nonce replay protection
- **Fully autonomous mode** — Google Doc edits automatically trigger Claude to implement changes without manual intervention

## Installation

### Via Claude Code plugin manager

```bash
# Install from GitHub
claude plugin install stefanocasafranca/claude-build-script-plugin
```

### Manual installation

```bash
# Clone to Claude plugins directory
git clone https://github.com/stefanocasafranca/claude-build-script-plugin \
  ~/.claude/plugins/local/build_script
```

## Usage

In any Claude Code session, run:

```
/build_script
```

This initializes the Document-as-System in your current project:
1. Generates an HMAC secret for secure queue signing
2. Creates/updates `CLAUDE.md` with spec-maintenance rules
3. Optionally connects a GitHub repository for auto-commits
4. Optionally connects a Google Doc for bidirectional sync

## Plugin Structure

```
.claude-plugin/
  plugin.json          # Plugin metadata (name, version, description)
hooks/
  hooks.json           # Hook definitions (UserPromptSubmit, PostToolUse, Stop)
  user-prompt-handler.py  # Injects spec-maintenance instructions + Google Doc queue
  post-tool-handler.sh    # Auto-commits BUILD_SCRIPT.md changes to git
  stop-hook-handler.py    # Blocks Claude stop if queue has pending remote changes
skills/
  build_script/
    SKILL.md            # /build_script skill definition
tools/
  sync-gdoc.js          # Google Docs bidirectional sync daemon
  start-all.sh          # Launcher: sync daemon + osascript auto-trigger
  paragraph-diff.js     # Diff utility for detecting Google Doc changes
  security.js           # HMAC signing utilities for queue files
```

## How It Works

### Spec Maintenance
Every user prompt gets the spec-maintenance instructions invisibly appended via the `UserPromptSubmit` hook. Claude updates `BUILD_SCRIPT.md` (a single continuous paragraph of current requirements) and `BUILD_SCRIPT_FULL.md` (full history) silently on every code-related response.

### Google Docs Sync
The `sync-gdoc.js` daemon polls a Google Doc every second. After 10 seconds of no editing activity, it diffs the current doc against the last known state, generates a structured change summary, signs it with HMAC-SHA256, writes it to `.build_script_queue.json`, then sends an Enter keystroke to the active Claude Code terminal. The `UserPromptSubmit` hook intercepts this empty keystroke, finds the signed queue, and injects the changes as the full prompt.

### Security
- Queue files are signed with HMAC-SHA256 using a per-machine secret (`~/.config/build_script/hmac_secret`)
- Nonce replay protection prevents the same queue from being consumed twice
- Files written with `0o600` permissions
- Timestamp freshness check (30-minute window)

## Requirements

- [Claude Code](https://claude.ai/code) CLI
- Python 3 (for hooks)
- Node.js (for Google Docs sync tools)
- `gh` CLI (optional, for GitHub auto-push)
- Google Cloud OAuth credentials (optional, for Google Docs sync)

## Version

**9.0.0** — Visual daemon feedback, GitHub repo auto-push integration, fully autonomous mode as default.

## License

MIT
