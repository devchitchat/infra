# Migrate k3s CNI to Cilium for NetworkPolicy enforcement

Oct 5, 2026 · @Joey

## Context

k3s ships Flannel as its default CNI. Flannel handles pod routing but silently ignores `NetworkPolicy` objects — the API server accepts them, but nothing enforces them.

`platform/infra/registry/network-policy.yaml` restricts direct access to `registry.mesh-system.svc.cluster.local:5000` to only the `mesh-ci-runner` pod in the `ci` namespace. Without an enforcing CNI, that file is inert and any pod in the cluster can push directly to the upstream registry, bypassing the registry-proxy entirely.

Cilium replaces Flannel as the CNI and enforces `NetworkPolicy` natively. It is the path the k3s docs recommend when policy enforcement is needed, and it has a maintained Helm chart with first-class k3s support.

## Pre-migration checklist

- [ ] Lima VM is healthy: `limactl list` shows k3s running
- [ ] k3s API reachable: `kubectl get nodes` returns `lima-k3s Ready`
- [ ] All workloads healthy: no crash-looping pods before you start
- [ ] Helm installed on host (`brew install helm` if not)
- [ ] Cilium CLI installed on host (`brew install cilium-cli` if not)
- [ ] Note your k3s version (`kubectl version`) — Cilium 1.15+ requires Kubernetes 1.26+
- [ ] Tell anyone sharing the cluster: \~5 min of pod network disruption during the CNI swap

## Migration steps

1. **Shell into the Lima VM**

   ```
   limactl shell k3s
   ```
2. **Edit the k3s config** to disable Flannel and its built-in policy controller

   ```
   sudo tee -a /etc/rancher/k3s/config.yaml <<'EOF'
   flannel-backend: none
   disable-network-policy: true
   EOF
   ```
3. **Stop k3s**

   ```
   sudo systemctl stop k3s
   ```
4. **Remove Flannel's CNI config** so k3s doesn't restart it

   ```
   sudo rm -f /var/lib/rancher/k3s/agent/etc/cni/net.d/10-flannel.conflist
   sudo ip link delete flannel.1 2>/dev/null || true
   sudo ip link delete cni0 2>/dev/null || true
   ```
5. **Start k3s** and wait for the API to come back (pods will show `Pending` — normal, no CNI yet)

   ```
   sudo systemctl start k3s
   kubectl wait --for=condition=Ready node/lima-k3s --timeout=60s
   ```
6. **Install Cilium** via Helm (run from your Mac host, not the VM)

   ```
   helm repo add cilium https://helm.cilium.io/
   helm repo update
   helm install cilium cilium/cilium \
     --namespace kube-system \
     --set operator.replicas=1 \
     --set ipam.mode=kubernetes \
     --set kubeProxyReplacement=false
   ```

   `operator.replicas=1` is required on single-node clusters. `kubeProxyReplacement=false` keeps kube-proxy running (simpler for a first migration).
7. **Wait for Cilium to be ready**

   ```
   cilium status --wait
   ```
8. **Confirm all pods recover** — coredns, metrics-server, and your workloads should return to `Running`

   ```
   kubectl get pods -A
   ```
9. **Apply the NetworkPolicy** (if not already applied via GitOps)

   ```
   kubectl apply -f platform/infra/registry/network-policy.yaml
   ```

## Verification

**1. Cilium is healthy**

```
cilium status
```

All components should show `OK`.

**2. NetworkPolicy is present**

```
kubectl get networkpolicy -n mesh-system
```

Should show `registry-ingress`.

**3. Policy blocks direct access** — exec into any pod that is NOT `mesh-ci-runner` and try to reach the registry

```
kubectl run test --rm -it --image=curlimages/curl --restart=Never -- \
  curl -v http://registry.mesh-system.svc.cluster.local:5000/v2/
```

Expect: connection timeout or refused (not a 200).

**4. Policy allows the proxy** — exec into the `mesh-ci-runner` pod and confirm the proxy path still works

```
kubectl exec -n ci deploy/mesh-ci-runner -c registry-proxy -- \
  wget -qO- http://registry.mesh-system.svc.cluster.local:5000/v2/
```

Expect: `{}` (empty catalog response from the registry).

**5. Run a CI build** and confirm an image pushes end-to-end through the proxy.

## Rollback

If Cilium fails to come up or pods don't recover, revert to Flannel:

1. **Uninstall Cilium**

   ```
   helm uninstall cilium -n kube-system
   ```
2. **Remove Cilium's CNI config**

   ```
   sudo rm -f /var/lib/rancher/k3s/agent/etc/cni/net.d/05-cilium.conflist
   ```
3. **Re-enable Flannel** — edit `/etc/rancher/k3s/config.yaml` and remove (or comment out) the two lines added in step 2:

   ```
   # flannel-backend: none       ← remove
   # disable-network-policy: true ← remove
   ```
4. **Restart k3s**

   ```
   sudo systemctl restart k3s
   ```

Flannel will re-create its CNI config on startup and pods will recover. The `NetworkPolicy` object will remain in the cluster but go back to being unenforced.
