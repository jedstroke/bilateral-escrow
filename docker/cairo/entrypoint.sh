#!/bin/sh
# Run the toolchain as the host user when asked to.
#
# DOCKER_UID / DOCKER_GID are set by scripts/compose.mjs on Linux hosts, so that
# contracts/target is owned by you rather than by root. On Windows and macOS they stay
# unset and everything runs as root, which is what Docker Desktop expects.
set -e

uid="${DOCKER_UID:-0}"
gid="${DOCKER_GID:-0}"

if [ "$uid" = "0" ]; then
  exec "$@"
fi

# The cache volume may predate this image and be root-owned. Hand it over once;
# after that the owner matches and this is skipped.
if [ "$(stat -c %u /root/.cache/scarb)" != "$uid" ]; then
  chown -R "$uid:$gid" /root/.cache/scarb
fi
exec gosu "$uid:$gid" "$@"
