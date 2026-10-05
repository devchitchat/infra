#!/bin/bash
set -e

git config --global http.https://localhost:7979.sslVerify false
git config --global http.https://host.lima.internal:7979.sslVerify false
git config --global http.https://mesh-ci-runner.ci.svc.cluster.local:7979.sslVerify false

if [ ! -f ~/.mesh/mesh.toml ]; then
  mesh init
  sed -i "s/^name = .*/name = \"${MESH_NODE_NAME:-mesh-node}\"/" ~/.mesh/mesh.toml
fi

# This pod is not a CI runner
sed -i 's/^enabled = true/enabled = false/' ~/.mesh/mesh.toml

exec mesh start
