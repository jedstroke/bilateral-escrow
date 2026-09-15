#!/usr/bin/env sh
# Shortcut for the npm scripts in package.json, for when you'd rather type ./dev.sh than npm run.
# Same commands as dev.ps1:
#
#   ./dev.sh build              compile the Cairo contract
#   ./dev.sh test               run the TypeScript tests in Docker against devnet
#   ./dev.sh test-local         same tests, with your local Node
#   ./dev.sh deploy             deploy to devnet, write deployments/devnet.json
#   ./dev.sh up | logs | reset | down | fmt | clean | shell | typecheck | accounts | ui
#
# Anything else is passed straight to npm run, so `./dev.sh test -t disputes` works and any
# script added to package.json is available here without touching this file.
set -e
cd "$(dirname "$0")"

cmd="${1:-help}"
case "$cmd" in
  help|-h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
esac
shift

# dash-style names map to the npm colon convention: test-local -> test:local
script=$(printf '%s' "$cmd" | tr '-' ':')

# npm needs exactly one "--" before script arguments; add it ourselves.
[ "${1:-}" = "--" ] && shift

if [ "$#" -gt 0 ]; then
  exec npm run "$script" -- "$@"
else
  exec npm run "$script"
fi
