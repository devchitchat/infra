export const LIMA_INSTANCE = process.env.LIMA_INSTANCE ?? "k3s";
export const KUBE_CONTEXT  = process.env.KUBE_CONTEXT  ?? "k3s-local";

export type LimaStatus = "Running" | "Stopped" | "Broken" | "NotFound" | "Unknown";

/**
 * Return the current status of a Lima instance by parsing `limactl list` output.
 * Format: NAME    STATUS    SSH    VMTYPE    ARCH    CPUS    MEMORY    DISK    DIR
 */
export async function getLimaStatus(instance: string = LIMA_INSTANCE): Promise<LimaStatus> {
  try {
    const out = await Bun.$`limactl list`.text();
    const line = out.split("\n").find(l => l.split(/\s+/)[0] === instance);
    if (!line) return "NotFound";
    const status = line.trim().split(/\s+/)[1] ?? "Unknown";
    if (["Running", "Stopped", "Broken"].includes(status)) return status as LimaStatus;
    return "Unknown";
  } catch {
    return "Unknown";
  }
}

/**
 * Start the Lima VM, handling the Broken state the same way start-lima-k3s.sh does.
 */
export async function startLima(instance: string = LIMA_INSTANCE): Promise<void> {
  const status = await getLimaStatus(instance);

  if (status === "Running") {
    console.log(`[lima] ${instance} is already Running`);
    return;
  }

  if (status === "NotFound") {
    throw new Error(`Lima instance "${instance}" does not exist. Run: infra cluster setup`);
  }

  if (status === "Broken") {
    console.log(`[lima] ${instance} is Broken — force-stopping before restart`);
    await Bun.$`limactl stop --force ${instance}`;
  }

  console.log(`[lima] Starting ${instance}...`);
  await Bun.$`limactl start ${instance} --tty=false`;
}

export async function stopLima(instance: string = LIMA_INSTANCE): Promise<void> {
  console.log(`[lima] Stopping ${instance}...`);
  await Bun.$`limactl stop ${instance}`;
}

/**
 * Poll until the k3s API server responds to `kubectl get nodes`, matching
 * the 6-minute timeout used in start-lima-k3s.sh (72 × 5 s).
 */
export async function waitForK3s(
  context: string = KUBE_CONTEXT,
  maxWaitMs: number = 360_000,
): Promise<void> {
  console.log("[k3s] Waiting for API server...");
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const result = await Bun.$`kubectl --context=${context} get nodes`.quiet().nothrow();
    if (result.exitCode === 0) {
      console.log("\n[k3s] API server is ready");
      return;
    }
    process.stdout.write(".");
    await Bun.sleep(5_000);
  }
  throw new Error("k3s API server did not become ready within the timeout");
}

/** Open an interactive shell inside the Lima VM (replaces limactl shell directly). */
export async function openShell(instance: string = LIMA_INSTANCE): Promise<void> {
  const proc = Bun.spawn(["limactl", "shell", instance], {
    stdin:  "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exit(await proc.exited);
}
