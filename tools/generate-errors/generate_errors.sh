#!/bin/sh

# Switch to script's directory, letting it be called from any folder.
cd $(dirname $0)

./download_errors.sh

# The original tooling output to ../content/learn relative to the Rust crate
# (generate-errors/). This TS port lives in tools/generate-errors/, so the
# repo-root content/learn folder is two levels up.
node --experimental-strip-types generate.ts --errors-path bevy/errors --output-path ../../content/learn
