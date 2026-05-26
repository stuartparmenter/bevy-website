#!/usr/bin/env node --experimental-strip-types
// Port of generate-assets/src/bin/generate.rs to TypeScript.
//
// Reads the `bevy-assets` directory and generates Zola content under the
// website's content directory: an `assets` section tree of `_index.md`s and
// per-asset `.md` files with `+++` TOML frontmatter. Metadata (license, bevy
// version) is enriched from crates.io / GitHub / GitLab (see metadata.ts).
//
// Usage (positional args, matching the Rust binary):
//   node --experimental-strip-types generate.ts <asset_dir> <content_dir>
//
// Environment:
//   GITHUB_TOKEN  - required to enrich github.com-hosted assets (else skipped).
//   GITLAB_TOKEN  - optional; gitlab is queried unauthenticated either way.
//   CRATES_IO_DATA_DIR - directory containing the extracted crates.io db-dump
//                        CSVs (crates.csv, versions.csv, dependencies.csv).
//                        Defaults to `./data` (matching the Rust crate's cache).

import { mkdirSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";

import {
  parseAssets,
  assetSlug,
  type Section,
  type Asset,
  type AssetNode,
} from "./lib.ts";
import {
  prepareCratesDb,
  getLatestBevyVersion,
  cratesOnlySource,
  enrichAssets,
  collectAssets,
  GithubClient,
  GitlabClient,
  type CratesIoDb,
  type NetworkMetadataOptions,
} from "./metadata.ts";
import { parseVersion, versionMatchesReq, type SemverCore } from "./semver.ts";
import { serializeFrontmatter, type TomlFieldValue } from "./toml-serialize.ts";

// --- sorting (ports of sort_section / node_semver_compat_with) ---

function nodeSemverCompatWith(node: AssetNode, version: SemverCore): boolean {
  if (node.kind !== "Asset") return false;
  const ver = node.asset.bevyVersions?.[0];
  if (ver === undefined) return false;
  return versionMatchesReq(ver, version);
}

/**
 * Sorts the assets in a section so that:
 *   - assets with a manually-assigned order are first,
 *   - assets semver-compatible with the latest Bevy are next,
 *   - ties are broken randomly.
 * Then assigns each asset a sequential `order` = its index. Mirrors `sort_section`.
 */
function sortSection(nodes: AssetNode[], latest: SemverCore): void {
  for (const node of nodes) {
    if (node.kind === "Section") {
      sortSection(node.section.content, latest);
    }
  }

  const toSort: Array<{
    node: AssetNode;
    order: number;
    notCompat: number;
    random: number;
  }> = [];
  for (const node of nodes) {
    if (node.kind !== "Asset") continue;
    const isCompat = nodeSemverCompatWith(node, latest);
    const existingOrder = node.asset.order ?? Number.MAX_SAFE_INTEGER;
    toSort.push({
      node,
      order: existingOrder,
      notCompat: isCompat ? 0 : 1,
      // Rust uses a random u32 tiebreaker.
      random: Math.floor(Math.random() * 0x1_0000_0000),
    });
  }

  // sort_by_key((order, !is_semver_compat, random)) — a stable ascending sort by
  // the tuple. JS Array.sort is not guaranteed stable across the tuple, so we
  // compare the full tuple explicitly.
  toSort.sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order;
    if (a.notCompat !== b.notCompat) return a.notCompat - b.notCompat;
    return a.random - b.random;
  });

  toSort.forEach((entry, i) => {
    if (entry.node.kind === "Asset") {
      entry.node.asset.order = i;
    }
  });
}

// --- frontmatter writers (ports of the FrontMatterWriter impls) ---

// Rust sorts sub-sections by the string `"{order}-{name}"` using byte-wise Ord.
function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function nodeNameFor(node: AssetNode): string {
  return node.kind === "Section" ? node.section.name : node.asset.name;
}
function nodeOrderFor(node: AssetNode): number {
  if (node.kind === "Section") return node.section.order ?? 99999;
  return node.asset.order ?? 99999;
}

// Fisher-Yates shuffle (matches `slice.shuffle(&mut rng())`).
function shuffle<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function writeAsset(
  asset: Asset,
  rootPath: string,
  currentPath: string,
  weight: number,
): void {
  const path = join(rootPath, currentPath);

  // FrontMatterAsset: title, description, weight, [extra].
  // weight = asset.order ?? 0; overridden by the positional `weight` if order is None.
  let frontWeight = asset.order ?? 0;
  if (asset.order === null) {
    frontWeight = weight;
  }

  let imageLink: string | null = asset.image;
  if (asset.image !== null) {
    const file = asset.image;
    const imageFilePath = join(path, file);
    const imageFileLink = join(currentPath, file);
    const originalImage = join(dirname(asset.originalPath!), file);
    imageLink = imageFileLink;
    try {
      copyFileSync(originalImage, imageFilePath);
    } catch {
      // Rust uses `let _ = fs::copy(...)`, ignoring errors.
    }
  }

  const topLevel: Array<[string, TomlFieldValue]> = [
    ["title", asset.name],
    ["description", asset.description],
    ["weight", frontWeight],
  ];
  const extra: Array<[string, TomlFieldValue]> = [
    ["link", asset.link],
    ["image", imageLink],
    ["licenses", asset.licenses],
    ["bevy_versions", asset.bevyVersions],
    ["nsfw", asset.nsfw],
  ];

  const formattedName = `${assetSlug(asset.name)}.md`;
  const body = `+++\n${serializeFrontmatter(topLevel, extra)}\n+++\n`;
  writeFileSync(join(path, formattedName), body);
}

function writeSection(
  section: Section,
  rootPath: string,
  currentPath: string,
  weight: number,
): void {
  const sectionPath = join(currentPath, section.name.toLowerCase());
  const path = join(rootPath, sectionPath);
  // Rust uses `fs::create_dir` only when the path doesn't exist.
  if (!existsSync(path)) {
    mkdirSync(path);
  }

  // FrontMatterSection: title, sort_by, template, weight, [extra].
  const weightValue = section.order ?? weight;
  const topLevel: Array<[string, TomlFieldValue]> = [
    ["title", section.name],
    ["sort_by", "weight"],
    ["template", section.template], // omitted if null
    ["weight", weightValue],
  ];
  const extra: Array<[string, TomlFieldValue]> = [
    ["header_message", section.header], // omitted if null
    ["sort_order_reversed", section.sortOrderReversed],
  ];

  const body = `+++\n${serializeFrontmatter(topLevel, extra)}\n+++\n`;
  writeFileSync(join(path, "_index.md"), body);

  // Sub-sections sorted by "{order}-{name}" (byte-wise).
  const sortedSections: AssetNode[] = [];
  for (const content of section.content) {
    if (content.kind === "Section") sortedSections.push(content);
  }
  sortedSections.sort((a, b) =>
    byteCompare(`${nodeOrderFor(a)}-${nodeNameFor(a)}`, `${nodeOrderFor(b)}-${nodeNameFor(b)}`),
  );

  // Assets split into manually-sorted (order set) and randomized (order none).
  // After sort_section every asset has an order, so manually_sorted is the norm.
  const manuallySorted: AssetNode[] = [];
  const randomized: AssetNode[] = [];
  for (const content of section.content) {
    if (content.kind === "Asset") {
      if (content.asset.order !== null) manuallySorted.push(content);
      else randomized.push(content);
    }
  }
  manuallySorted.sort((a, b) => nodeOrderFor(a) - nodeOrderFor(b));
  shuffle(randomized);

  const all = [...sortedSections, ...manuallySorted, ...randomized];
  all.forEach((content, i) => {
    writeNode(content, rootPath, sectionPath, i);
  });
}

function writeNode(
  node: AssetNode,
  rootPath: string,
  currentPath: string,
  weight: number,
): void {
  if (node.kind === "Section") {
    writeSection(node.section, rootPath, currentPath, weight);
  } else {
    writeAsset(node.asset, rootPath, currentPath, weight);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const assetDir = args[0];
  if (assetDir === undefined) {
    throw new Error("Expected first argument to be the path to the bevy-assets directory.");
  }
  const contentDir = args[1];
  if (contentDir === undefined) {
    throw new Error("Expected second argument to be the path to the website content directory.");
  }

  // crates.io DB dump (optional: skipped if the data dir is absent).
  const dataDir = process.env.CRATES_IO_DATA_DIR ?? join(process.cwd(), "data");
  let cratesDb: CratesIoDb | null = null;
  if (existsSync(dataDir)) {
    console.log(`Using crates.io data dump from: ${dataDir}`);
    cratesDb = prepareCratesDb(dataDir);
  } else {
    console.log(
      `crates.io data dump not found at ${dataDir}; crates.io enrichment will be skipped.`,
    );
  }

  const githubToken = process.env.GITHUB_TOKEN;
  let githubClient: GithubClient | null = null;
  if (githubToken) {
    githubClient = new GithubClient(githubToken);
  } else {
    console.log("GITHUB_TOKEN not found, github links will be skipped");
  }

  // The Rust crate always builds a GitlabClient (with an empty token if absent).
  const gitlabClient = new GitlabClient(process.env.GITLAB_TOKEN ?? "");
  if (!process.env.GITLAB_TOKEN) {
    console.log("GITLAB_TOKEN not found, gitlab links will be skipped");
  }

  const options: NetworkMetadataOptions = {
    cratesDb,
    githubClient,
    gitlabClient,
  };

  // Rust: `let _ = fs::create_dir(content_dir)` (ignore "already exists").
  mkdirSync(contentDir, { recursive: true });

  // 1. Parse + synchronously enrich crates.io-hosted assets.
  const assetRootSection = parseAssets(assetDir, cratesOnlySource(options));

  // 2. Asynchronously enrich github.com / gitlab.com hosted assets.
  //    (The Rust crate does this inline during the walk; Node's `fetch` is async
  //    so we do it as a post-pass before sorting, preserving the same effect.)
  const allAssets = collectAssets({ kind: "Section", section: assetRootSection });
  await enrichAssets(allAssets, options);

  // 3. Determine the latest Bevy version for semver-compat sorting.
  //    Without the crates.io DB we cannot know it; fall back to no version
  //    (every asset then sorts as "not semver compatible", a no-op tiebreaker).
  let latest: SemverCore | null = null;
  if (cratesDb !== null) {
    const latestStr = getLatestBevyVersion(cratesDb);
    latest = parseVersion(latestStr);
  }

  // 4. Sort.
  if (latest !== null) {
    sortSection(assetRootSection.content, latest);
  } else {
    // Mirror sort_section's order-assignment even when we have no version: it
    // still assigns sequential orders. Use an unsatisfiable version so nothing
    // is "compatible" (matching node_semver_compat_with returning false).
    sortSection(assetRootSection.content, { major: -1, minor: -1, patch: -1 });
  }

  // 5. Write the tree.
  writeSection(assetRootSection, contentDir, "", 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
