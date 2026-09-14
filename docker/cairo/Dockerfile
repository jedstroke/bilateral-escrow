# Cairo toolchain: Scarb (compiler + package manager) and Starknet Foundry (snforge, sncast).
# Built once, then used as a throwaway shell: `docker compose run --rm cairo scarb build`.
FROM ubuntu:24.04

ARG SCARB_VERSION=2.19.4
ARG SNFOUNDRY_VERSION=0.63.0

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

ENV PATH="/root/.local/bin:${PATH}"

RUN curl --proto '=https' --tlsv1.2 -sSf https://docs.swmansion.com/scarb/install.sh \
    | sh -s -- -v ${SCARB_VERSION}

RUN curl -sSL https://raw.githubusercontent.com/foundry-rs/starknet-foundry/master/scripts/install.sh | sh \
    && snfoundryup -v ${SNFOUNDRY_VERSION}

RUN scarb --version && snforge --version && sncast --version

WORKDIR /work/contracts
