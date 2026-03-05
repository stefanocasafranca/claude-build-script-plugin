#!/usr/bin/env node
/**
 * Google Docs Sync v9.0 — Visual PTY Feedback + GitHub Auto-Push
 *
 * Writes an HMAC-signed queue file and triggers Claude Code via a three-tier
 * fallback chain to process Google Doc changes within ~11 seconds.
 *
 * v9.0 Changes from v8.1:
 * - CRITICAL FIX: PTY write to /dev/ttysNNN only displays text — it does NOT
 *   inject input into Claude Code's TUI. v8.0 treated PTY write as a successful
 *   trigger and skipped osascript, so the queue was NEVER consumed. v9.0 uses
 *   PTY write for visual feedback only, then ALWAYS proceeds to osascript for
 *   actual Enter keystroke injection via Accessibility API.
 * - Visual PTY feedback: writes '[build_script] Processing remote changes...'
 *   to the terminal for user visibility (display only, not input)
 * - Notification title bumped to "Build Script v9.0"
 *
 * v8.1 Changes from v8.0:
 * - Fixed nonce replay check: match QUEUE_READ only, not QUEUE_WRITE
 * - Fixed AppleScript tab enumeration: outer try/on error around tabs of w
 * - Fixed Claude TTY disambiguation: lsof-based CWD detection for multi-session
 * - Tailored injection prompts: delta-only, logs changes in BUILD_SCRIPT_FULL.md
 *
 * v8.0 Changes from v7.0:
 * - Three-tier trigger: PTY direct write → improved osascript → notification
 * - Tier 1 writes '\n' directly to Claude Code's /dev/ttysNNN (no window matching)
 * - Daemon self-exclusion via recorded PID/TTY
 * - findClaudeTTY() discovers Claude CLI process TTY from ps output
 * - AppleScript uses `key code 36` targeted at Terminal process (not generic keystroke)
 * - TTY-based Terminal.app tab matching (no window name dependency)
 * - stderr captured from osascript for diagnostic logging
 * - Notification includes diagnostic info (daemon TTY, failure reasons)
 *
 * v7.0 Changes from v6.0:
 * - Fixed Terminal.app osascript: match window name (not tab name)
 * - Queue file written with mode 0o600 (owner-only)
 * - Nonce replay protection via audit log check
 * - Default poll interval reduced from 2s to 1s
 *
 * Usage:
 *   node sync-gdoc.js --doc-id YOUR_DOC_ID [--project-dir /path] [--poll 1] [--no-agent] [--no-osascript]
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const { sanitize, signQueue, rateLimit, auditLog, verifyNonceUniqueness, generateSecret, DEFAULT_SECRET_PATH } = require('./security');
const { extractParagraph, diffParagraphs, formatDiffDetail } = require('./paragraph-diff');

function getArg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

// Read project config for auto-discovery (doc ID, etc.)
function readProjectConfig(projectDir) {
  const configPath = path.join(projectDir, '.build_script_config.json');
  try {
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
  } catch {
    // Config file is optional
  }
  return {};
}

const projectDir = getArg('--project-dir', process.cwd());
const projectConfig = readProjectConfig(projectDir);

const CONFIG = {
  docId: getArg('--doc-id', projectConfig.docId || process.env.GOOGLE_DOC_ID),
  projectDir,
  localFile: getArg('--local-file', 'BUILD_SCRIPT.md'),
  pollInterval: parseInt(getArg('--poll', '1')) * 1000,
  localDebounce: 3000,
  remoteDebounce: 10000, // 10-second inactivity debounce for remote changes
  tokenPath: path.join(require('os').homedir(), '.config/google-docs-mcp/token.json'),
  agentEnabled: !process.argv.includes('--no-agent'),
  hmacSecretPath: getArg('--hmac-secret-path', DEFAULT_SECRET_PATH),
  devPort: getArg('--dev-port', ''),
  tmuxPane: getArg('--tmux-pane', process.env.TMUX_PANE || ''),
  noOsascript: process.argv.includes('--no-osascript'),
};

// v8.0: Record daemon's own PID/TTY for self-exclusion
const DAEMON_STATE = {
  pid: process.pid,
  tty: null, // resolved in main()
};

if (!CONFIG.docId) {
  console.error('Error: Google Doc ID is required');
  console.error('Usage: node sync-gdoc.js --doc-id YOUR_DOC_ID [--project-dir /path]');
  process.exit(1);
}

let accessToken = null;
let tokenExpiry = 0;
let isSyncing = false;
let lastLocalHash = null;
let lastRemoteHash = null;

// Remote change debounce state
let remoteChangeTimer = null;
let pendingRemoteContent = null;
let pendingPreviousContent = null;

function log(msg, level = 'info') {
  const ts = new Date().toISOString();
  const colors = {
    info: '\x1b[36m[INFO]\x1b[0m',
    success: '\x1b[32m[OK]\x1b[0m',
    error: '\x1b[31m[ERROR]\x1b[0m',
    sync: '\x1b[35m[SYNC]\x1b[0m',
    local: '\x1b[34m[LOCAL]\x1b[0m',
    remote: '\x1b[33m[REMOTE]\x1b[0m',
    queue: '\x1b[33m[QUEUE]\x1b[0m',
    security: '\x1b[31m[SECURITY]\x1b[0m',
  };
  console.log(`${ts} ${colors[level] || colors.info} ${msg}`);
}

function hash(str) {
  return require('crypto').createHash('md5').update(str || '').digest('hex');
}

function normalize(str) {
  if (!str) return '';
  return str
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function contentHash(str) {
  return hash(normalize(str));
}

function httpRequest(options, postData) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data });
        }
      });
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

async function getAccessToken() {
  if (accessToken && Date.now() < tokenExpiry) return accessToken;
  const tokenData = JSON.parse(fs.readFileSync(CONFIG.tokenPath, 'utf8'));
  const postData = new URLSearchParams({
    client_id: tokenData.client_id,
    client_secret: tokenData.client_secret,
    refresh_token: tokenData.refresh_token,
    grant_type: 'refresh_token',
  }).toString();

  const res = await httpRequest({
    hostname: 'oauth2.googleapis.com',
    path: '/token',
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  }, postData);

  if (res.status !== 200) throw new Error(`Token refresh failed: ${JSON.stringify(res.data)}`);
  accessToken = res.data.access_token;
  tokenExpiry = Date.now() + (res.data.expires_in - 60) * 1000;
  return accessToken;
}

async function readGoogleDoc() {
  const token = await getAccessToken();
  const res = await httpRequest({
    hostname: 'docs.googleapis.com',
    path: `/v1/documents/${CONFIG.docId}`,
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });

  if (res.status !== 200) throw new Error(`Read failed (${res.status}): ${JSON.stringify(res.data)}`);

  let text = '';
  const body = res.data.body;
  if (body && body.content) {
    for (const element of body.content) {
      if (element.paragraph && element.paragraph.elements) {
        for (const elem of element.paragraph.elements) {
          if (elem.textRun && elem.textRun.content) {
            text += elem.textRun.content;
          }
        }
      }
    }
  }
  return text;
}

async function writeGoogleDoc(content) {
  if (!content || !content.trim()) {
    log('Skipping write: content is empty', 'sync');
    return false;
  }

  const token = await getAccessToken();
  const docRes = await httpRequest({
    hostname: 'docs.googleapis.com',
    path: `/v1/documents/${CONFIG.docId}`,
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });

  if (docRes.status !== 200) throw new Error(`Read for write failed: ${JSON.stringify(docRes.data)}`);

  const body = docRes.data.body;
  let endIndex = 1;
  if (body && body.content) {
    const lastElement = body.content[body.content.length - 1];
    if (lastElement) endIndex = lastElement.endIndex || 1;
  }

  const requests = [];
  if (endIndex > 2) {
    requests.push({
      deleteContentRange: { range: { startIndex: 1, endIndex: endIndex - 1 } }
    });
  }
  requests.push({
    insertText: { location: { index: 1 }, text: content }
  });

  const postData = JSON.stringify({ requests });
  const res = await httpRequest({
    hostname: 'docs.googleapis.com',
    path: `/v1/documents/${CONFIG.docId}:batchUpdate`,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  }, postData);

  if (res.status !== 200) throw new Error(`Write failed (${res.status}): ${JSON.stringify(res.data)}`);
  return true;
}

function readLocalFile() {
  const p = path.join(CONFIG.projectDir, CONFIG.localFile);
  try { return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null; } catch { return null; }
}

function writeLocalFile(content) {
  fs.writeFileSync(path.join(CONFIG.projectDir, CONFIG.localFile), content);
}

// ─── Prompts RAW reader ──────────────────────────────────────────────────────

function readPromptsRaw() {
  const fullPath = path.join(CONFIG.projectDir, 'BUILD_SCRIPT_FULL.md');
  try {
    if (!fs.existsSync(fullPath)) return null;
    const content = fs.readFileSync(fullPath, 'utf8');
    const marker = '## Prompts RAW';
    const idx = content.indexOf(marker);
    if (idx === -1) return null;
    return content.substring(idx);
  } catch {
    return null;
  }
}

// ─── Queue-based prompt injection (replaces triggerClaudeAgent) ──────────────

/**
 * Queue a prompt for the active Claude Code session.
 * Writes an HMAC-signed .build_script_queue.json that the Stop hook consumes.
 */
function queuePromptForSession(previousContent, newContent) {
  if (!CONFIG.agentEnabled) return;

  const auditPath = path.join(CONFIG.projectDir, '.build_script_audit.log');

  // Extract paragraphs and diff
  const oldParagraph = extractParagraph(previousContent || '');
  const newParagraph = extractParagraph(newContent || '');
  const diff = diffParagraphs(oldParagraph, newParagraph);

  if (!diff.added.length && !diff.removed.length && !diff.modified.length) {
    log('No meaningful paragraph changes detected', 'sync');
    return;
  }

  // Rate limit check
  if (!rateLimit(auditPath, 30000)) {
    log('Rate limited: minimum 30s between injections', 'security');
    auditLog(auditPath, {
      action: 'RATE_LIMITED',
      summary: diff.summary,
    });
    return;
  }

  // Build prompt data
  const promptData = {
    type: 'gdoc_diff',
    summary: diff.summary,
    previous_paragraph: sanitize(oldParagraph),
    current_paragraph: sanitize(newParagraph),
    diff_detail: sanitize(formatDiffDetail(diff)),
    raw_prompts_context: sanitize(readPromptsRaw() || ''),
  };

  // HMAC sign and write queue
  try {
    const signedQueue = signQueue(promptData, CONFIG.hmacSecretPath);

    // v7.0: Nonce replay protection — verify nonce hasn't been used before
    if (!verifyNonceUniqueness(signedQueue.nonce, auditPath)) {
      log('Duplicate nonce detected, skipping queue write', 'security');
      auditLog(auditPath, { action: 'NONCE_REPLAY_BLOCKED', nonce: signedQueue.nonce });
      return;
    }

    const queuePath = path.join(CONFIG.projectDir, '.build_script_queue.json');
    fs.writeFileSync(queuePath, JSON.stringify(signedQueue, null, 2), { mode: 0o600 });

    auditLog(auditPath, {
      action: 'QUEUE_WRITE',
      nonce: signedQueue.nonce,
      len: JSON.stringify(promptData).length,
      summary: diff.summary,
    });

    log(`Queued prompt for active session: ${diff.summary}`, 'queue');

    // Save previous paragraph for next diff
    const prevParagraphPath = path.join(CONFIG.projectDir, '.build_script_prev_paragraph.txt');
    fs.writeFileSync(prevParagraphPath, newParagraph);

    // Trigger Claude Code to process the queue immediately
    triggerSessionNudge();

  } catch (e) {
    log(`Failed to queue prompt: ${e.message}`, 'error');
    auditLog(auditPath, {
      action: 'QUEUE_ERROR',
      error: e.message,
    });
  }
}

// ─── v8.0: TTY discovery and AppleScript helpers ─────────────────────────────

/**
 * Find the TTY device for a running Claude Code CLI process.
 * Excludes the daemon's own TTY. Returns '/dev/ttysNNN' or null.
 */
function findClaudeTTY() {
  const { execSync } = require('child_process');
  try {
    const psOutput = execSync('ps -eo pid,tty,args', { encoding: 'utf8', timeout: 3000 });
    const lines = psOutput.split('\n');
    const candidates = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // Match lines where the command is the claude CLI binary (not this daemon)
      // Look for processes with 'claude' in args but not 'sync-gdoc' (this script)
      const match = trimmed.match(/^\s*(\d+)\s+(ttys\d+|\?)\s+(.+)$/);
      if (!match) continue;
      const [, pid, tty, args] = match;
      if (tty === '?' || tty === '??') continue;
      // Skip our own TTY
      if (DAEMON_STATE.tty && tty === DAEMON_STATE.tty) continue;
      // Match claude CLI processes (not this sync daemon, not node processes running this script)
      if (args.includes('sync-gdoc')) continue;
      // Look for the claude binary or 'claude' command
      if (/\bclaude\b/.test(args) && !args.includes('sync-gdoc.js')) {
        candidates.push({ pid: parseInt(pid), tty, args });
      }
    }

    if (candidates.length === 0) return null;

    if (candidates.length === 1) {
      const devPath = `/dev/${candidates[0].tty}`;
      log(`Found Claude TTY: ${devPath} (PID ${candidates[0].pid})`, 'queue');
      return devPath;
    }

    // Multiple candidates — disambiguate by checking which TTY has processes referencing our project dir
    const projectMatches = candidates.filter(c => c.args.includes(CONFIG.projectDir));
    if (projectMatches.length === 1) {
      const devPath = `/dev/${projectMatches[0].tty}`;
      log(`Found Claude TTY (project match): ${devPath} (PID ${projectMatches[0].pid})`, 'queue');
      return devPath;
    }

    // Still ambiguous — check which TTYs have processes with our project dir
    const ttySet = new Set(candidates.map(c => c.tty));
    for (const tty of ttySet) {
      // Check if any process on this TTY references our project
      const ttyProcs = lines.filter(l => {
        const m = l.trim().match(/^\s*\d+\s+(ttys\d+)\s+(.+)$/);
        return m && m[1] === tty && m[2].includes(CONFIG.projectDir);
      });
      if (ttyProcs.length > 0) {
        const devPath = `/dev/${tty}`;
        log(`Found Claude TTY (TTY-level project match): ${devPath}`, 'queue');
        return devPath;
      }
    }

    // v8.1: lsof-based CWD detection as final disambiguation attempt
    for (const candidate of candidates) {
      try {
        const lsofOutput = execSync(
          `lsof -a -d cwd -p ${candidate.pid} -Fn 2>/dev/null`,
          { encoding: 'utf8', timeout: 3000 }
        );
        const cwdLine = lsofOutput.split('\n').find(l => l.startsWith('n'));
        if (cwdLine && cwdLine.substring(1).startsWith(CONFIG.projectDir)) {
          const devPath = `/dev/${candidate.tty}`;
          log(`Found Claude TTY (lsof CWD match): ${devPath} (PID ${candidate.pid})`, 'queue');
          return devPath;
        }
      } catch { /* lsof failed for this candidate, try next */ }
    }

    log(`Ambiguous: ${candidates.length} Claude processes found, cannot determine TTY`, 'queue');
    return null;
  } catch (e) {
    log(`findClaudeTTY error: ${e.message}`, 'error');
    return null;
  }
}

/**
 * Build AppleScript to target a Terminal.app tab by its TTY device.
 * Uses `key code 36` (Return) targeted at Terminal process instead of generic `keystroke return`.
 */
function buildTerminalScriptByTTY(ttyPath) {
  const ttyName = path.basename(ttyPath); // e.g. 'ttys005'
  return [
    'tell application "Terminal"',
    '  set matched to false',
    '  repeat with w in windows',
    '    try',
    '      repeat with t in tabs of w',
    '        try',
    `          if tty of t is "/dev/${ttyName}" then`,
    '            set selected tab of w to t',
    '            set frontmost of w to true',
    '            delay 0.2',
    '            tell application "System Events" to tell process "Terminal" to key code 36',
    '            set matched to true',
    '            exit repeat',
    '          end if',
    '        end try',
    '      end repeat',
    '    on error',
    '      -- skip window with inaccessible tabs',
    '    end try',
    '    if matched then exit repeat',
    '  end repeat',
    '  if not matched then error "No tab with TTY ' + ttyName + '"',
    'end tell',
  ].join('\n');
}

/**
 * Build AppleScript to target a Terminal.app window by name, with daemon self-exclusion.
 */
function buildTerminalScriptByName(projectName) {
  const daemonTTY = DAEMON_STATE.tty ? `/dev/${DAEMON_STATE.tty}` : '';
  return [
    'tell application "Terminal"',
    '  set matched to false',
    '  repeat with w in windows',
    '    try',
    '      repeat with t in tabs of w',
    '        try',
    `          if name of w contains "${projectName}" then`,
    // Self-exclusion: skip tabs whose TTY matches the daemon
    ...(daemonTTY ? [
    `            if tty of t is not "${daemonTTY}" then`,
    ] : []),
    '              set selected tab of w to t',
    '              set frontmost of w to true',
    '              delay 0.2',
    '              tell application "System Events" to tell process "Terminal" to key code 36',
    '              set matched to true',
    ...(daemonTTY ? [
    '            end if',
    ] : []),
    '            exit repeat',
    '          end if',
    '        end try',
    '      end repeat',
    '    on error',
    '      -- skip window with inaccessible tabs',
    '    end try',
    '    if matched then exit repeat',
    '  end repeat',
    '  if not matched then error "No matching window for ' + projectName + '"',
    'end tell',
  ].join('\n');
}

/**
 * Build AppleScript for iTerm2 with relaxed name matching.
 */
function buildItermScript(projectName) {
  return [
    'tell application "iTerm2"',
    '  set matched to false',
    '  repeat with w in windows',
    '    repeat with t in tabs of w',
    '      repeat with s in sessions of t',
    `        if name of s contains "${projectName}" or name of s contains "claude" then`,
    '          select s',
    '          tell s to write text ""',
    '          set matched to true',
    '          exit repeat',
    '        end if',
    '      end repeat',
    '      if matched then exit repeat',
    '    end repeat',
    '    if matched then exit repeat',
    '  end repeat',
    '  if not matched then error "No matching session"',
    'end tell',
  ].join('\n');
}

// ─── v8.0: Three-tier session trigger ────────────────────────────────────────

/**
 * v9.0: Trigger the Claude Code session to process the queue.
 *
 * Two-step approach:
 *   Step 1 — Visual feedback: write message to PTY slave (display only, not input)
 *   Step 2 — Input trigger: osascript sends real Enter keystroke via Accessibility API
 *            Fallbacks: TTY tab match → name match → iTerm2 → tmux → notification
 *
 * CRITICAL: PTY slave write (/dev/ttysNNN) only DISPLAYS text on the terminal.
 * It does NOT inject input into Claude Code's TUI. osascript is the actual trigger.
 *
 * Security: only sends a literal Enter. HMAC verification in the hook is the security gate.
 */
function triggerSessionNudge() {
  const { execSync } = require('child_process');
  const projectName = path.basename(CONFIG.projectDir);
  const failures = [];

  // ── Step 1: Visual feedback via PTY write (display only) ──
  // IMPORTANT: Writing to PTY slave (/dev/ttysNNN) only DISPLAYS text on the
  // terminal — it does NOT inject input into Claude Code's TUI. We use this
  // purely for visual feedback, then ALWAYS proceed to osascript for actual
  // input triggering.
  const claudeTTY = findClaudeTTY();
  if (claudeTTY) {
    try {
      fs.writeFileSync(claudeTTY, '\x1b[33m[build_script]\x1b[0m Processing remote changes from Google Docs...\n');
      log(`Visual feedback written to ${claudeTTY} (PTY display only)`, 'queue');
    } catch (e) {
      log(`Visual feedback failed for ${claudeTTY}: ${e.message}`, 'error');
      // Non-fatal — continue to input trigger
    }
  }

  // ── Step 2: Actual input trigger via osascript ──
  // osascript sends a real Enter keystroke via Accessibility API, which Claude
  // Code's TUI processes as user input, firing the UserPromptSubmit hook.
  if (process.platform === 'darwin' && !CONFIG.noOsascript) {
    // 2a: Terminal.app — TTY-based tab match (most reliable)
    if (claudeTTY) {
      try {
        const script = buildTerminalScriptByTTY(claudeTTY);
        execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
          timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8'
        });
        log('Triggered Enter via osascript (TTY match) — queue should be consumed', 'queue');
        return;
      } catch (e) {
        const stderr = e.stderr ? e.stderr.trim() : e.message;
        failures.push(`osascript TTY match: ${stderr}`);
      }
    }

    // 2b: Terminal.app — name match with self-exclusion
    try {
      const script = buildTerminalScriptByName(projectName);
      execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
        timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8'
      });
      log('Triggered Enter via osascript (name match) — queue should be consumed', 'queue');
      return;
    } catch (e) {
      const stderr = e.stderr ? e.stderr.trim() : e.message;
      failures.push(`osascript name match: ${stderr}`);
    }

    // 2c: iTerm2
    try {
      const script = buildItermScript(projectName);
      execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
        timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8'
      });
      log('Triggered Enter via osascript (iTerm2) — queue should be consumed', 'queue');
      return;
    } catch (e) {
      const stderr = e.stderr ? e.stderr.trim() : e.message;
      failures.push(`osascript iTerm2: ${stderr}`);
    }
  }

  // ── Step 2 fallback: tmux send-keys ──
  if (process.env.TMUX || CONFIG.tmuxPane) {
    try {
      const pane = CONFIG.tmuxPane || '';
      if (pane) {
        execSync(`tmux send-keys -t "${pane}" "" Enter`, {
          timeout: 5000, stdio: ['pipe', 'pipe', 'pipe']
        });
        log('Triggered Enter via tmux send-keys', 'queue');
        return;
      }
    } catch (e) {
      failures.push(`tmux: ${e.message}`);
    }
  }

  // ── Step 3: macOS notification (last resort — user must press Enter manually) ──
  if (process.platform === 'darwin') {
    const diagParts = [`Daemon TTY: ${DAEMON_STATE.tty || 'unknown'}`];
    if (failures.length > 0) {
      diagParts.push(`Tried: ${failures.length} methods`);
    }
    const diagMsg = diagParts.join('. ');
    try {
      execSync(
        `osascript -e 'display notification "Google Doc updated — press Enter in Claude Code. ${diagMsg}" with title "Build Script v9.0" sound name "Ping"'`,
        { timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }
      );
      log(`Sent macOS notification (all auto-triggers failed). Failures: ${failures.join(' | ')}`, 'queue');
    } catch (e) {
      log(`All nudge methods failed. Failures: ${failures.join(' | ')}`, 'error');
    }
  } else {
    log(`No nudge method available. Failures: ${failures.join(' | ')}`, 'error');
  }
}

// ─── 10-second remote change debounce ────────────────────────────────────────

function onRemoteChangeDetected(previousContent, newContent) {
  pendingPreviousContent = previousContent;
  pendingRemoteContent = newContent;

  if (remoteChangeTimer) {
    clearTimeout(remoteChangeTimer);
    log('Remote still changing, resetting 10s timer...', 'remote');
  }

  log('Remote change detected — waiting 10s for editing to finish...', 'remote');

  remoteChangeTimer = setTimeout(() => {
    remoteChangeTimer = null;
    log('10s inactivity reached — processing remote change', 'remote');
    queuePromptForSession(pendingPreviousContent, pendingRemoteContent);
    pendingPreviousContent = null;
    pendingRemoteContent = null;
  }, CONFIG.remoteDebounce);
}

// ─── Sync cycle ──────────────────────────────────────────────────────────────

async function syncCycle() {
  if (isSyncing) return;
  isSyncing = true;

  try {
    let local = readLocalFile();
    if (local === null) {
      log('BUILD_SCRIPT.md not found locally — checking Google Doc...', 'sync');
      try {
        const remote = await readGoogleDoc();
        if (remote && remote.trim()) {
          log('Found content in Google Doc — creating local BUILD_SCRIPT.md', 'sync');
          writeLocalFile(remote);
          local = remote;
          lastLocalHash = contentHash(local);
          lastRemoteHash = lastLocalHash;
          log('Created BUILD_SCRIPT.md from Google Doc content', 'success');
          onRemoteChangeDetected(null, remote);
          return;
        }
      } catch (e) {
        log(`Could not read Google Doc: ${e.message}`, 'error');
      }
      log('Creating empty BUILD_SCRIPT.md scaffold...', 'sync');
      const scaffold = `# BUILD_SCRIPT\n\n## Prompts Up to date with Output\n\n\n## Project\n\n- **Name:** TBD\n- **Overview:** TBD\n- **Tech Stack:** TBD\n- **Structure:** TBD\n- **Features:** TBD\n- **Commands:** TBD\n`;
      writeLocalFile(scaffold);
      local = scaffold;
      lastLocalHash = contentHash(local);
      log('Created BUILD_SCRIPT.md scaffold', 'success');
      return;
    }

    const localH = contentHash(local);

    let remote;
    try {
      remote = await readGoogleDoc();
    } catch (e) {
      log(`Failed to read Google Doc: ${e.message}`, 'error');
      return;
    }
    const remoteH = contentHash(remote);

    if (!lastLocalHash) lastLocalHash = localH;
    if (!lastRemoteHash) lastRemoteHash = remoteH;

    const localChanged = localH !== lastLocalHash;
    const remoteChanged = remoteH !== lastRemoteHash;

    // v6.0: Diagnostic logging on every poll where something differs
    if (localChanged || remoteChanged) {
      log(`Poll: local=${localH.substring(0,8)} remote=${remoteH.substring(0,8)} localChanged=${localChanged} remoteChanged=${remoteChanged}`, 'sync');
    }

    if (localH === remoteH) {
      // In sync
    } else if (localChanged && !remoteChanged) {
      log('Local changed -> pushing to Google Doc', 'sync');
      await writeGoogleDoc(local);
      log('Pushed to Google Doc', 'success');
    } else if (remoteChanged && !localChanged) {
      log('Google Doc changed -> updating local file', 'sync');
      const previousContent = local;
      writeLocalFile(remote);
      log('Updated local BUILD_SCRIPT.md', 'success');
      // Use 10-second debounce instead of immediate agent spawn
      onRemoteChangeDetected(previousContent, remote);
    } else if (localChanged && remoteChanged) {
      log('CONFLICT: Both local and remote changed simultaneously!', 'error');
      log('Keeping local version. Remote saved as BUILD_SCRIPT.remote.md', 'error');
      fs.writeFileSync(path.join(CONFIG.projectDir, 'BUILD_SCRIPT.remote.md'), remote);
    } else {
      log('Initial mismatch -> pushing local to Google Doc', 'sync');
      await writeGoogleDoc(local);
      log('Initial sync complete', 'success');
    }

    // Update tracking hashes
    lastLocalHash = contentHash(readLocalFile());
    if (localH === remoteH) {
      try {
        lastRemoteHash = contentHash(await readGoogleDoc());
      } catch {
        lastRemoteHash = lastLocalHash;
      }
    } else {
      lastRemoteHash = lastLocalHash;
    }

  } catch (e) {
    log(`Sync error: ${e.message}`, 'error');
  } finally {
    isSyncing = false;
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  // Ensure HMAC secret exists
  try {
    generateSecret(CONFIG.hmacSecretPath);
  } catch (e) {
    log(`Warning: Could not generate HMAC secret: ${e.message}`, 'error');
  }

  // v8.0: Resolve daemon's own TTY for self-exclusion
  try {
    const { execSync } = require('child_process');
    const ttyRaw = execSync(`ps -p ${process.pid} -o tty=`, { encoding: 'utf8', timeout: 3000 }).trim();
    if (ttyRaw && ttyRaw !== '?' && ttyRaw !== '??') {
      DAEMON_STATE.tty = ttyRaw;
      log(`Daemon TTY: ${ttyRaw} (PID ${process.pid})`, 'info');
    } else {
      log(`Daemon TTY: not attached (PID ${process.pid})`, 'info');
    }
  } catch (e) {
    log(`Could not resolve daemon TTY: ${e.message}`, 'error');
  }

  const triggerMethod = CONFIG.noOsascript ? 'notification only' :
    process.platform === 'darwin' ? 'PTY write → osascript → notification' :
    process.env.TMUX ? 'tmux send-keys' : 'notification only';

  console.log(`
============================================================
  Google Docs Sync v9.0 — Visual Feedback + Auto-Trigger
============================================================
  Doc ID:      ${CONFIG.docId}
  Project:     ${CONFIG.projectDir}
  Local File:  ${CONFIG.localFile}
  Poll:        ${CONFIG.pollInterval / 1000}s
  Debounce:    ${CONFIG.remoteDebounce / 1000}s (remote inactivity)
  Injection:   ${CONFIG.agentEnabled ? 'ON (queue + auto-trigger)' : 'OFF'}
  Trigger:     ${triggerMethod}
  Daemon PID:  ${DAEMON_STATE.pid}
  Daemon TTY:  ${DAEMON_STATE.tty || 'not attached'}
  Dev Port:    ${CONFIG.devPort || 'not specified'}
============================================================
`);

  try {
    await getAccessToken();
    log('OAuth token valid', 'success');
  } catch (e) {
    log(`Token error: ${e.message}`, 'error');
    process.exit(1);
  }

  // v6.0: Startup validation — verify doc is readable and save config
  try {
    const docContent = await readGoogleDoc();
    const contentLen = docContent ? docContent.length : 0;
    log(`Doc validation: ${contentLen} chars, hash=${contentHash(docContent).substring(0,8)}`, 'success');

    // Save config for future auto-discovery
    const configPath = path.join(CONFIG.projectDir, '.build_script_config.json');
    const existingConfig = readProjectConfig(CONFIG.projectDir);
    if (existingConfig.docId && existingConfig.docId !== CONFIG.docId) {
      log(`WARNING: --doc-id (${CONFIG.docId}) differs from saved config (${existingConfig.docId})`, 'error');
    }
    const configData = { docId: CONFIG.docId, projectDir: CONFIG.projectDir, updatedAt: new Date().toISOString() };
    fs.writeFileSync(configPath, JSON.stringify(configData, null, 2));
    log('Saved doc ID to .build_script_config.json', 'info');
  } catch (e) {
    log(`WARNING: Could not validate doc on startup: ${e.message}`, 'error');
  }

  await syncCycle();

  setInterval(syncCycle, CONFIG.pollInterval);

  let debounce;
  setInterval(() => {
    const local = readLocalFile();
    if (local && contentHash(local) !== lastLocalHash) {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        log('Local file changed', 'local');
        syncCycle();
      }, CONFIG.localDebounce);
    }
  }, 2000);

  log('Watching for changes... (remote edits will be queued for active session)', 'success');
}

process.on('SIGINT', () => { log('Shutting down...'); process.exit(0); });
main();
