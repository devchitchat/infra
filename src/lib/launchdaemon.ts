import { existsSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

// Embedded at compile time so the binary is self-contained
import LIMA_PLIST from "../../vm/com.joeyguerra.lima-k3s.plist" with { type: "text" };
import COLIMA_PLIST from "../../vm/com.joeyguerra.colima.plist" with { type: "text" };

/**
 * Install both LaunchDaemons/Agents and load them.
 *
 * Lima k3s  → /Library/LaunchDaemons  (system daemon, survives logout)
 * Colima    → ~/Library/LaunchAgents  (user agent, requires login session)
 *
 * Safe to re-run: existing entries are unloaded before reinstalling.
 */
export async function installLaunchDaemon(): Promise<void> {
  await installLima();
  await installColima();
}

async function installLima(): Promise<void> {
  const name = "com.joeyguerra.lima-k3s";
  const dest = `/Library/LaunchDaemons/${name}.plist`;
  console.log(`[launchdaemon] Installing ${name} (requires sudo)...`);

  const tmp = join(tmpdir(), `${name}.plist`);
  writeFileSync(tmp, LIMA_PLIST, "utf8");

  try {
    if (existsSync(dest)) {
      await Bun.$`sudo launchctl bootout system/${name}`.nothrow();
    }
    await Bun.$`sudo cp ${tmp} ${dest}`;
    await Bun.$`sudo launchctl bootstrap system ${dest}`;
  } finally {
    unlinkSync(tmp);
  }

  console.log(`[launchdaemon] ${name} installed — auto-starts Lima k3s at boot`);
}

async function installColima(): Promise<void> {
  const name = "com.joeyguerra.colima";
  const agentsDir = join(homedir(), "Library", "LaunchAgents");
  const dest = join(agentsDir, `${name}.plist`);
  console.log(`[launchdaemon] Installing ${name}...`);

  writeFileSync(dest, COLIMA_PLIST, "utf8");

  await Bun.$`launchctl bootout gui/${process.getuid!()}/${name}`.nothrow();
  await Bun.$`launchctl bootstrap gui/${process.getuid!()} ${dest}`;

  console.log(`[launchdaemon] ${name} installed — auto-starts Colima at login`);
}
