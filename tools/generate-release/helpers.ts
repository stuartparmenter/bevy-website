// Port of generate-release/src/helpers.rs to TypeScript.

import { BevyRepo, GithubClient, IssueState, sleep } from "./github-client.ts";
import type { GithubCommitResponse, GithubIssuesResponse } from "./github-client.ts";

export interface MergedPr {
  pr: GithubIssuesResponse;
  commit: GithubCommitResponse;
  title: string;
}

export async function getMergedPrs(
  client: GithubClient,
  from: string,
  to: string,
  label: string | null,
): Promise<MergedPr[]> {
  console.log(`Getting list of all commits from ${from} to ${to}`);
  // We use the list of commits to make sure the PRs are only on main.
  const commits = await client.compareCommits(from, to);
  console.log(`Found ${commits.length} commits`);

  console.log(`Getting list of all merged PRs with label ${label === null ? "None" : `Some("${label}")`}`);

  const baseCommit = await client.getCommit(from, BevyRepo.Bevy);
  const baseCommitDate = baseCommit.commit.committer.date.slice(0, 10);

  // We also get the list of merged PRs in batches instead of getting them separately for each commit.
  // We can't set a `since` date, as the PRs requested are filtered by date opened, not date merged.
  const prs = await client.getIssuesAndPrs(BevyRepo.Bevy, IssueState.Merged, null, label);
  console.log(
    `Found ${commits.length} commits since ${baseCommitDate} (the base commit date)`,
  );

  const out: MergedPr[] = [];
  for (const commit of commits) {
    const parts = getTitlePartsFromCommit(commit);
    if (parts === null) {
      continue;
    }
    const [title, number] = parts;

    // Get the PR associated with the commit based on its title.
    const pr = prs.find((p) => p.number === number);
    if (pr === undefined) {
      // If there's no label, then not finding a PR is an issue because this means we want all PRs.
      // If there's a label then it just means the commit is not a PR with the label.
      if (label === null) {
        console.log(`\x1b[93mPR not found for ${title} sha: ${commit.sha}\x1b[0m`);
      }
      continue;
    }
    out.push({ pr, commit, title });
  }

  return out;
}

/**
 * Parses the commit message and returns the text without the PR number and the
 * PR number, or null if there was no PR associated with the commit.
 */
function getTitlePartsFromCommit(commit: GithubCommitResponse): [string, number] | null {
  // Title is always the first line of a commit message.
  // `str::lines()` splits on '\n' (stripping a trailing '\r'); the first element
  // always exists (matching the Rust `.next().expect(...)`).
  const firstLine = commit.commit.message.split("\n", 1)[0];
  const title = firstLine.replace(/\r$/, "");

  // Capture the title leading up to the PR number and the PR number.
  // The Rust code uses `captures_iter(title).last()`, i.e. the LAST match of the
  // anchored regex. Because the regex is anchored at the end (`$`), there is at
  // most one match, so the last match equals the only match.
  const re = /(.+?)\(#([\d]*)\)$/;
  const cap = re.exec(title);
  if (cap === null) {
    // This means there wasn't a PR associated with the commit.
    return null;
  }

  const titleOut = cap[1].replace(/\s+$/, ""); // trim_end()
  const number = Number.parseInt(cap[2], 10);
  return [titleOut, number];
}

/** Returns all the area labels for a PR, sorted case-insensitively. */
export function getPrArea(pr: GithubIssuesResponse): string[] {
  const areas = pr.labels
    .map((l) => l.name)
    .filter((l) => l.startsWith("A-"))
    .map((l) => l.replace("A-", ""));

  // sort_by_key(|a| a.to_lowercase()) — Rust's sort is stable.
  return stableSortBy(areas, (a) => a.toLowerCase());
}

/** A stable sort keyed by a derived comparable string (mirrors Rust `sort_by_key`). */
export function stableSortBy<T>(items: T[], key: (item: T) => string): T[] {
  return items
    .map((item, index) => ({ item, index, k: key(item) }))
    .sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : a.index - b.index))
    .map((entry) => entry.item);
}

/**
 * Gets a list of all authors and co-authors for the given commit.
 * Will retry the query automatically a few times.
 */
export async function getContributors(
  client: GithubClient,
  commit: GithubCommitResponse,
  pr: GithubIssuesResponse,
): Promise<string[]> {
  const getContributorsInternal = async (): Promise<string[]> => {
    const logins = await client.getContributors(commit.sha);
    if (logins.length === 0) {
      throw new Error(
        `\x1b[93mNo contributors found for https://github.com/bevyengine/${client.repo}/pull/${pr.number} sha: ${commit.sha}\x1b[0m`,
      );
    }
    return logins;
  };

  try {
    return await getContributorsInternal();
  } catch (err) {
    let retryCount = 0;
    while (retryCount < 20) {
      console.log(
        `\x1b[93mFailed to get contributors waiting and retrying: ${String(err)}\x1b[0m`,
      );
      await sleep(2000);
      try {
        return await getContributorsInternal();
      } catch {
        retryCount += 1;
      }
    }
    throw new Error("Too many retries");
  }
}
