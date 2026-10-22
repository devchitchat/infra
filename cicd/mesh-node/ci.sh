#!/bin/bash
# Build and publish mesh-node to the in-cluster registry.
# Pins the new image digest in the platform repo — apply from there.
# Run from the repo root: ./cicd/mesh-node/ci.sh
set -euo pipefail
# shellcheck source=../deploy-lib.sh
source "$(dirname "$0")/../deploy-lib.sh"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REGISTRY="host.docker.internal:5001"
IMAGE="${REGISTRY}/mesh-node:latest"
PLATFORM="${PLATFORM_REPO:-${SCRIPT_DIR}/../../../platform}"

ensure_registry_portforward

docker build -t "${IMAGE}" ./cicd/mesh-node
docker push "${IMAGE}"
verify_push "mesh-node" "latest"

# mesh-node is used as a sidecar in two manifests — pin both.
DIGEST=$(get_image_digest "mesh-node" "latest")
pin_platform_image "mesh-node" "${DIGEST}" "${PLATFORM}/infra/apps-controller/deployment.yaml"
pin_platform_image "mesh-node" "${DIGEST}" "${PLATFORM}/apps/agent/deployment.yaml"
