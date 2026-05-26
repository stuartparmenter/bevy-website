# Generate Errors (TypeScript)

TypeScript port of the `generate-errors` Rust crate (`../../generate-errors/`).
It takes the documentation of Bevy-unique error codes from the Bevy engine repo
and turns them into valid Zola pages under `content/learn/errors/`.

Runs on Node 22 with `node --experimental-strip-types` (no build step / no
transpile needed — the `.ts` files are executed directly).

## Usage

For most uses run the shell script from any directory:

```sh
./tools/generate-errors/generate_errors.sh
```

This downloads Bevy's `errors/` folder and then generates the Zola pages.

To run the generator directly against an already-downloaded `errors/` directory:

```sh
node --experimental-strip-types tools/generate-errors/generate.ts \
  --errors-path <ERRORS_PATH> --output-path <OUTPUT_PATH>
```

- `--errors-path` is the directory containing the original Bevy error files
  (e.g. `bevy/errors`).
- `--output-path` is the folder the `errors/` section folder is written into
  (the website uses `content/learn`).

See `-h` / `--help` for the help text.

## Inputs

- A directory of Bevy error-code markdown files. Each file is named with a Bevy
  error code somewhere in the file name matching `B[0-9]{4}` (e.g. `B0001.md`).
  Files whose names do not match, and any subdirectories, are ignored.

### Network dependency

`download_errors.sh` fetches the `errors/` folder from GitHub using a sparse,
shallow checkout of the Bevy engine repository:

```
git init bevy
git -C bevy remote add origin https://github.com/bevyengine/bevy
git -C bevy sparse-checkout set errors
git -C bevy pull --depth=1 origin latest
```

This requires network access to `github.com` and pulls the `latest` branch
(the most recent Bevy release). The generator itself is offline; only the
download step needs the network.

## Outputs

Written under `<OUTPUT_PATH>/errors/`:

- `_index.md` — the Zola section index (template `docs.html`, redirects to
  `/learn/errors/introduction`).
- `introduction.md` — the introduction page (weight 0).
- One page per error code, file name lower-cased (e.g. `B0001.md` -> `b0001.md`).
  Each page has TOML frontmatter with:
  - `title` = the error code (file name with the `.md` suffix removed).
  - `[extra] weight` = the 1-based position of the code in sorted order
    (the introduction page occupies weight 0, so error pages start at 1).

Per-page content transforms applied to the source markdown:

- The first `# B[0-9]{4}` heading is removed (Zola renders the title itself).
- In code fences that start with ` ```rust `, annotations are reordered so the
  language comes last, e.g. ` ```rust,no_run ` becomes ` ```no_run,rust `.
  Fences where `rust` is not the first token (e.g. ` ```should_panic,rust `)
  are left untouched, matching the Rust implementation.

## Parity with the Rust crate

The emitted frontmatter and bodies are produced as raw strings (not via a TOML
serializer) so the output is byte-for-byte identical to the original Rust crate.
A smoke test comparing both implementations on a fabricated `errors/` input
produced identical files (matching md5sums for `_index.md`, `introduction.md`,
and the per-error pages).

`smol-toml` is listed as a dependency for any future TOML needs, but the current
output is intentionally hand-emitted to guarantee identical bytes.

## Files

- `lib.ts` — port of `src/lib.rs` (`getErrorPages`, `writeSection`, `writePages`).
- `generate.ts` — port of `src/bin/generate.rs` (CLI entry point).
- `download_errors.sh` — sparse/shallow git fetch of Bevy's `errors/`.
- `generate_errors.sh` — download + generate wrapper.
