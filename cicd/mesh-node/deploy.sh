#!/bin/bash
# Build and push mesh-node to the in-cluster registry, then restart dependents.
# Run from the repo root: ./cicd/mesh-node/deploy.sh
set -euo pipefail
# shellcheck source=../deploy-lib.sh
source "$(dirname "$0")/../deploy-lib.sh"

REGISTRY="host.docker.internal:5001"
IMAGE="${REGISTRY}/mesh-node:latest"

ensure_registry_portforward

docker build -t "${IMAGE}" ./cicd/mesh-node
docker push "${IMAGE}"
verify_push "mesh-node" "latest"

# Restart all deployments that use mesh-node as a sidecar
kubectl rollout restart deployment/apps-controller deployment/mesh-gitops-controller -n mesh-system
kubectl rollout status deployment/apps-controller deployment/mesh-gitops-controller -n mesh-system --timeout=120s
