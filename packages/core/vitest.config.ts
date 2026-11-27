import { defineConfig } from "vitest/config";

// Every test file runs after test/no-network.ts: nothing leaves this PC and GitHub CLI never runs (PLAN.md §0.4).
// 30 s a test: the task tests spawn git about ten times for each task, one after another, and on Windows a process
// start is costly. A test with five tasks takes 4 to 6.5 s alone, and two to three times as long with other test runs
// on the PC (other sessions' worktrees) or on GitHub's Windows runners. A hang still fails.
// Half the cores, not all but one (vitest's default): with every core busy the suite ran slower (105 s against 72 s on
// a 20-thread PC) and task tests passed their time.
export default defineConfig({
  test: { setupFiles: ["./test/no-network.ts"], testTimeout: 30_000, maxWorkers: "50%" },
});
