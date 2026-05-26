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

## Layout

- `astro-site/`  Astro project (new)
- `tools/`       comparison + helper scripts
- Zola files remain in place for reference/validation during migration.

## Progress

(see task list)
