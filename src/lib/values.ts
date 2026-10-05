import { parse } from "yaml";
import { existsSync } from "node:fs";

export interface Values {
  context: string;
  namespace: string;
  lima: string;
  backup: {
    db: string;       // path to SQLite file inside the container
    hostPath: string; // host directory to write backups into
  };
  /** Arbitrary string variables substituted into deployment.yaml as {{ key }} */
  vars: Record<string, string>;
}

const DEFAULTS: Values = {
  context: "k3s-local",
  namespace: "default",
  lima: "k3s",
  backup: { db: "", hostPath: "" },
  vars: {},
};

/**
 * Load infra.yaml and infra.local.yaml from `dir`, deep-merge them over
 * the built-in defaults, and return a fully-resolved Values object.
 *
 * infra.local.yaml is gitignored and takes precedence over infra.yaml.
 */
export async function loadValues(dir: string = process.cwd()): Promise<Values> {
  let base: Partial<Values> = {};
  let local: Partial<Values> = {};

  const basePath  = `${dir}/infra.yaml`;
  const localPath = `${dir}/infra.local.yaml`;

  if (existsSync(basePath)) {
    const raw = await Bun.file(basePath).text();
    base = (parse(raw) as Partial<Values>) ?? {};
  }

  if (existsSync(localPath)) {
    const raw = await Bun.file(localPath).text();
    local = (parse(raw) as Partial<Values>) ?? {};
  }

  return deepMerge(deepMerge(DEFAULTS as unknown as Record<string, unknown>, base), local) as unknown as Values;
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...target };
  for (const key of Object.keys(source)) {
    const sv = source[key];
    const tv = target[key];
    if (sv && typeof sv === "object" && !Array.isArray(sv) &&
        tv && typeof tv === "object" && !Array.isArray(tv)) {
      out[key] = deepMerge(
        tv as Record<string, unknown>,
        sv as Record<string, unknown>
      );
    } else if (sv !== undefined) {
      out[key] = sv;
    }
  }
  return out;
}
