#!/usr/bin/env bash
# Paperclip plugin install script for file-access-manager
# Usage: bash install-plugin.sh
set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "$0")" && pwd)"
API_BASE="${PAPERCLIP_API_BASE:-http://localhost:3000/api}"
COMPANY_ID="${PAPERCLIP_COMPANY_ID:-}"  # optional

echo "=== Paperclip Plugin Install: file-access-manager ==="
echo ""

# Step 1: Check API key
KEY_COUNT=$(printenv | grep -c PAPERCLIP_API_KEY || true)
echo "1. PAPERCLIP_API_KEY env var count: $KEY_COUNT"
if [ "$KEY_COUNT" -eq 0 ]; then
  echo "   ERROR: PAPERCLIP_API_KEY is not set in environment"
  exit 1
fi
KEY_LEN=${#PAPERCLIP_API_KEY}
echo "   Key length: $KEY_LEN"
echo ""

# Step 2: Check CLI
CLI_PATH=$(which paperclipai 2>/dev/null || true)
echo "2. paperclipai CLI: ${CLI_PATH:-NOT FOUND}"
echo ""

# Step 3: Build the plugin (if dist/ doesn't exist)
if [ ! -d "$PLUGIN_DIR/dist" ]; then
  echo "3. Building plugin (dist/ not found)..."
  cd "$PLUGIN_DIR"
  if command -v bun &>/dev/null; then
    bun install
    bun run build
  else
    echo "   ERROR: bun is not installed. Cannot build plugin."
    exit 1
  fi
  echo "   Build complete."
else
  echo "3. dist/ already exists, skipping build."
fi
echo ""

# Step 4: Check current plugins
echo "4. Checking existing plugins..."
PLUGINS_RESP=$(curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" "$API_BASE/plugins")
echo "   Current plugins: $PLUGINS_RESP" | head -c 500
echo ""
echo ""

# Step 5: Install via API
echo "5. Installing plugin via POST /api/plugins/install..."
INSTALL_RESP=$(curl -s -X POST "$API_BASE/plugins/install" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"packageName\":\"$PLUGIN_DIR\",\"isLocalPath\":true}")
echo "   Response: $INSTALL_RESP" | head -c 1000
echo ""

# Check if install succeeded
if echo "$INSTALL_RESP" | grep -q '"id"'; then
  echo "   ✓ Plugin installed successfully!"
else
  echo "   ✗ Install may have failed. Check response above."
  echo ""
  echo "   If 403: The API key user needs instance_admin role."
  echo "   If 400: The plugin manifest may be invalid or dist/ missing."
fi