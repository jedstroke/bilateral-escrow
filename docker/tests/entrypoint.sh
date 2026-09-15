#!/bin/sh
# Install dependencies into the node_modules volume, then run whatever was asked.
#
# DOCKER_UID / DOCKER_GID are set by scripts/compose.mjs on Linux hosts, so that files
# written to bind mounts (package-lock.json, deployments/*.json) belong to you and not
# to root. On Windows and macOS they stay unset and everything runs as root, which is
# what Docker Desktop expects.
set -e

uid="${DOCKER_UID:-0}"
gid="${DOCKER_GID:-0}"
install="npm install --no-audit --no-fund --loglevel=error"

if [ "$uid" = "0" ]; then
  $install
  exec "$@"
fi

# The node_modules volume is created root-owned (and may hold a root-run install from
# before). Hand it over once; after that the owner matches and this is skipped.
if [ "$(stat -c %u /work/tests/node_modules)" != "$uid" ]; then
  chown -R "$uid:$gid" /work/tests/node_modules
fi
# A uid with no passwd entry has no home; give npm and tsx somewhere to write.
export HOME=/tmp npm_config_cache=/tmp/.npm
su-exec "$uid:$gid" $install
exec su-exec "$uid:$gid" "$@"
