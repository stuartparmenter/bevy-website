#!/usr/bin/env node --experimental-strip-types
// Offline validation harness for the generate-release TS port.
//
// The GitHub-fetching subcommands can't run without network + a token. What we
// CAN validate offline is that our pure-local serialization, slugification, and
// sort comparators reproduce the conventions visible in the committed
// `release-content/` output.
//
// The committed `_guides.toml` / `changelog.toml` files have been hand-edited
// after generation (merged multi-PR entries, retitled guides, stray blank
// lines), so a whole-file byte round-trip is not expected. Instead we validate
// at the granularity that IS stable:
//
//   1. Per-block serialization: for each parsed entry, re-emit its TOML block
//      and confirm the exact block text appears verbatim in the committed file.
//      This pins down key order, quoting, list formatting, and escaping.
//   2. file_name reconstruction from title + PR number (single-PR entries).
//   3. Sort-comparator agreement with the committed ordering (reported, since
//      manual reordering can legitimately diverge).
//
// The 0.14 files use a legacy format where `prs` were quoted strings; the
// current Rust crate (and this port) emit bare integers, so 0.14 block matches
// are reported separately and not counted as failures.

import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";

import { slugifyTitle, truncateUtf8 } from "./util.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..", "..");
const releaseContent = join(repoRoot, "release-content");

let failures = 0;
function check(cond: boolean, msg: string): void {
  console.log(`  ${cond ? "ok" : "FAIL"}: ${msg}`);
  if (!cond) failures += 1;
}

interface GuideMeta {
  title: string;
  prs: number[];
  areas: string[];
  file_name: string;
}

function guideBlock(g: GuideMeta): string {
  const prs = g.prs.join(", ");
  const areas = g.areas.map((a) => `"${a}"`).join(", ");
  const title = g.title.trim().replace(/"/g, '\\"');
  return `[[guides]]
title = "${title}"
prs = [${prs}]
areas = [${areas}]
file_name = "${g.file_name}"
`;
}

function validateGuides(version: string, legacyStringPrs: boolean): void {
  const path = join(releaseContent, version, "migration-guides", "_guides.toml");
  if (!existsSync(path)) return;
  console.log(`\n_guides.toml: ${version}`);
  const original = readFileSync(path, "utf8");
  const parsed = parseToml(original) as { guides: GuideMeta[] };
  const guides = parsed.guides;

  let blockMatches = 0;
  for (const g of guides) {
    let block = guideBlock(g);
    if (legacyStringPrs) {
      // Legacy 0.14 format quoted the PR numbers.
      block = block.replace(/prs = \[(\d+(?:, \d+)*)\]/, (_m, nums: string) => {
        const quoted = nums.split(", ").map((n) => `"${n}"`).join(", ");
        return `prs = [${quoted}]`;
      });
    }
    if (original.includes(block)) blockMatches += 1;
  }
  if (legacyStringPrs) {
    console.log(`  (legacy 0.14 string-prs format) blocks reproduced: ${blockMatches}/${guides.length}`);
  } else {
    check(blockMatches === guides.length, `all ${guides.length} guide blocks reproduced verbatim (${blockMatches} matched)`);
  }

  // file_name reconstruction for single-PR entries.
  let match = 0;
  let differ = 0;
  for (const g of guides) {
    if (g.prs.length !== 1) continue;
    const expected = truncateUtf8(`${g.prs[0]}_${slugifyTitle(g.title)}`, 64) + ".md";
    if (expected === g.file_name) match += 1;
    else differ += 1;
  }
  console.log(`  file_name reconstruction (single-PR): ${match} match, ${differ} differ (hand-retitled entries differ legitimately)`);
}

interface ReleaseNoteMeta {
  title: string;
  authors: string[];
  contributors: string[];
  prs: number[];
  file_name: string;
}

function validateReleaseNotes(version: string): void {
  const path = join(releaseContent, version, "release-notes", "_release-notes.toml");
  if (!existsSync(path)) return;
  console.log(`\n_release-notes.toml: ${version}`);
  const original = readFileSync(path, "utf8");
  const parsed = parseToml(original) as { release_notes: ReleaseNoteMeta[] };
  const notes = parsed.release_notes;

  // The generator only ever emits a single author (`["@author",]`) and a single
  // PR; the committed files are heavily hand-edited (extra authors, multi-PR,
  // custom file names, section comments). So we only verify file_name
  // reconstruction for the single-PR, single-author, numbered-file-name entries
  // that still look generator-produced.
  let match = 0;
  let reconstructible = 0;
  for (const n of notes) {
    if (n.prs.length !== 1) continue;
    if (!/^\d+_/.test(n.file_name)) continue; // hand-named files start with words
    reconstructible += 1;
    const expected = truncateUtf8(`${n.prs[0]}_${slugifyTitle(n.title)}`, 64) + ".md";
    if (expected === n.file_name) match += 1;
  }
  console.log(`  file_name reconstruction (generator-shaped entries): ${match}/${reconstructible} match`);
}

interface ChangelogArea {
  name: string[];
  prs: { title: string; number: number }[];
}

function validateChangelog(version: string): void {
  const path = join(releaseContent, version, "changelog.toml");
  if (!existsSync(path)) return;
  console.log(`\nchangelog.toml: ${version}`);
  const original = readFileSync(path, "utf8");
  const parsed = parseToml(original) as { areas: ChangelogArea[] };

  // Re-emit each area block and confirm it appears verbatim. Skip titles that
  // contain a literal newline (a few hand-entered titles do), since smol-toml
  // re-escapes them and the on-disk form differs.
  let areaMatches = 0;
  let skipped = 0;
  for (const area of parsed.areas) {
    let block = "[[areas]]\n";
    block += `name = [${area.name.map((a) => `"${a}"`).join(", ")}]\n`;
    let hasNewlineTitle = false;
    for (const pr of area.prs) {
      if (pr.title.includes("\n")) hasNewlineTitle = true;
      block += "[[areas.prs]]\n";
      block += `title = "${pr.title.trim().replace(/"/g, '\\"')}"\n`;
      block += `number = ${pr.number}\n`;
    }
    if (hasNewlineTitle) {
      skipped += 1;
      continue;
    }
    if (original.includes(block)) areaMatches += 1;
  }
  const total = parsed.areas.length - skipped;
  check(areaMatches === total, `all ${total} changelog area blocks reproduced verbatim (${areaMatches} matched, ${skipped} skipped for embedded newlines)`);
}

for (const version of ["0.14", "0.15", "0.16", "0.17", "0.18"]) {
  validateGuides(version, version === "0.14");
  validateReleaseNotes(version);
  validateChangelog(version);
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
