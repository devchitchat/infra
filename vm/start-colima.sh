#!/usr/bin/env bash
# start-colima.sh
#
# Called by the com.joeyguerra.colima LaunchAgent at user login.
# Starts Colima (Docker daemon) if it isn't already running.

set -euo pipefail

log() { echo "[$(date '+%Y-%m-%dT%H:%M:%S')] $*"; }

log "=== Colima boot start ==="

STATUS=$(colima status 2>&1 || true)

if echo "$STATUS" | grep -q "colima is running"; then
  log "Colima already running — skipping start."
  exit 0
fi

log "Starting Colima..."
colima start
log "=== Colima is up ==="
