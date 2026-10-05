#!/bin/bash
# Build and push registry-proxy to the in-cluster registry, then restart the CI runner.
# Run from the repo root: ./cicd/registry-proxy/deploy.sh
set -euo pipefail

REGISTRY="host.docker.internal:5001"
IMAGE="${REGISTRY}/registry-proxy:latest"

# Ensure port-forward to the in-cluster registry is alive.
if ! curl -sf "http://127.0.0.1:5001/v2/" >/dev/null 2>&1; then
  echo "Starting port-forward to registry..."
  kubectl port-forward --address 0.0.0.0 svc/registry -n mesh-system 5001:5000 &>/tmp/pf-registry.log &
  PF_PID=$!
  for i in $(seq 1 15); do
    sleep 1
    curl -sf "http://127.0.0.1:5001/v2/" >/dev/null 2>&1 && break
    [ "$i" -eq 15 ] && { echo "ERROR: registry port-forward did not become ready"; kill $PF_PID 2>/dev/null; exit 1; }
  done
  echo "Port-forward ready (PID $PF_PID)"
fi

docker build -t "${IMAGE}" ./cicd/registry-proxy
docker push "${IMAGE}"
kubectl rollout restart deployment/mesh-ci-runner -n ci
kubectl rollout status deployment/mesh-ci-runner -n ci --timeout=120s
