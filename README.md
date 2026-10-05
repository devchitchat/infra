# local-k8s

VM and cluster management for a Mac Mini running k3s via Lima, with GitOps deployments via the mesh stack.

## What's here

```
vm/k3s-lima.yaml               Lima VM definition (QEMU, Ubuntu, k3s)
vm/registries.yaml             k3s insecure registry mirror config (registry.local:5000)
bootstrap-mesh.sh               One-time GitOps stack bootstrap
namespaces/                     Namespace PodSecurity policies
cloudflared-deployment.yml      Cloudflare tunnel manifest (embedded by infra cf setup)
vm/com.joeyguerra.lima-k3s.plist   LaunchDaemon — starts Lima VM at boot (no login required)
vm/start-lima-k3s.sh           Called by the LaunchDaemon

cicd/
  mesh-ci-runner/               mesh daemon + bun + docker CLI — runs CI pipelines
    deploy.sh                   Build + push + rollout restart
  mesh-gitops-controller/       polls mesh-gitops repo and applies manifests to k3s
    deploy.sh                   Build + push + rollout restart (restarts apps-controller too)
  mesh-node/                    generic mesh P2P daemon sidecar (used by controllers and agent)
    deploy.sh                   Build + push + rollout restart
  registry-proxy/               push-scoping proxy: enforces per-repo image name restrictions
    deploy.sh                   Build + push + rollout restart

src/                            infra CLI source (TypeScript / Bun)
cli.ts                          CLI entry point
```

## Architecture

```
Mac Mini boot
  └── launchd → com.joeyguerra.lima-k3s (LaunchDaemon, no login required)
        └── limactl start k3s  (QEMU VM, Ubuntu 24.04)
              └── k3s
                    ├── mesh-system/
                    │     ├── registry               in-cluster image registry (NodePort 30500)
                    │     ├── mesh-gitops-controller  polls platform.git every 30s, applies infra/
                    │     └── apps-controller         polls mesh-gitops.git every 30s, applies apps/
                    ├── ci/
                    │     └── mesh-ci-runner pod
                    │           ├── mesh              CI runner (shell mode, bun + docker CLI)
                    │           ├── registry-proxy    push-scoping proxy on :5050
                    │           └── buildkitd         BuildKit daemon on :1234 (mTLS, privileged)
                    ├── apps/
                    │     └── ... apps               managed by GitOps (apps-controller)
                    └── default/
                          └── cloudflared            → Cloudflare edge (public traffic)
```

**Deployments go through GitOps.** Push a manifest change to the `mesh-gitops` repo and the controller applies it within 30s. Images are built by the CI runner when commits land on the mesh network.

**CI image push scoping.** Each pipeline can only push images whose name matches its repo. The `registry-proxy` subscribes to the mesh daemon's global CI SSE stream (`GET /ci/events`). When a run transitions to `running` on this runner, the proxy opens a session for that repo; when the run completes it closes it. Pipelines never hold the control token and cannot influence session state.

**BuildKit mTLS.** A `gen-buildkit-certs` initContainer generates a per-pod CA and cert pair at startup. buildkitd and buildx both require mutual TLS so arbitrary code inside the pod cannot connect to buildkitd without the client certificate. buildkitd runs `privileged: true` — required on k3s/containerd for bind mounts from the runc-native snapshot store.

**Mesh P2P network** (kaizen-hq/mesh v5.7.1) connects the host, ci-runner, controllers, and agent. Each node serves git repos over self-signed HTTPS at port 7979. Controllers and the agent run `mesh-node` as a sidecar; the CI runner bundles mesh into its own image.

## First-time setup

### 1. Create the VM and install the LaunchDaemon

```sh
infra cluster setup
```

This installs Lima, creates the k3s VM, merges the kubeconfig, applies namespace policies, and installs the boot LaunchDaemon.

### 2. Copy `.env.example` → `.env` and fill in your mesh pubkey

```sh
cp .env.example .env
# Edit .env: set MESH_PEER_PUBKEY to the output of: mesh pubkey
```

### 3. Bootstrap the GitOps stack

```sh
infra cluster bootstrap
```

This builds and pushes the mesh-ci-runner and mesh-gitops-controller images, deploys the in-cluster registry, runs the invite/join dance, and pushes the gitops repo into the mesh network.

### 4. Deploy the Cloudflare tunnel

```sh
infra cf setup
```

Reads `CF_TOKEN` from `~/.config/infra/.env` (or `CF_TOKEN` env var).

## Day-to-day

```sh
infra cluster status     # VM status, nodes, GitOps stack, all pods
infra cluster start      # start Lima VM + wait for k3s API
infra cluster stop       # gracefully stop Lima VM
infra cluster shell      # interactive shell inside the Lima VM
```

kubectl context: `k3s-local`

## Security: host home directory

Lima mounts `~` into the VM by default and this cannot be disabled ([lima#627](https://github.com/lima-vm/lima/discussions/627)). `namespaces/default.yaml` enforces the `baseline` PodSecurity profile on the `default` namespace, which blocks `hostPath` volumes at the API server level.

## Mesh peering topology

```
host (joey-agent, host.lima.internal:7979)
  └── mesh-ci-runner (ci namespace, mesh-ci-runner.ci.svc.cluster.local:7979)
        ├── mesh-gitops-controller (mesh-system)
        ├── apps-controller (mesh-system)
        └── agent (apps namespace)
```

Peering is established once via `mesh invite` / `mesh join` and persists in PVCs at `/home/mesh/.mesh`. Re-run `infra cluster bootstrap` after a full teardown.

## Deploying CI/CD infrastructure

These components are not self-managed by GitOps — they are the infrastructure that runs GitOps. There are two kinds of changes:

- **Image-only changes** (code edits): run the relevant `deploy.sh` script.
- **Deployment spec changes** (new env vars, volumes, sidecars): apply the manifest from the `devchitchat` platform repo first, then run `deploy.sh`.

### deploy.sh scripts

Each script handles the port-forward automatically if it isn't already running. Run all scripts from the repo root.

| Component | Script | Restarts |
|---|---|---|
| mesh-node | `./cicd/mesh-node/deploy.sh` | `apps-controller` + `mesh-gitops-controller` (mesh-system) |
| registry-proxy | `./cicd/registry-proxy/deploy.sh` | `mesh-ci-runner` (ci) |
| mesh-ci-runner | `./cicd/mesh-ci-runner/deploy.sh` | `mesh-ci-runner` (ci) |
| mesh-gitops-controller | `./cicd/mesh-gitops-controller/deploy.sh` | `mesh-gitops-controller` + `apps-controller` (mesh-system) |

### Deployment order when the pod spec changes

When `devchitchat/platform/infra/ci-runner/deployment.yaml` changes (e.g. new sidecars, volumes, initContainers), apply the spec **before** building the new image. The old image continues running with the new pod spec, so there is no downtime window where the image expects resources that aren't there yet.

```sh
# 1. Apply the updated deployment spec
cd ../devchitchat
kubectl apply -f platform/infra/apps-controller/rbac.yaml   # if RBAC changed
kubectl apply -f platform/infra/ci-runner/deployment.yaml   # if pod spec changed

# 2. Build and push images (order matters: mesh-ci-runner last)
cd ../local-k8s
./cicd/registry-proxy/deploy.sh
./cicd/mesh-gitops-controller/deploy.sh
./cicd/mesh-ci-runner/deploy.sh   # last: entrypoint depends on volumes from the spec above
```

`./cicd/mesh-ci-runner/deploy.sh` must come after the deployment spec is applied because `entrypoint.sh` reads mTLS cert paths (`/certs/ca.pem` etc.) that are only present when the `gen-buildkit-certs` initContainer and `buildkit-certs` volume mount are live.

### Updating the mesh-node sidecar

`mesh-node` is the generic mesh daemon sidecar used by `apps-controller`, `mesh-gitops-controller`, and the `agent` pod. It is built and versioned independently of the apps that use it. To update:

```sh
# Update MESH_REF in cicd/mesh-node/Dockerfile, then:
./cicd/mesh-node/deploy.sh
```

### Registry port-forward

The deploy scripts push to `host.docker.internal:5001`. This requires a port-forward from the Mac host to the in-cluster registry. The scripts start one automatically if `http://127.0.0.1:5001/v2/` is not responding. To start it manually:

```sh
kubectl port-forward --address 0.0.0.0 svc/registry -n mesh-system 5001:5000
```

`host.docker.internal:5001` must be in Colima's insecure-registries list (`~/.colima/default/colima.yaml`). The k3s node pulls the same image via the `registry.local:5000` mirror (NodePort 30500).

## Deploying the agent

The agent is not part of the bootstrap — deploy it separately once the GitOps stack is running:

```sh
cd ../devchitchat/agent
./deploy.sh
```

This builds and pushes the agent image, pushes `apps/agent/deployment.yaml` into the gitops repo, waits for rollout, and peers the agent's mesh node with the CI runner. The agent's mesh sidecar uses the `mesh-node` image managed from this repo — it is not built by the agent's own CI pipeline.
