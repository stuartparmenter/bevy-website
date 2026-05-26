# Generate Release (TypeScript)

TypeScript port of the `generate-release` Rust crate (`../../generate-release/`).
It generates the skeleton files under `release-content/<release-version>/` that
the website's release blog posts and migration-guide pages consume:

- `migration-guides/_guides.toml` + one `.md` per guide
- `release-notes/_release-notes.toml` + one `.md` per note
- `changelog.toml`
- `contributors.toml`

Data is fetched from the Bevy GitHub repo (commits, PRs/issues, contributors)
via the GitHub REST + GraphQL APIs.

Runs on Node 22 with `node --experimental-strip-types` (no build step — the
`.ts` files are executed directly). The only runtime dependency is `smol-toml`
(used to read back the pre-existing `_guides.toml` / `_release-notes.toml` when
not overwriting).

## Requirements

A valid `GITHUB_TOKEN` is required (classic token with `repo` scope, so it can
open issues / comment for the `release-notes` subcommand). Provide it via the
environment, or a `.env` file at the repository root:

```env
GITHUB_TOKEN=token_string_copied_from_github
```

The `.env` loader mirrors the Rust crate's `dotenvy`: it only sets variables
that are not already present in the environment.

## Usage

From any directory:

```sh
./tools/generate-release/generate_release.sh \
  --from v0.13.0 --to main --release-version 0.14 <subcommand> [options]
```

or directly:

```sh
node --experimental-strip-types tools/generate-release/generate.ts \
  --from v0.13.0 --to main --release-version 0.14 <subcommand> [options]
```

Global options (all required except `--release-path`):

- `-f, --from <FROM>` — branch / tag / commit to start from.
- `-t, --to <TO>` — branch / tag / commit to end on.
- `-r, --release-version <VERSION>` — e.g. `0.14`. Output goes to
  `release-content/<VERSION>/`.
- `--release-path <PATH>` — override the output root (defaults to
  `<repo>/release-content`). Not present in the Rust CLI; added here so the
  tool can be pointed at a scratch dir for testing.

See `--help` for the full text.

## Subcommands

These match the Rust crate exactly:

| Subcommand          | Options                                | Output |
| ------------------- | -------------------------------------- | ------ |
| `migration-guides`  | `-o, --overwrite-existing`             | `migration-guides/_guides.toml` + per-guide `.md` |
| `release-notes`     | `-o, --overwrite-existing`, `-c, --create-issues` | `release-notes/_release-notes.toml` + per-note `.md` |
| `changelog`         | —                                      | `changelog.toml` |
| `contributors`      | —                                      | `contributors.toml` |

### `migration-guides`

Fetches all merged PRs between `--from` and `--to`, keeps those with a
`## Migration Guide` section in the body or the `M-Needs-Migration-Guide` label,
groups them by their `A-*` area labels, and writes one cleaned-up Markdown file
per guide plus a `_guides.toml` metadata index.

When `--overwrite-existing` is not passed, the existing `_guides.toml` is read
and any PR already recorded there is skipped (so hand-merged / hand-edited
entries are preserved). The metadata is always re-sorted (area ascending, empty
areas last; then title ascending) and rewritten.

File naming: `<pr_number>_<slug>.md`, where `<slug>` is the title with spaces
replaced by `_` and all non-(Unicode-letter/number/`_`) characters removed, then
the whole `<pr_number>_<slug>` truncated to 64 UTF-8 bytes.

### `release-notes`

Fetches merged PRs with the `M-Needs-Release-Note` label and writes a skeleton
`<!-- TODO -->` note per PR plus a `_release-notes.toml` index. Without
`--overwrite-existing`, already-recorded PRs are skipped and new entries are
appended; with it, the file is rewritten. With `--create-issues`, an issue is
opened on `bevy-website` for each PR lacking notes and a comment is left on the
original PR; without it (the default) this is a dry run that prints what it
*would* do.

### `changelog`

Lists every merged PR between `--from` and `--to`, grouped by area label
(empty areas last) and sorted within each area by close date.

### `contributors`

Lists the unique author/co-author logins across all merged PRs (resolved via the
GraphQL commit-authors query, with retry/backoff). `@github-actions[bot]` is
filtered out.

## Parity notes / differences from the Rust crate

- TOML for the generated `.toml` files is hand-emitted as raw strings (exactly
  like the Rust crate's `format!`/`writeln!`), not via a serializer, so the byte
  layout matches. `smol-toml` is only used for *reading* the pre-existing
  metadata files.
- Each `[[guides]]` / `[[release_notes]]` / `[[areas]]` block is followed by a
  blank line, matching the Rust `writeln!("{block}")` (the block already ends in
  a newline).
- `release-notes` emits `authors = ["@author",]` with the trailing comma exactly
  as the Rust template does.
- The Rust crate parallelizes `contributors` with rayon (3 threads); the port
  mirrors this with 3 concurrent async workers. Because the underlying set is
  unordered (`HashSet` in Rust), the line order of `contributors.toml` is
  non-deterministic in both implementations.
- Markdown processing (the `migration-guides` body cleanup) is the only place
  the Rust crate uses an external parser (`pulldown-cmark` 0.9.2). There is no
  exact-equivalent dependency-free JS library, so `markdown.ts` reimplements the
  needed subset of CommonMark to produce the same event stream the Rust renderer
  consumes (headings, paragraphs, fenced/indented code, nested lists, block
  quotes, thematic breaks, raw HTML, and the inline elements the renderer
  special-cases). This is faithful for the constructs that appear in Bevy PR
  bodies but is not a full CommonMark engine.

## Validation

The GitHub-fetching subcommands need network access and a token, so they cannot
be run end-to-end offline. The pure-local pieces are validated against the
committed `release-content/` output:

```sh
node --experimental-strip-types tools/generate-release/validate.ts
```

This checks:

- **`_guides.toml` block serialization** — every parsed guide block is re-emitted
  and must appear verbatim in the committed file. 100% match for 0.15
  (214/214) and 0.16 (165/165); 0.14 matches in its legacy quoted-`prs` format
  (130/130).
- **`changelog.toml` block serialization** — 100% verbatim match for 0.14
  (90/90 areas) and 0.15 (109/109, one entry skipped for an embedded newline in
  a hand-entered title).
- **`file_name` reconstruction** from title + PR number for single-PR guide
  entries. Most match; the rest are guides whose `title` was edited after
  generation (so the slug no longer regenerates) or which were produced by an
  older version of the tool with a different truncation length (the 0.16 data
  shows 37 files capped at exactly 64 chars, confirming the current truncation
  behaviour).

What is **not** validated offline (network-bound, or non-deterministic):

- The actual GitHub fetching (`compareCommits`, `getIssuesAndPrs`,
  `getContributors`, `openIssue`, `leaveComment`).
- End-to-end `migration-guides` / `release-notes` runs (they fetch + process
  live PR bodies). The committed per-guide `.md` files are additionally
  hand-edited after generation, so they are not byte-exact references for the
  markdown transform.
- `contributors.toml` line ordering (non-deterministic set iteration).

## Files

- `generate.ts` — CLI entry point (port of `src/main.rs`).
- `github-client.ts` — GitHub REST/GraphQL client (port of `src/github_client.rs`).
- `helpers.ts` — merged-PR gathering, area extraction, contributor retry (port of `src/helpers.rs`).
- `markdown.ts` — Markdown section extraction + re-rendering (port of `src/markdown.rs`).
- `migration-guides.ts`, `release-notes.ts`, `changelog.ts`, `contributors.ts` —
  the four subcommands.
- `util.ts` — slugify, UTF-8 truncate, and Rust-`Ord`-compatible comparators.
- `validate.ts` — offline validation harness (see above).
- `generate_release.sh` — wrapper that runs `generate.ts` with Node 22.
