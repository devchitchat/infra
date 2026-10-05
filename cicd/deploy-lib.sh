# Shared helpers for cicd deploy scripts. Source this file; do not execute it directly.
# Usage: source "$(dirname "$0")/../deploy-lib.sh"

# ensure_registry_portforward
#
# Ensures http://127.0.0.1:5001 is forwarding to the in-cluster registry.
# If a stale port-forward process holds the port but is no longer healthy
# (lost connection to pod), it is killed before a fresh one is started.
ensure_registry_portforward() {
  if curl -sf "http://127.0.0.1:5001/v2/" >/dev/null 2>&1; then
    return 0
  fi

  # Port may be held by a dead port-forward — kill it before trying to bind.
  local stale_pids
  stale_pids=$(lsof -ti tcp:5001 2>/dev/null || true)
  if [ -n "${stale_pids}" ]; then
    echo "Killing stale process(es) on port 5001: ${stale_pids}"
    echo "${stale_pids}" | xargs kill 2>/dev/null || true
    sleep 1
  fi

  echo "Starting port-forward to registry..."
  kubectl port-forward --address 0.0.0.0 svc/registry -n mesh-system 5001:5000 \
    &>/tmp/pf-registry.log &
  local pf_pid=$!
  for i in $(seq 1 15); do
    sleep 1
    curl -sf "http://127.0.0.1:5001/v2/" >/dev/null 2>&1 && break
    if [ "${i}" -eq 15 ]; then
      echo "ERROR: registry port-forward did not become ready"
      kill "${pf_pid}" 2>/dev/null
      return 1
    fi
  done
  echo "Port-forward ready (PID ${pf_pid})"
}

# verify_push <image-name> <tag>
#
# Confirms every blob referenced by the manifest is non-empty in the registry
# at http://127.0.0.1:5001. Catches the silent-truncation failure mode where
# docker push exits 0 but the port-forward dropped mid-transfer, leaving
# zero-byte blobs that cause "short read: expected N bytes but got 0" on pull.
#
# Handles both OCI image indexes (multi-platform) and single manifests.
# Resolves image-index entries to their sub-manifests before checking blobs.
verify_push() {
  local image_name="$1"
  local tag="${2:-latest}"
  local registry="http://127.0.0.1:5001"
  local accepts="application/vnd.oci.image.index.v1+json,application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json"

  echo "Verifying push: ${image_name}:${tag}..."

  local manifest_json
  manifest_json=$(curl -sf -H "Accept: ${accepts}" \
    "${registry}/v2/${image_name}/manifests/${tag}") || {
    echo "ERROR: could not fetch manifest ${image_name}:${tag} from registry at ${registry}"
    return 1
  }

  # Collect sub-manifest digests (image index) or treat it as a single manifest.
  local manifest_digests
  manifest_digests=$(echo "${manifest_json}" | python3 -c "
import sys, json
m = json.load(sys.stdin)
mt = m.get('mediaType', '') or m.get('schemaVersion', '')
if 'index' in str(mt):
    for mf in m.get('manifests', []):
        print('manifest:' + mf['digest'])
else:
    print('single:')
")

  local failed=0

  _check_blobs() {
    local repo="$1" mfst_json="$2"
    local digests
    digests=$(echo "${mfst_json}" | python3 -c "
import sys, json
m = json.load(sys.stdin)
if 'config' in m:
    print(m['config']['digest'])
for layer in m.get('layers', []):
    print(layer['digest'])
")
    while IFS= read -r digest; do
      [ -z "${digest}" ] && continue
      # Fetch the first byte of the blob body (range 0-0). HEAD Content-Length
      # is served from stored metadata and reflects the expected size even when
      # the blob data file is empty or corrupt, so HEAD gives false confidence.
      local got
      got=$(curl -sfL -r 0-0 "${registry}/v2/${repo}/blobs/${digest}" | wc -c | tr -d ' ')
      if [ -z "${got}" ] || [ "${got}" -eq 0 ] 2>/dev/null; then
        echo "  EMPTY blob: ${digest}"
        failed=1
      fi
    done <<< "${digests}"
  }

  while IFS= read -r entry; do
    [ -z "${entry}" ] && continue
    local kind="${entry%%:*}"
    local digest="${entry#*:}"

    if [ "${kind}" = "manifest" ]; then
      # Resolve sub-manifest and check its blobs
      local sub_json
      sub_json=$(curl -sf -H "Accept: ${accepts}" \
        "${registry}/v2/${image_name}/manifests/${digest}") || {
        echo "ERROR: could not fetch sub-manifest ${digest}"
        failed=1
        continue
      }
      _check_blobs "${image_name}" "${sub_json}"
    else
      # Single manifest — check directly
      _check_blobs "${image_name}" "${manifest_json}"
    fi
  done <<< "${manifest_digests}"

  if [ "${failed}" -ne 0 ]; then
    echo "ERROR: ${image_name}:${tag} has one or more empty blobs in the registry."
    echo "       The push was likely interrupted mid-transfer. Re-run this script to retry."
    return 1
  fi

  echo "OK: ${image_name}:${tag} — all blobs present"
}
