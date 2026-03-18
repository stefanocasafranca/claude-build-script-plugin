#!/bin/bash
# Autonomous Build Loop Launcher v15.0
# Starts: dev server + Google Docs sync (with instant prompt injection)
# Auto-detects project type and launches the appropriate dev server.
# Detects actual port from dev server stdout (framework-agnostic).
# v15.0: Added .NET (dotnet watch run) detection.
# v7.0: Terminal.app window-name fix, nonce replay protection, 1s default polling.
# v6.0: osascript auto-trigger for instant injection on macOS.
#        Writes HMAC-signed queue files and sends Enter keystroke to Claude Code session.
#
# Usage: bash start-all.sh --doc-id YOUR_DOC_ID [--project-dir /path] [--project-type TYPE]
# Types: dotnet, react-vite, nextjs, vue-vite, svelte-kit, angular, python-flask,
#        python-fastapi, python-django, spring-boot, rails, flutter-web, express, static
#        (auto-detected if omitted)

PROJECT_DIR=""
PROJECT_TYPE=""
PASSTHROUGH_ARGS=()

# Parse args, collect passthrough for sync-gdoc.js
while [[ $# -gt 0 ]]; do
  case $1 in
    --project-dir)
      PROJECT_DIR="$2"
      PASSTHROUGH_ARGS+=("$1" "$2")
      shift 2
      ;;
    --project-type)
      PROJECT_TYPE="$2"
      PASSTHROUGH_ARGS+=("$1" "$2")
      shift 2
      ;;
    *)
      PASSTHROUGH_ARGS+=("$1")
      shift
      ;;
  esac
done

# Default project dir to cwd
if [ -z "$PROJECT_DIR" ]; then
  PROJECT_DIR="$(pwd)"
  PASSTHROUGH_ARGS+=("--project-dir" "$PROJECT_DIR")
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_DIR" || { echo "ERROR: Cannot cd to $PROJECT_DIR"; exit 1; }

# ─── Auto-detect project type ───────────────────────────────────────────────
# Helper: detect project type from a directory containing project files
detect_type_in_dir() {
  local dir="$1"
  # .NET projects: any *.csproj or *.fsproj file
  if ls "$dir"/*.csproj "$dir"/*.fsproj 2>/dev/null | grep -q .; then
    echo "dotnet"
    return
  fi
  if [ -f "$dir/package.json" ]; then
    if grep -q '"next"' "$dir/package.json" 2>/dev/null; then
      echo "nextjs"
    elif grep -q '"@angular/core"' "$dir/package.json" 2>/dev/null; then
      echo "angular"
    elif grep -q '"svelte"' "$dir/package.json" 2>/dev/null; then
      echo "svelte-kit"
    elif grep -q '"vue"' "$dir/package.json" 2>/dev/null; then
      echo "vue-vite"
    elif grep -q '"react"' "$dir/package.json" 2>/dev/null; then
      echo "react-vite"
    elif grep -q '"express"' "$dir/package.json" 2>/dev/null; then
      echo "express"
    else
      echo "node-generic"
    fi
  elif [ -f "$dir/pom.xml" ] || [ -f "$dir/build.gradle" ] || [ -f "$dir/build.gradle.kts" ]; then
    echo "spring-boot"
  elif [ -f "$dir/Gemfile" ] && [ -f "$dir/config/routes.rb" ]; then
    echo "rails"
  elif [ -f "$dir/pubspec.yaml" ] && [ -d "$dir/web" ]; then
    echo "flutter-web"
  elif [ -f "$dir/requirements.txt" ] || [ -f "$dir/pyproject.toml" ] || [ -f "$dir/app.py" ] || [ -f "$dir/main.py" ]; then
    if [ -f "$dir/requirements.txt" ] && grep -qi "fastapi" "$dir/requirements.txt" 2>/dev/null; then
      echo "python-fastapi"
    elif [ -f "$dir/requirements.txt" ] && grep -qi "django" "$dir/requirements.txt" 2>/dev/null; then
      echo "python-django"
    elif [ -f "$dir/manage.py" ]; then
      echo "python-django"
    else
      echo "python-flask"
    fi
  elif [ -f "$dir/angular.json" ]; then
    echo "angular"
  else
    echo ""
  fi
}

# Where the dev server should run (may differ from PROJECT_DIR if project is in a subfolder)
DEV_DIR="$PROJECT_DIR"

if [ -z "$PROJECT_TYPE" ]; then
  # First: try detecting in the project dir itself
  PROJECT_TYPE=$(detect_type_in_dir "$PROJECT_DIR")

  # If nothing found, search one level of subdirectories
  if [ -z "$PROJECT_TYPE" ]; then
    FOUND_DIR=""
    FOUND_TYPE=""
    FOUND_COUNT=0
    for subdir in "$PROJECT_DIR"/*/; do
      [ -d "$subdir" ] || continue
      detected=$(detect_type_in_dir "$subdir")
      if [ -n "$detected" ]; then
        FOUND_DIR="$subdir"
        FOUND_TYPE="$detected"
        FOUND_COUNT=$((FOUND_COUNT + 1))
      fi
    done

    if [ "$FOUND_COUNT" -eq 1 ]; then
      PROJECT_TYPE="$FOUND_TYPE"
      DEV_DIR="${FOUND_DIR%/}"
      echo "  Found project in subdirectory: $(basename "$DEV_DIR") ($PROJECT_TYPE)"
    elif [ "$FOUND_COUNT" -gt 1 ]; then
      echo "  WARNING: Multiple project subdirectories found. Using first: $(basename "$FOUND_DIR")"
      PROJECT_TYPE="$FOUND_TYPE"
      DEV_DIR="${FOUND_DIR%/}"
    else
      PROJECT_TYPE="static"
    fi
  fi
fi

# ─── Dev server command + fallback port per project type ─────────────────────
FALLBACK_PORT=""
case "$PROJECT_TYPE" in
  dotnet)
    # Prefer dotnet watch run for hot-reload; fall back to dotnet run if watch unavailable
    DEV_CMD="dotnet watch run"
    FALLBACK_PORT=5000
    ;;
  react-vite|vue-vite|svelte-kit|node-generic)
    DEV_CMD="npm run dev"
    FALLBACK_PORT=5173
    ;;
  nextjs)
    DEV_CMD="npm run dev"
    FALLBACK_PORT=3000
    ;;
  angular)
    if [ -f "$DEV_DIR/node_modules/.bin/ng" ]; then
      DEV_CMD="npx ng serve"
    else
      DEV_CMD="npm start"
    fi
    FALLBACK_PORT=4200
    ;;
  express)
    if grep -q '"dev"' "$DEV_DIR/package.json" 2>/dev/null; then
      DEV_CMD="npm run dev"
    else
      DEV_CMD="npm start"
    fi
    FALLBACK_PORT=3000
    ;;
  spring-boot)
    if [ -f "mvnw" ]; then
      DEV_CMD="./mvnw spring-boot:run"
    elif [ -f "gradlew" ]; then
      DEV_CMD="./gradlew bootRun"
    else
      DEV_CMD="mvn spring-boot:run"
    fi
    FALLBACK_PORT=8080
    ;;
  rails)
    DEV_CMD="rails server"
    FALLBACK_PORT=3000
    ;;
  flutter-web)
    DEV_CMD="flutter run -d web-server --web-port 8080"
    FALLBACK_PORT=8080
    ;;
  python-fastapi)
    DEV_CMD="uvicorn main:app --reload --port 8000"
    FALLBACK_PORT=8000
    ;;
  python-django)
    DEV_CMD="python manage.py runserver 8000"
    FALLBACK_PORT=8000
    ;;
  python-flask)
    DEV_CMD="python app.py"
    FALLBACK_PORT=5000
    ;;
  static|*)
    DEV_CMD="npx -y live-server --port=3000 --quiet"
    FALLBACK_PORT=3000
    ;;
esac

# ─── Start dev server + detect actual port from stdout ───────────────────────
DEV_PID=""
DEV_PORT=""
STDOUT_LOG=$(mktemp /tmp/dev-server-stdout.XXXXXX)
REUSED_SERVER=false

# Check if a dev server is already running on the fallback port
if lsof -i :"$FALLBACK_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "  Dev server already running on port $FALLBACK_PORT — reusing (no browser opened)"
  DEV_PORT="$FALLBACK_PORT"
  REUSED_SERVER=true
else
  # Also check common dev ports before starting a new server
  for CHECK_PORT in 5173 5174 5175 5176 5177 5178 3000 3001 4200 8080 8000 5000; do
    if lsof -i :"$CHECK_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
      echo "  Dev server already running on port $CHECK_PORT — reusing (no browser opened)"
      DEV_PORT="$CHECK_PORT"
      REUSED_SERVER=true
      break
    fi
  done
fi

if [ -z "$DEV_PORT" ]; then
  echo "  Starting: $DEV_CMD (in $(basename "$DEV_DIR"))"
  # Launch dev server from the actual project directory
  (cd "$DEV_DIR" && $DEV_CMD) > >(tee "$STDOUT_LOG") 2>&1 &
  DEV_PID=$!

  # Scan stdout for port number (up to 15 seconds)
  echo "  Detecting port..."
  for i in $(seq 1 30); do
    sleep 0.5
    if [ -f "$STDOUT_LOG" ]; then
      # Try host:port patterns (covers Vite, Flask, Rails, Django, FastAPI, etc.)
      DETECTED=$(grep -oE '(localhost|127\.0\.0\.1|0\.0\.0\.0):([0-9]+)' "$STDOUT_LOG" 2>/dev/null | head -1 | grep -oE '[0-9]+$')
      if [ -n "$DETECTED" ]; then
        DEV_PORT="$DETECTED"
        echo "  Detected port: $DEV_PORT"
        break
      fi
      # Try "port NNNN" or "port: NNNN" patterns (covers Spring Boot, generic)
      DETECTED=$(grep -oiE 'port[=: ]+([0-9]+)' "$STDOUT_LOG" 2>/dev/null | head -1 | grep -oE '[0-9]+')
      if [ -n "$DETECTED" ]; then
        DEV_PORT="$DETECTED"
        echo "  Detected port: $DEV_PORT"
        break
      fi
    fi
  done

  # Fallback if detection failed
  if [ -z "$DEV_PORT" ]; then
    DEV_PORT="$FALLBACK_PORT"
    echo "  Could not detect port from stdout, using fallback: $DEV_PORT"
  fi
fi

# Clean up temp file after a delay
(sleep 10 && rm -f "$STDOUT_LOG") &

# ─── Banner ──────────────────────────────────────────────────────────────────
HMAC_SECRET_PATH="$HOME/.config/build_script/hmac_secret"

# Detect trigger method
TRIGGER_INFO="  Trigger:      TIOCSTI → clipboard paste (any terminal, macOS)"
if [[ "$OSTYPE" != "darwin"* ]]; then
  if [ -n "$TMUX" ]; then
    TRIGGER_INFO="  Trigger:      tmux send-keys"
  else
    TRIGGER_INFO="  Trigger:      notification only (non-macOS, no tmux)"
  fi
fi

echo ""
echo "============================================"
echo "  Autonomous Build Loop v15.0"
echo "  Instant Prompt Injection"
echo "============================================"
echo "  Project Type: $PROJECT_TYPE"
echo "  Dev server:   http://localhost:$DEV_PORT"
echo "  Google Doc sync + auto-trigger injection"
echo "  Project: $PROJECT_DIR"
echo "$TRIGGER_INFO"
echo "============================================"
echo ""

# Only open browser if we started a NEW dev server (not reusing existing)
if [ "$REUSED_SERVER" = false ]; then
  open "http://localhost:$DEV_PORT"
fi

# Pass detected port and HMAC secret path to sync-gdoc.js
PASSTHROUGH_ARGS+=("--dev-port" "$DEV_PORT")
PASSTHROUGH_ARGS+=("--hmac-secret-path" "$HMAC_SECRET_PATH")

# ─── Start sync daemon (detached background, no controlling terminal) ────────
echo "  Starting sync daemon..."
PID_FILE="$PROJECT_DIR/.build_script/daemon.pid"

if [[ " ${PASSTHROUGH_ARGS[*]} " =~ " --foreground " ]]; then
  # Debug mode: run in foreground, logs go to this terminal
  node "$SCRIPT_DIR/sync-gdoc.js" "${PASSTHROUGH_ARGS[@]}"
else
  # Normal mode: self-daemonize (no terminal window)
  node "$SCRIPT_DIR/sync-gdoc.js" "${PASSTHROUGH_ARGS[@]}" --daemonize
fi

echo ""
echo "  To stop: kill \$(cat $PID_FILE) 2>/dev/null || echo 'not running'"

# Keep terminal open if a dev server is running (Ctrl+C to stop)
if [ -n "$DEV_PID" ]; then
  echo ""
  echo "  Dev server running (PID $DEV_PID). Press Ctrl+C to stop."
  wait $DEV_PID
  kill $DEV_PID 2>/dev/null
fi
