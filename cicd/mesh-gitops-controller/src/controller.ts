import { $ } from 'bun'
import { writeFileSync, mkdtempSync, rmSync, realpathSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const GITOPS_REPO_URL    = process.env.GITOPS_REPO_URL!
const GITOPS_REPO_BRANCH = process.env.GITOPS_REPO_BRANCH ?? 'main'
const GITOPS_REPO_DIR    = process.env.GITOPS_REPO_DIR ?? '/tmp/gitops'
const POLL_INTERVAL_MS   = parseInt(process.env.POLL_INTERVAL_MS ?? '30000')
const CONFIGMAP_NAME     = process.env.CONFIGMAP_NAME ?? 'mesh-gitops-state'
const STATE_NAMESPACE    = process.env.STATE_NAMESPACE ?? 'mesh-system'
// Space-separated list of subdirectories to watch within the repo (required).
const GITOPS_WATCH_DIRS  = (process.env.GITOPS_WATCH_DIRS ?? 'apps').split(' ').filter(Boolean)

if (!GITOPS_REPO_URL) {
  console.error('GITOPS_REPO_URL is required')
  process.exit(1)
}

async function ensureRepo(): Promise<void> {
  // Check for .git/HEAD (a file) — Bun.file().exists() returns false for directories
  const gitHead = Bun.file(join(GITOPS_REPO_DIR, '.git', 'HEAD'))
  if (!(await gitHead.exists())) {
    console.log(`Cloning ${GITOPS_REPO_URL}`)
    await $`git clone ${GITOPS_REPO_URL} ${GITOPS_REPO_DIR} --branch ${GITOPS_REPO_BRANCH} --single-branch`
  }
}

async function fetchLatest(): Promise<void> {
  await $`git -C ${GITOPS_REPO_DIR} fetch origin ${GITOPS_REPO_BRANCH}`.quiet()
}

async function getRemoteSHA(): Promise<string> {
  return (await $`git -C ${GITOPS_REPO_DIR} rev-parse origin/${GITOPS_REPO_BRANCH}`.text()).trim()
}

async function getLastAppliedSHA(): Promise<string | null> {
  try {
    const sha = await $`kubectl get configmap ${CONFIGMAP_NAME} -n ${STATE_NAMESPACE} -o jsonpath={.data.lastAppliedSHA}`
      .quiet()
      .text()
    return sha.trim() || null
  } catch {
    return null
  }
}

async function setLastAppliedSHA(sha: string): Promise<void> {
  const yaml = `apiVersion: v1
kind: ConfigMap
metadata:
  name: ${CONFIGMAP_NAME}
  namespace: ${STATE_NAMESPACE}
data:
  lastAppliedSHA: "${sha}"
`
  const dir = mkdtempSync(join(tmpdir(), 'mesh-gitops-state-'))
  const tmp = join(dir, 'state.yaml')
  try {
    writeFileSync(tmp, yaml)
    await $`kubectl apply -f ${tmp}`.quiet()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function watchedDirPrefixes(): string[] {
  return GITOPS_WATCH_DIRS.map(d => d.endsWith('/') ? d : d + '/')
}

async function getChangedYamlFiles(fromSHA: string, toSHA: string): Promise<string[]> {
  // Only apply added or modified yamls; deletions are handled separately
  const output = await $`git -C ${GITOPS_REPO_DIR} diff --name-only --diff-filter=AM ${fromSHA} ${toSHA}`.text()
  const prefixes = watchedDirPrefixes()
  return output.trim().split('\n').filter(f => f.endsWith('.yaml') && prefixes.some(p => f.startsWith(p)))
}

async function getDeletedYamlFiles(fromSHA: string, toSHA: string): Promise<string[]> {
  const output = await $`git -C ${GITOPS_REPO_DIR} diff --name-only --diff-filter=D ${fromSHA} ${toSHA}`.text()
  const prefixes = watchedDirPrefixes()
  return output.trim().split('\n').filter(f => f.endsWith('.yaml') && prefixes.some(p => f.startsWith(p)))
}

async function getAllYamlFiles(): Promise<string[]> {
  // 2>/dev/null so a missing watch dir on first clone doesn't throw
  const absDirs = GITOPS_WATCH_DIRS.map(d => `${GITOPS_REPO_DIR}/${d}`)
  const output = await $`find ${absDirs} -name '*.yaml' -type f 2>/dev/null`.text()
  return output.trim().split('\n').filter(Boolean)
}

async function applyFile(filePath: string): Promise<void> {
  // Resolve symlinks before the prefix check so a crafted symlink can't escape the repo.
  const resolved  = realpathSync(filePath)
  const repoRoot  = realpathSync(GITOPS_REPO_DIR)
  if (!resolved.startsWith(repoRoot + '/')) {
    throw new Error(`path escape: "${filePath}" resolves to "${resolved}" outside repo "${repoRoot}"`)
  }
  const rel = resolved.replace(repoRoot + '/', '')
  console.log(`  apply  ${rel}`)
  await $`kubectl apply -f ${resolved}`
}

async function deleteViaOldRevision(repoRelPath: string, fromSHA: string): Promise<void> {
  console.log(`  delete ${repoRelPath}`)
  const content = await $`git -C ${GITOPS_REPO_DIR} show ${fromSHA}:${repoRelPath}`.text()
  const dir = mkdtempSync(join(tmpdir(), 'mesh-gitops-delete-'))
  const tmp = join(dir, 'manifest.yaml')
  try {
    writeFileSync(tmp, content)
    await $`kubectl delete -f ${tmp} --ignore-not-found`
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export async function reconcile(): Promise<void> {
  await fetchLatest()

  const remoteSHA = await getRemoteSHA()
  const lastSHA   = await getLastAppliedSHA()

  if (lastSHA === remoteSHA) {
    console.log(`[${new Date().toISOString()}] up to date @ ${remoteSHA.slice(0, 8)}`)
    return
  }

  console.log(`[${new Date().toISOString()}] ${lastSHA?.slice(0, 8) ?? 'initial'} → ${remoteSHA.slice(0, 8)}`)

  let failed = 0

  async function tryApply(f: string): Promise<void> {
    try {
      await applyFile(f)
    } catch (err) {
      failed++
      const raw = (err as any)?.stderr
      const msg = (raw instanceof Uint8Array ? new TextDecoder().decode(raw) : String(raw ?? '')).trim()
        || (err instanceof Error ? err.message : String(err))
      console.error(`  error applying ${f.replace(GITOPS_REPO_DIR + '/', '')}:\n${msg}`)
    }
  }

  async function tryDelete(repoRelPath: string): Promise<void> {
    try {
      await deleteViaOldRevision(repoRelPath, lastSHA!)
    } catch (err) {
      failed++
      const raw = (err as any)?.stderr
      const msg = (raw instanceof Uint8Array ? new TextDecoder().decode(raw) : String(raw ?? '')).trim()
        || (err instanceof Error ? err.message : String(err))
      console.error(`  error deleting ${repoRelPath}:\n${msg}`)
    }
  }

  if (lastSHA === null) {
    // First run: apply everything
    const all = await getAllYamlFiles()
    console.log(`  first run, applying ${all.length} manifest(s)`)
    for (const f of all) await tryApply(f)
  } else {
    await $`git -C ${GITOPS_REPO_DIR} merge --ff-only origin/${GITOPS_REPO_BRANCH}`.quiet()

    const added   = await getChangedYamlFiles(lastSHA, remoteSHA)
    const deleted = await getDeletedYamlFiles(lastSHA, remoteSHA)

    if (added.length === 0 && deleted.length === 0) {
      console.log(`  no manifest changes`)
    }

    for (const f of added)   await tryApply(join(GITOPS_REPO_DIR, f))
    for (const f of deleted) await tryDelete(f)
  }

  await setLastAppliedSHA(remoteSHA)
  console.log(failed === 0 ? `  done` : `  done with ${failed} error(s)`)
}

export async function run(): Promise<never> {
  // mesh serves git over self-signed TLS — skip verification for localhost
  await $`git config --global http.https://localhost:7979.sslVerify false`.quiet()

  console.log('mesh-gitops-controller')
  console.log(`  repo:     ${GITOPS_REPO_URL}`)
  console.log(`  branch:   ${GITOPS_REPO_BRANCH}`)
  console.log(`  watch:    ${GITOPS_WATCH_DIRS.join(', ')}`)
  console.log(`  interval: ${POLL_INTERVAL_MS}ms`)
  console.log()

  while (true) {
    try {
      await ensureRepo()
    } catch (err) {
      const raw = (err as any)?.stderr
      const stderr = raw instanceof Uint8Array ? new TextDecoder().decode(raw) : String(raw ?? '')
      const detail = stderr.trim().split('\n').at(-1) || (err instanceof Error ? err.message : String(err))
      console.log(`[${new Date().toISOString()}] waiting for repo: ${detail} — retrying in ${POLL_INTERVAL_MS / 1000}s`)
      await Bun.sleep(POLL_INTERVAL_MS)
      continue
    }
    try {
      await reconcile()
    } catch (err) {
      const raw = (err as any)?.stderr
      const stderr = (raw instanceof Uint8Array ? new TextDecoder().decode(raw) : String(raw ?? '')).trim()
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[${new Date().toISOString()}] reconcile error: ${stderr || msg}`)
    }
    await Bun.sleep(POLL_INTERVAL_MS)
  }
}
