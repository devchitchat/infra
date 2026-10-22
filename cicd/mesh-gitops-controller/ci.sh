#!/bin/bash
# Build and publish mesh-gitops-controller to the in-cluster registry.
# Pins the new image digest in the platform repo — apply from there.
# Run from the repo root: ./cicd/mesh-gitops-controller/ci.sh
set -euo pipefail
# shellcheck source=../deploy-lib.sh
source "$(dirname "$0")/../deploy-lib.sh"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REGISTRY="host.docker.internal:5001"
IMAGE="${REGISTRY}/mesh-gitops-controller:latest"
PLATFORM="${PLATFORM_REPO:-${SCRIPT_DIR}/../../../platform}"

ensure_registry_portforward

docker build -t "${IMAGE}" ./cicd/mesh-gitops-controller
docker push "${IMAGE}"
verify_push "mesh-gitops-controller" "latest"

DIGEST=$(get_image_digest "mesh-gitops-controller" "latest")
pin_platform_image "mesh-gitops-controller" "${DIGEST}" "${PLATFORM}/infra/apps-controller/deployment.yaml"
