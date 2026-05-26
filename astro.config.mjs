import { defineConfig } from "astro/config";

// Mirror Zola: directory URLs (path/index.html), trailing slashes, unminified output
// (the structural comparator normalizes whitespace, so leaving HTML readable aids debugging).
export default defineConfig({
  site: "https://bevy.org",
  // static/ is copied verbatim to the output root (kept from the original site).
  publicDir: "static",
  trailingSlash: "ignore",
  build: {
    format: "directory",
    assets: "_astro",
  },
  compressHTML: false,
  // Markdown handled by a custom pipeline in src/lib (to match pulldown-cmark + Zola
  // shortcodes); Astro's built-in markdown rendering is not used for content pages.
  devToolbar: { enabled: false },
});
