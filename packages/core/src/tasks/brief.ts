/** The brief a worker gets (PLAN.md §9.5): the brief template (Customize › Prompts) filled in from its task and profile. */
import type { EncodingDamage } from "@aria/protocol";
import { DEFAULT_BRIEF_TEMPLATE, renderTemplate } from "../prompts/templates.ts";
import type { TaskRecord } from "../store/store.ts";

/** A short title from the first line of a brief. */
export function titleFrom(brief: string): string {
  const first = (brief.trim().split(/\r?\n/)[0] ?? "").replace(/\s+/g, " ").trim();
  if (!first) return "Task";
  return first.length > 60 ? `${first.slice(0, 57).trimEnd()}…` : first;
}

/**
 * How a sandboxed task changes files (R1): Windows PowerShell 5.1 writes Windows-1252 with `Set-Content`, UTF-16 with
 * `Out-File` and `>`, and adds a byte-order mark with their `UTF8`. .NET resolves a relative path against its own
 * current folder, which `cd` doesn't move, so the recipe uses full paths.
 */
export const SANDBOX_FILE_RULE =
  "- Files are UTF-8: keep a byte-order mark only where a file already has one, and leave a file that isn't UTF-8 in its own encoding. Change files with your edit tool. A script that must rewrite a UTF-8 file uses its full path, reads it with `[IO.File]::ReadAllText($path)` and writes it with `[IO.File]::WriteAllText($path, $text, (New-Object Text.UTF8Encoding $false))` (`$true` where it had a byte-order mark), never with `Set-Content`, `Out-File` or `>`.";

const REPLACEMENT_CHARACTER = String.fromCharCode(0xfffd);

/**
 * R1: what "Ask it to repair" sends a task, in ARIA's words: what was found, where, and how to repair it without
 * doing it again. The paths are the task's own file names, cleaned when they were counted (worktrees.ts).
 */
export function encodingRepairMessage(damage: EncodingDamage): string {
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const more = damage.files > damage.paths.length ? ` and ${damage.files - damage.paths.length} more` : "";
  return [
    `ARIA found ${plural(damage.lines, "line")} in ${plural(damage.files, "file")} that look like damaged text: UTF-8 read as Windows-1252 and written back (\`→\` became \`â†’\`, \`é\` became \`Ã©\`), characters turned into \`?\` or into bytes that aren't UTF-8, a replacement character (\`${REPLACEMENT_CHARACTER}\`), a file turned into UTF-16, or a byte-order mark the file didn't have.`,
    `Files: ${damage.paths.map((p) => `\`${p}\``).join(", ")}${more}.`,
    `Repair them: compare each file with the commit you started from (\`git diff ${damage.base} -- <file>\`) and put the original text back with your edit tool, not a script, changing nothing else. A file git now shows as binary (turned into UTF-16), or one that wasn't UTF-8 there, can't be repaired that way: restore it with \`git checkout ${damage.base} -- <file>\` and make your change to it again. Then commit the repair.`,
  ].join("\n");
}

/** What the worker should know about where it runs (D20): the sandbox, or which commands wait for the user. */
export function environmentRules(sandboxed: boolean, allowedPaths?: readonly string[]): string {
  const pathsNote = allowedPaths && allowedPaths.length > 0
    ? `\n- You may also read files from these allowed external paths: ${allowedPaths.map((p) => `\`${p}\``).join(", ")}.`
    : "";
  return sandboxed
    ? [
        `- You work in a sandbox: only this worktree can be changed, and the network only reaches package registries (so there's no GitHub access, and you can't push).${pathsNote}`,
        "- Shell commands may run in Windows PowerShell 5.1: avoid PowerShell 7-only syntax such as `&&`, `||`, `? :` and `??`.",
        SANDBOX_FILE_RULE,
      ].join("\n")
    : `- Commands other than tests, builds, lockfile installs, git basics and read-only ones, and anything outside this worktree or on the network, wait for the user's approval.${pathsNote}`;
}

/** `memory`: the {{memory}} block of your notes for the task's project (memory/memories.ts), empty without any. */
export function renderBrief(task: TaskRecord, profileInstructions?: string, template: string = DEFAULT_BRIEF_TEMPLATE, memory = ""): string {
  const extraContextText = task.extraContext?.trim() ?? "";
  const filesText = task.files && task.files.length > 0 ? task.files.map((f) => `- ${f}`).join("\n") : "";

  let rendered = renderTemplate(template, {
    title: task.title,
    repo: task.repoName,
    branch: task.branch ?? "(new)",
    base: task.baseBranch ?? "default",
    brief: task.brief.trim(),
    extraContext: extraContextText ? `Extra context\n${extraContextText}` : "",
    files: filesText ? `Provided files\n${filesText}` : "",
    memory,
    profileInstructions: profileInstructions?.trim() ?? "",
    environment: environmentRules(task.sandboxed === true, task.allowedPaths),
  });

  const additions: string[] = [];
  if (extraContextText && !template.includes("{{extraContext}}")) {
    additions.push(`Extra context\n${extraContextText}`);
  }
  if (filesText && !template.includes("{{files}}")) {
    additions.push(`Provided files\n${filesText}`);
  }
  if (additions.length > 0) {
    rendered = `${rendered}\n\n${additions.join("\n\n")}`;
  }
  return rendered;
}
