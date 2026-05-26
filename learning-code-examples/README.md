# Learning Code Examples (TypeScript)

TypeScript port of the `learning-code-examples` crate tooling
(`../../learning-code-examples/`), part of converting the site's tooling from
Rust to TypeScript.

The `learning-code-examples` crate is a Cargo "examples" project: a collection
of `.rs` files under `examples/` that are embedded into the Bevy website docs
via the `file_code_block` shortcode. The crate has **no Rust source** (`src/`) —
its only tooling is `validate_examples.sh`, which runs:

```sh
cargo check --examples && cargo clippy --examples -- -Dwarnings && cargo fmt --check
```

This port reproduces that validation and adds the parts that can run without a
Rust toolchain (anchor and reference validation).

Runs on Node 22 with `node --experimental-strip-types` (no build step / no
transpile needed — the `.ts` files are executed directly). No runtime
dependencies.

## Usage

The wrapper script can be called from any directory and runs both validations
(toolchain-free checks first, then the cargo checks):

```sh
./tools/learning-code-examples/validate_examples.sh
```

Or run a single phase directly:

```sh
# Toolchain-free: ANCHOR structure + content reference checks.
node --experimental-strip-types tools/learning-code-examples/validate.ts check-anchors

# Cargo check / clippy / fmt (requires the Rust toolchain).
node --experimental-strip-types tools/learning-code-examples/validate.ts cargo
```

Options:

- `--crate-path <PATH>` — path to the `learning-code-examples` crate
  (default: `<repo>/learning-code-examples`).
- `--content-path <PATH>` — site content directory scanned for
  `file_code_block` references (default: `<repo>/content`; pass `none` to skip).
- `-h` / `--help` — print help.

## What it validates

### `cargo` subcommand

Faithful reproduction of `validate_examples.sh`: runs `cargo check --examples`,
`cargo clippy --examples -- -Dwarnings`, and `cargo fmt --check` in the crate
directory, stopping at the first failure (mirroring the `&&` chaining in the
shell script). This **requires the Rust toolchain** and cannot be done in pure
TypeScript — it is intentionally shelled out to `cargo`, matching the original.

### `check-anchors` subcommand (toolchain-free)

1. **Example registration** — every `[[example]]` `path` in `Cargo.toml` exists,
   and every `examples/**/*.rs` file is registered as an `[[example]]`.
2. **ANCHOR structure** — for each example file: anchors are balanced (no
   unclosed `// ANCHOR:` and no orphan `// ANCHOR_END:`), the same anchor is not
   opened twice while already open, and each anchor renders at least one line.
3. **Content references** — every `file_code_block(file=..., anchor=...)`
   shortcode call in the content directory resolves to an existing example file
   and (if an anchor is given) an existing anchor.

Exits non-zero with a per-issue report if anything fails.

## ANCHOR / HIDE semantics

Anchor extraction is a faithful reproduction of the `file_code_block`
shortcode's `extractAnchor` (`astro-site/src/lib/shortcodes.ts`), which mirrors
the original Zola Tera template (`templates/shortcodes/file_code_block.md`):

- Source is split on `\n`.
- A line ending with `// ANCHOR_END: <anchor>` closes the region (checked before
  emission, so the end marker line is never included).
- A line ending with `// HIDE` is dropped from the rendered output.
- While inside the region, lines that do not contain `// ANCHOR:` or
  `// ANCHOR_END:` are emitted (so nested anchors' markers are excluded).
- A line ending with `// ANCHOR: <anchor>` opens the region (checked after
  emission, so the start marker line is never included).

## Tests

```sh
node --experimental-strip-types tools/learning-code-examples/test/run.ts
```

Covers anchor extraction (including the nested/HIDE example from the crate's own
README), anchor-structure validation, and `Cargo.toml` `[[example]]` parsing.

## Files

- `lib.ts` — anchor extraction/validation, `Cargo.toml` example parsing, and
  `file_code_block` reference scanning.
- `validate.ts` — CLI entry point (`cargo` and `check-anchors` subcommands).
- `validate_examples.sh` — wrapper that runs both phases; callable from any
  directory (equivalent to the crate's `validate_examples.sh`).
- `test/run.ts` — unit tests.

## Parity with the Rust crate

The crate had no Rust logic to port beyond `validate_examples.sh`; the `cargo`
subcommand reproduces that script exactly. The `check-anchors` subcommand is a
new, toolchain-free addition that validates the anchor data the examples exist
to provide, using the exact extraction semantics of the site's `file_code_block`
shortcode.

Validated locally against the real `learning-code-examples/examples/` and the
site `content/`: 13 examples (all registered and present), all anchors
well-formed, and all 23 `file_code_block` references resolving correctly. The
`cargo` phase invokes the toolchain correctly but a full build could not be
completed in the offline sandbox (dependency fetch blocked by the network
policy) — that is an environment limitation, not a tool defect.
