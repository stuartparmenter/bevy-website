#!/usr/bin/env node --experimental-strip-types
// Port of generate-assets/src/bin/validate.rs to TypeScript.
//
// Validates the `bevy-assets` directory (used in bevy-assets CI):
//   - Description must be <= MAX_DESCRIPTION_LENGTH bytes.
//   - Description must not contain forbidden formatting (newlines, leading '#',
//     or a markdown link).
//   - If an image is set, it must have an allowed extension, exist, and be at
//     most MAX_IMAGE_BYTES bytes.
//
// No metadata enrichment is performed (matches `MetadataSource::default()`).
//
// Usage:
//   node --experimental-strip-types validate.ts <asset_dir>

import { statSync } from "node:fs";
import { join, dirname, extname } from "node:path";

import {
  parseAssets,
  NULL_METADATA_SOURCE,
  type Section,
  type Asset,
  type AssetNode,
} from "./lib.ts";

const MAX_DESCRIPTION_LENGTH = 100;
const MAX_IMAGE_BYTES = 2_097_152; // keep in sync with docs in bevy-assets
const ALLOWED_IMAGE_EXTENSIONS = ["gif", "jpg", "jpeg", "png", "webp"];

type ValidationError =
  | { kind: "DescriptionTooLong" }
  | { kind: "DescriptionWithFormatting" }
  | { kind: "ImageInvalidLink" }
  | { kind: "ImageInvalidExtension" }
  | { kind: "ImageFileSizeTooLarge"; size: number };

function describeError(e: ValidationError): string {
  switch (e.kind) {
    case "DescriptionTooLong":
      return `Description must be at most ${MAX_DESCRIPTION_LENGTH} chars in length.`;
    case "DescriptionWithFormatting":
      return "Description must not contain formatting.";
    case "ImageInvalidLink":
      return "Image file not found.";
    case "ImageInvalidExtension":
      return `Image extension not allowed. Must be one of: ${ALLOWED_IMAGE_EXTENSIONS.join(", ")}`;
    case "ImageFileSizeTooLarge":
      return `Image file size ${e.size} exceeds maximum ${MAX_IMAGE_BYTES} bytes.`;
  }
}

interface AssetError {
  assetName: string;
  errors: ValidationError[];
}

function formatAssetError(e: AssetError): string {
  let out = `${e.assetName}\n`;
  for (const err of e.errors) {
    out += `  ${describeError(err)}\n`;
  }
  return out;
}

// Rust: `string.len()` is the byte length.
function byteLength(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

function hasForbiddenFormatting(s: string): boolean {
  if (s.includes("\n")) return true;
  if (s.startsWith("#")) return true;
  // Rust regex: \[(.+)\]\(((?:/|https?://)[\w\d./?=#]+)\)
  const re = /\[(.+)\]\(((?:\/|https?:\/\/)[\w\d./?=#]+)\)/;
  return re.test(s);
}

function validateImage(path: string): ValidationError | null {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return { kind: "ImageInvalidLink" };
  }
  if (size > MAX_IMAGE_BYTES) {
    return { kind: "ImageFileSizeTooLarge", size };
  }
  return null;
}

function validateAsset(asset: Asset): AssetError | null {
  const errors: ValidationError[] = [];

  if (byteLength(asset.description) > MAX_DESCRIPTION_LENGTH) {
    errors.push({ kind: "DescriptionTooLong" });
  }
  if (hasForbiddenFormatting(asset.description)) {
    errors.push({ kind: "DescriptionWithFormatting" });
  }

  if (asset.image !== null) {
    const imagePath = join(dirname(asset.originalPath!), asset.image);
    // Rust uses Path::extension; an extension-less file or a disallowed one is
    // an error.
    const ext = extname(imagePath).replace(/^\./, "");
    if (ext === "" || !ALLOWED_IMAGE_EXTENSIONS.includes(ext)) {
      errors.push({ kind: "ImageInvalidExtension" });
    }
    const imgErr = validateImage(imagePath);
    if (imgErr !== null) errors.push(imgErr);
  }

  if (errors.length === 0) return null;
  return { assetName: asset.name, errors };
}

function validateNode(node: AssetNode): AssetError[] {
  if (node.kind === "Section") return validateSection(node.section);
  const err = validateAsset(node.asset);
  return err === null ? [] : [err];
}

function validateSection(section: Section): AssetError[] {
  const out: AssetError[] = [];
  for (const node of section.content) {
    out.push(...validateNode(node));
  }
  return out;
}

function main(): void {
  const assetDir = process.argv[2];
  if (assetDir === undefined) {
    throw new Error("Please specify the path to bevy-assets");
  }

  const assetRootSection = parseAssets(assetDir, NULL_METADATA_SOURCE);
  const errors = validateSection(assetRootSection);

  if (errors.length === 0) {
    return;
  }

  console.error();
  for (const error of errors) {
    console.error(formatAssetError(error));
  }
  console.error(`${errors.length} asset(s) are invalid.`);
  process.exit(1);
}

main();
