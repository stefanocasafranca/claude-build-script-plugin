#!/bin/bash
#
# Post-Tool Handler for Document-as-System Research Plugin
#
# Auto-commits changes to BUILD_SCRIPT.md for research provenance tracking.
# This creates a git history of how the specification evolved.
#

# Get the current working directory from environment or use pwd
CWD="${CLAUDE_CWD:-$(pwd)}"

# Check if we're in a git repository
if ! git -C "$CWD" rev-parse --git-dir > /dev/null 2>&1; then
    exit 0
fi

# Track if any files need committing
NEEDS_COMMIT=false

# Check BUILD_SCRIPT.md
if [ -f "$CWD/BUILD_SCRIPT.md" ]; then
    if ! git -C "$CWD" diff --quiet "$CWD/BUILD_SCRIPT.md" 2>/dev/null || \
       ! git -C "$CWD" diff --cached --quiet "$CWD/BUILD_SCRIPT.md" 2>/dev/null || \
       [ -z "$(git -C "$CWD" ls-files "$CWD/BUILD_SCRIPT.md" 2>/dev/null)" ]; then
        git -C "$CWD" add "$CWD/BUILD_SCRIPT.md" 2>/dev/null
        NEEDS_COMMIT=true
    fi
fi

# Check BUILD_SCRIPT_FULL.md
if [ -f "$CWD/BUILD_SCRIPT_FULL.md" ]; then
    if ! git -C "$CWD" diff --quiet "$CWD/BUILD_SCRIPT_FULL.md" 2>/dev/null || \
       ! git -C "$CWD" diff --cached --quiet "$CWD/BUILD_SCRIPT_FULL.md" 2>/dev/null || \
       [ -z "$(git -C "$CWD" ls-files "$CWD/BUILD_SCRIPT_FULL.md" 2>/dev/null)" ]; then
        git -C "$CWD" add "$CWD/BUILD_SCRIPT_FULL.md" 2>/dev/null
        NEEDS_COMMIT=true
    fi
fi

# Commit if there are changes
if [ "$NEEDS_COMMIT" = true ]; then
    TIMESTAMP=$(date +"%Y-%m-%d %H:%M:%S")
    git -C "$CWD" commit -m "[invisible-doc] Spec update at $TIMESTAMP" \
        --author="Document System <invisible-doc@research.local>" \
        --no-verify 2>/dev/null

    # Push to GitHub if configured in .build_script_config.json
    CONFIG_FILE="$CWD/.build_script_config.json"
    if [ -f "$CONFIG_FILE" ]; then
        GITHUB_REPO=$(python3 -c "import json; c=json.load(open('$CONFIG_FILE')); print(c.get('githubRepo',''))" 2>/dev/null)
        if [ -n "$GITHUB_REPO" ]; then
            git -C "$CWD" push 2>/dev/null &
        fi
    fi

    # Push to Google Doc (bidirectional sync)
    # Only if GOOGLE_DOC_ID is set and push-to-google.js exists
    PLUGIN_ROOT="$(dirname "$(dirname "$0")")"
    PUSH_SCRIPT="${PLUGIN_ROOT}/tools/push-to-google.js"

    if [ -n "$GOOGLE_DOC_ID" ] && [ -f "$PUSH_SCRIPT" ]; then
        # Run push in background to not block the hook
        nohup node "$PUSH_SCRIPT" \
            --doc-id "$GOOGLE_DOC_ID" \
            --project-dir "$CWD" \
            > /dev/null 2>&1 &
    fi
fi

exit 0
