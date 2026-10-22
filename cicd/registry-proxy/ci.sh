#!/bin/bash
# Build and publish registry-proxy to the in-cluster registry.
# Pins the new image digest in the platform repo — apply from there.
# Run from the repo root: ./cicd/registry-proxy/ci.sh
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
