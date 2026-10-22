#!/bin/bash
# Build and publish mesh-ci-runner to the in-cluster registry.
# Pins the new image digest in the platform repo — apply from there.
# Run from the repo root: ./cicd/mesh-ci-runner/ci.sh
set -euo pipefail
# shellcheck source=../deploy-lib.sh
source "$(dirname "$0")/../deploy-lib.sh"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REGISTRY="host.docker.internal:5001"
IMAGE="${REGISTRY}/mesh-ci-runner:latest"
PLATFORM_YAML="${PLATFORM_REPO:-${SCRIPT_DIR}/../../../platform}/infra/ci-runner/deployment.yaml"

ensure_registry_portforward

docker build -t "${IMAGE}" ./cicd/mesh-ci-runner
docker push "${IMAGE}"
verify_push "mesh-ci-runner" "latest"

DIGEST=$(get_image_digest "mesh-ci-runner" "latest")
pin_platform_image "mesh-ci-runner" "${DIGEST}" "${PLATFORM_YAML}"
