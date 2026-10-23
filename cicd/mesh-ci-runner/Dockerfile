# Pull bun binaries from the official image — avoids running an unverified install script.
FROM oven/bun:1-debian AS bun-source

FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y \
    curl \
    git \
    gnupg \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Install docker CLI + buildx plugin before switching users (requires root)
RUN ARCH=$(dpkg --print-architecture) \
    && curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /usr/share/keyrings/docker.gpg \
    && echo "deb [arch=${ARCH} signed-by=/usr/share/keyrings/docker.gpg] https://download.docker.com/linux/debian bookworm stable" \
       > /etc/apt/sources.list.d/docker.list \
    && apt-get update && apt-get install -y docker-ce-cli docker-buildx-plugin \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -m -u 1001 -s /bin/bash mesh \
    # Dedicated jobs user: no home dir, no shell, isolated from ~/.mesh.
    # Shell jobs run as this uid so they cannot read keys/, mesh.toml, or
    # push-token-hash even if the worktree is on the same filesystem.
    # uid=65533 is the conventional "nobody-like" uid for unprivileged workers.
    && useradd -r -u 65533 -g nogroup -s /sbin/nologin mesh-jobs

# Copy bun from the official image instead of running curl | bash.
RUN mkdir -p /home/mesh/.bun/bin
COPY --from=bun-source /usr/local/bin/bun /home/mesh/.bun/bin/bun
RUN chown -R mesh:mesh /home/mesh/.bun

USER mesh
ENV HOME=/home/mesh \
    PATH="/home/mesh/.local/bin:/home/mesh/.bun/bin:$PATH"

# Install mesh: download the script to a file so the hash is visible in build logs.
# When upgrading MESH_REF, re-run the build and pin the printed SHA256 here for auditing.
RUN curl -fsSL https://raw.githubusercontent.com/kaizen-hq/mesh/main/install.sh \
      -o /tmp/mesh-install.sh \
    && echo "mesh install.sh sha256: $(sha256sum /tmp/mesh-install.sh)" \
    && MESH_REF=v7.8.0 bash /tmp/mesh-install.sh \
    && rm /tmp/mesh-install.sh

# Grant the mesh binary file capabilities so uid=1001 can spawn child
# processes as a different uid (jobs_uid=65533) via Bun.spawn { uid, gid }.
# File capabilities are applied at exec time by the kernel and survive the
# runtime's setuid(1001) call. This requires no_new_privs=0 in the pod
# securityContext (i.e. allowPrivilegeEscalation must not be set to false).
USER root
RUN apt-get update && apt-get install -y --no-install-recommends libcap2-bin \
    && rm -rf /var/lib/apt/lists/* \
    && setcap 'cap_setuid,cap_setgid=ep' /home/mesh/.local/bin/mesh
USER mesh

COPY --chown=mesh:mesh entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

WORKDIR /home/mesh

EXPOSE 7979

ENTRYPOINT ["/entrypoint.sh"]
