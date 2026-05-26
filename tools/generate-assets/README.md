# Generate Assets (TypeScript)

TypeScript port of the `generate-assets` Rust crate (`../../generate-assets/`).
It reads the [`bevy-assets`](https://github.com/bevyengine/bevy-assets)
repository layout (a tree of folders = sections and `*.toml` files = assets) and
generates the Zola content under `content/assets/` (`_index.md`s plus per-asset
`.md` files with `+++` TOML frontmatter). It can also **validate** the
`bevy-assets` TOML files (used by that repo's CI).

Runs on Node 22 with `node --experimental-strip-types` (no build step — the
`.ts` files are executed directly).

## Usage

For most uses run the shell script from any directory:

```sh
./tools/generate-assets/generate_assets.sh
```

This clones Bevy's `bevy-assets` repo (shallow) into
`tools/generate-assets/assets`, downloads + extracts the crates.io database dump
into `tools/generate-assets/data`, and generates the Zola pages into the
repo-root `content/` folder.

To run the generators directly (positional args, matching the Rust binaries):

```sh
# generate  (writes <content_dir>/assets/...)
node --experimental-strip-types tools/generate-assets/generate.ts \
  <asset_dir> <content_dir>

# validate  (exit code 1 + stderr report on failure)
node --experimental-strip-types tools/generate-assets/validate.ts <asset_dir>
```

The website invocation is `generate.ts assets ../../content/` (from inside this
folder). The generated section root is `<content_dir>/assets/...`, e.g.
`content/assets/...`.

### Environment variables (`generate` only)

| Variable | Purpose | If unset |
| --- | --- | --- |
| `GITHUB_TOKEN` | Authenticate GitHub API calls (Cargo.toml / license / file search) used to enrich `github.com`-hosted assets. | GitHub links are skipped. |
| `GITLAB_TOKEN` | Present for parity; GitLab is queried **unauthenticated** in both the Rust crate and this port. | GitLab links are still queried unauthenticated, matching the Rust crate. |
| `CRATES_IO_DATA_DIR` | Directory containing the extracted crates.io dump CSVs (`crates.csv`, `versions.csv`, `dependencies.csv`). | Defaults to `./data`; if that's absent, crates.io enrichment **and** the latest-Bevy-version sort key are skipped. |

## Inputs

- `_category.toml` (per folder, optional) — `order` (integer) and
  `sort_order_reversed` (bool) for that section.
- Asset files (`*.toml`) — `name`, `link`, `description` (required) plus optional
  `order` (int), `image` (local filename), `crate` (crates.io crate name),
  `licenses` (string array), `bevy_versions` (string array), `nsfw` (bool).
  Unknown keys are an error (mirrors serde `deny_unknown_fields`).
- `.git` / `.github` folders and `_category.toml` files are skipped during the
  asset walk.

## Outputs

Written under `<content_dir>/assets/`:

- `assets/_index.md` — root section (`template = "assets.html"`,
  `header_message = "Assets"`).
- `assets/<section>/_index.md` — one per source folder (folder name lower-cased
  as the slug). Carries `weight` (from `_category.toml` `order`, else
  positional), `sort_by = "weight"`, and `[extra] sort_order_reversed`.
- `assets/<section>/<asset>.md` — one per asset file. The file name is the
  asset's `name` run through the slug rule (ASCII-lowercased, `/`→`-`, ` `→`_`,
  then every character that is not ASCII `[0-9A-Za-z]`/`-`/`_` stripped — note
  non-ASCII letters are dropped). Frontmatter has `title`, `description`,
  `weight`, and an `[extra]` table with `link`, `image`, `licenses`,
  `bevy_versions`, `nsfw` (each omitted if absent).

Images: if `image` is set, the file is copied next to the generated page and the
frontmatter `image` is rewritten to the section-relative path.

### Ordering (matches the Rust crate, including its non-determinism)

`sort_section` (in `generate.ts`) sorts assets within each section by the tuple
`(manual order ?? MAX, not-semver-compatible-with-latest-Bevy, random)`, then
assigns each asset a sequential `weight`. So:

1. assets with a manual `order` come first (in that order),
2. then assets whose first `bevy_versions` entry is semver-compatible with the
   latest Bevy from the crates.io dump,
3. ties broken **randomly** (`Math.random`, like the Rust `rand` tiebreaker).

Sub-sections are ordered by the byte-wise string `"{order}-{name}"`. The
random tiebreaker means per-asset `weight` varies run-to-run for equal-rank
assets; this is non-deterministic in both implementations by design.

## Metadata enrichment (network)

Each asset's bevy version + license may be filled in from external sources,
dispatched on the asset's host (mirroring `get_extra_metadata`):

- **`crate` field set** → look up the crate in the crates.io DB dump
  (`crates.io`). Retried with `-` substituted for `_` if not found. Done
  synchronously during the walk (`node:sqlite`).
- **`github.com` link** → fetch the root `Cargo.toml`; if license missing, fetch
  the repo license; if anything still missing, search all `Cargo.toml` files and
  merge results. (GitHub Search API tends to 403 after a number of calls, so
  later assets may be under-enriched — same caveat as the Rust crate.)
- **`gitlab.com` link** → search the project by name, fetch its root
  `Cargo.toml`.

`set_license` splits on `" OR "`; `set_bevy_version` wraps a single version.
Both are no-ops if the asset already declares the field (so TOML-declared
`licenses` / `bevy_versions` always win).

### crates.io database dump

The Rust crate used `cratesio-dbdump-csvtab` to download
`https://static.crates.io/db-dump.tar.gz`, load the `crates` / `dependencies` /
`versions` CSVs into an in-memory SQLite DB, and run SQL against it. This port
reproduces that: `generate_assets.sh` downloads + extracts the three CSVs into
`./data`, and `metadata.ts` loads them into an in-memory `node:sqlite` database
with the **same table columns, indices, and SQL queries** as the Rust crate
(latest-version selection by parsed major/minor/patch, bevy-dependency join,
official-bevy-crate discovery by homepage+repository, latest Bevy version).

### Async note

The Rust enrichment is synchronous (`ureq`). Node's `fetch` is async, so this
port splits enrichment into two phases that preserve the same effect:

1. `parseAssets` enriches **crates.io** assets synchronously during the walk
   (via `node:sqlite`).
2. `enrichAssets` is an async post-pass (before sorting) that enriches
   **github.com / gitlab.com** assets.

Because enrichment finishes before `sort_section` runs, the semver-compat sort
sees the same data the Rust crate would.

## Validation (`validate.ts`)

Mirrors `src/bin/validate.rs` (no metadata enrichment):

- Description ≤ **100 bytes** (`String::len()` is a byte count).
- Description must not contain forbidden formatting: a newline, a leading `#`,
  or a markdown link (`[..](/.. or http(s)://..)`).
- If `image` is set: extension must be one of `gif, jpg, jpeg, png, webp`, the
  file must exist, and be ≤ **2 MiB** (2097152 bytes).

On failure it prints each invalid asset + its errors to stderr and exits 1.

## Parity with the Rust crate

The frontmatter is produced through a small custom TOML serializer
(`toml-serialize.ts`, shared with `../generate-community/`) that reproduces,
byte-for-byte, the output of the Rust `toml` crate v0.9 (`toml::to_string`) —
string-quoting heuristics, field order, the blank line before `[extra]`, and the
trailing newline. `smol-toml` is used only to **parse** input TOML.

### Validated here

- **24 unit tests** (`lib.test.ts`, `node --test`) cover: the slug rule, the
  `set_license`/`set_bevy_version` setters, the Cargo.toml license + bevy-version
  detection (all the cases from the Rust crate's `#[cfg(test)]` module), license
  / version merging, semver `VersionReq` matching, the frontmatter serializer
  shape, the directory walk + `deny_unknown_fields`, `_category.toml` reading,
  and injected-metadata application.
- The frontmatter serializer output and the slug algorithm were each
  cross-checked against **standalone Rust programs** using `toml` 0.9 and the
  exact slug expression from `generate.rs` (byte-for-byte match).
- The semver matcher was cross-checked against the real Rust `semver` crate
  (`VersionReq::parse(..).matches(..)`) across version/wildcard/comparator cases.
- An **offline end-to-end smoke test** of `generate.ts` on a fabricated `assets/`
  tree produced the expected section/asset `.md` layout and frontmatter, and
  `validate.ts` was exercised on valid and invalid trees (description length,
  formatting, image extension/existence) with matching messages.

### Not validated here

- A **direct binary-level diff against the original Rust crate** was not possible
  in this environment: the Rust crate depends on a git revision of
  `cratesio-dbdump-csvtab` that the sandbox firewall blocks, so `cargo build`
  fails. Parity was instead established piecewise (serializer, slug, semver,
  logic ports + unit tests) as described above.
- A **real end-to-end run against the live `bevy-assets` repo, crates.io dump,
  and GitHub/GitLab APIs** was not performed (all require network access
  unavailable here). The network layer (`metadata.ts`) is a faithful port but
  was only exercised against the offline crates.io-style injected metadata in
  tests, not live endpoints.

## Files

- `toml-serialize.ts` — TOML value serializer matching the Rust `toml` crate
  (shared with `generate-community`).
- `lib.ts` — port of `src/lib.rs`: asset/section model, the directory walk, the
  `MetadataSource` interface, the slug rule, and the license/version setters.
  This is the **pure, testable transformation** (no network).
- `cargo-toml.ts` — pure helpers porting the `cargo_toml`-based license +
  bevy-version detection (`get_license`, `get_bevy_version_from_manifest`, …).
- `semver.ts` — a small `VersionReq` matcher reproducing the Rust `semver`
  subset used for the compatibility sort.
- `metadata.ts` — the **network/API layer**: crates.io dump loader
  (`node:sqlite`), GitHub + GitLab clients, and the `MetadataSource`
  implementation / async enrichment pass.
- `generate.ts` — port of `src/bin/generate.rs` (CLI entry point + sorting +
  frontmatter writers).
- `validate.ts` — port of `src/bin/validate.rs`.
- `lib.test.ts` — unit tests for the pure logic.
- `generate_assets.sh` — clone + dump-download + generate wrapper.
