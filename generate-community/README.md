# Generate Community (TypeScript)

TypeScript port of the `generate-community` Rust crate (`../../generate-community/`).
It reads the [`bevy-community`](https://github.com/bevyengine/bevy-community)
repository layout and generates the Zola content under `content/community/`
(the `people` section/pages, the `donate` section, `_index.md`s, and member
`.md` files with `+++` TOML frontmatter).

Runs on Node 22 with `node --experimental-strip-types` (no build step / no
transpile needed — the `.ts` files are executed directly).

## Usage

For most uses run the shell script from any directory:

```sh
./tools/generate-community/generate_community.sh
```

This clones Bevy's `bevy-community` repo (shallow) into
`tools/generate-community/bevy-community` and then generates the Zola pages into
the repo-root `content/` folder.

To run the generators directly against an already-cloned `bevy-community`
directory (positional args, matching the Rust binaries):

```sh
# generate
node --experimental-strip-types tools/generate-community/generate.ts \
  <community_dir> <content_dir> <content_sub_dir>

# validate
node --experimental-strip-types tools/generate-community/validate.ts <community_dir>
```

The website invocation is `generate.ts bevy-community ../../content/ community`
(from inside this folder). The generated section path becomes
`<content_dir>/<content_sub_dir>/people/...`, e.g. `content/community/people/...`.

> Note: like the Rust crate, `generate` uses a non-recursive `mkdir` for the
> top section folder, so `<content_dir>/<content_sub_dir>` (e.g.
> `content/community`) must already exist. In this repo it does.

## Inputs

The `bevy-community` repo is a tree of folders (sections) and `*.toml` files
(members):

- `_roles.toml` (repo root) — defines `project-lead`, `maintainer`, and `[[sme]]`
  entries (by GitHub id). Roles are matched to members by their `github` field
  and injected into the generated frontmatter. Members must **not** set `roles`
  directly (validation enforces this).
- `_category.toml` (per folder, optional) — `order` (integer) and
  `sort_order_reversed` (bool) for that section.
- Member files (`*.toml`) — `name` (required) plus optional `profile-picture`
  (`"GitHub"` or a local image filename), `sponsor`, `bio`, and social links
  (`discord`, `discord-userid`, `github`, `mastodon`, `twitter`, `bluesky`,
  `instagram`, `itch-io`, `steam-developer`, `website`). Unknown keys are an
  error (mirrors serde `deny_unknown_fields`).
- `.git` and `.github` folders, and `_category.toml` / `_roles.toml` files, are
  skipped during the member walk.

### Network dependency

`generate_community.sh` clones the `bevy-community` repo from GitHub:

```
git clone --depth=1 https://github.com/bevyengine/bevy-community bevy-community
```

This requires network access to `github.com`. The generators themselves are
offline; only the clone step needs the network.

## Outputs

Written under `<content_dir>/<content_sub_dir>/`:

- `people/_index.md` — root section (`template = "people.html"`,
  `header_message = "People"`).
- `people/<section>/_index.md` — one per source folder (folder name
  lower-cased as the slug). Carries `weight` (from `_category.toml` `order`, else
  positional), `sort_by = "weight"`, and `[extra] sort_order_reversed`.
- `people/<section>/<member>.md` — one per member file (source file name with
  `.toml` removed). Frontmatter has `title`, `weight`, and an `[extra]` table
  with the social/profile fields and resolved `roles`.
- `donate/...` — a clone of the **The Bevy Organization** section renamed to
  *Supporting Bevy Development* (`template = "donate-community.html"`,
  `header_message = "Supporting Bevy"`), keeping only members that have a
  `sponsor`.

Profile pictures:

- `"GitHub"` → `profile_picture = "https://github.com/<github>.png"`.
- a local filename → the image is copied next to the generated page and
  `profile_picture` is rewritten to the section-relative path.

Member ordering within a section is by role group (Project Lead = 0,
Maintainer = 1, any other role = 2, none = 99999) and **randomly shuffled within
each group**, exactly like the Rust crate (`rand`). The per-member `weight`
therefore varies run-to-run for equal-order members; this is non-deterministic
in both implementations by design.

## Validation (`validate.ts`)

Mirrors `src/bin/validate.rs`:

- File profile pictures must reference an existing file.
- `"GitHub"` profile pictures require a `github` field.
- Bios must be at most **180 graphemes** (counted with `Intl.Segmenter`, matching
  the Rust `unicode-segmentation` extended grapheme clusters).
- Members must not set `roles` directly.

## Parity with the Rust crate

The frontmatter is produced through a small custom TOML serializer
(`toml-serialize.ts`) that reproduces, byte-for-byte, the output of the Rust
`toml` crate v0.9 (`toml::to_string`) — including its string-quoting heuristics
(literal vs. basic vs. multi-line, ported from `toml_writer`), field order, the
blank line before `[extra]`, and the trailing newline. `smol-toml` is used only
to **parse** the input TOML, never to emit output (its `stringify` uses different
quoting and layout).

A cross-check harness compared this port against the original Rust binary on a
fabricated `bevy-community` sample (GitHub & file profile pictures, sponsors,
multi-line bios, strings containing both `'` and `"`, SME/maintainer/lead roles,
`_category.toml` ordering + reversed sort, the donate clone). Results:

- All `_index.md` files were **byte-for-byte identical**.
- All member `.md` files were identical once the (randomized) `weight` line is
  normalized.
- Validation outcomes and error messages matched (unknown field, direct roles,
  bio length boundary at 180, missing image file, ZWJ-emoji grapheme counting).

### Not validated here

A real end-to-end run against the live `bevy-community` repo was not performed
(it needs network access to GitHub, unavailable in this environment). The port
was validated against fabricated sample inputs only.

## Files

- `toml-serialize.ts` — TOML value serializer matching the Rust `toml` crate.
- `lib.ts` — port of `src/lib.rs` (member/section parsing, role mapping, walk).
- `generate.ts` — port of `src/bin/generate.rs` (CLI entry point).
- `validate.ts` — port of `src/bin/validate.rs`.
- `generate_community.sh` — clone + generate wrapper.
