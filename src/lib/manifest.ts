import { parseAllDocuments } from "yaml";
import { existsSync } from "node:fs";

export interface AppManifest {
  /** metadata.name of the Deployment */
  name: string;
  /** Full image string from the first container, e.g. registry.local:5000/web-analytics:abc1234 */
  image: string;
  /** containerPort of the first container */
  port: number;
  /** claimName of the first PVC volume, if any */
  pvcName?: string;
  /** Raw YAML string with vars substituted — used for kubectl apply */
  raw: string;
  /** Original template as read from disk, {{ vars }} intact — used for disk write-back */
  template: string;
  /** Absolute path to the manifest file on disk */
  manifestPath: string;
}

/**
 * Find deployment.yaml by convention:
 *   1. <cwd>/deployment.yaml
 *   2. <cwd>/k8s/deployment.yaml
 */
export function findManifestPath(cwd: string = process.cwd()): string {
  const candidates = [
    `${cwd}/deployment.yaml`,
    `${cwd}/k8s/deployment.yaml`,
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error(
    `No deployment.yaml found in ${cwd} or ${cwd}/k8s/. ` +
    "Run infra commands from an app directory that has a deployment.yaml."
  );
}

export async function loadManifest(cwd: string = process.cwd(), vars: Record<string, string> = {}): Promise<AppManifest> {
  const manifestPath = findManifestPath(cwd);
  const template     = await Bun.file(manifestPath).text();
  return { ...parseManifest(substituteVars(template, vars)), template, manifestPath };
}

/**
 * Replace {{ key }} placeholders in the manifest with values from `vars`.
 * Unresolved placeholders are left as-is so kubectl surfaces the error clearly.
 */
export function substituteVars(raw: string, vars: Record<string, string>): string {
  return raw.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) => vars[key] ?? match);
}

export function parseManifest(raw: string): Omit<AppManifest, "manifestPath"> {
  const docs = parseAllDocuments(raw)
    .map(d => d.toJS() as Record<string, unknown>)
    .filter(Boolean);

  const deployment = docs.find(d => d?.kind === "Deployment");
  if (!deployment) throw new Error("No Deployment resource found in deployment.yaml");

  const spec       = deployment.spec as Record<string, unknown>;
  const podSpec    = ((spec.template as Record<string, unknown>).spec) as Record<string, unknown>;
  const containers = podSpec.containers as Array<Record<string, unknown>>;
  const container  = containers[0];

  const image  = container.image as string;
  const ports  = (container.ports as Array<Record<string, unknown>> | undefined) ?? [];
  const port   = (ports[0]?.containerPort as number) ?? 3000;

  const volumes   = (podSpec.volumes as Array<Record<string, unknown>> | undefined) ?? [];
  const pvcVol    = volumes.find(v => v.persistentVolumeClaim);
  const pvcName   = (pvcVol?.persistentVolumeClaim as Record<string, unknown> | undefined)
    ?.claimName as string | undefined;

  const meta = deployment.metadata as Record<string, unknown>;

  return {
    name:   meta.name as string,
    image,
    port,
    pvcName,
    raw,
    template: raw,  // overwritten by loadManifest with the real template
  };
}

