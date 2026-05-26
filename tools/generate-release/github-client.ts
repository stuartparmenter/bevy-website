// Port of generate-release/src/github_client.rs to TypeScript.
//
// A thin wrapper around the GitHub REST + GraphQL APIs used to fetch commits,
// issues / PRs, contributors, and to open issues / leave comments.
//
// Uses the global `fetch` (Node 18+). All requests are authenticated with a
// bearer token (the `GITHUB_TOKEN` env var in the original crate).

const USER_AGENT = "bevy-website-generate-release";

/** A GitHub repository in the `bevyengine` organization. */
export const BevyRepo = {
  Bevy: "bevy",
  BevyWebsite: "bevy-website",
} as const;
export type BevyRepo = (typeof BevyRepo)[keyof typeof BevyRepo];

export interface Committer {
  date: string;
}

export interface GithubCommitContent {
  // First line is the title.
  // If multiple authors, it will add "Co-Authored by: <author>" at the end.
  message: string;
  committer: Committer;
}

export interface GithubCommitResponse {
  sha: string;
  commit: GithubCommitContent;
}

export interface GithubUser {
  login: string;
}

export interface GithubAuthor {
  name: string;
  user: GithubUser | null;
}

export interface GithubLabel {
  name: string;
}

export interface GithubIssuesResponsePullRequest {
  merged_at: string | null;
}

export interface GithubIssuesResponse {
  title: string;
  number: number;
  body: string | null;
  labels: GithubLabel[];
  user: GithubUser;
  /** ISO-8601 timestamp string or null. */
  closed_at: string | null;
  pull_request: GithubIssuesResponsePullRequest | null;
}

export interface GithubIssueOpenedResponse {
  /** The human-friendly HTML URL of the freshly opened issue. */
  html_url: string;
}

/**
 * The status of an issue or PR on GitHub.
 *
 * The string representation requested by the GitHub API is given by
 * {@link issueStateAsGithubStr}.
 */
export const IssueState = {
  Open: "Open",
  Closed: "Closed",
  Merged: "Merged",
  All: "All",
} as const;
export type IssueState = (typeof IssueState)[keyof typeof IssueState];

function issueStateAsGithubStr(state: IssueState): string {
  switch (state) {
    case IssueState.Open:
      return "open";
    // All merged PRs are considered closed, but not all closed PRs are merged.
    case IssueState.Closed:
    case IssueState.Merged:
      return "closed";
    case IssueState.All:
      return "all";
  }
}

export class IssueError extends Error {}

/** Sleep for the given number of milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class GithubClient {
  private token: string;
  public repo: BevyRepo;

  constructor(token: string, repo: BevyRepo) {
    this.token = token;
    this.repo = repo;
  }

  /** Builds the headers for a REST `GET` request. */
  private getHeaders(): Record<string, string> {
    return {
      Accept: "application/json",
      Authorization: `Bearer ${this.token}`,
      "User-Agent": USER_AGENT,
    };
  }

  private async getJson(url: string): Promise<unknown> {
    const resp = await fetch(url, { headers: this.getHeaders() });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`GET ${url} failed: ${resp.status} ${resp.statusText}\n${text}`);
    }
    return resp.json();
  }

  /** Gets the list of all commits between two git refs. */
  async compareCommits(from: string, to: string): Promise<GithubCommitResponse[]> {
    const commits: GithubCommitResponse[] = [];
    // The github page stuff is 1-based indexing and not 0-based.
    // Starting at 0 will give you the same page for 0 and 1.
    let page = 1;
    // To get all the prs we need to iterate on every page available.
    for (;;) {
      const commitsInPage = await this.compareCommitsPage(from, to, page);
      console.log(`Page: ${page} (${commitsInPage.commits.length} commits)`);
      // When it returns an empty page it means we have all the commits in the given range.
      if (commitsInPage.commits.length === 0) {
        break;
      }
      commits.push(...commitsInPage.commits);
      page += 1;
    }
    return commits;
  }

  private async compareCommitsPage(
    from: string,
    to: string,
    page: number,
  ): Promise<{ commits: GithubCommitResponse[] }> {
    const url = new URL(
      `https://api.github.com/repos/bevyengine/${BevyRepo.Bevy}/compare/${from}...${to}`,
    );
    url.searchParams.set("per_page", "250");
    url.searchParams.set("page", page.toString());
    return (await this.getJson(url.toString())) as { commits: GithubCommitResponse[] };
  }

  /**
   * Gets a filtered list of issues and PRs from `bevyengine/{repo}`.
   *
   * If `since` is provided, it should be a date in the YYYY-MM-DD format.
   */
  async getIssuesAndPrs(
    repo: BevyRepo,
    state: IssueState,
    since: string | null,
    label: string | null,
  ): Promise<GithubIssuesResponse[]> {
    let datetimeUtcMs: number | null = null;
    if (since !== null) {
      // NaiveDate::parse_from_str(since, "%Y-%m-%d") at 00:00:00 UTC.
      datetimeUtcMs = Date.parse(`${since}T00:00:00Z`);
      if (Number.isNaN(datetimeUtcMs)) {
        throw new Error(`invalid since date: ${since}`);
      }
    }

    const prs: GithubIssuesResponse[] = [];
    let page = 1;
    // The github rest API is limited to 100 prs per page,
    // so to get all the prs we need to iterate on every page available.
    for (;;) {
      if (page === 100) {
        // We can't fetch more than 99 pages of data or GitHub will fail with a 422.
        break;
      }
      const prsInPage = await this.getIssuesAndPrsByPage(page, repo, state, since, label);
      console.log(`Page: ${page} (${prsInPage.length} prs)`);
      if (prsInPage.length === 0) {
        break;
      }
      prs.push(...prsInPage);
      page += 1;
    }

    // Make sure the older PRs from the last page aren't returned.
    if (datetimeUtcMs !== null) {
      console.log(
        `Filtering PRs closed before the target datetime ${new Date(datetimeUtcMs).toISOString()}`,
      );
      return prs.filter(
        (pr) => pr.closed_at !== null && Date.parse(pr.closed_at) >= datetimeUtcMs!,
      );
    }

    return prs;
  }

  /** Request issues and PRs by the page returned by the GitHub API. */
  private async getIssuesAndPrsByPage(
    page: number,
    repo: BevyRepo,
    state: IssueState,
    date: string | null,
    label: string | null,
  ): Promise<GithubIssuesResponse[]> {
    const url = new URL(`https://api.github.com/repos/bevyengine/${repo}/issues`);
    url.searchParams.set("state", issueStateAsGithubStr(state));
    url.searchParams.set("base", "main");
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", page.toString());
    if (date !== null) {
      url.searchParams.set("since", `${date}T00:00:00Z`);
    }
    if (label !== null) {
      url.searchParams.set("labels", label);
    }

    let responses = (await this.getJson(url.toString())) as GithubIssuesResponse[];

    // Filter the PRs based on the requested state.
    switch (state) {
      case IssueState.Open:
        responses = responses.filter((pr) => pr.closed_at === null);
        break;
      case IssueState.Closed:
        responses = responses.filter((pr) => pr.closed_at !== null);
        break;
      case IssueState.Merged:
        responses = responses.filter(
          (pr) => pr.pull_request !== null && pr.pull_request.merged_at !== null,
        );
        break;
      case IssueState.All:
        break;
    }

    return responses;
  }

  /** Gets the deduplicated list of author logins / names for a commit. */
  async getContributors(commitSha: string): Promise<string[]> {
    const queryRaw = `
query {
    resource(url: "https://github.com/bevyengine/${this.repo}/commit/${commitSha}") {
        ... on Commit {
            authors(first: 10) {
                nodes {
                    user {
                        login
                    },
                    name
                }
            }
        }
    }
}`;
    // for whatever reasons, github doesn't accept newlines in graphql queries
    const query = queryRaw.replace(/\n/g, "");

    const resp = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        Authorization: `bearer ${this.token}`,
        "User-Agent": USER_AGENT,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`graphql request failed: ${resp.status} ${resp.statusText}\n${text}`);
    }
    const json = (await resp.json()) as any;

    // A Map preserving insertion order. The value is the `@login` if found, else null.
    const nameLoginMap = new Map<string, string | null>();

    const nodes = json?.data?.resource?.authors?.nodes;
    if (!Array.isArray(nodes)) {
      throw new Error(`nodes should be an array\n: ${JSON.stringify(json)}`);
    }
    for (const node of nodes) {
      const author = node as GithubAuthor;
      if (author.user) {
        // If we find an already matching entry that had no login then use the login for that entry.
        // Otherwise if it doesn't exist just insert it.
        const existing = nameLoginMap.get(author.name);
        if (existing === undefined || existing === null) {
          nameLoginMap.set(author.name, `@${author.user.login}`);
        }
      } else {
        // Some entries have a name with no login but another entry with the same name and a login,
        // so we first check if it already exists because we don't want to overwrite an entry that
        // already had a login.
        if (!nameLoginMap.has(author.name)) {
          nameLoginMap.set(author.name, null);
        }
      }
    }

    const contributors: string[] = [];
    for (const [name, login] of nameLoginMap) {
      if (login !== null) {
        contributors.push(login);
      } else {
        console.log(
          `\x1b[93mUser login not found, using name '${name}' instead.\n${JSON.stringify(json)}\x1b[0m`,
        );
        contributors.push(name);
      }
    }
    return contributors;
  }

  /** Gets the data for a specific commit on the provided `bevyengine` repo. */
  async getCommit(gitRef: string, repo: BevyRepo): Promise<GithubCommitResponse> {
    const url = `https://api.github.com/repos/bevyengine/${repo}/commits/${gitRef}`;
    return (await this.getJson(url)) as GithubCommitResponse;
  }

  /** Opens a new issue on the specified repo. */
  async openIssue(
    repo: BevyRepo,
    issueTitle: string,
    issueBody: string,
    labels: string[],
  ): Promise<GithubIssueOpenedResponse> {
    const resp = await fetch(`https://api.github.com/repos/bevyengine/${repo}/issues`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": USER_AGENT,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title: issueTitle,
        body: issueBody,
        labels,
      }),
    });

    if (resp.status !== 201) {
      const text = await resp.text();
      throw new IssueError(
        `failed to create issue: ${resp.status} ${resp.statusText}\n${text}`,
      );
    }
    return (await resp.json()) as GithubIssueOpenedResponse;
  }

  /** Leaves a comment on the specified issue or pull request. */
  async leaveComment(repo: BevyRepo, issueNumber: number, comment: string): Promise<void> {
    const resp = await fetch(
      `https://api.github.com/repos/bevyengine/${repo}/issues/${issueNumber}/comments`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": USER_AGENT,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ body: comment }),
      },
    );
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`failed to leave comment: ${resp.status} ${resp.statusText}\n${text}`);
    }
  }
}
