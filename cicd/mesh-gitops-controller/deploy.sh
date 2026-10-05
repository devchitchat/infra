#!/bin/bash
# Build and push mesh-gitops-controller to the in-cluster registry, then restart the deployment.
# Run from the repo root: ./cicd/mesh-gitops-controller/deploy.sh
set -euo pipefail
# shellcheck source=../deploy-lib.sh
source "$(dirname "$0")/../deploy-lib.sh"

REGISTRY="host.docker.internal:5001"
IMAGE="${REGISTRY}/mesh-gitops-controller:latest"

ensure_registry_portforward

docker build -t "${IMAGE}" ./cicd/mesh-gitops-controller
docker push "${IMAGE}"
verify_push "mesh-gitops-controller" "latest"
kubectl rollout restart deployment/mesh-gitops-controller -n mesh-system
kubectl rollout restart deployment/apps-controller -n mesh-system
kubectl rollout status deployment/mesh-gitops-controller -n mesh-system --timeout=120s
kubectl rollout status deployment/apps-controller -n mesh-system --timeout=120s
