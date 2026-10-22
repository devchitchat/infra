#!/bin/bash
# Build and push registry-proxy to the in-cluster registry, pin the digest in
# the platform repo, and apply the updated manifest.
# Run from the repo root: ./cicd/registry-proxy/deploy.sh
set -euo pipefail
# shellcheck source=../deploy-lib.sh
source "$(dirname "$0")/../deploy-lib.sh"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REGISTRY="host.docker.internal:5001"
IMAGE="${REGISTRY}/registry-proxy:latest"
PLATFORM_YAML="${PLATFORM_REPO:-${SCRIPT_DIR}/../../../platform}/infra/ci-runner/deployment.yaml"

ensure_registry_portforward

docker build -t "${IMAGE}" ./cicd/registry-proxy
docker push "${IMAGE}"
verify_push "registry-proxy" "latest"

DIGEST=$(get_image_digest "registry-proxy" "latest")
pin_platform_image "registry-proxy" "${DIGEST}" "${PLATFORM_YAML}"
# Apply drives the rollout — the digest change is what triggers it, so
# rollout restart is not needed. Commit the updated YAML to the platform repo.
kubectl apply -f "${PLATFORM_YAML}"
kubectl rollout status deployment/mesh-ci-runner -n ci --timeout=120s
