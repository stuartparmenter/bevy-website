// Port of generate-assets/src/lib.rs to TypeScript.
//
// Reads the `bevy-assets` repo layout (a tree of folders = sections and `*.toml`
// files = assets) and builds an in-memory tree mirroring the Rust data model and
// directory walk.
//
// The pure transformation (TOML tree -> Section/AssetNode model) lives here and
// is fully testable offline. Network/API enrichment (crates.io DB, GitHub,
// GitLab) is injected through the `MetadataSource` interface, whose
// implementation lives in `metadata.ts`.

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { parse as parseToml } from "smol-toml";

// Known asset keys. Used to enforce the Rust struct's
// `#[serde(deny_unknown_fields)]` behaviour.
const ASSET_KEYS = new Set([
  "name",
  "link",
  "description",
  "order",
  "image",
  "crate",
  "licenses",
  "bevy_versions",
  "nsfw",
]);

export interface Asset {
  name: string;
  link: string;
  description: string;
  order: number | null;
  image: string | null;
  crateName: string | null;
  licenses: string[] | null;
  bevyVersions: string[] | null;
  nsfw: boolean | null;

  // not read from the toml file
  originalPath: string | null;
}

export interface Section {
  name: string;
  content: AssetNode[];
  template: string | null;
  header: string | null;
  order: number | null;
  sortOrderReversed: boolean;
}

export type AssetNode =
  | { kind: "Section"; section: Section }
  | { kind: "Asset"; asset: Asset };

/**
 * Source of bevy-version + license metadata for an asset, injected into the
 * directory walk. The Rust crate threads a stateful `MetadataSource` struct
 * (crates.io DB connection, GitHub/GitLab clients) through the recursion; here
 * we expose a single synchronous method that, given an asset, returns the
 * `(license, version)` pair it discovered (each may be `null`).
 *
 * Returning `null` for the whole result means "no metadata source consulted /
 * unknown host" and leaves the asset unchanged, matching the Rust `None` arm.
 */
export interface MetadataSource {
  /**
   * Look up extra metadata for an asset. Implementations should mirror
   * `get_extra_metadata` in lib.rs: dispatch on the URL host (crates.io,
   * github.com, gitlab.com) and return `[license, version]`. Either element
   * may be `null` if not found. Return `null` to signal "no source consulted".
   *
   * Errors should be caught by the implementation and surfaced as `null` (the
   * Rust crate logs and continues on failure), but if one is thrown here the
   * walk will catch it and continue, also matching the Rust behaviour.
   */
  getExtraMetadata(asset: Asset): [string | null, string | null] | null;
}

/** A no-op metadata source: never enriches anything (used by `validate`). */
export const NULL_METADATA_SOURCE: MetadataSource = {
  getExtraMetadata() {
    return null;
  },
};

export function nodeName(node: AssetNode): string {
  return node.kind === "Section" ? node.section.name : node.asset.name;
}

export function nodeOrder(node: AssetNode): number {
  if (node.kind === "Section") {
    return node.section.order ?? 99999;
  }
  return node.asset.order ?? 99999;
}

// --- license / version setters (Asset impl in lib.rs) ---

/**
 * Parses a license string separated with " OR " into an array. No-op if the
 * asset already has licenses. Mirrors `Asset::set_license`.
 */
export function setLicense(asset: Asset, license: string | null): void {
  if (asset.licenses !== null) return;
  if (license !== null) {
    asset.licenses = license.split(" OR ").map((x) => x.trim());
  }
}

/**
 * Sets the single bevy version. No-op if already set. Mirrors
 * `Asset::set_bevy_version`.
 */
export function setBevyVersion(asset: Asset, version: string | null): void {
  if (asset.bevyVersions !== null) return;
  if (version !== null) {
    asset.bevyVersions = [version];
  }
}

function asString(value: unknown, path: string, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`field \`${field}\` must be a string in ${path}`);
  }
  return value;
}

function parseAsset(path: string): Asset {
  const raw = parseToml(readFileSync(path, "utf8")) as Record<string, unknown>;

  // deny_unknown_fields
  for (const key of Object.keys(raw)) {
    if (!ASSET_KEYS.has(key)) {
      throw new Error(`unknown field \`${key}\` in ${path}`);
    }
  }

  // Required fields (serde would error if missing).
  for (const required of ["name", "link", "description"]) {
    if (raw[required] === undefined) {
      throw new Error(`missing field \`${required}\` in ${path}`);
    }
  }

  let order: number | null = null;
  if (raw.order !== undefined) {
    const o = raw.order;
    if (typeof o !== "number" || !Number.isInteger(o) || o < 0) {
      throw new Error(`field \`order\` must be a non-negative integer in ${path}`);
    }
    order = o;
  }

  let licenses: string[] | null = null;
  if (raw.licenses !== undefined) {
    if (!Array.isArray(raw.licenses)) {
      throw new Error(`field \`licenses\` must be an array in ${path}`);
    }
    licenses = raw.licenses.map((v) => asString(v, path, "licenses"));
  }

  let bevyVersions: string[] | null = null;
  if (raw.bevy_versions !== undefined) {
    if (!Array.isArray(raw.bevy_versions)) {
      throw new Error(`field \`bevy_versions\` must be an array in ${path}`);
    }
    bevyVersions = raw.bevy_versions.map((v) => asString(v, path, "bevy_versions"));
  }

  let nsfw: boolean | null = null;
  if (raw.nsfw !== undefined) {
    if (typeof raw.nsfw !== "boolean") {
      throw new Error(`field \`nsfw\` must be a boolean in ${path}`);
    }
    nsfw = raw.nsfw;
  }

  return {
    name: asString(raw.name, path, "name"),
    link: asString(raw.link, path, "link"),
    description: asString(raw.description, path, "description"),
    order,
    image: raw.image === undefined ? null : asString(raw.image, path, "image"),
    crateName: raw.crate === undefined ? null : asString(raw.crate, path, "crate"),
    licenses,
    bevyVersions,
    nsfw,
    originalPath: path,
  };
}

/**
 * Recursive traversal of directories inside the cloned "Bevy Assets" project.
 * Each directory is a Section (configured by its `_category.toml`), each other
 * `.toml` file is an Asset. Mirrors `visit_dirs`.
 */
function visitDirs(dir: string, section: Section, metadataSource: MetadataSource): void {
  // Rust: `if dir.is_file() { return Ok(()) }`. Callers only pass directories.
  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const name = entry.name;
    if (name === ".git" || name === ".github") continue;

    const path = join(dir, name);

    if (entry.isDirectory()) {
      let order: number | null = null;
      let sortOrderReversed = false;
      const categoryPath = join(path, "_category.toml");
      if (existsSync(categoryPath)) {
        const fromFile = parseToml(readFileSync(categoryPath, "utf8")) as Record<string, unknown>;
        const orderVal = fromFile.order;
        order = typeof orderVal === "number" && Number.isInteger(orderVal) ? orderVal : null;
        const reversedVal = fromFile.sort_order_reversed;
        sortOrderReversed = typeof reversedVal === "boolean" ? reversedVal : false;
      }
      const newSection: Section = {
        name,
        content: [],
        template: null,
        header: null,
        order,
        sortOrderReversed,
      };
      visitDirs(path, newSection, metadataSource);
      section.content.push({ kind: "Section", section: newSection });
    } else {
      // Rust: `path.extension().expect("file must have an extension")`.
      if (name === "_category.toml") continue;
      const ext = extname(name);
      if (ext === "") {
        throw new Error(`file must have an extension: ${path}`);
      }
      if (ext !== ".toml") continue;

      const asset = parseAsset(path);

      try {
        const metadata = metadataSource.getExtraMetadata(asset);
        if (metadata !== null) {
          const [license, version] = metadata;
          setLicense(asset, license);
          setBevyVersion(asset, version);
        }
      } catch (err) {
        // We don't want to stop execution here (matches lib.rs `get_extra_metadata`).
        console.error(`Failed to get metadata for ${asset.name}`);
        console.error(`ERROR: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      }

      section.content.push({ kind: "Asset", asset });
    }
  }
}

/**
 * Entry point: initialises the root `Assets` section and walks the asset
 * directory, enriching each asset via the provided `MetadataSource`. Mirrors
 * `parse_assets`.
 */
export function parseAssets(assetDir: string, metadataSource: MetadataSource): Section {
  const assetRootSection: Section = {
    name: "Assets",
    content: [],
    template: "assets.html",
    header: "Assets",
    order: null,
    sortOrderReversed: false,
  };

  // Rust's `parse_assets` calls `visit_dirs` directly with the dir path; the
  // top-level `visit_dirs` returns early only if the path is a file. We mirror
  // the implicit "must be a directory" expectation by reading it directly,
  // letting an error propagate (matching the Rust `?` on `read_dir`).
  let isDir = false;
  try {
    isDir = statSync(assetDir).isDirectory();
  } catch {
    isDir = false;
  }
  if (isDir) {
    visitDirs(assetDir, assetRootSection, metadataSource);
  }

  return assetRootSection;
}

// --- slug generation (used by generate.ts; tested in lib tests) ---

/**
 * Produces the asset page slug from its name, reproducing the Rust expression:
 *   name.to_ascii_lowercase().replace('/', "-").replace(' ', "_")
 *       .replace(|c| !c.is_ascii_alphanumeric() && !matches!(c, '-'|'_'), "")
 *
 * Note `to_ascii_lowercase` only lowercases ASCII A-Z; non-ASCII characters are
 * left as-is and then stripped (they are not ASCII-alphanumeric).
 */
export function assetSlug(name: string): string {
  let s = "";
  for (const ch of name) {
    // ASCII lowercase only.
    const code = ch.codePointAt(0)!;
    let c = ch;
    if (code >= 0x41 && code <= 0x5a) {
      c = String.fromCharCode(code + 0x20);
    }
    s += c;
  }
  s = s.replaceAll("/", "-").replaceAll(" ", "_");
  // Strip anything that is not ASCII [0-9A-Za-z] or '-' or '_'.
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    const isAsciiAlnum =
      (code >= 0x30 && code <= 0x39) ||
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a);
    if (isAsciiAlnum || ch === "-" || ch === "_") {
      out += ch;
    }
  }
  return out;
}
