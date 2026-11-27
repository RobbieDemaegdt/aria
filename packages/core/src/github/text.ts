/**
 * Text from GitHub is untrusted (PLAN.md §4.13): titles, branch, workflow and job names, review bodies and logins can be
 * written by anyone who can open a PR or an issue. It's cleaned before it's stored, drawn as plain text, and reaches
 * ARIA only as one quoted line (or not at all: review bodies and inbox titles, D37). Links ARIA shows are built
 * here from checked parts, so a page never points anywhere but github.com.
 */

/** Control, format (bidi, zero-width) and line/paragraph separator characters. */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** One line of GitHub's text for a card or a list: no control or invisible characters, runs of space as one, cut. */
export function githubText(value: unknown, max = 200): string {
  const text = typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
  const flat = text.replace(INVISIBLE, " ").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Several lines (a review's text) for a card: line breaks kept, everything else as githubText, cut. */
export function githubBlock(value: unknown, max = 1_000): string {
  const text = typeof value === "string" ? value : "";
  const lines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(INVISIBLE, " ").replace(/[ \t]+/g, " ").trimEnd());
  const joined = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return joined.length > max ? `${joined.slice(0, max - 1)}…` : joined;
}

/**
 * GitHub's text in front of ARIA (a digest line, a tool result): one line, quoted, and nothing in it can end the
 * quote or the digest's block: `"` and backticks become `'`, `<` and `>` become `‹` and `›`.
 */
export function digestText(value: unknown, max = 120): string {
  const clean = githubText(value, max).replace(/["`]/g, "'").replace(/</g, "‹").replace(/>/g, "›");
  return `"${clean}"`;
}

/** An owner or repository name as GitHub allows them; anything else is never put in a path or a link. */
const NAME = /^[A-Za-z0-9_.-]{1,100}$/;
export const validName = (value: unknown): value is string => typeof value === "string" && NAME.test(value) && value !== "." && value !== "..";

/** "owner/repo", lowercased: how watches compare repositories (GitHub doesn't tell letter case apart). */
export const repoKey = (owner: string, repo: string) => `${owner}/${repo}`.toLowerCase();

/** "owner/repo" from GitHub's `full_name`, when it's a real one. */
export function fullName(value: unknown): { owner: string; repo: string } | undefined {
  if (typeof value !== "string") return undefined;
  const [owner, repo, more] = value.split("/");
  return more === undefined && validName(owner) && validName(repo) ? { owner, repo } : undefined;
}

/** A login as GitHub allows them (bots end in [bot]); else nothing. */
export function login(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/.test(value) ? value : undefined;
}

/** A positive whole number from GitHub (an id, a run or PR number). */
export const id = (value: unknown): number | undefined => (typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined);

/** A time from GitHub (ISO 8601) in milliseconds. */
export function time(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

const encodePath = (branch: string) => branch.split("/").map(encodeURIComponent).join("/");

/** github.com pages, built by ARIA from checked parts. */
export const links = {
  repo: (owner: string, repo: string) => `https://github.com/${owner}/${repo}`,
  run: (owner: string, repo: string, runId: number) => `https://github.com/${owner}/${repo}/actions/runs/${runId}`,
  job: (owner: string, repo: string, runId: number, jobId: number) => `https://github.com/${owner}/${repo}/actions/runs/${runId}/job/${jobId}`,
  pull: (owner: string, repo: string, number: number) => `https://github.com/${owner}/${repo}/pull/${number}`,
  checks: (owner: string, repo: string, number: number) => `https://github.com/${owner}/${repo}/pull/${number}/checks`,
  issue: (owner: string, repo: string, number: number) => `https://github.com/${owner}/${repo}/issues/${number}`,
  branchRuns: (owner: string, repo: string, branch: string) => `https://github.com/${owner}/${repo}/actions?query=${encodeURIComponent(`branch:${branch}`)}`,
  workflow: (owner: string, repo: string, file: string) => `https://github.com/${owner}/${repo}/actions/workflows/${encodeURIComponent(file)}`,
  branch: (owner: string, repo: string, branch: string) => `https://github.com/${owner}/${repo}/tree/${encodePath(branch)}`,
  notifications: () => "https://github.com/notifications",
};

/** A page GitHub's API named (an `html_url`), only when it's on github.com over https; anything else isn't linked. */
export function githubPage(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com" && !url.username && !url.password && url.port === "" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** A notification's subject (an API address like …/repos/o/r/pulls/12) as its github.com page, and its number. */
export function subjectPage(apiUrl: unknown, owner: string, repo: string): { url: string; number?: number } {
  if (typeof apiUrl === "string") {
    const match = /\/repos\/[^/]+\/[^/]+\/(pulls|issues)\/(\d+)$/.exec(apiUrl);
    const number = match ? Number(match[2]) : undefined;
    if (match && number && Number.isSafeInteger(number)) return { url: match[1] === "pulls" ? links.pull(owner, repo, number) : links.issue(owner, repo, number), number };
  }
  return { url: links.repo(owner, repo) };
}

/** "4m12s", "1h03m", "35s". */
export function durationText(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}
