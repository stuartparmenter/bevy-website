// Image metadata + (later) resizing, mirroring Zola's get_image_metadata / resize_image.
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { imageSize } from "image-size";
import { REPO_ROOT, CONTENT_DIR } from "./content.ts";

function resolveImage(path: string): string | null {
  const candidates = [
    join(CONTENT_DIR, path),
    join(REPO_ROOT, path),
    join(REPO_ROOT, "static", path),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

export function getImageMetadata(path: string): { width: number; height: number; format: string } {
  const file = resolveImage(path);
  if (!file) throw new Error(`get_image_metadata: image not found: ${path}`);
  const dim = imageSize(readFileSync(file));
  return { width: dim.width || 0, height: dim.height || 0, format: dim.type || "" };
}
