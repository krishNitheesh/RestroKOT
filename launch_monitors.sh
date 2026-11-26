#!/usr/bin/env bash
# ==============================================================================
# Grand Palace KOT System - Multi-Monitor Launch Script (macOS / Linux)
# Opens 5 isolated windows for your multi-monitor setup from a single computer
# ==============================================================================

PORT=3000
BASE_URL="http://localhost:${PORT}"

echo "================================================================="
echo "  🛎️  LAUNCHING MULTI-MONITOR STATIONS ON SINGLE SYSTEM"
echo "================================================================="
echo "  1. Monitor 1: Manager POS      -> ${BASE_URL}/pos?pin=1234"
echo "  2. Monitor 2: Kitchen KDS      -> ${BASE_URL}/kitchen?pin=2222"
echo "  3. Monitor 3: Service Area     -> ${BASE_URL}/service?pin=3333"
echo "  4. Monitor 4: TV 1 (Dining)    -> ${BASE_URL}/display"
echo "  5. Monitor 5: TV 2 (Takeaway)  -> ${BASE_URL}/display?station=counter"
echo "================================================================="

# Detect browser on macOS
if command -v "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" >/dev/null 2>&1; then
  CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  echo "Opening 5 independent Chrome app windows..."
  "$CHROME" --new-window --app="${BASE_URL}/pos?pin=1234" &
  sleep 0.4
  "$CHROME" --new-window --app="${BASE_URL}/kitchen?pin=2222" &
  sleep 0.4
  "$CHROME" --new-window --app="${BASE_URL}/service?pin=3333" &
  sleep 0.4
  "$CHROME" --new-window --app="${BASE_URL}/display" &
  sleep 0.4
  "$CHROME" --new-window --app="${BASE_URL}/display?station=counter" &
elif command -v open >/dev/null 2>&1; then
  open "${BASE_URL}/pos?pin=1234"
  open "${BASE_URL}/kitchen?pin=2222"
  open "${BASE_URL}/service?pin=3333"
  open "${BASE_URL}/display"
  open "${BASE_URL}/display?station=counter"
else
  xdg-open "${BASE_URL}/pos?pin=1234" 2>/dev/null || true
  xdg-open "${BASE_URL}/kitchen?pin=2222" 2>/dev/null || true
  xdg-open "${BASE_URL}/service?pin=3333" 2>/dev/null || true
  xdg-open "${BASE_URL}/display" 2>/dev/null || true
  xdg-open "${BASE_URL}/display?station=counter" 2>/dev/null || true
fi

echo "Done! Drag each window to its monitor and press F11 for Fullscreen."

