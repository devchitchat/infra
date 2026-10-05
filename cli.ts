#!/usr/bin/env bun
export {};

const [, , cmd, sub, ...rest] = process.argv;

switch (cmd) {
  case "cluster": {
    const { run } = await import("./src/commands/cluster.ts");
    await run(sub, rest);
    break;
  }
  case "cf": {
    const { run } = await import("./src/commands/cloudflare.ts");
    await run(sub, rest);
    break;
  }
  case "render":
  case "status":
  case "logs":
  case "backup": {
    const { run } = await import("./src/commands/app.ts");
    await run(cmd, rest);
    break;
  }
  default:
    help();
    process.exit(cmd ? 1 : 0);
}

function help(): void {
  console.log(`
infra — local k3s VM and app management CLI

Cluster:
  infra cluster setup      one-time setup (brew, lima, k3s, launchdaemon)
  infra cluster bootstrap  one-time GitOps mesh stack setup (registry, CI runner, controller)
  infra cluster start      start Lima VM + wait for k3s API
  infra cluster stop       gracefully stop Lima VM
  infra cluster status     show VM, nodes, GitOps stack, and all pods
  infra cluster shell      open an interactive shell inside the Lima VM

Cloudflare:
  infra cf setup           deploy cloudflared tunnel to the cluster

App  (run from an app directory that has a deployment.yaml + infra.yaml):
  infra render             print the final manifest with vars substituted
  infra status             kubectl get pods for this app
  infra logs               tail logs for this app
  infra backup             copy the SQLite DB out of the running pod

  Deployments go through GitOps — push a manifest change to the mesh-gitops
  repo and the in-cluster controller applies it within 30s.

Convention:
  deployment.yaml          K8s manifest — image prefix registry.local:5000/
  infra.yaml               CLI config (context, namespace, lima, backup)
  infra.local.yaml         local overrides (gitignored, deep-merged over infra.yaml)
`);
}
