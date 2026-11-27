/**
 * My work's searches (PLAN.md §5.2, D38): three shapes fixed here, each scoped to your projects by `repo:` qualifiers.
 * As many repositories go in one query as keep the whole query within 256 characters (GitHub's limit leaves the
 * qualifiers out of its count; this counts them, so it holds either way), at most 8 queries a shape: 24 searches a
 * refresh, under the search limit of 30 a minute. The fetch guard (fetch.ts) refuses any other query.
 */
import type { MyWorkReason } from "@aria/protocol";

export const SEARCH_SHAPES: Readonly<Record<MyWorkReason, string>> = {
  review_requested: "is:open is:pr review-requested:@me archived:false",
  authored: "is:open is:pr author:@me archived:false",
  assigned: "is:open assignee:@me archived:false",
};
export const SEARCH_REASONS = Object.keys(SEARCH_SHAPES) as MyWorkReason[];

export const MAX_QUERY_LENGTH = 768;
export const MAX_BATCHES = 8;
/** Items per search (GitHub's `per_page`); past them, "and N more" from its `total_count`. */
export const SEARCH_PER_PAGE = 50;

const NAME = "[A-Za-z0-9_.-]{1,100}";
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A query ARIA makes: one of the shapes, then one or more `repo:owner/name`. */
export const SEARCH_QUERY = new RegExp(`^(?:${Object.values(SEARCH_SHAPES).map(escape).join("|")})(?: repo:${NAME}/${NAME})+$`);

/** The repositories a query names (lowercased "owner/name"). */
export const queryRepos = (q: string): string[] => [...q.matchAll(new RegExp(` repo:(${NAME}/${NAME})`, "g"))].map((m) => m[1]!.toLowerCase());

/**
 * The repositories ("owner/name") in groups, each group fitting every shape within the length limit; the same groups for
 * every shape. Past `MAX_BATCHES` groups the rest isn't searched (`unsearched` says how many).
 */
export function searchBatches(repos: readonly string[]): { batches: string[][]; unsearched: number } {
  const longest = Math.max(...Object.values(SEARCH_SHAPES).map((s) => s.length));
  const sorted = [...new Set(repos.map((r) => r.toLowerCase()))].sort();
  const batches: string[][] = [];
  let current: string[] = [];
  let length = longest;
  let unsearched = 0;
  for (const repo of sorted) {
    const add = ` repo:${repo}`.length;
    if (current.length && length + add > MAX_QUERY_LENGTH) {
      batches.push(current);
      current = [];
      length = longest;
    }
    if (batches.length >= MAX_BATCHES) {
      unsearched++;
      continue;
    }
    // A repository too long for any query on its own (GitHub's names are at most 100 characters each) isn't searched.
    if (longest + add > MAX_QUERY_LENGTH) {
      unsearched++;
      continue;
    }
    current.push(repo);
    length += add;
  }
  if (current.length && batches.length < MAX_BATCHES) batches.push(current);
  else if (current.length) unsearched += current.length;
  return { batches, unsearched };
}

export const searchQuery = (reason: MyWorkReason, repos: readonly string[]): string => `${SEARCH_SHAPES[reason]}${repos.map((r) => ` repo:${r}`).join("")}`;
