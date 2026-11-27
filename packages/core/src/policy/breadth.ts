/**
 * What ARIA says about a rule before it's saved (D26): the same check for Customize › Permissions and the "Always
 * allow this" form. Only Auto rules have limits (Ask and Never only make things stricter):
 *
 * - An Auto rule that isn't exact, or is exact but has a word in angle brackets (which stands for any argument), is
 *   allowed only for commands that test, build, lint, format or type-check (an allowlist of program and first words);
 *   anything else has to be exact, with every argument named, so a rule can't let a whole program run on its own
 *   (`git`, `node`, `npm <x>`, `pwsh -Command <x>`).
 * - An Auto rule for a destructive command (D28) can't be saved, exact or not, and neither can one that names a
 *   program by its folder (it would never match: such a program asks, whatever a rule says).
 *
 * The warnings say what a rule also covers, and when it runs although a Never rule of yours matches it.
 */
import type { PolicyRule, RuleCheck, RuleEffect, RuleScope } from "@aria/protocol";
import { parseArgs, ruleMatches, ruleShape, ruleWeight, type ParsedCommand } from "./command.ts";
import { destructive } from "./destructive.ts";
import { namesFolder } from "./worker.ts";

export interface RuleCheckInput {
  match: string;
  effect: RuleEffect;
  exact?: boolean | undefined;
  scope?: RuleScope | undefined;
}

/** Package managers' test and build commands: `npm test`, `npm t`, `npm run build`… */
const SCRIPT_RUNNERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const SCRIPTS = new Set(["test", "build", "lint", "format", "typecheck", "check"]);
/**
 * Programs and the first words a rule for them may stop at: what follows is a project, a test filter or packages, not
 * more actions. Not `make`, `just`, `task`, `gradle` or `mvn`, where each further word is another goal (`make test
 * deploy`): a rule for one of them has to be exact.
 */
const FIRST_WORDS: Record<string, ReadonlySet<string>> = {
  dotnet: new Set(["build", "test", "restore", "format"]),
  cargo: new Set(["build", "test", "check", "clippy", "fmt"]),
  go: new Set(["build", "test", "vet", "fmt"]),
};
/** Programs that only test, lint, format or type-check: a rule may name them alone. */
const CHECKERS = new Set(["tsc", "eslint", "prettier", "vitest", "jest", "pytest", "ruff", "black", "mypy", "flake8"]);

/** Whether a rule that isn't exact may be Auto: the allowlist above. */
function broadAllowed(program: string, pattern: Array<string | undefined>): boolean {
  if (CHECKERS.has(program)) return true;
  const [first, second] = pattern;
  if (SCRIPT_RUNNERS.has(program)) return first === "test" || first === "t" || (first === "run" && second !== undefined && SCRIPTS.has(second));
  return first !== undefined && (FIRST_WORDS[program]?.has(first) ?? false);
}

/** The command a rule names, read the way the policy reads a command (a placeholder stands for a plain word). */
export function ruleCommand(match: string): ParsedCommand | undefined {
  const shape = ruleShape(match, true);
  if (!shape) return undefined;
  const args = shape.tokens.map((token) => token ?? "x");
  return { ...parseArgs(shape.program, args), programToken: shape.programToken, text: match.trim() };
}

export function checkRule(rule: RuleCheckInput, others: readonly PolicyRule[] = []): RuleCheck {
  const problems: string[] = [];
  const warnings: string[] = [];
  const match = rule.match.trim().replace(/\s+/g, " ");
  const exact = rule.exact === true;
  const shape = ruleShape(match, exact);
  if (!shape || /^[<-]/.test(shape.program) || shape.program.startsWith("/")) return { problems: [`\`${match}\` doesn't start with a command.`], warnings };
  if (match.length > 200) problems.push("It's longer than 200 characters.");
  if (rule.effect !== "auto") return { problems, warnings };

  const command = ruleCommand(match);
  const destroys = destructive(command);
  if (destroys) problems.push(`It's destructive (it ${destroys}): destructive commands ask every time, whatever a rule says.`);
  if (namesFolder(shape.programToken)) problems.push("It names the program by its folder: a task can put its own program there, so such a command always asks. Name the program alone.");
  // A word in angle brackets stands for any argument, so an exact rule with one is as broad there as a rule that isn't.
  const placeholder = shape.tokens.includes(undefined);
  if ((!exact || placeholder) && !broadAllowed(shape.program, shape.pattern)) {
    problems.push(
      exact
        ? `Its word in angle brackets would let tasks run \`${match}\` with anything there on their own. Only rules for tests, builds, linters and formatters (\`npm test\`, \`dotnet test\`, \`eslint\`…) can have one: name the argument instead.`
        : `Without “Only exactly this”, it would let tasks run any \`${match}\` command on their own. Only rules for tests, builds, linters and formatters (\`npm test\`, \`npm run build\`, \`dotnet test\`, \`eslint\`…) can do without it.`,
    );
  }
  if (!exact) warnings.push("It also covers this command with more arguments or options after it.");
  if (shape.pattern.includes(undefined) || shape.tokens.includes(undefined)) warnings.push("A word in angle brackets stands for any one argument.");
  if ((shape.program === "git" && shape.pattern[0] === "push") || (shape.program === "gh" && shape.pattern[0] === "pr" && shape.pattern[1] === "merge")) {
    warnings.push("Pushing to the default branch, destructive pushes and merging stay refused whatever this says.");
  }
  if ((rule.scope ?? "everywhere") === "everywhere") warnings.push("In a task without the sandbox, paths and options that reach outside its worktree still ask.");
  // Most specific wins: say when it beats one of your Never rules for its own command.
  if (command) {
    const weight = ruleWeight(shape);
    for (const other of others) {
      if (other.effect !== "never") continue;
      const theirs = ruleShape(other.match, other.exact === true);
      if (!theirs || !ruleMatches(theirs, command)) continue;
      if (ruleWeight(theirs) < weight) warnings.push(`It runs although your Never rule \`${other.match}\` matches it (this one is more specific).`);
      else warnings.push(`Your Never rule \`${other.match}\` still refuses it (it's at least as specific).`);
    }
  }
  return { problems, warnings };
}
