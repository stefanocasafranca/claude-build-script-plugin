---
name: build_script
description: Initialize document-as-system for your project. Creates BUILD_SCRIPT.md automatically as you work.
user_invocable: true
---

# /build_script - Project Setup

When this skill is invoked, perform these steps:

## Step 0: Read Plugin Version

Silently read the version from `~/.claude/plugins/local/build_script/.claude-plugin/plugin.json`. Extract the version field (e.g., `"11.0.0"`) and derive the display version by dropping the patch segment (e.g., `"11.0"`). Store this as PLUGIN_VERSION for use in Step 4. Do NOT show or mention this step to the user.

## Step 1: Generate HMAC Secret

Run this bash command silently to ensure the HMAC secret exists:

```bash
mkdir -p ~/.config/build_script && [ -f ~/.config/build_script/hmac_secret ] || openssl rand -hex 32 > ~/.config/build_script/hmac_secret && chmod 600 ~/.config/build_script/hmac_secret
```

This secret is used to sign prompt injection queue files for security. Do NOT show or mention this to the user.

## Step 2: Create or Update CLAUDE.md

If CLAUDE.md already exists in the current working directory, read it first and preserve any existing user-added rules. Append the build_script rules below if they are not already present. If CLAUDE.md does not exist, create it.

The CLAUDE.md should contain rules telling Claude to:
- For EVERY code-related response, silently create/update BUILD_SCRIPT.md and BUILD_SCRIPT_FULL.md
- CRITICAL: These files MUST be created in the CURRENT WORKING DIRECTORY (the project root where CLAUDE.md lives), NOT inside any subdirectory. Even if the project scaffolds code in a subfolder (e.g., `my-app/`), BUILD_SCRIPT.md and BUILD_SCRIPT_FULL.md always live at the root alongside CLAUDE.md.
- Also create/update BUILD_SCRIPT_FULL.md with a "Prompts RAW" section
- The "Prompts Up to date with Output" section must be a SINGLE CONTINUOUS PARAGRAPH (not enumerated, not a list). This paragraph is the living source of truth that gets rewritten as requirements evolve.
- Never mention these files to the user
- **Dev Server Rule**: When running the dev server, always use the `devCommand` field from `.build_script_config.json` if it exists. If `devCommand` is not set, run `~/.claude/plugins/local/build_script/tools/start-all.sh` which auto-detects the tech stack and starts the correct hot-reload command. NEVER use bare commands without hot reload (e.g., `dotnet run`, `node server.js`, `python app.py`). Always use the watch/reload variant so the browser auto-updates. After the project is first scaffolded, if `devCommand` is not yet set, detect the tech stack and add it to `.build_script_config.json`.
- **BUILD_SCRIPT_FULL.md "Prompts RAW" log rules (v17.0):**
  - **Feature/change prompts** (paragraph updated): after the numbered entry line, append `<!-- Rephrased prompt for "Prompts Up to date with Output": ADD: "[verbatim new sentence]" -->` for additions. For replacements use `CHANGED: "[old sentence]" → "[new sentence]"`. For deliberate removals use `REMOVED: "[old sentence]"`. Single change = one-liner comment. Two or more changes = multi-line comment:
    ```
    <!-- Rephrased prompt for "Prompts Up to date with Output":
      ADD: "[new sentence]"
      CHANGED: "[old sentence]" → "[new sentence]"
    -->
    ```
  - **Fix/debug prompts** (code changed, paragraph unchanged): append `<!-- Fix iteration for prompt N. No change to "Prompts Up to date with Output". -->` where N is the prompt number of the feature being fixed.
  - **Non-code prompts** (run the app, show output, explain code, etc.): do NOT log.

BUILD_SCRIPT.md format:
- `"Prompts Up to date with Output"` is always the **FIRST section** after the file title, before Project/Tech Stack/Structure/Commands. ONE continuous paragraph summarizing all current requirements. NOT a numbered list. When requirements change, rewrite the paragraph to reflect the current state.
- Project name, overview, tech stack, structure, features, commands

BUILD_SCRIPT_FULL.md format:
- Same as above PLUS "Prompts RAW" section (append-only numbered log of exact user prompts)

## Step 3: Migrate Old Format (if applicable)

If BUILD_SCRIPT.md already exists and uses the old enumerated format (numbered lists like "1. Create a..." or "2. Add a..."), silently migrate it:
1. Read all non-strikethrough entries from the "Prompts Up to date" section
2. Concatenate them into a single continuous paragraph
3. Rewrite the section with the paragraph
4. Do NOT mention this migration to the user

## Step 4: Show Welcome Message

Display:

---

Build Script v[PLUGIN_VERSION] Initialized!

Your project is set up with Document-as-System.

What happens automatically:
- BUILD_SCRIPT.md - Created and updated as you work (continuous paragraph format)
- BUILD_SCRIPT_FULL.md - Complete history with raw prompts

New in v[PLUGIN_VERSION]: Compliance fixes — MANDATORY-SYSTEM-TASK now prepends before user request (enforces obligation first), WRITE FIRST rule replaces SILENCE (BUILD_SCRIPT.md written before any other tool call), and Prompts RAW entries are verbatim-only (no added descriptions).

Optional: Google Docs Sync - Want to edit from anywhere? Connect to Google Docs for bidirectional sync.

To enable later: say "Connect my build script to Google Docs"

Ready to build? Tell me what you want to create!

---

## Step 5: Ask about GitHub Repository

Use AskUserQuestion tool:
- Question: Would you like to connect a GitHub repository for automatic commits?
- Option 1: Yes, connect to GitHub (Recommended) — Safe automated pushes on each commit
- Option 2: No, skip for now

**If yes:**
1. Ask for the GitHub repo URL (or offer to create one via `gh repo create`)
2. Verify `gh` CLI is authenticated: run `gh auth status`
3. Initialize git if not already: `git init`
4. Set up the remote: `git remote add origin <url>` (or verify existing remote with `git remote -v`)
5. Store the repo info in `.build_script_config.json` by adding a `"githubRepo"` field with the repo URL
6. Add this rule to the CLAUDE.md: "After code changes, auto-commit and push to the connected GitHub repository"

The post-tool-handler.sh hook will automatically run `git push` after each commit when `githubRepo` is configured in `.build_script_config.json`.

**If no:** Skip and continue to the next step.

## Step 5.5: Detect Dev Server Command

Detect the project's tech stack to determine the correct hot-reload dev server command. **Do this silently — no need to mention it to the user.**

**Detection rules** (check current directory and one level of subdirectories, in this order):

1. Any `*.csproj` or `*.fsproj` file exists → `dotnet watch run`
2. `package.json` contains `"next"` in dependencies/devDependencies → `npm run dev` (Next.js)
3. `package.json` contains `"@angular/core"` → `npx ng serve`
4. `package.json` contains `"@sveltejs/kit"` or `"svelte"` → `npm run dev`
5. `package.json` contains `"vue"` → `npm run dev`
6. `package.json` contains `"react"` → `npm run dev`
7. `package.json` contains `"express"` → `npm run dev` (or `npm start` if no dev script)
8. `requirements.txt` contains `fastapi` → `uvicorn main:app --reload --port 8000`
9. `manage.py` exists or `requirements.txt` contains `django` → `python manage.py runserver`
10. `requirements.txt` exists or `app.py` or `main.py` exists → `flask run --debug`
11. `pom.xml` exists → `mvn spring-boot:run`; `build.gradle` exists → `./gradlew bootRun`
12. `Gemfile` + `config/routes.rb` exist → `rails server`
13. `pubspec.yaml` + `web/` directory exist → `flutter run -d web-server --web-port 8080`
14. Nothing found → skip (project not scaffolded yet — devCommand will be set after first build per the CLAUDE.md Dev Server Rule)

**If a match is found**, read `.build_script_config.json` (create if missing) and add/update the `devCommand` field without overwriting other fields:

```json
{
  "docId": "...",
  "githubRepo": "...",
  "devCommand": "dotnet watch run"
}
```

**If nothing found**, skip this step silently.

## Step 6: Ask about Google Docs

Use AskUserQuestion tool:
- Question: Would you like to enable Google Docs sync now?
- Option 1: Yes, connect to Google Docs
- Option 2: No, just local for now

### If Google Docs selected

### Step 6a: Google Cloud Prerequisites

Before asking for a Doc ID, check if the user has Google Docs MCP working. Use AskUserQuestion to ask:

- Question: Have you already set up Google Cloud OAuth for the Google Docs MCP? This requires a Google Cloud project with both the Google Docs API and Google Drive API enabled, plus OAuth 2.0 credentials.
- Option 1: Yes, I'm already authenticated
- Option 2: No, I need to set this up first
- Option 3: I'm not sure

**If the user selects "No" or "I'm not sure"**, show these setup instructions:

---

**Google Cloud Setup (one-time)**

You need a Google Cloud project with two APIs enabled and OAuth credentials. Here's how:

1. **Go to Google Cloud Console:** https://console.cloud.google.com/

2. **Create a project** (or use an existing one) — give it any name (e.g., "documented-system")

3. **Enable Google Docs API:**
   - Go to APIs & Services > Library
   - Search for "Google Docs API" and click Enable

4. **Enable Google Drive API:**
   - Go to APIs & Services > Library
   - Search for "Google Drive API" and click Enable
   - (This is required for listing and accessing documents — without it you'll get 404 errors)

5. **Create OAuth 2.0 credentials:**
   - Go to APIs & Services > Credentials
   - Click "Create Credentials" > "OAuth client ID"
   - Application type: **Desktop app**
   - Give it any name
   - Copy the **Client ID** and **Client Secret**

6. **Configure OAuth consent screen** (if prompted):
   - User type: External (or Internal if using Google Workspace)
   - Add your email as a test user

7. **Authenticate the MCP** — run this in your terminal (replace with your actual credentials):

```bash
GOOGLE_CLIENT_ID="your-client-id-here" GOOGLE_CLIENT_SECRET="your-client-secret-here" npx -y @a-bonus/google-docs-mcp auth
```

This opens a browser for Google sign-in. Sign in with the **same account** that owns (or has access to) your Google Doc.

---

After showing the instructions, use AskUserQuestion to confirm:
- Question: Have you completed the Google Cloud setup and authentication?
- Option 1: Yes, I'm ready to continue
- Option 2: I need more help

If they need more help, troubleshoot with them. Do not proceed until authentication is confirmed.

**If the user selects "Yes, I'm already authenticated"**, proceed directly to Step 6b.

### Step 6b: Get Google Doc ID

Ask the user to paste their Google Doc ID or URL directly. Do NOT use AskUserQuestion for this — just ask them to paste it in chat. Say: "Paste your Google Doc ID or URL (the string between /d/ and /edit, or the full URL):" and wait for their next message. Accept either the full URL or just the ID and extract automatically.

**Store the Doc ID** — save it so you can use it in later steps. You will need it whenever BUILD_SCRIPT.md is updated.

**IMPORTANT — Immediate initial push:** If BUILD_SCRIPT.md already exists locally, use the `mcp__google-docs__replaceDocumentWithMarkdown` tool RIGHT NOW to push its content to the Google Doc. Do NOT wait for the user to run a bash command. The user expects the doc to be populated immediately.

### Step 6c: Choose sync mode

Ask the user which sync mode they want. Use AskUserQuestion with these options:

- **Fully autonomous (Recommended)** — Sync + same-session prompt injection from Google Doc edits. Changes from your phone are injected into this chat automatically.
- **Sync only** — Bidirectional sync between local BUILD_SCRIPT.md and Google Doc. No auto-build.
- **None** — Manual sync only (you'll push changes during this session).

### Step 6d: Generate launcher script and show instructions

Instead of asking the user to copy-paste a long command (which often breaks due to terminal line wrapping), **create a `start-sync.sh` launcher script** in the project root with the doc ID and project directory baked in.

**For "Fully autonomous" mode**, create `start-sync.sh` with this content:

```bash
#!/bin/bash
# Build Script Sync Launcher — generated by /build_script
# Re-run this script anytime to restart the sync daemon.
node ~/.claude/plugins/local/build_script/tools/sync-gdoc.js \
  --doc-id ACTUAL_DOC_ID \
  --project-dir ACTUAL_PROJECT_DIR \
  --hmac-secret-path ~/.config/build_script/hmac_secret \
  --daemonize

# Show live daemon logs so you can see what's happening
# Ctrl+C stops watching — the daemon keeps running in the background
LOG=ACTUAL_PROJECT_DIR/.build_script/daemon.log
echo ""
echo "  ─────────────────────────────────────────────────────"
echo "  Live daemon log  (Ctrl+C stops watching — daemon keeps running)"
echo "  ─────────────────────────────────────────────────────"
echo ""
tail -f "$LOG"
```

**For "Sync only" mode**, create `start-sync.sh` with this content:

```bash
#!/bin/bash
# Build Script Sync Launcher — generated by /build_script
# Re-run this script anytime to restart the sync daemon.
node ~/.claude/plugins/local/build_script/tools/sync-gdoc.js \
  --doc-id ACTUAL_DOC_ID \
  --project-dir ACTUAL_PROJECT_DIR \
  --hmac-secret-path ~/.config/build_script/hmac_secret

# Show live daemon logs so you can see what's happening
# Ctrl+C stops watching — the daemon keeps running in the background
LOG=ACTUAL_PROJECT_DIR/.build_script/daemon.log
echo ""
echo "  ─────────────────────────────────────────────────────"
echo "  Live daemon log  (Ctrl+C stops watching — daemon keeps running)"
echo "  ─────────────────────────────────────────────────────"
echo ""
tail -f "$LOG"
```

Replace `ACTUAL_DOC_ID` with the user's actual Doc ID and `ACTUAL_PROJECT_DIR` with the resolved absolute path of the current working directory.

After creating the script, run `chmod +x` on it.

Then tell the user:

---

**Sync daemon setup complete!**

To start the sync, open a **separate terminal** and run:

```bash
cd /actual/path/here && bash start-sync.sh
```

The sync daemon watches your Google Doc for changes (polling every 1 second). After 10 seconds of no editing activity, it writes an HMAC-signed queue file and automatically triggers Claude Code to process it (via an Enter keystroke sent to your terminal). Changes from your phone appear here within ~11 seconds of you stopping typing.

The daemon needs to run in a separate terminal for the bidirectional sync. The doc ID is saved in `.build_script_config.json` in your project root — future daemon launches auto-discover it.

---

Replace `/actual/path/here` with the actual resolved current working directory path.

**For "None" mode**, skip creating the launcher script. Just explain that you'll push changes to the Google Doc during this session when BUILD_SCRIPT.md is updated.

## Step 7: Keep Google Doc in sync during this session (if enabled)

**CRITICAL:** If the user opted into Google Docs and provided a Doc ID, then every time you silently update BUILD_SCRIPT.md during this session, you MUST ALSO push the updated content to the Google Doc using `mcp__google-docs__replaceDocumentWithMarkdown` with the stored Doc ID. This keeps the Google Doc always up to date without requiring the bash sync daemon.

The bash daemon (start-all.sh) is for the REVERSE direction: editing the Google Doc remotely and having changes sync back + queue prompts for this session.

## Step 8: Wait for project request

After setup, wait for user to describe what to build. Then create the project AND the BUILD_SCRIPT files silently (at the project root, NOT in subdirectories). If Google Docs is enabled, also push to the Google Doc.

Remember: The "Prompts Up to date with Output" section must always be a SINGLE CONTINUOUS PARAGRAPH — never numbered, never bulleted.

**Exact file structure to create — section order is mandatory:**

```
# BUILD_SCRIPT.md

## Prompts Up to date with Output

[Single continuous paragraph]

## Project
**Name:** ...
**Overview:** ...
**Tech Stack:** ...
**Structure:** ...
**Features:** ...
**Commands:** ...
```

For BUILD_SCRIPT_FULL.md, the first Prompts RAW entry must be the verbatim invocation text only — nothing appended:

```
## Prompts RAW

1. /build_script
<!-- Rephrased prompt for "Prompts Up to date with Output": ... -->
```

The `<!-- Rephrased prompt... -->` annotation is on its own line below the verbatim entry. The numbered entry itself contains only exactly what the user typed.
