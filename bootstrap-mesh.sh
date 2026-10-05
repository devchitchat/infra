#!/bin/bash
# bootstrap-mesh.sh
#
# One-time setup for the mesh GitOps stack:
#   1. Configures k3s insecure registry mirror (registry.local:5000 → NodePort 30500)
#   2. Deploys the in-cluster registry (registry:2)
#   3. Builds and pushes the CI runner and controller images
#   4. Deploys the CI runner pod and GitOps controller
#   5. Instructs how to push the gitops repo via the mesh sidecar
#
# No SSH keys or external auth needed — git access is via the mesh P2P sidecar
# running at localhost:7979 within each pod. Push to it from outside the cluster
# via kubectl port-forward.
#
# Optional env vars:
#   MESH_GITOPS_DIR   — path to mesh-gitops working copy (default: ../devchitchat/mesh-gitops)
#   CONTROLLER_DIR    — path to mesh-gitops-controller source (default: ./cicd/mesh-gitops-controller)
#
# Usage:
#   ./bootstrap-mesh.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

MESH_GITOPS_DIR="${MESH_GITOPS_DIR:-"${SCRIPT_DIR}/../devchitchat/mesh-gitops"}"
PLATFORM_DIR="${PLATFORM_DIR:-"${SCRIPT_DIR}/../devchitchat/platform"}"
CONTROLLER_DIR="${CONTROLLER_DIR:-"${SCRIPT_DIR}/cicd/mesh-gitops-controller"}"

# Docker daemon runs inside Colima, so "localhost" from its perspective is the
# Colima VM — not the Mac host. Lima forwards Mac host:5050 → Lima VM:30500
# (the registry NodePort), so the daemon must reach it via host.docker.internal.
# Port 5000 is reserved by macOS AirPlay — hence 5050.
#
# The registry uses plain HTTP. HTTPS would require: a mkcert localhost cert,
# the registry:2 pod configured with REGISTRY_HTTP_TLS_CERTIFICATE/KEY, and the
# CA cert installed into Colima's Docker at
# /etc/docker/certs.d/host.docker.internal:5050/ca.crt. Not worth it for a
# registry that never leaves the machine.
#
# Colima must have host.docker.internal:5050 in its insecure-registries:
#   ~/.colima/default/colima.yaml → docker: { insecure-registries: [host.docker.internal:5050] }
# Restart Colima after changing that setting.
BOOTSTRAP_REGISTRY="host.docker.internal:5050"

log()  { echo; echo "==> $*"; }
die()  { echo "ERROR: $*" >&2; exit 1; }
info() { echo "    $*"; }

# ── Load .env ─────────────────────────────────────────────────────────────────
ENV_FILE="${SCRIPT_DIR}/.env"
[ -f "${ENV_FILE}" ] || die ".env not found — copy .env.example to .env and fill in your MESH_PEER_PUBKEY"
# shellcheck source=.env.example
source "${ENV_FILE}"
[ -n "${MESH_PEER_PUBKEY:-}" ] || die "MESH_PEER_PUBKEY not set in .env"
MESH_PEER_NAME="${MESH_PEER_NAME:-joeyguerra}"
MESH_PEER_ADDR="${MESH_PEER_ADDR:-host.lima.internal:7979}"

# ── Prerequisites ─────────────────────────────────────────────────────────────
log "Checking prerequisites..."
for cmd in limactl kubectl docker; do
  command -v "$cmd" &>/dev/null || die "'$cmd' not found — is it installed?"
done
kubectl cluster-info &>/dev/null || die "kubectl cannot reach the cluster — is Lima k3s running?"
docker info &>/dev/null          || die "Docker daemon not reachable — is Colima running?"

info "mesh-gitops dir: ${MESH_GITOPS_DIR}"
info "platform dir:    ${PLATFORM_DIR}"
info "controller dir:  ${CONTROLLER_DIR}"

# ── 1. Configure k3s registry mirror ─────────────────────────────────────────
log "Configuring k3s insecure registry mirror on Lima VM..."
limactl shell k3s -- sudo mkdir -p /etc/rancher/k3s
limactl shell k3s -- sudo tee /etc/rancher/k3s/registries.yaml \
  < "${SCRIPT_DIR}/vm/registries.yaml" > /dev/null
info "registries.yaml written — restarting k3s (~30s)..."
limactl shell k3s -- sudo systemctl restart k3s
kubectl wait --for=condition=Ready node --all --timeout=120s
info "k3s ready"

# ── 2. Namespace + RBAC (creates mesh-system) ─────────────────────────────────
log "Applying controller RBAC (creates mesh-system namespace)..."
kubectl apply -f "${PLATFORM_DIR}/infra/mesh-gitops-controller/rbac.yaml"

# ── 3. Mesh peer Secret (both namespaces) ─────────────────────────────────────
# ci/mesh-peer-config → consumed by ci-runner (the only pod that peers with the host)
# The controller's mesh sidecar only serves repos internally — no host peer needed.
log "Creating mesh-peer-config secret in ci namespace..."
kubectl create namespace ci --dry-run=client -o yaml | kubectl apply -f -
kubectl create secret generic mesh-peer-config \
  --from-literal=MESH_PEER_NAME="${MESH_PEER_NAME}" \
  --from-literal=MESH_PEER_ADDR="${MESH_PEER_ADDR}" \
  --from-literal=MESH_PEER_PUBKEY="${MESH_PEER_PUBKEY}" \
  -n ci --dry-run=client -o yaml | kubectl apply -f -
info "mesh-peer-config secret created"

# ── 4. Deploy in-cluster registry ─────────────────────────────────────────────
log "Deploying registry..."
kubectl apply -f "${PLATFORM_DIR}/infra/registry/deployment.yaml"
kubectl rollout status deployment/registry -n mesh-system --timeout=120s

# Wait until the registry API is actually accepting connections via Lima's port forward
info "waiting for registry API on localhost:5050..."
for i in $(seq 1 30); do
  if curl -s -o /dev/null "http://localhost:5050/v2/"; then
    info "registry ready"
    break
  fi
  if [ "$i" -eq 30 ]; then
    die "Timed out waiting for registry API on localhost:5050"
  fi
  sleep 2
done

# ── 5. Build and push images ──────────────────────────────────────────────────
log "Building mesh-ci-runner image (mesh + bun + docker CLI, CI enabled)..."
docker build -t "${BOOTSTRAP_REGISTRY}/mesh-ci-runner:latest" \
  "${SCRIPT_DIR}/cicd/mesh-ci-runner"
docker push "${BOOTSTRAP_REGISTRY}/mesh-ci-runner:latest"
info "pushed mesh-ci-runner:latest"

log "Building mesh-gitops-controller image..."
docker build -t "${BOOTSTRAP_REGISTRY}/mesh-gitops-controller:latest" \
  "${CONTROLLER_DIR}"
docker push "${BOOTSTRAP_REGISTRY}/mesh-gitops-controller:latest"
info "pushed mesh-gitops-controller:latest"

# ── 6. Deploy CI runner ───────────────────────────────────────────────────────
log "Deploying CI runner..."
kubectl apply -f "${PLATFORM_DIR}/infra/ci-runner/namespace.yaml"
kubectl apply -f "${PLATFORM_DIR}/infra/ci-runner/service.yaml"
kubectl apply -f "${PLATFORM_DIR}/infra/ci-runner/deployment.yaml"
info "CI runner deployment applied"

# ── 7. Deploy GitOps controller ───────────────────────────────────────────────
log "Deploying mesh-gitops-controller..."
kubectl apply -f "${PLATFORM_DIR}/infra/mesh-gitops-controller/deployment.yaml"
kubectl rollout status deployment/mesh-gitops-controller \
  -n mesh-system --timeout=120s
info "controller ready"

# ── 8. Wait for mesh sidecars to be ready ─────────────────────────────────────
log "Waiting for mesh sidecars to be ready..."
kubectl rollout status deployment/mesh-ci-runner -n ci --timeout=120s
info "ci-runner ready"

# ── 9. Mesh invite/join dance ─────────────────────────────────────────────────
log "Establishing mesh peering (ci-runner ↔ controller)..."

mesh_join() {
  local joiner_deploy="$1" joiner_ns="$2" joiner_addr="$3"
  local token attempt=0 max_attempts=10

  # Retry invite until the mesh sidecar in ci-runner is ready to accept connections
  while true; do
    attempt=$((attempt + 1))
    token=$(kubectl exec deployment/mesh-ci-runner -n ci -c mesh -- \
      mesh invite --addr mesh-ci-runner.ci.svc.cluster.local:7979 2>&1 \
      | grep '^  mesh1\.' | tr -d ' ')
    if [ -n "${token}" ]; then
      break
    fi
    if [ "${attempt}" -ge "${max_attempts}" ]; then
      die "mesh invite failed after ${max_attempts} attempts — ci-runner mesh sidecar not ready"
    fi
    info "mesh invite attempt ${attempt} failed — retrying in 5s..."
    sleep 5
  done

  # Retry join until the joiner's mesh sidecar is also reachable
  attempt=0
  while true; do
    attempt=$((attempt + 1))
    if kubectl exec "${joiner_deploy}" -n "${joiner_ns}" -c mesh -- \
      mesh join --addr "${joiner_addr}" "${token}"; then
      return 0
    fi
    if [ "${attempt}" -ge "${max_attempts}" ]; then
      die "mesh join failed after ${max_attempts} attempts for ${joiner_deploy}"
    fi
    info "mesh join attempt ${attempt} failed — retrying in 5s..."
    sleep 5
  done
}

mesh_join deployment/mesh-gitops-controller mesh-system \
  mesh-gitops-controller.mesh-system.svc.cluster.local:7979
info "controller peered"


# ── 10. Push gitops repo into the controller mesh ─────────────────────────────
log "Pushing gitops repo to controller mesh..."
kubectl port-forward deployment/mesh-gitops-controller 7978:7979 -n mesh-system &
PFPID=$!
sleep 2
git -C "${MESH_GITOPS_DIR}" -c http.sslVerify=false \
  push https://localhost:7978/mesh-gitops.git main
kill "${PFPID}" 2>/dev/null
info "gitops repo pushed — controller will reconcile within 30s"

# ── Done ──────────────────────────────────────────────────────────────────────
log "Bootstrap complete!"
echo
echo "  Registry:   registry.local:5000  (NodePort 30500)"
echo "  Controller: mesh-system/mesh-gitops-controller"
echo "  CI runner:  ci/mesh-ci-runner"
