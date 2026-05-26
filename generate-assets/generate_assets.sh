#!/bin/sh
set -e

# Switch to script's directory, letting it be called from any folder.
cd "$(dirname "$0")"

# Download a copy of the Bevy assets repository.
git clone --depth=1 https://github.com/bevyengine/bevy-assets assets

# Download + extract the crates.io database dump (the Rust crate used
# `cratesio-dbdump-csvtab` to do this automatically and cache it under ./data).
# We extract the CSVs we need into ./data so the generator can load them via
# node:sqlite. This is a large download (hundreds of MB); set CRATES_IO_DATA_DIR
# to an already-extracted dump's `data/` dir to skip it.
if [ -z "$CRATES_IO_DATA_DIR" ] && [ ! -d data ]; then
  echo "Downloading crates.io db dump (this is large)..."
  curl -fSL https://static.crates.io/db-dump.tar.gz -o db-dump.tar.gz
  # The dump extracts to a timestamped dir containing `data/`. Pull out the
  # three CSVs we need and place them flat under ./data.
  mkdir -p data
  tar -xzf db-dump.tar.gz \
    --wildcards \
    --strip-components=2 \
    -C data \
    '*/data/crates.csv' '*/data/versions.csv' '*/data/dependencies.csv'
  rm -f db-dump.tar.gz
fi

# The original tooling output to ../content/ relative to the Rust crate
# (generate-assets/). This TS port lives in tools/generate-assets/, so the
# repo-root content/ folder is one level up.
#
# GITHUB_TOKEN / GITLAB_TOKEN should be set in the environment (or a .env loaded
# by the caller) to enrich github.com / gitlab.com hosted assets.
node --experimental-strip-types generate.ts assets ../content/
