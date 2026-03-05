/**
 * security.js — Shared security module for build_script v8.0.0
 *
 * Provides HMAC signing/verification, input sanitization, rate limiting,
 * and audit logging for the prompt injection queue system.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_SECRET_PATH = path.join(
  require('os').homedir(),
  '.config',
  'build_script',
  'hmac_secret'
);

const MAX_PROMPT_LENGTH = 10000;
const MIN_INJECTION_INTERVAL_MS = 30000; // 30 seconds
const MAX_QUEUE_AGE_MS = 1800000; // 30 minutes — phone-to-laptop workflows need longer window

// ---------------------------------------------------------------------------
// HMAC Secret Management
// ---------------------------------------------------------------------------

function generateSecret(secretPath) {
  secretPath = secretPath || DEFAULT_SECRET_PATH;
  const dir = path.dirname(secretPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(secretPath)) {
    const secret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(secretPath, secret, { mode: 0o600 });
  }
  return fs.readFileSync(secretPath, 'utf8').trim();
}

function readSecret(secretPath) {
  secretPath = secretPath || DEFAULT_SECRET_PATH;
  if (!fs.existsSync(secretPath)) {
    return null;
  }
  return fs.readFileSync(secretPath, 'utf8').trim();
}

// ---------------------------------------------------------------------------
// HMAC Signing & Verification
// ---------------------------------------------------------------------------

function signQueue(promptData, secretPath) {
  const secret = readSecret(secretPath);
  if (!secret) {
    throw new Error('HMAC secret not found. Run /build_script to initialize.');
  }

  const nonce = crypto.randomBytes(16).toString('hex');
  const timestamp = Date.now();
  const payload = JSON.stringify({ nonce, timestamp, prompt: promptData });
  const hmac = crypto.createHmac('sha256', secret).update(payload).digest('hex');

  return {
    version: 1,
    queued_at: new Date(timestamp).toISOString(),
    consumed: false,
    nonce,
    timestamp,
    hmac,
    prompt: promptData,
  };
}

function verifyQueue(queueData, secretPath) {
  const secret = readSecret(secretPath);
  if (!secret) return { valid: false, reason: 'no_secret' };

  // Check consumed
  if (queueData.consumed) return { valid: false, reason: 'already_consumed' };

  // Check timestamp freshness
  const age = Date.now() - (queueData.timestamp || 0);
  if (age > MAX_QUEUE_AGE_MS) return { valid: false, reason: 'stale' };
  if (age < 0) return { valid: false, reason: 'future_timestamp' };

  // Verify HMAC
  const payload = JSON.stringify({
    nonce: queueData.nonce,
    timestamp: queueData.timestamp,
    prompt: queueData.prompt,
  });
  const expected = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');

  const valid = crypto.timingSafeEqual(
    Buffer.from(expected, 'hex'),
    Buffer.from(queueData.hmac || '', 'hex')
  );

  return valid ? { valid: true } : { valid: false, reason: 'hmac_mismatch' };
}

// ---------------------------------------------------------------------------
// Nonce Replay Protection (v7.0)
// ---------------------------------------------------------------------------

/**
 * Check the audit log for a previously consumed nonce.
 * Returns true if the nonce has NOT been seen before (safe to use).
 * Returns false if the nonce was already consumed (replay attack).
 */
function verifyNonceUniqueness(nonce, auditLogPath) {
  if (!nonce || !auditLogPath) return true;
  if (!fs.existsSync(auditLogPath)) return true;

  try {
    const content = fs.readFileSync(auditLogPath, 'utf8');
    return !content.includes(`QUEUE_READ nonce=${nonce}`);
  } catch {
    // If we can't read the log, allow the operation (fail-open for availability)
    return true;
  }
}

// ---------------------------------------------------------------------------
// Sanitization
// ---------------------------------------------------------------------------

function sanitize(text) {
  if (!text) return '';

  let result = text;

  // Strip ASCII control characters (0x00-0x1F) except newline (0x0A), tab (0x09)
  result = result.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  // Strip ANSI escape sequences
  result = result.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
  result = result.replace(/\x1b\][^\x07]*\x07/g, '');

  // Strip shell command substitution patterns
  result = result.replace(/\$\([^)]*\)/g, '[removed]');
  result = result.replace(/`[^`]*`/g, '[removed]');
  result = result.replace(/\$\{[^}]*\}/g, '[removed]');

  // Strip potential HTML/XML injection that could confuse system prompts
  result = result.replace(/<\/?(?:script|iframe|object|embed|form|input|style)[^>]*>/gi, '[removed]');

  // Enforce max length
  if (result.length > MAX_PROMPT_LENGTH) {
    result = result.substring(0, MAX_PROMPT_LENGTH) + '\n[TRUNCATED: exceeded 10,000 char limit]';
  }

  return result;
}

// ---------------------------------------------------------------------------
// Rate Limiting
// ---------------------------------------------------------------------------

function rateLimit(auditLogPath, minIntervalMs) {
  minIntervalMs = minIntervalMs || MIN_INJECTION_INTERVAL_MS;

  if (!fs.existsSync(auditLogPath)) return true;

  try {
    const content = fs.readFileSync(auditLogPath, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);

    // Find last QUEUE_WRITE entry
    for (let i = lines.length - 1; i >= 0; i--) {
      const match = lines[i].match(/^\[([^\]]+)\] QUEUE_WRITE/);
      if (match) {
        const lastTime = new Date(match[1]).getTime();
        const elapsed = Date.now() - lastTime;
        return elapsed >= minIntervalMs;
      }
    }
  } catch {
    // If we can't read the log, allow the operation
  }

  return true;
}

// ---------------------------------------------------------------------------
// Audit Logging
// ---------------------------------------------------------------------------

function auditLog(logPath, entry) {
  const timestamp = new Date().toISOString();
  const { action, ...rest } = entry;
  const details = Object.entries(rest)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');

  const line = `[${timestamp}] ${action} ${details}\n`;

  try {
    const fd = fs.openSync(logPath, 'a', 0o600);
    fs.writeSync(fd, line);
    fs.closeSync(fd);
  } catch {
    // Non-critical: don't crash if audit log can't be written
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  generateSecret,
  readSecret,
  signQueue,
  verifyQueue,
  verifyNonceUniqueness,
  sanitize,
  rateLimit,
  auditLog,
  DEFAULT_SECRET_PATH,
  MAX_PROMPT_LENGTH,
  MIN_INJECTION_INTERVAL_MS,
  MAX_QUEUE_AGE_MS,
};
