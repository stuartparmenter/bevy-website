// Port of generate-release/src/migration_guides.rs to TypeScript.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";

import { GithubClient } from "./github-client.ts";
import type { GithubIssuesResponse } from "./github-client.ts";
import { getMergedPrs, getPrArea } from "./helpers.ts";
import { writeMarkdownSection } from "./markdown.ts";
import { compareStringArrays, slugifyTitle, truncateUtf8 } from "./util.ts";

interface MigrationGuideMeta {
  title: string;
  prs: number[];
  /** Sorted, deduplicated set of areas (BTreeSet in Rust). */
  areas: string[];
  file_name: string;
}

export async function generateMigrationGuides(
  from: string,
  to: string,
  path: string,
  client: GithubClient,
  overwriteExisting: boolean,
): Promise<void> {
  // Get all PRs by area.
  const areas = await getPrsByAreas(client, from, to);

  // Create the directory that will contain all the migration guides.
  mkdirSync(path, { recursive: true });

  let guidesMetadata: MigrationGuideMeta[];
  if (overwriteExisting) {
    guidesMetadata = [];
  } else {
    // If there is metadata that already exists (e.g. which PR already has an
    // entry), get it and use it.
    const guidesTomlPath = join(path, "_guides.toml");
    let preexisting: MigrationGuideMeta[] | null = null;
    if (existsSync(guidesTomlPath)) {
      const parsed = parseToml(readFileSync(guidesTomlPath, "utf8")) as {
        guides?: MigrationGuideMeta[];
      };
      preexisting = parsed.guides ?? [];
    }
    console.error(`metadata exists? ${preexisting !== null}`);
    guidesMetadata = preexisting ?? [];
  }

  // Write all the separate migration guide files.
  // `areas` is iterated in BTreeMap order (sorted by the area-array key).
  for (const { prs } of areas) {
    for (const { title, pr } of prs) {
      // If a PR is already included in the migration guides, skip it.
      let prAlreadyGenerated = false;
      for (const migrationGuide of guidesMetadata) {
        if (migrationGuide.prs.includes(pr.number)) {
          prAlreadyGenerated = true;
        }
      }
      if (prAlreadyGenerated) {
        console.error(`PR #${pr.number} already exists`);
        continue;
      }

      const titleSlug = slugifyTitle(title);

      // PR number first so sorting by name stays consistent (PR numbers are monotonic).
      let fileName = `${pr.number}_${titleSlug}`;
      // Shorten the filename (some OSes still have path-length limits); 64 is arbitrary.
      fileName = truncateUtf8(fileName, 64);
      fileName = `${fileName}.md`;

      const filePath = join(path, fileName);

      if (pr.body === null) {
        throw new Error("PR has no body");
      }

      if (writeMigrationFile(filePath, pr.body, pr.number)) {
        guidesMetadata.push({
          title,
          prs: [pr.number],
          // area is already sorted (BTreeMap key) and converted to a BTreeSet.
          areas: dedupeSorted(getPrArea(pr)),
          file_name: fileName,
        });
      }
    }
  }

  // Sort by: Area ascending (empty areas at the end), then Title ascending.
  guidesMetadata.sort((a, b) => {
    const aEmpty = a.areas.length === 0;
    const bEmpty = b.areas.length === 0;
    let areasCmp: number;
    if (!aEmpty && !bEmpty) {
      const aAreas = a.areas.join(" ");
      const bAreas = b.areas.join(" ");
      areasCmp = aAreas < bAreas ? -1 : aAreas > bAreas ? 1 : 0;
    } else if (!aEmpty && bEmpty) {
      areasCmp = -1;
    } else if (aEmpty && !bEmpty) {
      areasCmp = 1;
    } else {
      areasCmp = 0;
    }
    if (areasCmp !== 0) return areasCmp;
    return a.title < b.title ? -1 : a.title > b.title ? 1 : 0;
  });

  // Create the metadata file (overwriting if present). Even when overwritten, it
  // retains the preexisting metadata gathered above when overwrite_existing is false.
  let out = "";
  for (const metadata of guidesMetadata) {
    out += generateMetadataBlock(metadata.title, metadata.file_name, metadata.areas, metadata.prs);
    out += "\n"; // writeln! adds a trailing newline after each block
  }
  writeFileSync(join(path, "_guides.toml"), out);
}

interface PrEntry {
  title: string;
  pr: GithubIssuesResponse;
}

interface AreaGroup {
  area: string[];
  prs: PrEntry[];
}

/**
 * Gets all PRs that have either a migration guide section or the
 * `M-Needs-Migration-Guide` label, grouped by their area-label list and
 * returned in BTreeMap (sorted-key) order.
 */
async function getPrsByAreas(
  client: GithubClient,
  from: string,
  to: string,
): Promise<AreaGroup[]> {
  // Map keyed by the JSON of the area array; insertion order preserves commit order.
  const areas = new Map<string, AreaGroup>();

  const mergedPrs = await getMergedPrs(client, from, to, null);
  let count = 0;
  for (const { pr, title } of mergedPrs) {
    if (pr.body === null) {
      // No body => no migration guide, safely skip.
      continue;
    }
    const hasMigrationGuideSection = pr.body.toLowerCase().includes("## migration guide");
    const hasBreakingLabel = pr.labels.some((l) => l.name.includes("M-Needs-Migration-Guide"));

    // Check for PRs with the breaking label but without the guide section to make
    // it easier to track down missing guides.
    if (hasMigrationGuideSection || hasBreakingLabel) {
      const area = getPrArea(pr);
      const key = JSON.stringify(area);
      let group = areas.get(key);
      if (group === undefined) {
        group = { area, prs: [] };
        areas.set(key, group);
      }
      group.prs.push({ title, pr });
      count += 1;
    }
  }
  console.log(`\nFound ${count} breaking PRs merged`);

  // Sort groups by BTreeMap key order (lexicographic over the area arrays).
  return [...areas.values()].sort((a, b) => compareStringArrays(a.area, b.area));
}

/** Generates the TOML block for a migration guide entry. */
function generateMetadataBlock(
  title: string,
  fileName: string,
  areas: string[],
  prNumbers: number[],
): string {
  const prs = prNumbers.join(", ");
  const areasStr = areas.map((a) => `"${a}"`).join(", ");
  const titleEscaped = title.trim().replace(/"/g, '\\"');
  return `[[guides]]
title = "${titleEscaped}"
prs = [${prs}]
areas = [${areasStr}]
file_name = "${fileName}"
`;
}

/**
 * Write a file containing the body of the migration guide, applying clean-ups.
 * Returns false (and writes nothing) if the resulting section is empty.
 */
function writeMigrationFile(filePath: string, prBody: string, prNumber: number): boolean {
  let [section] = writeMarkdownSection(prBody, "migration guide", true);

  // Some guides have a rule at the end; remove it.
  if (section.endsWith("\n---\n")) {
    section = section.replace("\n---\n", "");
  }

  // Strip leading and trailing whitespace and add a trailing newline.
  section = section.trim() + "\n";

  if (section.trim() === "") {
    // Section is just whitespace, so we can skip it (may be a false positive; log the URL).
    console.log(
      `\x1b[93mMigration guide is empty for https://github.com/bevyengine/bevy/pull/${prNumber}\x1b[0m`,
    );
    return false;
  }

  writeFileSync(filePath, section);
  return true;
}

/** Return a sorted, deduplicated copy (mirrors collecting into a BTreeSet). */
function dedupeSorted(items: string[]): string[] {
  return [...new Set(items)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
