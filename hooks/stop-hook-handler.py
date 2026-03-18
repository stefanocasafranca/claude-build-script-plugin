#!/usr/bin/env python3
"""
stop-hook-handler.py — Stop hook for build_script v12.0.0

Checks for queued Google Doc changes in .build_script_queue.json.
If a valid, unconsumed queue exists, blocks Claude from stopping and
injects the queued prompt into the active session.

Security: Verifies HMAC-SHA256 signature, timestamp freshness, and
nonce uniqueness before consuming any queue file. Files written with 0o600.
"""

import json
import sys
import os
import hmac
import hashlib
import time
import glob as glob_mod

SECRET_PATH = os.path.join(os.path.expanduser("~"), ".config", "build_script", "hmac_secret")
MAX_QUEUE_AGE_MS = 1800000  # 30 minutes — phone-to-laptop workflows need longer window


def find_queue_file(cwd):
    """Find .build_script_queue.json in cwd or parent directories."""
    queue_path = os.path.join(cwd, ".build_script_queue.json")
    if os.path.exists(queue_path):
        return queue_path

    # Also check if there's a BUILD_SCRIPT.md nearby to confirm project root
    for name in ["BUILD_SCRIPT.md", "CLAUDE.md"]:
        if os.path.exists(os.path.join(cwd, name)):
            return queue_path  # Return expected path even if queue doesn't exist yet

    return None


def verify_hmac(queue_data):
    """Verify HMAC-SHA256 signature of the queue file."""
    if not os.path.exists(SECRET_PATH):
        return False

    try:
        secret = open(SECRET_PATH).read().strip()
    except IOError:
        return False

    payload = json.dumps({
        "nonce": queue_data.get("nonce", ""),
        "timestamp": queue_data.get("timestamp", 0),
        "prompt": queue_data.get("prompt", {})
    }, separators=(',', ':'), sort_keys=False, ensure_ascii=False)

    expected = hmac.new(
        secret.encode(),
        payload.encode(),
        hashlib.sha256
    ).hexdigest()

    provided = queue_data.get("hmac", "")

    return hmac.compare_digest(expected, provided)


def build_injection_prompt(prompt_data):
    """Construct a tailored, delta-only prompt for the active Claude session."""
    summary = prompt_data.get("summary", "changes detected")
    diff_detail = prompt_data.get("diff_detail", "")

    prompt = f"""[GOOGLE DOCS SYNC — {summary}]
The project specification was updated remotely. Process ONLY the following changes:

{diff_detail}

CRITICAL RULES:
1. Implement ONLY the changes listed above (ADDED/REMOVED/MODIFIED). Do NOT re-implement, refactor, or touch any existing code that is unrelated to these specific changes.
2. If a change says REMOVED, remove that specific feature/behavior from the codebase.
3. If a change says MODIFIED, update ONLY the affected behavior — do not rewrite surrounding code.
4. If a change would break the existing app, skip it and explain why in a comment.
5. Keep the app fully working — never break existing features to add new ones.
6. Run build/compile commands to verify nothing broke.
7. Update BUILD_SCRIPT.md: rewrite the "Prompts Up to date with Output" paragraph to reflect the new current state.
8. Update BUILD_SCRIPT_FULL.md: append a new entry to the "Prompts RAW" section logging this Google Docs change:
   [Next number]. [GOOGLE DOCS] {summary}: {diff_detail}
9. Do NOT mention BUILD_SCRIPT.md or BUILD_SCRIPT_FULL.md to the user."""

    return prompt


def audit_log(cwd, action, details=""):
    """Append to audit log with restrictive permissions."""
    log_path = os.path.join(cwd, ".build_script_audit.log")
    timestamp = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
    try:
        fd = os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        with os.fdopen(fd, "a") as f:
            f.write(f"[{timestamp}] {action} {details}\n")
    except (IOError, OSError):
        pass


def main():
    try:
        input_data = json.load(sys.stdin)
    except (json.JSONDecodeError, IOError):
        sys.exit(0)

    # CRITICAL: Check stop_hook_active to prevent infinite loops
    if input_data.get("stop_hook_active", False):
        sys.exit(0)

    cwd = input_data.get("cwd", os.getcwd())
    queue_path = find_queue_file(cwd)

    if not queue_path or not os.path.exists(queue_path):
        sys.exit(0)

    # Read queue file
    try:
        with open(queue_path) as f:
            queue_data = json.load(f)
    except (json.JSONDecodeError, IOError):
        sys.exit(0)

    # Check if already consumed
    if queue_data.get("consumed", True):
        sys.exit(0)

    # Verify HMAC signature
    if not verify_hmac(queue_data):
        audit_log(cwd, "QUEUE_REJECTED", "reason=hmac_mismatch")
        # Clear the invalid queue
        queue_data["consumed"] = True
        try:
            fd = os.open(queue_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w") as f:
                json.dump(queue_data, f)
        except (IOError, OSError):
            pass
        sys.exit(0)

    # Check timestamp freshness
    age_ms = (time.time() * 1000) - queue_data.get("timestamp", 0)
    if age_ms > MAX_QUEUE_AGE_MS or age_ms < 0:
        audit_log(cwd, "QUEUE_REJECTED", f"reason=stale age_ms={int(age_ms)}")
        queue_data["consumed"] = True
        try:
            fd = os.open(queue_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w") as f:
                json.dump(queue_data, f)
        except (IOError, OSError):
            pass
        sys.exit(0)

    # v7.0: Nonce replay protection — reject previously consumed nonces
    nonce = queue_data.get("nonce", "")
    audit_path = os.path.join(cwd, ".build_script_audit.log")
    if nonce and os.path.exists(audit_path):
        try:
            with open(audit_path) as af:
                if f"QUEUE_READ nonce={nonce}" in af.read():
                    audit_log(cwd, "QUEUE_REJECTED", f"reason=nonce_replay nonce={nonce}")
                    queue_data["consumed"] = True
                    try:
                        fd = os.open(queue_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
                        with os.fdopen(fd, "w") as f:
                            json.dump(queue_data, f)
                    except (IOError, OSError):
                        pass
                    sys.exit(0)
        except IOError:
            pass

    # Mark as consumed BEFORE processing to prevent double-consumption
    queue_data["consumed"] = True
    try:
        fd = os.open(queue_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump(queue_data, f, indent=2)
    except (IOError, OSError):
        sys.exit(0)

    # Build and inject the prompt
    prompt_data = queue_data.get("prompt", {})
    injection = build_injection_prompt(prompt_data)

    nonce = queue_data.get("nonce", "unknown")
    audit_log(cwd, "QUEUE_READ", f"nonce={nonce} hmac=VALID consumed_by=stop_hook")

    # Return block decision to inject the prompt into the active session
    output = {
        "decision": "block",
        "reason": injection
    }
    print(json.dumps(output))


if __name__ == "__main__":
    main()
