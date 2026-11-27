/** My work's queries (github/search.ts, D38): fixed shapes, scoped by `repo:`, batched within GitHub's limits. */
import { describe, expect, it } from "vitest";
import { MAX_BATCHES, MAX_QUERY_LENGTH, queryRepos, SEARCH_QUERY, SEARCH_REASONS, searchBatches, searchQuery } from "../src/github/search.ts";

describe("My work's searches", () => {
  it("batches the repositories so every shape's query stays within MAX_QUERY_LENGTH, each repository once", () => {
    const repos = Array.from({ length: 30 }, (_, i) => `some-organisation-${i}/repository-number-${i}`);
    const { batches, unsearched } = searchBatches(repos);
    expect(unsearched).toBe(0);
    expect(batches.flat().sort()).toEqual(repos.map((r) => r.toLowerCase()).sort());
    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) {
      for (const reason of SEARCH_REASONS) {
        const q = searchQuery(reason, batch);
        expect(q.length, q).toBeLessThanOrEqual(MAX_QUERY_LENGTH);
        expect(SEARCH_QUERY.test(q), q).toBe(true);
        expect(queryRepos(q)).toEqual(batch);
      }
    }
  });

  it("at most 8 batches a shape (24 searches a refresh, under the search limit); the rest is counted as not searched", () => {
    const repos = Array.from({ length: 200 }, (_, i) => `organisation-${i}/repository-${i}`);
    const { batches, unsearched } = searchBatches(repos);
    expect(batches).toHaveLength(MAX_BATCHES);
    expect(batches.flat().length + unsearched).toBe(200);
    expect(unsearched).toBeGreaterThan(0);
  });

  it("the same repository twice (letter case) is one; none at all is no search", () => {
    expect(searchBatches(["Me/Moonrise", "me/moonrise"]).batches).toEqual([["me/moonrise"]]);
    expect(searchBatches([])).toEqual({ batches: [], unsearched: 0 });
  });
});
