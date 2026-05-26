// Port of generate-release/src/changelog.rs to TypeScript.

import { writeFileSync } from "node:fs";
import { parse as parseToml } from "smol-toml";

import { GithubClient } from "./github-client.ts";
import type { GithubIssuesResponse } from "./github-client.ts";
import { getMergedPrs, getPrArea } from "./helpers.ts";
import { compareStringArrays } from "./util.ts";

interface PrEntry {
  title: string;
  pr: GithubIssuesResponse;
}

interface AreaGroup {
  area: string[];
  prs: PrEntry[];
}

export async function generateChangelog(
  from: string,
  to: string,
  path: string,
  client: GithubClient,
): Promise<void> {
  let output = "";

  // BTreeMap keyed by the area-array; insertion order is commit order.
  const areas = new Map<string, AreaGroup>();

  const mergedPrs = await getMergedPrs(client, from, to, null);
  for (const { pr, title } of mergedPrs) {
    const area = getPrArea(pr);
    const key = JSON.stringify(area);
    let group = areas.get(key);
    if (group === undefined) {
      group = { area, prs: [] };
      areas.set(key, group);
    }
    group.prs.push({ title, pr });
  }

  let count = 0;
  // BTreeMap iteration order = sorted by area-array key.
  const areasVec = [...areas.values()].sort((a, b) => compareStringArrays(a.area, b.area));

  // Move empty areas to the end.
  areasVec.sort((a, b) => {
    const aEmpty = a.area.length === 0;
    const bEmpty = b.area.length === 0;
    if (!aEmpty && !bEmpty) {
      const aj = a.area.join(" ");
      const bj = b.area.join(" ");
      return aj < bj ? -1 : aj > bj ? 1 : 0;
    }
    if (!aEmpty && bEmpty) return -1;
    if (aEmpty && !bEmpty) return 1;
    return 0;
  });

  for (const { area, prs } of areasVec) {
    output += "[[areas]]\n";
    output += `name = [${area.map((a) => `"${a}"`).join(", ")}]\n`;

    // Sort PRs by closed_at (stable). In Rust `None` sorts before `Some`.
    const sortedPrs = stableSortByClosedAt(prs);

    for (const { title, pr } of sortedPrs) {
      output += "[[areas.prs]]\n";
      output += `title = "${title.trim().replace(/"/g, '\\"')}"\n`;
      output += `number = ${pr.number}\n`;
      count += 1;
    }

    output += "\n";
  }

  console.log(`\nAdded ${count} PRs to the changelog`);

  writeFileSync(path, output);
}

/**
 * Stable sort by `closed_at`. Rust compares `Option<DateTime<Utc>>` where
 * `None < Some(_)` and `Some`s compare by timestamp. `closed_at` is an ISO-8601
 * string here (or null); we parse it for comparison.
 */
function stableSortByClosedAt(prs: PrEntry[]): PrEntry[] {
  return prs
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const ca = a.entry.pr.closed_at;
      const cb = b.entry.pr.closed_at;
      const ka = ca === null ? null : Date.parse(ca);
      const kb = cb === null ? null : Date.parse(cb);
      let cmp: number;
      if (ka === null && kb === null) cmp = 0;
      else if (ka === null) cmp = -1; // None < Some
      else if (kb === null) cmp = 1;
      else cmp = ka - kb;
      return cmp !== 0 ? cmp : a.index - b.index;
    })
    .map((x) => x.entry);
}
