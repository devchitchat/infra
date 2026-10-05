/**
 * Thin wrapper around kubectl. Scoped to a context + namespace so callers
 * don't have to repeat those flags everywhere.
 */
export function kubectl(context: string, namespace: string) {
  const flags = [`--context=${context}`, `-n`, namespace];

  return {
    /**
     * Apply a YAML manifest string via stdin (kubectl apply -f -).
     * Writes to a temp file to avoid shell escaping issues.
     */
    async apply(manifest: string): Promise<void> {
      const tmp = `/tmp/infra-manifest-${Date.now()}.yaml`;
      await Bun.write(tmp, manifest);
      try {
        await Bun.$`kubectl ${flags} apply -f ${tmp}`;
      } finally {
        await Bun.$`rm -f ${tmp}`.nothrow();
      }
    },

    async getPods(app: string): Promise<void> {
      await Bun.$`kubectl ${flags} get pods -l app=${app}`;
    },

    async logs(app: string): Promise<void> {
      await Bun.$`kubectl ${flags} logs -l app=${app} --container=${app} --tail=100 -f`;
    },

    async getPodName(app: string): Promise<string> {
      const name = await Bun.$`kubectl ${flags} get pod -l app=${app} -o jsonpath='{.items[0].metadata.name}'`.text();
      return name.trim().replace(/^'|'$/g, "");
    },

    async secretExists(name: string): Promise<boolean> {
      const r = await Bun.$`kubectl ${flags} get secret ${name}`.quiet().nothrow();
      return r.exitCode === 0;
    },

    async createSecretFromEnvFile(name: string, envFile: string): Promise<void> {
      await Bun.$`kubectl ${flags} create secret generic ${name} --from-env-file=${envFile}`;
    },

    async createSecretLiteral(name: string, kvPairs: Record<string, string>): Promise<void> {
      const literalFlags = Object.entries(kvPairs)
        .map(([k, v]) => `--from-literal=${k}=${v}`)
        .join(" ");
      await Bun.$`kubectl ${flags} create secret generic ${name} ${literalFlags}`;
    },

    async cp(podName: string, srcPath: string, destPath: string): Promise<void> {
      await Bun.$`kubectl ${flags} cp ${podName}:${srcPath} ${destPath}`;
    },

    async exec(podName: string, command: string[]): Promise<void> {
      await Bun.$`kubectl ${flags} exec ${podName} -- ${command}`;
    },

    async execSilent(podName: string, command: string[]): Promise<string> {
      return (await Bun.$`kubectl ${flags} exec ${podName} -- ${command}`.text()).trim();
    },

    async getNodes(): Promise<void> {
      await Bun.$`kubectl ${flags} get nodes`;
    },

    async getAllPods(): Promise<void> {
      await Bun.$`kubectl --context=${context} get pods -A`;
    },

    async rolloutRestart(app: string): Promise<void> {
      await Bun.$`kubectl ${flags} rollout restart deployment/${app}`;
      await Bun.$`kubectl ${flags} rollout status deployment/${app} --timeout=120s`;
    },
  };
}
