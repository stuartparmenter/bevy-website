// Port of generate-release/src/release_notes.rs to TypeScript.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";

import { BevyRepo, GithubClient, IssueState, sleep } from "./github-client.ts";
import type { GithubIssuesResponse } from "./github-client.ts";
import { getContributors, getMergedPrs } from "./helpers.ts";
import { slugifyTitle, truncateUtf8 } from "./util.ts";

interface ReleaseNoteMeta {
  title: string;
  authors: string[];
  contributors: string[];
  prs: number[];
  file_name: string;
}

export async function generateReleaseNotes(
  from: string,
  to: string,
  path: string,
  client: GithubClient,
  overwriteExisting: boolean,
  // If this value is false, no issues will be opened.
  createIssues: boolean,
): Promise<void> {
  // Get all PRs that need release notes.
  const prs = await getMergedPrs(client, from, to, "M-Needs-Release-Note");

  // Create the directory that will contain all the release notes.
  mkdirSync(path, { recursive: true });

  // We'll write the file once at the end when all the metadata is generated.
  const notesMetadata: string[] = [];

  // Generate the list of all issues so we don't spam the repo with duplicates.
  // Done outside the loop so we don't re-request it for every PR.
  console.log(
    "Getting list of the issues from the `bevy-website` repo to check for duplicates.",
  );
  const issuesAndPrs = await client.getIssuesAndPrs(
    BevyRepo.BevyWebsite,
    IssueState.All,
    null,
    null,
  );
  const issueTitles = new Set(issuesAndPrs.map((issue) => issue.title));
  console.log(`Found ${issueTitles.size} issues`);

  // If metadata already exists, load it to know which PRs already have entries.
  const releaseNotesTomlPath = join(path, "_release-notes.toml");
  let preexistingMetadata: ReleaseNoteMeta[] | null = null;
  if (existsSync(releaseNotesTomlPath)) {
    const parsed = parseToml(readFileSync(releaseNotesTomlPath, "utf8")) as {
      release_notes?: ReleaseNoteMeta[];
    };
    preexistingMetadata = parsed.release_notes ?? [];
  }
  console.error(`metadata exists? ${preexistingMetadata !== null}`);

  let newPrs = false;

  for (const { pr, commit, title } of prs) {
    // If a PR is already included in the release notes, skip it (unless overwriting).
    if (preexistingMetadata !== null && !overwriteExisting) {
      let prAlreadyGenerated = false;
      for (const releaseNote of preexistingMetadata) {
        if (releaseNote.prs.includes(pr.number)) {
          prAlreadyGenerated = true;
        }
      }
      if (prAlreadyGenerated) {
        console.error(`PR #${pr.number} already exists`);
        continue;
      }
    }

    // We have new PRs to record.
    newPrs = true;

    const titleSlug = slugifyTitle(title);

    // PR number first so sorting by name stays consistent (PR numbers are monotonic).
    let fileName = `${pr.number}_${titleSlug}`;
    // Shorten the filename (some OSes still have path-length limits); 64 is arbitrary.
    fileName = truncateUtf8(fileName, 64);

    // Get the list of contributors to this PR.
    const contributorsSet = new Set<string>();
    const author = `@${pr.user.login}`;

    try {
      const prContributors = await getContributors(client, commit, pr);
      for (const c of prContributors) {
        contributorsSet.add(c);
      }
    } catch {
      // Matches Rust's `if let Ok(...)`: on error, leave contributors empty.
    }

    contributorsSet.delete(author);

    // Separate contributors from authors for manual filtering (contributors may
    // include typo fixes and other minor changes unwanted for the author position).
    const contributors = [...contributorsSet];

    notesMetadata.push(generateMetadataBlock(title, author, contributors, pr.number, fileName));

    const filePath = join(path, `${fileName}.md`);

    let fileContent = "";
    fileContent += `<!-- ${title} -->\n`;
    fileContent += `<!-- https://github.com/bevyengine/bevy/pull/${pr.number} -->\n`;
    fileContent += "\n<!-- TODO -->\n";
    writeFileSync(filePath, fileContent);

    // Open an issue to remind the author(s) to write the release notes.
    await generateAndOpenIssue(client, issueTitles, pr, title, filePath, createIssues);
  }

  if (!createIssues) {
    console.log(
      "No issues were created. If you would like to do so, add the `--create-issues` flag.",
    );
  }

  console.error(`new prs? ${newPrs}`);

  // Early return if there are no new PRs to append to the metadata file.
  if (!newPrs) {
    return;
  }

  if (overwriteExisting) {
    // Replace and overwrite file.
    let out = "";
    for (const metadata of notesMetadata) {
      out += metadata + "\n";
    }
    writeFileSync(releaseNotesTomlPath, out);
  } else {
    // Append to the metadata file, creating it if necessary.
    let out = "";
    for (const metadata of notesMetadata) {
      out += metadata + "\n";
    }
    appendFileSync(releaseNotesTomlPath, out);
  }
}

function generateMetadataBlock(
  title: string,
  author: string,
  contributors: string[],
  prNumber: number,
  fileName: string,
): string {
  const contributorsStr = contributors.map((c) => `"${c}"`).join(", ");
  const titleEscaped = title.trim().replace(/"/g, '\\"');
  // Matches the Rust template exactly, including `authors = ["...",]` trailing comma.
  return `[[release_notes]]
title = "${titleEscaped}"
authors = ["${author}",]
contributors = [${contributorsStr}]
prs = [${prNumber}]
file_name = "${fileName}.md"
`;
}

/**
 * 1. Generates a new issue on the `bevy-website` repo for the given PR.
 * 2. Leaves a comment in the original PR linking to the new issue.
 *
 * If the issue already exists, no action is taken.
 */
async function generateAndOpenIssue(
  client: GithubClient,
  existingIssueTitles: Set<string>,
  pr: GithubIssuesResponse,
  title: string,
  filePath: string,
  createIssues: boolean,
): Promise<void> {
  const prNumber = pr.number;
  const issueTitle = `Write release notes for PR #${prNumber}: ${title}`;

  // Don't spam the repo with duplicate issues.
  if (existingIssueTitles.has(issueTitle)) {
    console.log(`Issue already exists for PR #${prNumber}: ${title}`);
    return;
  }

  const prUrl = `https://github.com/bevyengine/bevy/pull/${prNumber}`;

  // The weird indentation is intentional: otherwise the tabs get copied into the
  // issue body and GitHub renders it incorrectly.
  const issueBody = `${prUrl} needs release notes for the upcoming Bevy release!

Please reply below if you'd like to write these notes. 
While the author(s) of the PR often have the context, knowledge and motivation to draft the release notes for their feature, anyone can contribute release notes!

------

Release notes should:

1. Clearly motivate the change.
2. Be written in a way that is understandable by the average Bevy user: some programming background and a general understanding of games.
3. Show off the coolest features of the PR. Screenshots are awesome, but elegant APIs are also welcome!
4. If this was a perf-centric PR, quantify the performance improvements. Graphs and statistics work well for this.

We can help you revise the release notes: a rough draft alone is incredibly useful :)
Your expertise is invaluable for contextualizing the changes; we'll work with you to bring the technical writing up to par.

To submit your release notes, modify \`${filePath}\` and submit a PR.
In that PR, please mention this issue with the \`Fixes #ISSUE_NUMBER\` keyphrase so it gets closed automatically.`;

  const labels = ["A-Release-Notes", "C-Content", "S-Ready-For-Implementation"];

  if (!createIssues) {
    console.log("Would open issue on GitHub:");
    console.log(`Title: ${issueTitle}`);
    console.log(`Body: ${issueBody}`);
    console.log(`Labels: ${JSON.stringify(labels)}\n\n`);
    return;
  }

  let response;
  try {
    response = await client.openIssue(BevyRepo.BevyWebsite, issueTitle, issueBody, labels);
  } catch (err) {
    console.error(`Failed to open issue for PR #${prNumber}: ${title}`);
    console.error(`Error: ${String(err)}`);
    process.exit(1);
  }
  console.log(`Opened issue for PR #${prNumber}: ${title}`);
  // Pause between opening issues to avoid getting rate-limited.
  await sleep(2000);

  // Leave a comment on the PR linking to the new issue.
  const issueUrl = response.html_url;
  const comment = `Thank you to everyone involved with the authoring or reviewing of this PR! This work is relatively important and needs release notes! Head over to ${issueUrl} if you'd like to help out.`;

  try {
    await client.leaveComment(BevyRepo.Bevy, prNumber, comment);
  } catch (err) {
    console.error(`Failed to leave a comment on PR #${prNumber}: ${title}`);
    console.error(`Error: ${String(err)}`);
    process.exit(1);
  }
}
