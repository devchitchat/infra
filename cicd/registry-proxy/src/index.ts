/**
 * Registry push-scoping proxy
 *
 * Sits between the CI runner and the Docker registry. Allows pulls from any
 * image, but restricts pushes to image names that match the repo currently
 * building on this runner.
 *
 * Sessions are managed internally by subscribing to the mesh daemon's global
 * CI SSE stream (GET /ci/events). When a run transitions to "running" on this
 * runner, the session is opened; when it completes, the session is cleared.
 * The pipeline never holds CONTROL_TOKEN and cannot influence session state.
 *
 * Flow per CI job:
 *   1. Mesh daemon fires run-changed SSE event with status="running", runner=MESH_NODE_NAME
 *   2. This proxy sets activeRepo — pushes to matching image names are allowed
 *   3. Mesh daemon fires run-changed SSE event with status="passed"|"failed"
 *   4. This proxy clears activeRepo
 *
 * Environment variables:
 *   REGISTRY_UPSTREAM     URL of the real registry (default: http://registry:5000)
 *   PROXY_PORT            Port to listen on (default: 5050)
 *   MESH_URL              URL of the local mesh daemon (default: http://localhost:7979)
 *   MESH_NODE_NAME        Name of this runner node — used to filter SSE events (default: mesh-ci-runner)
 *   CONTROL_TOKEN         Bearer token required to call /control/* endpoints.
 *                         If unset, control endpoints are disabled and all pushes
 *                         are denied (safe default — forces explicit configuration).
 */

import { timingSafeEqual } from 'crypto'

const REGISTRY_UPSTREAM = process.env.REGISTRY_UPSTREAM ?? 'http://registry:5000'
const PROXY_PORT        = parseInt(process.env.PROXY_PORT ?? '5050')
const CONTROL_TOKEN     = process.env.CONTROL_TOKEN ?? ''
const MESH_URL          = process.env.MESH_URL ?? 'http://localhost:7979'
const MESH_NODE_NAME    = process.env.MESH_NODE_NAME ?? 'mesh-ci-runner'

// Active session: the repo currently allowed to push. null = no session = deny all.
let activeRepo: string | null = null

// --- mesh SSE session management ---

async function connectMeshSse(): Promise<void> {
  const url = `${MESH_URL}/ci/events`
  while (true) {
    try {
      console.log(`[session] connecting to mesh SSE at ${url}`)
      const res = await fetch(url, { headers: { Accept: 'text/event-stream' } })
      if (!res.ok || !res.body) {
        console.error(`[session] SSE connect failed: ${res.status} — retrying in 5s`)
        await Bun.sleep(5_000)
        continue
      }
      console.log(`[session] connected to mesh SSE`)
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      let eventType = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          if (line.startsWith('event:')) {
            eventType = line.slice(6).trim()
          } else if (line.startsWith('data:') && eventType === 'run-changed') {
            try {
              const payload = JSON.parse(line.slice(5).trim()) as { repo: string; runner: string; status: string }
              if (payload.runner === MESH_NODE_NAME) {
                if (payload.status === 'running') {
                  console.log(`[session] started — repo "${payload.repo}"`)
                  activeRepo = payload.repo
                } else if (payload.status === 'passed' || payload.status === 'failed' || payload.status === 'cancelled') {
                  if (activeRepo !== null) {
                    console.log(`[session] ended — was "${activeRepo}" (${payload.status})`)
                    activeRepo = null
                  }
                }
              }
            } catch { /* malformed data line */ }
            eventType = ''
          } else if (line === '') {
            eventType = ''
          }
        }
      }
      console.log(`[session] SSE stream closed — reconnecting in 2s`)
    } catch (err) {
      console.error(`[session] SSE error: ${err} — retrying in 5s`)
    }
    await Bun.sleep(5_000)
  }
}

void connectMeshSse()

// Repo names must be lowercase alphanumeric with hyphens/underscores, 1-64 chars.
const REPO_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

// --- helpers ---

function imageNameFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/v2\/([^/]+(?:\/[^/]+)*)\/(manifests|blobs)(\/|$)/)
  return match ? match[1] : null
}

function isPushRequest(method: string, pathname: string): boolean {
  if (!['PUT', 'PATCH', 'POST', 'DELETE'].includes(method)) return false
  return /^\/v2\/.+\/(manifests|blobs)(\/|$)/.test(pathname)
}

function allowedPrefixesForRepo(repoName: string): string[] {
  return [repoName, `${repoName}-`]
}

function isImageAllowed(imageName: string, repo: string): boolean {
  return allowedPrefixesForRepo(repo).some(p => imageName === p || imageName.startsWith(p))
}

function verifyControlToken(req: Request): Response | null {
  if (!CONTROL_TOKEN) {
    return new Response('control endpoint disabled: CONTROL_TOKEN not configured', { status: 503 })
  }
  const auth    = req.headers.get('authorization') ?? ''
  const expected = `Bearer ${CONTROL_TOKEN}`
  // Use constant-time comparison to prevent timing-based token enumeration.
  const match = auth.length === expected.length &&
    timingSafeEqual(Buffer.from(auth), Buffer.from(expected))
  if (!match) {
    return new Response('unauthorized', { status: 401 })
  }
  return null
}

// --- server ---

const server = Bun.serve({
  port: PROXY_PORT,
  async fetch(req) {
    const url    = new URL(req.url)
    const method = req.method
    const path   = url.pathname + (url.search ? url.search : '')

    // Control API — only the runner uses these; the pipeline never gets CONTROL_TOKEN
    if (url.pathname === '/control/session') {
      const deny = verifyControlToken(req)
      if (deny) return deny

      if (method === 'POST') {
        const body = await req.json().catch(() => null) as { repo?: string } | null
        if (!body?.repo || typeof body.repo !== 'string') {
          return new Response('{"error":"repo is required"}', { status: 400, headers: { 'Content-Type': 'application/json' } })
        }
        if (!REPO_NAME_RE.test(body.repo)) {
          return new Response(
            JSON.stringify({ error: `invalid repo name "${body.repo}" — must match ${REPO_NAME_RE}` }),
            { status: 400, headers: { 'Content-Type': 'application/json' } }
          )
        }
        if (activeRepo !== null) {
          return new Response(
            JSON.stringify({ error: `session already active for repo "${activeRepo}" — DELETE first` }),
            { status: 409, headers: { 'Content-Type': 'application/json' } }
          )
        }
        activeRepo = body.repo
        console.log(`[SESSION] started — repo "${activeRepo}" — allows ${allowedPrefixesForRepo(activeRepo).map(p => p + '*').join(', ')}`)
        return new Response(JSON.stringify({ repo: activeRepo, status: 'active' }), { headers: { 'Content-Type': 'application/json' } })
      }

      if (method === 'DELETE') {
        const previous = activeRepo
        activeRepo = null
        console.log(`[SESSION] ended — was "${previous}"`)
        return new Response(JSON.stringify({ status: 'cleared' }), { headers: { 'Content-Type': 'application/json' } })
      }

      if (method === 'GET') {
        return new Response(JSON.stringify({ repo: activeRepo }), { headers: { 'Content-Type': 'application/json' } })
      }

      return new Response('method not allowed', { status: 405 })
    }

    // Health check
    if (url.pathname === '/healthz') {
      return new Response('ok')
    }

    // Push enforcement
    if (isPushRequest(method, url.pathname)) {
      const imageName = imageNameFromPath(url.pathname)

      if (!activeRepo) {
        console.warn(`[DENY] ${method} ${url.pathname} — no active session`)
        return new Response(
          JSON.stringify({ errors: [{ code: 'DENIED', message: 'no active CI session — runner must POST /control/session before pushing' }] }),
          { status: 403, headers: { 'Content-Type': 'application/json' } }
        )
      }

      if (!imageName || !isImageAllowed(imageName, activeRepo)) {
        console.warn(`[DENY] ${method} ${url.pathname} — image "${imageName}" not in session for repo "${activeRepo}"`)
        return new Response(
          JSON.stringify({
            errors: [{
              code: 'DENIED',
              message: `repo "${activeRepo}" may only push images matching "${activeRepo}" or "${activeRepo}-*"; got "${imageName}"`,
            }],
          }),
          { status: 403, headers: { 'Content-Type': 'application/json' } }
        )
      }

      console.log(`[ALLOW] ${method} ${url.pathname} — image "${imageName}" matches session repo "${activeRepo}"`)
    }

    // Forward to upstream registry
    const upstreamUrl = `${REGISTRY_UPSTREAM}${path}`
    const headers     = new Headers(req.headers)
    headers.delete('host')
    headers.delete('connection')
    headers.delete('te')
    headers.delete('trailers')
    headers.delete('transfer-encoding')
    headers.delete('upgrade')

    const body = ['GET', 'HEAD'].includes(method) ? undefined : req.body

    try {
      const upstream = await fetch(upstreamUrl, {
        method,
        headers,
        body,
        // @ts-ignore — Bun-specific: pass body as stream without buffering
        duplex: 'half',
      })

      const responseHeaders = new Headers(upstream.headers)
      const location = responseHeaders.get('location')
      if (location?.startsWith(REGISTRY_UPSTREAM)) {
        responseHeaders.set('location', location.replace(REGISTRY_UPSTREAM, ''))
      }
      responseHeaders.delete('connection')
      responseHeaders.delete('transfer-encoding')

      return new Response(upstream.body, {
        status:  upstream.status,
        headers: responseHeaders,
      })
    } catch (err) {
      console.error(`[ERROR] upstream request failed: ${err}`)
      return new Response('upstream registry unavailable', { status: 502 })
    }
  },
})

console.log(`registry-proxy listening on :${PROXY_PORT}`)
console.log(`  upstream: ${REGISTRY_UPSTREAM}`)
console.log(`  mesh:     ${MESH_URL}  (runner: ${MESH_NODE_NAME})`)
console.log(`  control:  ${CONTROL_TOKEN ? 'configured' : 'DISABLED — all pushes will be denied'}`)
