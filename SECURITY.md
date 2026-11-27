# Security policy

## Reporting a vulnerability

Please report a vulnerability privately, not in a public issue. On this repository's **Security** tab, choose **Report a
vulnerability**: GitHub's private vulnerability reporting sends the report to the maintainers only.

Include what you can of:

- what you found and what it lets someone do that ARIA says it won't;
- the steps to reproduce it, and the ARIA version (the What's New window shows it, and so does the installer's file name);
- the Windows version, and whether the sandbox was on for the task;
- the command, the request or the file involved, if there is one.

Do not put a token, a password or any other secret in a report or in an issue, and do not paste ARIA's logs without reading them
first: a log can hold paths and names. If a report needs a secret to be understood, say so, and the maintainers will agree how to
share it.

## What counts

ARIA runs commands and edits files on a PC on the strength of a model's output, so what matters most is the code that stands
between the two. In scope:

- the **permission engine**: a request that should have asked and ran, or a rule that matches more than it says;
- the **sandbox**: a task that reaches a file or a host outside its worktree and the package registries;
- the **fixed refusals**: a push to a default branch, a pull request merge, or the deleting, mirroring or pruning of remote
  branches, however it is phrased or reached (an alias, another program, an encoded command), and a destructive command that did
  not ask;
- the **prompt-injection guards**: text in a file, a web page, a tracker task or a message that makes ARIA remember, forget,
  schedule or send something the person never asked for;
- **secret handling**: a token or key stored or written anywhere in plain text, or shown in a card, a log or the chat.

How these are meant to work is written in [`PLAN.md`](PLAN.md) §4.8 and in its decision log. A report of a gap between that text and
what ARIA does is as welcome as one of a gap in the text.

Not in scope: a flaw in Electron, the Copilot SDK, Copilot CLI, Git or a dependency that ARIA only uses (report those to their
projects), and anything that needs the attacker to already control the PC or the signed-in user's account.

## Supported versions

Only the latest release is supported. A fix ships as a new release, not as a patch to an old one.

## What to expect

This is a personal project. The maintainers read reports and aim to answer, but promise no response time. When a fix is released,
the report is disclosed with it, and the reporter is named if they wish.
