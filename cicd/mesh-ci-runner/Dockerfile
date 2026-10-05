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

RUN useradd -m -u 1001 -s /bin/bash mesh

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
    && MESH_REF=v5.8.0 bash /tmp/mesh-install.sh \
    && rm /tmp/mesh-install.sh

COPY --chown=mesh:mesh entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

WORKDIR /home/mesh

EXPOSE 7979

ENTRYPOINT ["/entrypoint.sh"]
