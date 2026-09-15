# Cairo toolchain: Scarb (compiler + package manager) and Starknet Foundry (snforge, sncast).
# Built once, then used as a throwaway shell: `docker compose run --rm cairo scarb build`.
FROM ubuntu:24.04

ARG SCARB_VERSION=2.19.4
ARG SNFOUNDRY_VERSION=0.63.0

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates git gosu \
    && rm -rf /var/lib/apt/lists/*

ENV PATH="/root/.local/bin:${PATH}"

RUN curl --proto '=https' --tlsv1.2 -sSf https://docs.swmansion.com/scarb/install.sh \
    | sh -s -- -v ${SCARB_VERSION}

RUN curl -sSL https://raw.githubusercontent.com/foundry-rs/starknet-foundry/master/scripts/install.sh | sh \
    && snfoundryup -v ${SNFOUNDRY_VERSION}

RUN scarb --version && snforge --version && sncast --version

# Let the toolchain run as any uid (see entrypoint.sh). HOME stays /root because that is
# where scarb and snforge were installed; the chmod lets a non-root uid use them.
ENV HOME=/root XDG_CACHE_HOME=/root/.cache XDG_DATA_HOME=/root/.local/share
RUN mkdir -p /root/.cache/scarb && chmod -R a+rwX /root
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

WORKDIR /work/contracts
ENTRYPOINT ["/entrypoint.sh"]
