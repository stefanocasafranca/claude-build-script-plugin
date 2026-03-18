#!/usr/bin/env node
/**
 * Google Docs Sync v16.0 — Structured Log Format, Quality Gate Auto-Injection
 *
 * v16.0 Changes from v15.0:
 * - NEW: appendToFullLog() now appends <!-- Rephrased prompt for "Prompts Up to date
 *   with Output": ADD: "..." | CHANGED: "old" → "new" --> comment on every GDocs entry.
 * - NEW: buildInjectionPrompt() appends a quality gate HTML comment to every GDocs
 *   injection so Claude verifies features end-to-end before finishing.
 * - FIX: Rephrase inline annotation now uses HTML comment syntax (<!-- -->) instead of //
 * - REFACTOR: formatComment() added to paragraph-diff.js; imported here.
 *
 * v15.0 Changes from v14.0:
 * - FIX: Feedback loop eliminated: after a local→remote push (Claude's own write),
 *   the paragraph baseline (.build_script_prev_paragraph.txt) is immediately
 *   advanced. Prevents the daemon from seeing that Google Doc update as a user
 *   edit and firing a second injection.
 * - FIX: Prompt log deduplication: appendToFullLog() now detects rephrase/refinement
 *   entries (within 2 min, >50% word overlap) and annotates the existing entry inline
 *   instead of creating a new numbered entry in BUILD_SCRIPT_FULL.md.
 * - FIX: Dev server auto-reload: SKILL.md now stores devCommand in
 *   .build_script_config.json and adds a CLAUDE.md rule requiring the hot-reload
 *   variant always. Non-technical users see browser auto-refresh.
 *
 * v14.0 Changes from v13.0:
 * - FIX: start-sync.sh template now calls sync-gdoc.js directly (--daemonize)
 *   instead of start-all.sh. Prevents hang on non-JS projects (e.g. .NET, Go,
 *   Rust) where start-all.sh fell back to live-server and blocked indefinitely.
 * - UX: start-sync.sh now tails daemon.log after spawning so the terminal shows
 *   live activity instead of returning to a blank prompt.
 *
 * v13.0 Changes from v12.0:
 * - FIX: TIOCSTI retry storm: attemptInjection() now marks delivered:true in
 *   pending.json after first successful TIOCSTI call, then switches to
 *   pollForConfirmation() (30s intervals) — never injects again. Retries
 *   injection ONLY on actual TIOCSTI failure (exception thrown). Eliminates
 *   the N×5s duplicate injection loop that caused up to 11 identical messages.
 * - FIX: Multiple daemon instances: acquireDaemonLock() uses PID file +
 *   process.kill(pid,0) liveness check. Kills existing daemon on startup.
 *   Releases lock on SIGINT/SIGTERM/exit. Prevents two daemons from racing.
 *
 * v12.0 Changes from v11.0:
 * - FIX: 429 rate-limit storm: readGoogleDocSafe() wraps readGoogleDoc() with
 *   exponential backoff (5s → 10s → 20s → … → 120s max). Prevents hammering
 *   the API after quota exhaustion.
 * - FIX: Removed redundant extra readGoogleDoc() call at end of syncCycle()
 *   when already in sync — was doubling API usage every poll.
 * - FIX: Spurious full-paragraph injection on daemon resume: queuePromptForSession
 *   now reads .build_script_prev_paragraph.txt as the comparison baseline instead
 *   of re-extracting from the local file snapshot. Baseline is initialized from
 *   the Google Doc on first startup, so restarts only inject genuine deltas.
 * - FIX: osascript / System Events hang on macOS Sequoia moved to tiocsti_inject.py
 *   (_macos_app_running now uses pgrep -x instead of AppleScript).
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
const { extractParagraph, diffParagraphs, formatDiffDetail, formatComment } = require('./paragraph-diff');

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
};

// v8.0: Record daemon's own PID/TTY for self-exclusion
const DAEMON_STATE = {
  pid: process.pid,
  tty: null, // resolved in main()
};

// v13.0: Daemon singleton lock file path
const LOCK_FILE = path.join(CONFIG.projectDir, '.build_script', 'daemon.lock');

// v13.0: Injection timing constants
const INJECT_RETRY_INTERVAL_MS = 5000;  // retry failed injection every 5s
const CONFIRM_POLL_INTERVAL_MS = 30000; // poll for confirmation every 30s
const MAX_INJECT_RETRIES = 12;          // 12 × 5s = 60s max before fallback
const MAX_CONFIRM_POLLS = 12;           // 12 × 30s = 6min max wait for confirmation

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

// v12.0: Exponential backoff state for 429 rate-limit recovery
let consecutiveReadFailures = 0;
let readBackoffUntil = 0;

// Remote change debounce state
let remoteChangeTimer = null;
let pendingRemoteContent = null;
let pendingPreviousContent = null;

// v15.0: Rephrase detection state for appendToFullLog() deduplication.
// Tracks the most recent full-log entry within this daemon session so rephrases
// can be annotated inline instead of creating duplicate numbered entries.
let lastFullLogEntry = { text: '', time: 0, num: 0 };

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

// v12.0: Wrap readGoogleDoc with exponential backoff on 429 (5s→10s→20s→…→120s)
async function readGoogleDocSafe() {
  if (Date.now() < readBackoffUntil) {
    const remaining = Math.ceil((readBackoffUntil - Date.now()) / 1000);
    throw new Error(`Rate-limit backoff active — ${remaining}s remaining`);
  }
  try {
    const result = await readGoogleDoc();
    consecutiveReadFailures = 0;
    readBackoffUntil = 0;
    return result;
  } catch (e) {
    if (e.message && e.message.includes('429')) {
      consecutiveReadFailures++;
      const backoffMs = Math.min(Math.pow(2, consecutiveReadFailures - 1) * 5000, 120000);
      readBackoffUntil = Date.now() + backoffMs;
      log(`Rate limit (429) — backoff ${Math.round(backoffMs / 1000)}s (failure #${consecutiveReadFailures})`, 'error');
    }
    throw e;
  }
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

// v12.0: Read persisted paragraph baseline — survives daemon restarts
function readPrevParagraph() {
  const p = path.join(CONFIG.projectDir, '.build_script_prev_paragraph.txt');
  try { return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim() || null : null; } catch { return null; }
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

// ─── v10.0: TIOCSTI-based injection ──────────────────────────────────────────

/**
 * Convert a sentence-level diff into a single coherent natural-language prompt.
 * All three change types (added, removed, modified) are combined into one string
 * that Claude can act on in a single response.
 */
function buildInjectionPrompt(diff) {
  const parts = [];
  for (const s of diff.added) {
    parts.push(`Add: ${s}`);
  }
  for (const s of diff.removed) {
    parts.push(`Remove: ${s}`);
  }
  for (const m of diff.modified) {
    parts.push(`Update "${m.old}" -> "${m.new}"`);
  }
  return parts.join('. ');
}

/**
 * Inject a prompt string into the given TTY's input buffer using TIOCSTI.
 * Characters appear visibly in the Claude Code terminal as if typed by the user.
 * Final \n fires Enter, causing Claude Code to process the prompt.
 */
function injectPromptViaTIOCSTI(ttyPath, promptText) {
  const { execFileSync } = require('child_process');
  const scriptPath = path.join(__dirname, 'tiocsti_inject.py');
  execFileSync('python3', [scriptPath, ttyPath, promptText], {
    timeout: 10000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/**
 * v15.0: Jaccard word-overlap between two strings (case-insensitive).
 * Returns a value in [0, 1]: 1 = identical word sets, 0 = no common words.
 * Used by appendToFullLog() to detect rephrase/refinement entries.
 */
function wordOverlap(a, b) {
  const words = s => new Set((s || '').toLowerCase().match(/\b\w+\b/g) || []);
  const setA = words(a);
  const setB = words(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let common = 0;
  for (const w of setA) { if (setB.has(w)) common++; }
  return common / Math.max(setA.size, setB.size);
}

/**
 * Immediately append a raw entry to BUILD_SCRIPT_FULL.md.
 * Called before injection so the record survives even if injection fails.
 *
 * v16.0: accepts diff to build the <!-- Rephrased prompt for "Prompts Up to date
 * with Output": ADD: "..." --> annotation; rephrase inline annotation uses HTML
 * comment syntax instead of //.
 */
function appendToFullLog(promptText, diff) {
  const fullPath = path.join(CONFIG.projectDir, 'BUILD_SCRIPT_FULL.md');
  try {
    let content = '';
    if (fs.existsSync(fullPath)) {
      content = fs.readFileSync(fullPath, 'utf8');
    }

    const marker = '## Prompts RAW';

    // v15.0: Rephrase detection — annotate last entry inline instead of creating
    // a new numbered entry if the new prompt is semantically the same intent:
    // condition: within 2 minutes AND >50% Jaccard word overlap.
    if (
      content.includes(marker) &&
      lastFullLogEntry.num > 0 &&
      lastFullLogEntry.text &&
      Date.now() - lastFullLogEntry.time < 120_000
    ) {
      const overlap = wordOverlap(lastFullLogEntry.text, promptText);
      if (overlap > 0.5) {
        // Find the last numbered entry line and append annotation after it
        const entryPrefix = `${lastFullLogEntry.num}. [GOOGLE DOCS]`;
        const lastIdx = content.lastIndexOf(entryPrefix);
        if (lastIdx !== -1) {
          // v16.0: find end of the entry block (past any existing comment lines)
          let blockEnd = content.indexOf('\n', lastIdx);
          if (blockEnd !== -1) {
            // Advance past any existing <!-- ... --> comment lines belonging to this entry
            let nextNewline = content.indexOf('\n', blockEnd + 1);
            while (nextNewline !== -1) {
              const segment = content.substring(blockEnd + 1, nextNewline).trim();
              if (segment.startsWith('<!--') || segment === '') {
                blockEnd = nextNewline;
                nextNewline = content.indexOf('\n', blockEnd + 1);
              } else {
                break;
              }
            }
          }
          const insertAt = blockEnd === -1 ? content.length : blockEnd;
          // v16.0: use HTML comment syntax instead of //
          const annotation = `\n<!-- BUILD_SCRIPT.md rephrased as: ${promptText} -->`;
          content = content.substring(0, insertAt) + annotation + content.substring(insertAt);
          fs.writeFileSync(fullPath, content, 'utf8');
          log(`BUILD_SCRIPT_FULL.md: annotated entry #${lastFullLogEntry.num} as rephrase (overlap=${Math.round(overlap * 100)}%)`, 'queue');
          lastFullLogEntry = { ...lastFullLogEntry, time: Date.now() };
          return;
        }
      }
    }

    let nextNum = 1;

    if (content.includes(marker)) {
      const after = content.substring(content.indexOf(marker) + marker.length);
      const entries = after.match(/^\d+\./gm);
      if (entries && entries.length > 0) {
        nextNum = entries.length + 1;
      }
    } else {
      // Append the section header
      content = content.trimEnd() + '\n\n## Prompts RAW\n';
    }

    // v16.0: build the rephrase comment from the diff
    const comment = diff ? formatComment(diff) : '';
    let rawEntry = `\n${nextNum}. [GOOGLE DOCS] ${promptText}`;
    if (comment) {
      rawEntry += `\n<!-- Rephrased prompt for "Prompts Up to date with Output": ${comment} -->`;
    }

    // Insert before or after marker
    if (content.includes(marker)) {
      content = content.trimEnd() + rawEntry + '\n';
    } else {
      content = content + rawEntry + '\n';
    }

    fs.writeFileSync(fullPath, content, 'utf8');
    log(`BUILD_SCRIPT_FULL.md: appended entry #${nextNum}`, 'queue');
    lastFullLogEntry = { text: promptText, time: Date.now(), num: nextNum };
  } catch (e) {
    log(`appendToFullLog error: ${e.message}`, 'error');
  }
}

// ─── Queue-based prompt injection ────────────────────────────────────────────

/**
 * Queue a prompt for the active Claude Code session.
 * Writes an HMAC-signed .build_script_queue.json that the Stop hook consumes.
 */
function queuePromptForSession(previousContent, newContent) {
  if (!CONFIG.agentEnabled) return;

  const auditPath = path.join(CONFIG.projectDir, '.build_script_audit.log');

  // v12.0: Use persisted baseline so daemon restarts don't re-inject already-processed changes.
  // Falls back to extracting from the local file snapshot only when no baseline file exists.
  const persistedPrev = readPrevParagraph();

  if (persistedPrev === null && !previousContent) {
    // First-ever run with no baseline: save Google Doc state as starting point, don't inject.
    const initPara = extractParagraph(newContent || '');
    if (initPara) {
      try {
        fs.writeFileSync(path.join(CONFIG.projectDir, '.build_script_prev_paragraph.txt'), initPara, 'utf8');
        log('First-run: saved initial paragraph baseline — no injection', 'sync');
      } catch {}
    }
    return;
  }

  const oldParagraph = persistedPrev !== null ? persistedPrev : extractParagraph(previousContent || '');
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

  // v10.0: Build injection prompt covering ALL change types
  // v16.0: base prompt is logged; quality gate is appended for Claude only
  const basePrompt = buildInjectionPrompt(diff);
  const injectionPrompt = basePrompt +
    '\n\n<!-- Quality gate: Do not mark this complete until the feature is verified working end-to-end in the browser. Test it before finishing. -->';

  // v10.0: Write BUILD_SCRIPT_FULL.md IMMEDIATELY before injection
  // (record survives even if injection fails)
  // v16.0: pass diff so the log entry gets the ADD:/CHANGED:/REMOVED: comment
  appendToFullLog(basePrompt, diff);

  // v10.0: Write pending state — baseline NOT advanced yet
  // .build_script_prev_paragraph.txt still holds OLD content.
  // On retry, diffParagraphs() will recompute the same diff from the unchanged baseline.
  const nonce = require('crypto').randomBytes(16).toString('hex');
  const pendingPath = path.join(CONFIG.projectDir, '.build_script_pending.json');
  const pendingData = {
    pending: true,
    text: injectionPrompt,
    nonce,
    injected_at: Date.now(),
    new_paragraph: newParagraph,
  };
  try {
    fs.writeFileSync(pendingPath, JSON.stringify(pendingData, null, 2), { mode: 0o600 });
    log(`Pending state written (nonce=${nonce.substring(0, 8)}...)`, 'queue');
  } catch (e) {
    log(`Failed to write pending state: ${e.message}`, 'error');
  }

  // Also write HMAC-signed queue for backward compatibility with hook-based fallback
  try {
    const promptData = {
      type: 'gdoc_diff',
      summary: diff.summary,
      previous_paragraph: sanitize(oldParagraph),
      current_paragraph: sanitize(newParagraph),
      diff_detail: sanitize(formatDiffDetail(diff)),
      raw_prompts_context: sanitize(readPromptsRaw() || ''),
    };
    const signedQueue = signQueue(promptData, CONFIG.hmacSecretPath);
    if (verifyNonceUniqueness(signedQueue.nonce, auditPath)) {
      const queuePath = path.join(CONFIG.projectDir, '.build_script_queue.json');
      fs.writeFileSync(queuePath, JSON.stringify(signedQueue, null, 2), { mode: 0o600 });
      auditLog(auditPath, {
        action: 'QUEUE_WRITE',
        nonce: signedQueue.nonce,
        len: JSON.stringify(promptData).length,
        summary: diff.summary,
      });
    }
  } catch (e) {
    log(`Queue write error (non-fatal): ${e.message}`, 'error');
  }

  log(`Injection prompt: "${injectionPrompt.substring(0, 80)}..."`, 'queue');

  // Attempt TIOCSTI injection with retry
  attemptInjection(pendingPath, injectionPrompt);
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

// ─── v13.0: Daemon singleton lock ────────────────────────────────────────────

/**
 * Release the daemon lock file if it belongs to this process.
 */
function releaseDaemonLock() {
  try {
    const content = fs.readFileSync(LOCK_FILE, 'utf8').trim();
    if (parseInt(content) === process.pid) {
      fs.unlinkSync(LOCK_FILE);
    }
  } catch { /* already gone or unreadable */ }
}

/**
 * Acquire exclusive daemon lock. If another instance is running, kill it first.
 * Uses PID file + process.kill(pid, 0) liveness check — the lock is released
 * automatically when the process exits (via exit/SIGINT/SIGTERM handlers).
 */
function acquireDaemonLock() {
  const lockDir = path.dirname(LOCK_FILE);
  try { fs.mkdirSync(lockDir, { recursive: true }); } catch {}

  if (fs.existsSync(LOCK_FILE)) {
    let existingPid = null;
    try { existingPid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim()); } catch {}

    if (existingPid && existingPid !== process.pid) {
      let isRunning = false;
      try { process.kill(existingPid, 0); isRunning = true; } catch {}

      if (isRunning) {
        log(`Existing daemon (PID ${existingPid}) found — sending SIGTERM`, 'info');
        try { process.kill(existingPid, 'SIGTERM'); } catch {}
        // Busy-wait up to 2s for old daemon to exit before overwriting lock
        const deadline = Date.now() + 2000;
        while (Date.now() < deadline) {
          try { process.kill(existingPid, 0); } catch { break; }
          const t = Date.now() + 100; while (Date.now() < t) {} // 100ms spin
        }
      } else {
        log(`Stale lock (PID ${existingPid} not running) — taking over`, 'info');
      }
    }
  }

  fs.writeFileSync(LOCK_FILE, String(process.pid), { mode: 0o600 });
  log(`Daemon lock acquired (PID ${process.pid})`, 'info');
}

// ─── v13.0: TIOCSTI injection with delivery/confirmation separation ───────────

/**
 * Mark pending.json as delivered after successful TIOCSTI.
 * Prevents re-injection even if the retry loop fires again.
 */
function markDelivered(pendingPath) {
  try {
    const pending = JSON.parse(fs.readFileSync(pendingPath, 'utf8'));
    if (!pending.delivered) {
      pending.delivered = true;
      fs.writeFileSync(pendingPath, JSON.stringify(pending, null, 2), { mode: 0o600 });
    }
  } catch { /* non-fatal */ }
}

/**
 * Poll pending.json for hook confirmation (pending:false).
 * Called ONCE after successful TIOCSTI delivery. Advances baseline when confirmed.
 * Never injects again — only waits.
 */
function pollForConfirmation(pendingPath, pollCount) {
  pollCount = pollCount || 0;
  setTimeout(() => {
    let pending;
    try {
      pending = JSON.parse(fs.readFileSync(pendingPath, 'utf8'));
    } catch {
      return; // file gone — stop polling
    }

    if (!pending.pending) {
      log('Injection confirmed by hook — advancing paragraph baseline', 'queue');
      const prevParagraphPath = path.join(CONFIG.projectDir, '.build_script_prev_paragraph.txt');
      try { fs.writeFileSync(prevParagraphPath, pending.new_paragraph || ''); } catch {}
      return;
    }

    if (pollCount < MAX_CONFIRM_POLLS) {
      log(`Awaiting confirmation... poll ${pollCount + 1}/${MAX_CONFIRM_POLLS}`, 'queue');
      pollForConfirmation(pendingPath, pollCount + 1);
    } else {
      // Timed out (6 min) — advance baseline anyway to prevent permanent stall
      log('Confirmation timeout — advancing baseline to prevent stall', 'queue');
      try {
        const prevParagraphPath = path.join(CONFIG.projectDir, '.build_script_prev_paragraph.txt');
        fs.writeFileSync(prevParagraphPath, pending.new_paragraph || '');
      } catch {}
    }
  }, CONFIRM_POLL_INTERVAL_MS);
}

/**
 * v13.0: Attempt TIOCSTI injection with strict delivery/confirmation separation.
 *
 * State machine:
 *   pending:true, delivered:false → try to inject (retry on failure only)
 *   pending:true, delivered:true  → already sent, poll for confirmation (no inject)
 *   pending:false                 → confirmed, advance baseline, done
 */
function attemptInjection(pendingPath, promptText, retryCount) {
  retryCount = retryCount || 0;

  // Read current pending state
  let pending;
  try {
    pending = JSON.parse(fs.readFileSync(pendingPath, 'utf8'));
  } catch {
    return; // file gone — stop
  }

  // State: confirmed — advance baseline and stop
  if (!pending.pending) {
    log('Injection confirmed — advancing paragraph baseline', 'queue');
    const prevParagraphPath = path.join(CONFIG.projectDir, '.build_script_prev_paragraph.txt');
    try { fs.writeFileSync(prevParagraphPath, pending.new_paragraph || ''); } catch {}
    return;
  }

  // State: delivered but not yet confirmed — only poll, never inject again
  if (pending.delivered) {
    log('Injection already delivered — switching to confirmation polling', 'queue');
    pollForConfirmation(pendingPath, 0);
    return;
  }

  // State: not yet delivered — attempt TIOCSTI
  const claudeTTY = findClaudeTTY();

  if (claudeTTY) {
    try {
      injectPromptViaTIOCSTI(claudeTTY, promptText);
      log(`[INJECT] TIOCSTI -> ${claudeTTY} (attempt ${retryCount + 1})`, 'queue');

      // Mark delivered immediately — no further injection attempts regardless of outcome
      markDelivered(pendingPath);

      // Switch to confirmation polling (30s intervals, never injects again)
      pollForConfirmation(pendingPath, 0);
      return;
    } catch (e) {
      log(`TIOCSTI failed (attempt ${retryCount + 1}): ${e.message}`, 'error');
    }
  } else {
    log(`Claude TTY not found (attempt ${retryCount + 1})`, 'error');
  }

  // Injection delivery failed — retry injection after 5s
  if (retryCount < MAX_INJECT_RETRIES) {
    log(`Retrying injection in 5s... (${retryCount + 1}/${MAX_INJECT_RETRIES})`, 'queue');
    setTimeout(() => attemptInjection(pendingPath, promptText, retryCount + 1), INJECT_RETRY_INTERVAL_MS);
  } else {
    log('Max injection retries — fallback notification', 'error');
    sendFallbackNotification();
    // Still poll so baseline advances if user manually triggers Claude
    pollForConfirmation(pendingPath, 0);
  }
}

/**
 * Send a macOS notification as last resort when TIOCSTI injection fails.
 */
function sendFallbackNotification() {
  if (process.platform !== 'darwin') return;
  try {
    const { execSync } = require('child_process');
    execSync(
      `osascript -e 'display notification "Google Doc updated — press Enter in Claude Code" with title "Build Script v15.0" sound name "Ping"'`,
      { timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    log('Sent macOS fallback notification', 'queue');
  } catch (e) {
    log(`Fallback notification failed: ${e.message}`, 'error');
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
        const remote = await readGoogleDocSafe();
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
      remote = await readGoogleDocSafe();
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
      // v15.0: Advance paragraph baseline immediately after Claude's own local→remote push.
      // Without this, the next sync cycle sees the Google Doc changed (it was our own push)
      // and fires a second injection as if the user edited the doc — feedback loop.
      // Advancing the baseline here tells queuePromptForSession() there is nothing new.
      const prevParagraphPath = path.join(CONFIG.projectDir, '.build_script_prev_paragraph.txt');
      const currentParagraph = extractParagraph(local);
      if (currentParagraph) {
        try {
          fs.writeFileSync(prevParagraphPath, currentParagraph, 'utf8');
          log('Baseline advanced after local→remote sync (feedback loop prevented)', 'sync');
        } catch (e) {
          log(`Could not advance baseline: ${e.message}`, 'error');
        }
      }
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

    // Update tracking hashes (v12.0: no extra read when in sync — use already-known hash)
    lastLocalHash = contentHash(readLocalFile());
    lastRemoteHash = localH === remoteH ? remoteH : lastLocalHash;

  } catch (e) {
    log(`Sync error: ${e.message}`, 'error');
  } finally {
    isSyncing = false;
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  // v11.0: Self-daemonize if --daemonize flag is passed and we're in a TTY
  if (process.argv.includes('--daemonize') && process.stdin.isTTY) {
    const daemonDir = path.join(CONFIG.projectDir, '.build_script');
    fs.mkdirSync(daemonDir, { recursive: true });
    const logFile = path.join(daemonDir, 'daemon.log');
    const pidFile = path.join(daemonDir, 'daemon.pid');
    const args = process.argv.slice(1).filter(a => a !== '--daemonize');
    const logFd = fs.openSync(logFile, 'a');
    const child = require('child_process').spawn(process.execPath, args, {
      detached: true,
      stdio: ['ignore', logFd, logFd],
    });
    child.unref();
    fs.writeFileSync(pidFile, String(child.pid));
    console.log(`Build Script daemon running (PID ${child.pid})`);
    console.log(`Logs:  tail -f ${logFile}`);
    console.log(`Stop:  kill ${child.pid}  (or bash stop-sync.sh)`);
    process.exit(0);
  }

  // v13.0: Acquire daemon singleton lock — kills any existing daemon first
  acquireDaemonLock();

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

  const triggerMethod = process.platform === 'darwin'
    ? 'PTY TIOCSTI → paste (any terminal) → retry 5s'
    : 'xdotool/ydotool → notification';

  console.log(`
============================================================
  Google Docs Sync v15.0 — Feedback-Loop Fix, Log Deduplication, Auto-Reload
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
    const docContent = await readGoogleDocSafe();
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

    // v12.0: Initialize paragraph baseline on first startup — prevents spurious full-paragraph
    // injection when daemon resumes on a project that already has history.
    const prevParaPath = path.join(CONFIG.projectDir, '.build_script_prev_paragraph.txt');
    if (!fs.existsSync(prevParaPath) && docContent) {
      const initPara = extractParagraph(docContent);
      if (initPara) {
        try {
          fs.writeFileSync(prevParaPath, initPara, 'utf8');
          log('Initialized paragraph baseline from Google Doc', 'info');
        } catch {}
      }
    }
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

// v13.0: Release lock on all exit paths
process.on('SIGINT', () => { releaseDaemonLock(); log('Shutting down...'); process.exit(0); });
process.on('SIGTERM', () => { releaseDaemonLock(); log('Shutting down (SIGTERM)...'); process.exit(0); });
process.on('exit', releaseDaemonLock);
main();
