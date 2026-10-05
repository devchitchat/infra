import { KUBE_CONTEXT } from "../lib/lima.ts";
import { kubectl } from "../lib/kubectl.ts";

// Embedded at compile time — safe to bundle (no secrets)
import CF_MANIFEST_TEXT from "../../cloudflared-deployment.yml" with { type: "text" };

// .env is NOT embedded — it contains secrets and must live on the filesystem.
// Look for it next to wherever the binary is invoked from.
const ENV_FILE = `${process.env.HOME}/.config/infra/.env`;

export async function run(subcommand: string, _args: string[]): Promise<void> {
  switch (subcommand) {
    case "setup": return setup();
    default:
      console.error(`Unknown subcommand: infra cf ${subcommand ?? ""}`);
      console.error("Available: setup");
      process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// infra cf setup — deploys cloudflared to the cluster
// Mirrors the Cloudflare tunnel steps in deploy-to-k3s.sh.
// ---------------------------------------------------------------------------

async function setup(): Promise<void> {
  console.log("=== infra cf setup ===\n");

  // Read CF_TOKEN from the .env file at the repo root
  // (Bun auto-loads .env from CWD, but infra might be run from any directory)
  const cfToken = await readCFToken();

  const kc = kubectl(KUBE_CONTEXT, "default");

  // Create the cloudflared-token secret if it doesn't already exist
  if (await kc.secretExists("cloudflared-token")) {
    console.log("[cf] Secret cloudflared-token already exists — skipping create");
  } else {
    console.log("[cf] Creating cloudflared-token secret...");
    await kc.createSecretLiteral("cloudflared-token", { CF_TOKEN: cfToken });
  }

  // Apply the cloudflared deployment
  // k3s containerd will pull the public cloudflared image from Docker Hub on pod start.
  console.log("[cf] Applying cloudflared-deployment.yml...");
  const kc2 = kubectl(KUBE_CONTEXT, "default");
  await kc2.apply(CF_MANIFEST_TEXT);

  console.log("\n[cf] Cloudflare tunnel deployed.");
  console.log("Check status: infra cluster status");
}

async function readCFToken(): Promise<string> {
  // Also accept CF_TOKEN from the environment directly
  if (process.env.CF_TOKEN) return process.env.CF_TOKEN;

  const { existsSync } = await import("node:fs");
  if (!existsSync(ENV_FILE)) {
    throw new Error(
      `CF_TOKEN not found.\n` +
      `Set it as an environment variable, or create ${ENV_FILE} with:\n` +
      `  CF_TOKEN=<your-cloudflare-tunnel-token>`
    );
  }

  const content = await Bun.file(ENV_FILE).text();
  const match = content.match(/^CF_TOKEN=(.+)$/m);
  if (!match?.[1]) {
    throw new Error(`CF_TOKEN not found in ${ENV_FILE}`);
  }
  return match[1].trim();
}
