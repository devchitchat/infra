import { mkdirSync, existsSync } from "node:fs";

const HOME = process.env.HOME!;

/**
 * Merge the k3s kubeconfig from the Lima guest into the host's ~/.kube/config.
 *
 * Replicates the sed + kubectl-merge approach from start-lima-k3s.sh:
 *   1. Read guest kubeconfig (copied to host by Lima's copyToHost mechanism)
 *   2. Replace all "default" context/cluster/user references with the desired name
 *   3. Merge into ~/.kube/config using kubectl config view --merge --flatten
 *
 * This is safe to run multiple times — it converges on the same result.
 */
export async function mergeKubeconfig(
  limaInstance: string,
  context: string,
): Promise<void> {
  const guestConfigPath = `${HOME}/.lima/${limaInstance}/copied-from-guest/k3s.yaml`;

  if (!existsSync(guestConfigPath)) {
    console.warn(`[kubeconfig] Guest config not found yet at ${guestConfigPath} — skipping merge`);
    return;
  }

  // Ensure ~/.kube/config exists
  mkdirSync(`${HOME}/.kube`, { recursive: true });
  const kubeconfigPath = `${HOME}/.kube/config`;
  if (!existsSync(kubeconfigPath)) {
    await Bun.write(kubeconfigPath, "");
  }

  // Rename all "default" references to the chosen context name
  let guestContent = await Bun.file(guestConfigPath).text();
  guestContent = guestContent
    .replaceAll("name: default",            `name: ${context}`)
    .replaceAll("cluster: default",         `cluster: ${context}`)
    .replaceAll("user: default",            `user: ${context}`)
    .replaceAll("current-context: default", `current-context: ${context}`);

  // Write to a temp file then merge
  const tmp = `/tmp/infra-k3s-${Date.now()}.yaml`;
  await Bun.write(tmp, guestContent);

  try {
    const merged = await Bun.$`kubectl config view --merge --flatten`
      .env({ ...process.env, KUBECONFIG: `${tmp}:${kubeconfigPath}` })
      .text();

    await Bun.write(kubeconfigPath, merged);
    console.log(`[kubeconfig] Merged "${context}" into ~/.kube/config`);
  } finally {
    await Bun.$`rm -f ${tmp}`.nothrow();
  }
}
