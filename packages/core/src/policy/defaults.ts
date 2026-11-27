/** Default worker permission rules and sandbox hosts (PLAN.md §4.8, D18, D20); editable in Customize › Permissions. */
import type { PolicyRule } from "@aria/protocol";

const ADDS = "Adds a package. Installing from the lockfile runs on its own.";

export const DEFAULT_RULES: readonly PolicyRule[] = [
  { id: "npm-install", match: "npm install <package>", effect: "ask", note: ADDS },
  { id: "npm-i", match: "npm i <package>", effect: "ask", note: ADDS },
  { id: "npm-add", match: "npm add <package>", effect: "ask", note: ADDS },
  { id: "pnpm-add", match: "pnpm add <package>", effect: "ask", note: ADDS },
  { id: "yarn-add", match: "yarn add <package>", effect: "ask", note: ADDS },
  { id: "dotnet-add-package", match: "dotnet add package", effect: "ask", note: ADDS },
  { id: "dotnet-add-project-package", match: "dotnet add <project> package", effect: "ask", note: ADDS },
  { id: "pip-install", match: "pip install <package>", effect: "ask", note: "Installs a Python package." },
  { id: "git-push", match: "git push", effect: "ask", note: "Publishes the branch. A sandboxed task can't push at all: ARIA pushes when you open a pull request." },
  { id: "gh-workflow-run", match: "gh workflow run", effect: "ask", note: "Triggers a GitHub Actions workflow run." },
  { id: "gh-run-rerun", match: "gh run rerun", effect: "ask", note: "Re-runs a GitHub Actions workflow run." },
  { id: "git-reset-hard", match: "git reset --hard", effect: "ask", note: "Throws away uncommitted work." },
  { id: "git-clean", match: "git clean -f", effect: "ask", note: "Deletes untracked files." },
  { id: "remove-recurse", match: "Remove-Item -Recurse", effect: "ask", note: "Deletes a folder and everything in it (also rm -r, del -Recurse)." },
];

/** Package registries and GitHub CLI API: lockfile installs (D18) and approved gh commands need them, nothing else does. */
export const DEFAULT_ALLOWED_HOSTS: readonly string[] = [
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "repo.yarnpkg.com",
  "api.nuget.org",
  "*.nuget.org",
  "api.github.com",
  "github.com",
];
