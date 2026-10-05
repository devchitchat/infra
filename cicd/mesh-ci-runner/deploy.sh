#!/bin/bash
# Build and push mesh-ci-runner to the in-cluster registry, then restart the deployment.
# Run from the repo root: ./cicd/mesh-ci-runner/deploy.sh
set -euo pipefail
# shellcheck source=../deploy-lib.sh
source "$(dirname "$0")/../deploy-lib.sh"

REGISTRY="host.docker.internal:5001"
IMAGE="${REGISTRY}/mesh-ci-runner:latest"

ensure_registry_portforward

docker build -t "${IMAGE}" ./cicd/mesh-ci-runner
docker push "${IMAGE}"
verify_push "mesh-ci-runner" "latest"
kubectl rollout restart deployment/mesh-ci-runner -n ci
kubectl rollout status deployment/mesh-ci-runner -n ci --timeout=120s
