// Port of generate-release/src/contributors.rs to TypeScript.

import { writeFileSync } from "node:fs";

import { GithubClient } from "./github-client.ts";
import { getContributors, getMergedPrs } from "./helpers.ts";

/** Generates the list of contributors for the given release. */
export async function generateContributors(
  from: string,
  to: string,
  path: string,
  client: GithubClient,
): Promise<void> {
  // TODO consider adding website contributors.

  const mergedPrs = await getMergedPrs(client, from, to, null);

  // Getting the contributors is slow because it needs a separate call per commit.
  // The Rust crate uses rayon with 3 threads to parallelize and hit the rate
  // limit a little less aggressively while still finishing faster. We mirror the
  // bounded concurrency here.
  //
  // NOTE: the original collects into a `HashSet`, whose iteration order is
  // non-deterministic, so the exact line ordering of the committed
  // `contributors.toml` files is not reproducible by either implementation.
  const contributors = new Set<string>();

  const concurrency = 3;
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const idx = next++;
      if (idx >= mergedPrs.length) break;
      const { pr, commit } = mergedPrs[idx];
      const prContributors = await getContributors(client, commit, pr);
      for (const c of prContributors) {
        contributors.add(c);
      }
      contributors.add(`@${pr.user.login}`);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  contributors.delete("@github-actions[bot]");

  console.log(`Found ${contributors.size} unique contributors`);

  let output = "";
  for (const name of contributors) {
    output += `[[contributors]]\nname = '${name}'\n\n`;
  }

  writeFileSync(path, output);
}
