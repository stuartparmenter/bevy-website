#!/bin/sh

# Switch to script's directory, letting it be called from any folder.
cd $(dirname $0)

# Download a copy of the Bevy community repository.
git clone --depth=1 https://github.com/bevyengine/bevy-community bevy-community

# The original tooling output to ../content/ relative to the Rust crate
# (generate-community/). This TS port lives in tools/generate-community/, so the
# repo-root content/ folder is two levels up.
node --experimental-strip-types generate.ts bevy-community ../../content/ community
