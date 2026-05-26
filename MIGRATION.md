# Zola → Astro Migration

Goal: convert this site from Zola to Astro, validated by structural comparison of
built output (Zola `public/` vs Astro `dist/`), done mechanically (no bug fixes / new
features). Frontmatter may change; Tera templates → Astro components; Rust generators → TS.

## Reference build

- Zola 0.19.2 builds to `/tmp/zola-baseline` (134 pages, 1084 files).
  Generated content (assets/errors/community/wasm-examples) is NOT present locally
  (needs network + external repos); core site is the primary validation target.
- Build reference: `zola build -o /tmp/zola-baseline`

## Key Zola features in use (must reproduce)

- TOML `+++` frontmatter (sections `_index.md` + pages). Astro will use YAML; a
  preprocessing step / custom loader converts TOML→data.
- Tera template inheritance (`layouts/base.html`), macros, blocks → Astro layouts/components.
- Shortcodes (`templates/shortcodes/*`) used inside markdown → remark/rehype + MDX-ish handling.
- Taxonomies (`news`) + Atom feed (`atom.xml`) + per-section feeds.
- Sitemap (`sitemap.xml`), `robots.txt`, `404.html`.
- Sass compilation `sass/site.scss` → `/site.css` (dart-sass `sass` pkg ≈ Zola's grass).
- Syntax highlighting: syntect, `highlight_theme="css"`, `z-`-prefixed scope classes,
  extra WGSL syntax. NOT reproducible span-for-span in JS → comparator normalizes code blocks.
- Markdown: pulldown-cmark; `insert_anchor_links="right"` adds `<a class=anchor-link href=#id>#</a>`.
  Heading IDs via Zola slugify.
- Search index: `search_index.en.js` (elasticlunr) + `elasticlunr.min.js`.
- Image processing: `resize_image`/`get_image_metadata` → `processed_images/<hash>.<ext>`.
- `load_data` (TOML/CSV/markdown), `get_section`, `get_url`, `get_image_metadata`.
- HTML minified (`minify_html=true`).

## Strategy

1. **Comparison harness** (`tools/compare.mjs`): parse both HTML trees to DOM, normalize
   whitespace, compare tag/attrs/children recursively. Code blocks (`pre>code`) compared by
   normalized text only. Non-HTML (xml/txt/css) compared by normalized text. Binary assets by
   existence + size. Reports per-file structural diffs + a summary.
2. **Astro scaffold** (`astro-site/`): output `dist/`, minify off (comparator normalizes).
3. **Static passthrough**: `static/` + colocated content assets + processed images.
4. **Layouts/pages/components** ported from Tera.
5. **Markdown pipeline**: remark/rehype tuned to match pulldown-cmark + anchor links + slugify.
6. **Feeds/sitemap/robots/search**.
7. **Rust generators → TS** (`generate-*` → TS equivalents producing identical content/data).

## Conventions

- Deterministic, repeatable changes (frontmatter TOML→YAML, bulk renames, data
  reshaping) are done via committed scripts in `tools/`, never by hand-editing many
  files. Scripts must be idempotent and re-runnable.

## Layout (after cutover)

- repo root = the Astro project (`astro.config.mjs`, `package.json`, `src/`, `scripts/`).
- `content/`, `static/`, `sass/`, `release-content/`, `learning-code-examples/examples/`
  are consumed by the build (kept from the original site).
- `generate-*/`, `write-rustdoc-hide-lines/`, `learning-code-examples/` now hold the
  **TypeScript** ports (the Rust crates were replaced in place).
- `tools/compare.mjs` — the structural comparison harness.
- Zola-only files (`config.toml`, `templates/`, `syntaxes/`, `.djlintrc`, `rustfmt.toml`,
  `Cargo.*`) were removed.

Build: `npm run build` → `dist/`.  Compare: `node tools/compare.mjs /tmp/zola-baseline dist`.

## Cutover status / remaining for production

Done: Astro at repo root; Rust→TS in place; Zola files removed; `deploy.yml` and the key
`ci.yml` jobs (`check-hide-lines`, `build-website`) switched to Node/Astro.

Done:
- `ci.yml` converted to Node/Astro (`test-tools` replaces the Rust lint/test jobs; the
  `generate-*` jobs use Node; `build-website` runs `npm run build`).
- **Search** works: `scripts/postbuild.mjs` builds `search_index.en.js` with the
  `elasticlunr` package (v0.9.5, 161 docs — same count as Zola), and ships
  `elasticlunr.min.js` from `node_modules` (the vendored copy was removed). The index is
  functionally equivalent and queryable; it is not byte-identical to Zola's Rust
  elasticlunr port (different tokenizer term frequencies), and `elasticlunr.min.js` is the
  npm build (different minification than Zola's), so both show as "differing".

Remaining (optional, functional):
- **News thumbnails**: `resize_image` produced hashed `processed_images/*`; decide on an
  Astro image-processing step (or accept different filenames). Only affects `news/index`.

## Known cross-engine limitations (cannot byte/structurally match)

- **Search index** (`search_index.en.js`): Zola's elasticlunr index is an engine-specific
  serialization; not reproducible. `elasticlunr.min.js` is a Zola builtin (copied as a
  static asset).
- **`resize_image` thumbnails** (`processed_images/<name>.<hash>.<ext>`): the hashed
  filenames and resized bytes are produced by Zola's image pipeline; a JS resizer yields
  different hashes/bytes, so `news/` index-card `src`s and these files won't match exactly.
- **Docs prev/next on ~9 book pages**: equal-weight sibling order follows Zola's
  non-portable filesystem-walk order (the-renderer/assets, release-builds/profiling). The
  menu is compared order-insensitively; the prev/next footer of the tie-adjacent pages can
  differ. See TODO in `astro-site/src/lib/docs.ts`.
- **Generated content** (assets/errors/community/wasm-examples): produced by the
  `generate-*` programs (ported to TS in `tools/generate-*`), requires network + external
  repos; not built locally so not in the comparison baseline.

## Result

Validated with `node tools/compare.mjs /tmp/zola-baseline astro-site/dist`
(reference = `zola build`):

- **1072 / 1083 output files structurally identical.**
- 0 files only-in-astro; 1 only-in-zola (`search_index.en.js`).
- The 11 differing + 1 missing files are ALL the documented cross-engine limitations:
  9 book pages (prev/next filesystem-order ties), `news/index.html`
  (resize_image thumbnail hashes), `site.css` (grass vs dart-sass), and the
  elasticlunr `search_index.en.js`. Every other page, the atom feed, sitemap,
  robots.txt, redirects, colocated assets, data files and static assets match.

Build: `cd astro-site && npm run build` (Astro build → `scripts/postbuild.mjs`:
minify, copy colocated/section assets, compile sass, emit redirects).
Compare:  `node tools/compare.mjs /tmp/zola-baseline astro-site/dist`.

All 6 Rust crates are ported to TypeScript under `tools/` (generate-assets,
generate-community, generate-errors, generate-release, write-rustdoc-hide-lines,
learning-code-examples), each validated against the Rust original where local
data allowed; network-bound fetch paths are documented per-crate README.

Note: content frontmatter was NOT rewritten — `astro-site/src/lib/content.ts`
parses the existing Zola TOML `+++` frontmatter directly, so the conversion is
non-destructive to `content/`.
