FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

# Create the dedicated mesh user before installing so the install script runs as
# that user and all files land in /home/mesh/.local/ — owned by mesh, never root.
RUN useradd -m -u 1001 -s /bin/bash mesh

USER mesh
ENV HOME=/home/mesh \
    PATH="/home/mesh/.local/bin:$PATH"

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
