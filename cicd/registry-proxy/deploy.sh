#!/bin/bash
# Build and push registry-proxy to the in-cluster registry, then restart the CI runner.
# Run from the repo root: ./cicd/registry-proxy/deploy.sh
set -euo pipefail
# shellcheck source=../deploy-lib.sh
source "$(dirname "$0")/../deploy-lib.sh"

REGISTRY="host.docker.internal:5001"
IMAGE="${REGISTRY}/registry-proxy:latest"

ensure_registry_portforward

docker build -t "${IMAGE}" ./cicd/registry-proxy
docker push "${IMAGE}"
verify_push "registry-proxy" "latest"
kubectl rollout restart deployment/mesh-ci-runner -n ci
kubectl rollout status deployment/mesh-ci-runner -n ci --timeout=120s
