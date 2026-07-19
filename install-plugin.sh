#!/usr/bin/env bash
# Paperclip plugin install script for file-access-manager.
#
# This is the REST-API *fallback* installer for environments without the
# `paperclipai` CLI (the CLI is the canonical path — see README). It talks to a
# Paperclip server's HTTP API.
#
# Usage: bash install-plugin.sh [--no-build]
#
# Environment:
#   PAPERCLIP_API_KEY   (required) board API key with instance_admin role.
#   PAPERCLIP_API_BASE  (optional) API base URL. Defaults to the standard local
#                       Paperclip server: http://localhost:3000/api. Point this
#                       at a remote/custom instance if yours does not run there,
#                       e.g. PAPERCLIP_API_BASE=http://host.example:3100/api.
set -euo pipefail

NO_BUILD=false
for arg in "$@"; do
  case "$arg" in
    --no-build) NO_BUILD=true ;;
    *) echo "Unknown option: $arg"; exit 1 ;;
  esac
done

PLUGIN_DIR="$(cd "$(dirname "$0")" && pwd)"
API_BASE="${PAPERCLIP_API_BASE:-http://localhost:3000/api}"
COMPANY_ID="${PAPERCLIP_COMPANY_ID:-}"  # optional

# Extract the installed plugin's id (matched by pluginKey) from a plugins-list
# JSON array on stdin. Uses whatever JS runtime is present — bun (already
# required to build) preferred, then node — so the script carries no python3
# dependency in an otherwise bun/TypeScript project. Prints "" if none / no rt.
json_plugin_id() {
  local rt=""
  if command -v bun >/dev/null 2>&1; then rt="bun"
  elif command -v node >/dev/null 2>&1; then rt="node"
  else return 0; fi
  "$rt" -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try {
        const arr = JSON.parse(s);
        const hit = (Array.isArray(arr) ? arr : []).find(
          (p) => p && p.pluginKey === "ordillect.file-access-manager",
        );
        process.stdout.write(hit && hit.id ? String(hit.id) : "");
      } catch {
        process.stdout.write("");
      }
    });
  '
}

echo "=== Paperclip Plugin Install: file-access-manager ==="
echo "   API base: $API_BASE"
echo "   Plugin dir: $PLUGIN_DIR"
echo ""

# Step 1: Check API key
if [ -z "${PAPERCLIP_API_KEY:-}" ]; then
  echo "1. ERROR: PAPERCLIP_API_KEY is not set in environment"
  exit 1
fi
KEY_LEN=${#PAPERCLIP_API_KEY}
echo "1. PAPERCLIP_API_KEY env var is set (length: $KEY_LEN)"
echo ""

# Step 2: Check CLI
CLI_PATH=$(command -v paperclipai 2>/dev/null || true)
echo "2. paperclipai CLI: ${CLI_PATH:-NOT FOUND}"
echo ""

# Prepare a temporary header file so the bearer token never appears in argv / ps.
# Write the auth header to a temp file so the key is passed via file, not argv.
HEADER_FILE=$(mktemp)
trap 'rm -f "$HEADER_FILE"' EXIT
chmod 600 "$HEADER_FILE"
printf 'Authorization: Bearer %s\n' "$PAPERCLIP_API_KEY" > "$HEADER_FILE"

# Step 3: Build the plugin (always rebuild unless --no-build)
if [ "$NO_BUILD" = true ]; then
  echo "3. --no-build set, skipping bun install + build."
else
  echo "3. Building plugin (unconditional rebuild)..."
  cd "$PLUGIN_DIR"
  if command -v bun &>/dev/null; then
    bun install
    bun run build
  else
    echo "   ERROR: bun is not installed. Cannot build plugin."
    exit 1
  fi
  echo "   Build complete."
fi
echo ""

# Step 4: Uninstall existing instance of this plugin if present
echo "4. Checking for existing plugin installation..."
PLUGINS_RESP=$(curl -s -H @"$HEADER_FILE" "$API_BASE/plugins")
EXISTING_ID=$(printf '%s' "$PLUGINS_RESP" | json_plugin_id)
if [ -n "$EXISTING_ID" ]; then
  echo "   Existing plugin found (id: $EXISTING_ID), uninstalling with purge..."
  DEL_RESP=$(curl -s -X DELETE "${API_BASE}/plugins/${EXISTING_ID}?purge=true" -H @"$HEADER_FILE")
  echo "   Uninstall response: $DEL_RESP" | head -c 500
  echo ""
else
  echo "   No existing plugin installation found."
fi
echo ""

# Step 5: Install via API
echo "5. Installing plugin via POST /api/plugins/install..."
INSTALL_RESP=$(curl -s -X POST "$API_BASE/plugins/install" \
  -H @"$HEADER_FILE" \
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
