#!/usr/bin/env node --experimental-strip-types
// Port of generate-community/src/bin/validate.rs to TypeScript.
//
// Validates the `bevy-community` directory:
//   - File profile pictures must reference an existing file.
//   - GitHub profile pictures require a `github` field.
//   - Bios must be at most MAX_BIO_LENGTH graphemes.
//   - Members must not set `roles` directly (roles come from _roles.toml).
//
// Usage:
//   node --experimental-strip-types validate.ts <community_dir>

import { existsSync } from "node:fs";
import { join, dirname } from "node:path";

import { parseMembers, type Section, type CommunityNode } from "./lib.ts";

const MAX_BIO_LENGTH = 180;

// Grapheme count using Intl.Segmenter, matching unicode-segmentation's
// `graphemes(true)` (extended grapheme clusters).
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
function graphemeCount(s: string): number {
  let count = 0;
  for (const _ of segmenter.segment(s)) count++;
  return count;
}

function validateNode(node: CommunityNode): void {
  if (node.kind === "Section") {
    validateSection(node.section);
    return;
  }

  const member = node.member;
  const pp = member.profilePicture;
  if (pp !== null) {
    if (pp.kind === "File") {
      const imagePath = join(dirname(member.originalPath!), pp.file);
      if (!existsSync(imagePath)) {
        throw new Error(
          `${JSON.stringify(member.originalPath)}: Profile Picture set to a file, but file not found`,
        );
      }
    } else if (pp.kind === "GitHub") {
      if (member.github == null) {
        throw new Error(
          `${JSON.stringify(member.originalPath)}: Profile Picture set to GitHub, but no GitHub profile found`,
        );
      }
    }
  }

  if (member.bio != null) {
    const count = graphemeCount(member.bio);
    if (count > MAX_BIO_LENGTH) {
      throw new Error(
        `Bio is longer than the maximum allowed length of ${MAX_BIO_LENGTH}. It is currently ${count} characters long.`,
      );
    }
  }

  if (member.roles != null) {
    throw new Error("Roles must be defined in the roles.toml file");
  }
}

function validateSection(section: Section): void {
  for (const node of section.content) {
    validateNode(node);
  }
}

function main(): void {
  const communityDir = process.argv[2];
  if (communityDir === undefined) {
    throw new Error("Expected first argument to be the path to the community directory.");
  }

  const peopleRootSection = parseMembers(communityDir);
  validateSection(peopleRootSection);
}

main();
