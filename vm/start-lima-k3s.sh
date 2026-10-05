#!/usr/bin/env bash
# start-lima-k3s.sh
#
# Called by the com.joeyguerra.lima-k3s LaunchDaemon at every system boot.
# Starts the Lima k3s VM and updates the kubeconfig on the host.
# Runs as user 'joeyguerra' (set via UserName in the plist) so it has
# access to ~/.lima and ~/.kube without needing sudo for those paths.

set -euo pipefail

LIMA_INSTANCE="k3s"
KUBE_CONTEXT="k3s-local"
GUEST_KUBECONFIG="$HOME/.lima/$LIMA_INSTANCE/copied-from-guest/k3s.yaml"

log() { echo "[$(date '+%Y-%m-%dT%H:%M:%S')] $*"; }

log "=== Lima k3s boot start ==="
log "HOME=$HOME"

# ── Start the VM ──────────────────────────────────────────────────────────────

if ! limactl list "$LIMA_INSTANCE" &>/dev/null 2>&1; then
  log "ERROR: Lima instance '$LIMA_INSTANCE' not found. Run setup-k3s.sh first."
  exit 1
fi

CURRENT_STATUS=$(limactl list "$LIMA_INSTANCE" --format '{{.Status}}' 2>/dev/null || echo "unknown")
log "Current VM status: $CURRENT_STATUS"

if [ "$CURRENT_STATUS" = "Running" ]; then
  log "VM already running — skipping start."
elif [ "$CURRENT_STATUS" = "Broken" ]; then
  log "VM is in Broken state — force-stopping to clear stale state..."
  limactl stop --force "$LIMA_INSTANCE" 2>/dev/null || true
  sleep 2
  log "Starting Lima VM '$LIMA_INSTANCE'..."
  limactl start "$LIMA_INSTANCE" --tty=false
  log "Lima start command returned."
else
  log "Starting Lima VM '$LIMA_INSTANCE'..."
  limactl start "$LIMA_INSTANCE" --tty=false
  log "Lima start command returned."
fi

# ── Wait for k3s API server ───────────────────────────────────────────────────

log "Waiting for k3s to be ready..."
for i in $(seq 1 72); do
  if limactl shell "$LIMA_INSTANCE" -- sudo kubectl get nodes &>/dev/null 2>&1; then
    log "k3s is ready after $((i * 5))s."
    break
  fi
  if [ "$i" -eq 72 ]; then
    log "ERROR: k3s did not become ready in 6 minutes."
    log "Check with: limactl shell k3s -- journalctl -u k3s -n 50"
    exit 1
  fi
  sleep 5
done

# ── Refresh kubeconfig ────────────────────────────────────────────────────────
# Lima copies k3s.yaml from the guest automatically (copyToHost in k3s-lima.yaml).
# We re-merge it so the host kubeconfig reflects the current VM address.

log "Refreshing kubeconfig..."
mkdir -p "$HOME/.kube"

if [ ! -f "$GUEST_KUBECONFIG" ]; then
  limactl shell "$LIMA_INSTANCE" -- sudo cat /etc/rancher/k3s/k3s.yaml > "$GUEST_KUBECONFIG"
fi

TMP_CFG=$(mktemp /tmp/k3s-lima-XXXXXX.yaml)
sed \
  -e "s/name: default/name: $KUBE_CONTEXT/g" \
  -e "s/cluster: default/cluster: $KUBE_CONTEXT/g" \
  -e "s/user: default/user: $KUBE_CONTEXT/g" \
  -e "s/current-context: default/current-context: $KUBE_CONTEXT/g" \
  "$GUEST_KUBECONFIG" > "$TMP_CFG"

if [ ! -f "$HOME/.kube/config" ]; then
  cp "$TMP_CFG" "$HOME/.kube/config"
else
  TMP_MERGED=$(mktemp /tmp/k3s-merged-XXXXXX.yaml)
  KUBECONFIG="$HOME/.kube/config:$TMP_CFG" kubectl config view --flatten > "$TMP_MERGED"
  mv "$TMP_MERGED" "$HOME/.kube/config"
fi
chmod 600 "$HOME/.kube/config"
rm -f "$TMP_CFG"

log "=== Lima k3s is up. Context: $KUBE_CONTEXT ==="
