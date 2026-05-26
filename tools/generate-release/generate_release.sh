#!/bin/sh

# Switch to the script's directory, letting it be called from any folder.
cd "$(dirname "$0")"

# Thin wrapper around the TS generator. All arguments are passed straight
# through to generate.ts. A GITHUB_TOKEN env var (or a .env file at the repo
# root) is required.
#
# Examples:
#   ./generate_release.sh --from v0.13.0 --to main --release-version 0.14 migration-guides
#   ./generate_release.sh --from v0.13.0 --to main --release-version 0.14 release-notes
#   ./generate_release.sh --from v0.13.0 --to main --release-version 0.14 changelog
#   ./generate_release.sh --from v0.13.0 --to main --release-version 0.14 contributors

node --experimental-strip-types generate.ts "$@"
