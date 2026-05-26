#!/bin/sh
# TypeScript-port wrapper, equivalent to learning-code-examples/validate_examples.sh.
#
# Runs the toolchain-free anchor/reference validation, then the cargo
# check/clippy/fmt validation. Can be called from any directory.

set -e

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

NODE_BIN="${NODE_BIN:-node}"

"$NODE_BIN" --experimental-strip-types "$SCRIPT_DIR/validate.ts" check-anchors
"$NODE_BIN" --experimental-strip-types "$SCRIPT_DIR/validate.ts" cargo
