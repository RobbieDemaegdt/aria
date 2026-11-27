# Task tracker configs

ARIA works with one task tracker at a time, if you use one: the place where your tasks live and where you register your time.
It needs no tracker to run. To use one, you give ARIA a **config**, a small JSON file that says how that tracker's MCP server
speaks: which tools list your tasks, where a task's fields are in what they return, what a task reference looks like, and how a
time log is written. This page is the format. [`PLAN.md`](../PLAN.md) §4.13 and §4.14 say what ARIA does with it.

## What a tracker config is

A config describes a tracker that already has an MCP server, set up in your Copilot CLI like any other. ARIA ships no tracker of
its own and no code for any one tracker: everything it knows about yours comes from the config. A config is data, not code. It
is checked key by key when it loads, nothing in it is ever run, and a config that is wrong in any way doesn't load at all.

What ARIA uses a config for:

- **My work.** The tasks the tracker lists for you, and a watcher that polls them every 10 minutes and tells you in the chat when
  a task is assigned to you, changes status or priority, or gets a new comment.
- **Task links.** A task reference (an ID, or a link to the task's page) in a branch name, a commit, a PR, a task brief or a meeting
  invite ties that work to the task. Cards and the Time view open a task on its page.
- **The Timekeeper.** At the end of the day it reads your open tasks and what is already registered, and prepares a draft of your
  timesheet, with each block mapped to a task.
- **The Time view.** Submit, Update and Delete of time logs go through the config's tools, after your click, with ARIA's exact-payload
  check: the call that runs is the call you approved.

A config can leave out the time logs and the project lookups; the parts of ARIA that need them are then left out too, and the
Time view keeps times and comments only. The tasks part is the one every config has.

## Setting one up

1. **The file.** A config is a file called `<id>.json` in ARIA's `trackers` folder, which is `trackers` inside ARIA's data folder
   (`%APPDATA%\ARIA\trackers`). The `id` key inside the file must be the same as the name: `acme.json` holds `"id": "acme"`. The id is 2
   to 32 lower-case letters, digits or `-`, starting with a letter, and not `none` or `default`. It stays on the tracker's data
   (task and time-log IDs are stored as `<id>:<task>:<date>`), so choose it once.
2. **Customize › Integrations.** The page starts with a **Task tracker** panel: **Import config…** checks a file and copies it into the
   trackers folder as `<id>.json` (it asks before replacing one), and **Open folder** opens the folder, where you can also put a file by hand.
   The panel lists every file it finds, with its label and a short hash, and for one that can't be used, why. Then, on the card of the
   tracker's MCP server, click **Use as task tracker**, pick the config, see which of its tools that server has, and click Use.
   **Stop using** takes the tracker away again.
3. **The chat.** `/tracker` lists the configs and the one in use. `/tracker <id>` switches to a config, `/tracker none` to no tracker, and
   `/tracker default` to the tracker of your task data (or none, if there is no data).
4. **Loading.** A config loads whole or not at all: at most 256 KB, valid JSON, the schema, and the cross-checks below. ARIA reads the folder
   at start, when you import, and when you refresh the page; when the file of the tracker in use changes, ARIA loads the new version and
   says so, or says why it kept the old one.
5. **Switching.** Another tracker's task and time-log data is kept, dormant, when you switch, unless you tell ARIA to clear it; it asks first.

Without a Copilot subscription you can still see a tracker at work: see [Trying a config without a model](#trying-a-config-without-a-model).

## A complete example

This is Acme Tracker, a made-up tracker with a made-up MCP server. Every key of the format that a real config would use is in it,
and the config is checked by the tests of this repository: the block below is the file `packages/core/test/fixtures/trackers/acme.json`
as it is.

```json config
{
  "schema": 1,
  "id": "acme",
  "label": "Acme Tracker",
  "info": {
    "urlTemplate": "https://acme.example/browse/{id}",
    "taskRefPlaceholder": "Issue key (e.g. ACME-123) or acme.example link",
    "serverHint": "Acme Cloud"
  },
  "servers": { "match": ["acme"], "fallback": "Acme" },
  "taskRef": {
    "id": "ACME-[1-9]\\d{0,6}",
    "prefixes": ["issue"],
    "bare": true,
    "urls": ["acme.example/browse/{id}"],
    "caseInsensitive": true,
    "normalize": "upper"
  },
  "ids": { "task": "[A-Z][A-Z0-9]{1,9}-[1-9]\\d{0,6}", "entity": "[A-Za-z0-9][A-Za-z0-9_-]{0,39}", "timeLog": "[1-9]\\d{0,11}" },
  "objectKeys": { "id": ["id", "key"], "text": ["name", "value"], "name": ["displayName", "name"] },
  "tools": {
    "testConnection": "get_current_user",
    "reserved": ["add_worklogs", "update_worklog", "delete_worklogs"],
    "confirm": ["delete_worklogs"]
  },
  "tasks": {
    "myTasks": ["list_my_issues"],
    "byId": { "tools": ["get_issues"], "args": { "keys": { "$list": "ids" } } },
    "lists": ["issues"],
    "fields": {
      "id": ["key"],
      "title": ["fields.summary"],
      "status": ["fields.status"],
      "priority": ["fields.priority"],
      "taskType": ["fields.issuetype"],
      "projectId": ["fields.project.key"],
      "projectName": ["fields.project.name"],
      "customerId": ["fields.account.id"],
      "customerName": ["fields.account.name"],
      "dueDate": ["fields.duedate"],
      "modifiedAt": ["fields.updated"]
    },
    "comments": { "list": ["fields.comments"], "text": ["body"], "by": ["author"], "id": ["id"] },
    "closedStatuses": ["done", "won't do"],
    "statusRank": ["in progress", "in review", "to do", "backlog"]
  },
  "timeLogs": {
    "byRange": { "tools": ["list_worklogs"], "args": { "from": "{from}", "to": "{until}" } },
    "lists": ["worklogs"],
    "emptyText": ["no worklogs"],
    "fields": {
      "id": ["id"], "taskId": ["issueKey"], "taskTitle": ["issueSummary"],
      "start": ["started"], "end": ["ended"], "comment": ["comment"]
    },
    "time": "offset",
    "create": {
      "tool": "add_worklogs",
      "args": { "worklogs": { "$each": "rows", "item": {
        "issueKey": "{taskId}", "started": "{start}", "ended": "{end}", "comment": "{comment}"
      } } },
      "result": {
        "perRow": { "list": ["created"], "index": "index", "id": ["id"], "error": "error" },
        "match": { "start": ["started"], "end": ["ended"], "task": ["issueKey"] }
      }
    },
    "update": {
      "tool": "update_worklog",
      "args": { "id": "{entryId}", "started": "{start}", "ended": "{end}", "comment": "{comment}",
                "issueKey": { "$if": "taskId", "value": "{taskId}" } }
    },
    "delete": { "tool": "delete_worklogs", "args": { "ids": { "$list": "ids" } } }
  },
  "timekeeper": {
    "steps": [
      "The user's open Acme issues ({prefix}list_my_issues) and any issue keys that need their details ({prefix}get_issues).",
      "Worklogs already registered for the target date ({prefix}list_worklogs)."
    ],
    "taskUpdatesName": "Acme issue updates"
  }
}
```

Reading it from the top: the tracker's MCP server has `acme` in its name; a task reference is `ACME-123`, an `issue` prefix may come before
it, and a link `acme.example/browse/ACME-123` is one too; a task is an object with its key at `key` and its title at `fields.summary`; the day's
time logs come from `list_worklogs` with the day and the next day; they are written with the zone's offset; three tools write, and only the
Time view may call them; and the Timekeeper is told which of the tracker's tools to read first.

## The reference

Every key a config may have, one row per key path, in the order of the schema (`packages/core/src/trackers/config/schema.ts`). A path
with `[]` is a key of each item of a list. **Every object is strict**: a key that isn't listed here is an error, so a typo shows. A key
"required" must be there; "none" means it may be left out and nothing takes its place; otherwise the default is given.

**Words used in the "Type" column:**

- *text* is a string; its own control characters become spaces and invisible format characters are dropped; the number is its longest length.
- *tool name* is 1 to 64 letters, digits, `_`, `.` or `-`.
- *key* is an object key: a letter, `_` or `$`, then up to 63 letters, digits, `_`, `$` or `-` (never `__proto__`, `constructor` or `prototype`).
- *path* is 1 to 5 keys joined by dots, such as `fields.status`, at most 200 characters; no array indexes, no wildcards.
- *paths* is a list of 1 to 20 paths. The engine tries them in order and takes the first that holds a value its field can read ("first valid").
- *ID pattern* is a restricted pattern for IDs; see [ID patterns](#id-patterns).
- *template* is a JSON value with placeholders and directives; see [Templates](#templates).

### Identity

| Key path | Type | Default | What it does |
| --- | --- | --- | --- |
| `schema` | the number `1` | required | The version of this format. `1` is the only one. |
| `id` | text | required | The tracker's id, and its file name without `.json`. 2 to 32 lower-case letters, digits or `-`, starting with a letter; not `none` or `default`. |
| `label` | text, 40 | required | The tracker's name, as the window and the Conductor say it ("Acme Tracker"). |
| `info` | object | required | How the window refers to the tracker. |
| `info.urlTemplate` | text, 300 | required | A task's page: `https://`, a host, and one `{id}` in the path or the query (never the host); no spaces. "Open task" links are made from it. |
| `info.taskRefPlaceholder` | text, 120 | `<label> task ID or link` | The hint in the boxes where you type a task. |
| `info.serverHint` | text, 60 | none | What setup hints call the tracker's MCP server ("Acme Cloud"); they say the label when it is left out. |

### Servers

| Key path | Type | Default | What it does |
| --- | --- | --- | --- |
| `servers` | object | `{}` | Which MCP servers of your setup are this tracker's. Choosing servers with **Use as task tracker** replaces `match` and `prefer`. |
| `servers.match` | up to 10 strings of 3 to 64 characters | `[]` | Parts of a server's name. A server whose name holds one (case does not matter) is the tracker's. |
| `servers.prefer` | up to 10 texts, 64 | `[]` | Exact server names, case-insensitive, the preferred first, for when more than one matches. |
| `servers.fallback` | text, 64 | none | The server name the Timekeeper's instructions use when no server has been chosen yet. |

### Task references

| Key path | Type | Default | What it does |
| --- | --- | --- | --- |
| `taskRef` | object | required | What a reference to a task looks like. |
| `taskRef.id` | ID pattern | required | An explicit reference: the whole input is an ID, or an ID after `#` or one of the `prefixes`, or one inside a link. It can't match whitespace or `/`. |
| `taskRef.idInText` | ID pattern | `taskRef.id` | The pattern for IDs found in free text and branch names, when it has to be looser or stricter than `id`. It can't match whitespace or `/` either. |
| `taskRef.prefixes` | up to 20 texts, 40 | `[]` | Words that may come before an explicit ID: `issue 12` is one when `issue` is a prefix. |
| `taskRef.keywords` | up to 20 texts, 40 | `[]` | Words that introduce an ID in free text (a commit message, a PR, a brief, an invite): `fixes ACME-12`. |
| `taskRef.bare` | boolean | `false` | Whether an ID counts in free text with no keyword before it. For IDs that say what they are, such as `ACME-12`; leave it off for plain numbers. |
| `taskRef.urls` | up to 5 URL patterns | `[]` | Task links: `host/path/{id}` with no scheme (both `http` and `https` are read), exactly one `{id}`, in the path. |
| `taskRef.caseInsensitive` | boolean | `false` | Whether the ID patterns ignore case. |
| `taskRef.normalize` | `"none"`, `"upper"` or `"lower"` | `"none"` | How a found ID is written before ARIA uses it. |
| `ids` | object | `{}` | What the IDs the tracker returns look like, when they differ from a reference. |
| `ids.task` | ID pattern | `taskRef.id` | A task's ID, as the tracker's tools return it. |
| `ids.entity` | ID pattern | `[^\s,]{1,64}` | A project's or a customer's ID. |
| `ids.timeLog` | ID pattern | `[^\s,]{1,64}` | A time log's ID. |
| `objectKeys` | object | `{}` | Which keys to read when a field's value is an object instead of a string. |
| `objectKeys.id` | up to 10 keys | `["id"]` | An object that holds an ID: the first of these it has. |
| `objectKeys.text` | up to 10 keys | `["value","name"]` | An object that holds text (a status, a priority): the first it has. |
| `objectKeys.name` | up to 10 keys | `["name"]` | An object that holds a name (a project, a customer, a person). |

### Tools

| Key path | Type | Default | What it does |
| --- | --- | --- | --- |
| `tools` | object | `{}` | How ARIA treats the tracker's tools. |
| `tools.testConnection` | tool name | none | A read tool ARIA calls, with no arguments, when you test the server: it checks the sign-in. It must be named like a read and not reserved. |
| `tools.reserved` | up to 20 tool names | `[]` | Write tools that only the Timesheet card and the Time view may call, after your click. It must hold the `create`, `update` and `delete` tools of `timeLogs`. |
| `tools.confirm` | up to 20 tool names | `[]` | Destructive tools that need `confirm: true` in the call, even before ARIA has seen their schema. ARIA never sets it by itself: your tick does. |
| `tools.rawCompanions` | an object of up to 20 tool name pairs | `{}` | A read tool that returns raw JSON, and the tool that returns the same as formatted text. Allowing the text one in a server's tools filter lets the JSON one through. |

### Tasks

| Key path | Type | Default | What it does |
| --- | --- | --- | --- |
| `tasks` | object | required | Reading your tasks. |
| `tasks.myTasks` | 1 to 4 tool names | required | The tools that list your open tasks, tried in order. Each must be named like a read. |
| `tasks.byId` | object | none | Looking tasks up by ID, for the ones a result only names. |
| `tasks.byId.tools` | 1 to 4 tool names | required | The tools to try, in order. |
| `tasks.byId.args` | template | required | Their arguments. Variable: `{ids}` (a list), which it must use. |
| `tasks.lists` | up to 10 keys | `[]` | Where a result holds its list of tasks: the first of these keys that is an array. A result that is itself an array, or one task, needs none. |
| `tasks.emptyText` | up to 10 texts, 80 | `[]` | Answers in plain text that mean "no tasks" (an empty list and nothing at all always do). |
| `tasks.fields` | object | required | Where a task's fields are in each task object. |
| `tasks.fields.id` | paths | required | The task's ID. It must fit `ids.task`. |
| `tasks.fields.title` | paths | required | Its title, up to 200 characters. |
| `tasks.fields.status` | paths | none | Its status (text, or an object with a `objectKeys.text` key), up to 80 characters. |
| `tasks.fields.priority` | paths | none | Its priority, up to 60. |
| `tasks.fields.taskType` | paths | none | Its kind (bug, story), up to 80. |
| `tasks.fields.projectId` | paths | none | Its project's ID; it must fit `ids.entity`. |
| `tasks.fields.projectName` | paths | none | Its project's name, up to 120. A path that is also a project ID path reads the object's name, and nothing for a bare ID. |
| `tasks.fields.customerId` | paths | none | Its customer's ID. |
| `tasks.fields.customerName` | paths | none | Its customer's name. |
| `tasks.fields.dueDate` | paths | none | Its due date. An ISO date is kept; the placeholder dates `0001-01-01`, `1900-01-01` and `1970-01-01` are dropped. |
| `tasks.fields.modifiedAt` | paths | none | When it last changed: a time string in the day's zone, or epoch milliseconds. |
| `tasks.comments` | object | none | Where a task's latest comment is, for the watcher's "new comment" cards. |
| `tasks.comments.list` | paths | none | An array of comments; the last is the latest. |
| `tasks.comments.latest` | paths | none | The latest comment itself, a string or an object (used when `list` finds nothing). |
| `tasks.comments.single` | paths | none | A single comment, a string or an object (used when `list` and `latest` find nothing). |
| `tasks.comments.text` | paths | required | In a comment object: its text. |
| `tasks.comments.by` | paths | none | In a comment object: its author. |
| `tasks.comments.id` | paths | none | In a comment object: its ID, which makes a changed comment recognizable. |
| `tasks.comments.taskBy` | paths | none | On the task, for a comment that is a string: its author. |
| `tasks.comments.taskVersion` | paths | none | On the task, for a comment that is a string: a version that changes with it. |
| `tasks.comments.latestFallback` | object | none | Task-level paths for the author and ID of a `latest` comment that is an object without them. |
| `tasks.comments.latestFallback.by` | paths | none | The author. |
| `tasks.comments.latestFallback.id` | paths | none | The ID. |
| `tasks.comments.singleFallback` | object | none | The same, for a `single` comment. |
| `tasks.comments.singleFallback.by` | paths | none | The author. |
| `tasks.comments.singleFallback.id` | paths | none | The ID. |
| `tasks.closedStatuses` | up to 20 texts, 40 | `[]` | Statuses that mean a task is closed. A status matches when it starts with one of these at a word edge, case-insensitive. |
| `tasks.statusRank` | up to 30 texts, 40 | `[]` | Statuses in the order they should sort, the first first; any other status comes after them. |

### Time logs

Leave `timeLogs` out when the tracker has no time logs. When it is there, all of `byRange`, `fields`, `create`, `update` and `delete` are.

| Key path | Type | Default | What it does |
| --- | --- | --- | --- |
| `timeLogs` | object | none | The tracker's time logs. |
| `timeLogs.byRange` | object | required | Reading the time logs of a day, so ARIA can check for duplicates and show what is registered. |
| `timeLogs.byRange.tools` | 1 to 4 tool names | required | The tools to try, in order. Each must be named like a read, and be read first by a `timeLogs` route with `mode` `dateRange`. |
| `timeLogs.byRange.args` | template | required | Their arguments. Variables: `{from}`, which it must use (the day, `YYYY-MM-DD`), and `{until}` (the next day, `YYYY-MM-DD`). |
| `timeLogs.lists` | up to 10 keys | `[]` | Where a result holds its list of time logs. Without a list key, an object is unreadable. |
| `timeLogs.emptyText` | up to 10 texts, 80 | `[]` | Plain-text answers that mean "no time logs". |
| `timeLogs.fields` | object | required | Where a time log's fields are. |
| `timeLogs.fields.id` | paths | required | Its ID. It must fit `ids.timeLog`. |
| `timeLogs.fields.taskId` | paths | required | The task it is on. It must fit `ids.task`. |
| `timeLogs.fields.start` | paths | required | When it starts: a time string in the day's zone, or epoch milliseconds. |
| `timeLogs.fields.end` | paths | required | When it ends. |
| `timeLogs.fields.taskTitle` | paths | none | The task's title, when the log carries it. |
| `timeLogs.fields.projectId` | paths | none | The project's ID. |
| `timeLogs.fields.customerId` | paths | none | The customer's ID. |
| `timeLogs.fields.comment` | paths | none | Its comment; an empty one is kept as empty. |
| `timeLogs.time` | `"local"`, `"offset"` or `"utc"` | `"local"` | How `{start}` and `{end}` are written in a call: `2026-07-08T09:00:00` (local wall time), `2026-07-08T09:00:00+02:00` (with the zone's offset at that moment) or `2026-07-08T07:00:00Z` (UTC). An end of `24:00` is written as the last second of the day. |
| `timeLogs.requiresProjectCustomer` | boolean | `false` | Whether the tracker needs a project and a customer on every time log. ARIA then won't submit a row without both, and `create.args` must use `{projectId}` and `{customerId}`. |
| `timeLogs.create` | object | required | Registering the rows of a timesheet. |
| `timeLogs.create.tool` | tool name | required | The tool. It must be in `tools.reserved`. |
| `timeLogs.create.args` | template | required | Its arguments. Variable: `{rows}`, a list that it must use with `$each`. |
| `timeLogs.create.result` | object | required | How to read the answer. At least one of `perRow`, `created` and `textIds`, or ARIA could never tell what was registered. |
| `timeLogs.create.result.perRow` | object | none | An answer that holds one object per row. |
| `timeLogs.create.result.perRow.list` | paths | required | Where the list of those objects is. |
| `timeLogs.create.result.perRow.index` | key | none | In each object: the number of the row it answers (from 0). |
| `timeLogs.create.result.perRow.id` | paths | required | In each object: the ID of the time log created. |
| `timeLogs.create.result.perRow.error` | key | `"error"` | In each object: the text that says it failed. |
| `timeLogs.create.result.perRow.ok` | key | none | In each object: a boolean, `false` when it failed. |
| `timeLogs.create.result.match` | object | none | How to find the row an object answers when there is no usable `index`: by its start, end and task. |
| `timeLogs.create.result.match.start` | paths | required | In each object: the start, as the call wrote it. |
| `timeLogs.create.result.match.end` | paths | required | The end. |
| `timeLogs.create.result.match.task` | paths | required | The task. |
| `timeLogs.create.result.created` | object | none | An answer that is a list of what was created, without per-row results. |
| `timeLogs.create.result.created.lists` | 1 to 5 keys | required | Where the list is, when the answer is an object. With every row matched, or as many entries as rows, all with IDs and no error, the rows count as registered. |
| `timeLogs.create.result.textIds` | object | none | An answer in plain text that says the IDs. |
| `timeLogs.create.result.textIds.label` | text, 20 | required | The word before each ID: `id: 123` or `id=123`. |
| `timeLogs.create.result.textIds.id` | ID pattern | required | What the ID looks like. |
| `timeLogs.update` | object | required | Changing a registered entry in place. |
| `timeLogs.update.tool` | tool name | required | The tool. It must be in `tools.reserved`. |
| `timeLogs.update.args` | template | required | Its arguments. Variables: `{entryId}` (required), `{date}`, `{start}`, `{end}`, `{minutes}`, `{comment}` (may be empty), `{taskId}`, `{projectId}`, `{customerId}`. |
| `timeLogs.delete` | object | required | Deleting registered entries. |
| `timeLogs.delete.tool` | tool name | required | The tool. It must be in `tools.reserved`. |
| `timeLogs.delete.args` | template | required | Its arguments. Variable: `{ids}` (a list), which it must use. Only after a confirm card that lists the exact IDs. |

### Projects

| Key path | Type | Default | What it does |
| --- | --- | --- | --- |
| `projects` | object | none | Looking up projects and their customers, to fill in the IDs a time log needs. |
| `projects.search` | object | none | A search by name. |
| `projects.search.tool` | tool name | required | The tool. It must be named like a read, and be read first by a `projects` route. |
| `projects.search.args` | template | required | Its arguments. Variable: `{query}`, which it must use. |
| `projects.lists` | up to 10 keys | `[]` | Where a result holds its list of projects. |
| `projects.fields` | object | required | Where a project's fields are. |
| `projects.fields.id` | paths | required | Its ID. It must fit `ids.entity`. |
| `projects.fields.name` | paths | required | Its name. |
| `projects.fields.customerId` | paths | none | Its customer's ID. |
| `projects.fields.customerName` | paths | none | Its customer's name. |
| `knownIds` | object | none | IDs the tracker never gives by name. |
| `knownIds.customers` | an object of up to 50 names, each with an ID | none | A last resort: a customer's name and its ID, for a customer the tracker names on a task and never resolves to an ID. Each ID must fit `ids.entity`. |

### The Timekeeper and the words

| Key path | Type | Default | What it does |
| --- | --- | --- | --- |
| `timekeeper` | object | `{}` | How the Timekeeper reads the tracker. |
| `timekeeper.routes` | up to 20 objects | `[]` | Which reader gets a tool's result, by the tool's name without the server's prefix. These come first; ARIA adds an exact-name route for each tool the config names (`tasks.myTasks` and `tasks.byId.tools` for tasks, `timeLogs.byRange.tools` for time logs in date-range mode, `projects.search.tool` for projects). The first route a read tool reaches has to be the one for what it reads. |
| `timekeeper.routes[].handler` | `"tasks"`, `"timeLogs"` or `"projects"` | required | Who reads the result. |
| `timekeeper.routes[].mode` | `"history"` or `"dateRange"` | none | `history` goes with `tasks`: the result is a task's history, read for its activity and not cached as tasks. `dateRange` goes with `timeLogs`: the result is the day's registered entries and replaces them. |
| `timekeeper.routes[].anyOf` | 1 to 20 texts, 64 | none | Parts of the tool's name, any of which matches. A route has either `anyOf` or `equals`. |
| `timekeeper.routes[].equals` | 1 to 20 tool names | none | Exact tool names (case-insensitive). |
| `timekeeper.routes[].allOf` | up to 20 texts, 64 | `[]` | Parts that must all be in the name too. |
| `timekeeper.routes[].noneOf` | up to 20 texts, 64 | `[]` | Parts that must not be. |
| `timekeeper.steps` | up to 6 text templates, 600 | `[]` | The tracker's steps in the Timekeeper's instructions, before the Work IQ ones. Variable: `{prefix}`, the server's tool-name prefix (`Acme-`). |
| `timekeeper.dateRangeHint` | text template, 300 | none | A sentence added to the Timekeeper's prompt for a day: how to ask the tracker for that day's registered time logs. Variables: `{date}`, `{nextDay}`. |
| `timekeeper.resolveIdsHint` | text template, 300 | none | A sentence added to the Timekeeper's prompt when the day's activity names tasks ARIA hasn't read yet: how to look them up. Variables: `{prefix}`, `{ids}` (the IDs, comma-separated). |
| `timekeeper.commentHint` | text template, 200 | none | A sentence added to the chat's digest line for a new comment: where to read it. Variable: `{prefix}`. |
| `timekeeper.taskUpdatesName` | text, 60 | `<label> task updates` | What the Timekeeper's instructions call the tracker's task changes among the work they consolidate. |
| `messages` | object | `{}` | The words ARIA uses when you type a bad task reference. |
| `messages.invalidTaskRef` | text template, 300 | `"<input>" isn't a valid <label> task ID or link.` | Said when a reference isn't one. Variable: `{input}`. |
| `messages.invalidRuleTaskRef` | text template, 300 | the same | Said when a mapping rule names one that isn't. Variable: `{input}`. |

### ID patterns

An ID pattern is the one place a config holds something like a regular expression, and it is a small, checked grammar, never compiled as it is
written. It is made of:

- **atoms:** a letter, a digit, `_` or `-`; `\.`, `\-`, `\/`, `\#`, `\:`; `\d`, `\w`, `\s`; and classes `[...]` or `[^...]` of letters, digits, ranges
  of one kind (`a-z`, `A-Z`, `0-9`), those escapes, `\[`, `\]`, `\\` and other ASCII punctuation (`-` only first or last in a class);
- **repeats:** `?`, `{m}` or `{m,n}`, one per atom; no `*`, `+` or `{m,}`.

There are no groups, alternatives, anchors, `.`, backreferences or lookaround. The limits are in the table of [limits](#limits). A pattern for IDs found in
text (`taskRef.id`, `taskRef.idInText`) also can't match whitespace or `/`, so an ID is always one word. Examples: `ACME-[1-9]\d{0,6}` (`ACME-1` to `ACME-9999999`),
`[A-Za-z0-9][A-Za-z0-9_-]{0,39}`, `[1-9]\d{0,11}`. In JSON, a backslash is written twice: `"ACME-[1-9]\\d{0,6}"`.

### Limits

| Limit | Value |
| --- | --- |
| The config file | 256 KB |
| A template's depth | 8 levels |
| A template's size | 200 values |
| An ID pattern's length | 100 characters |
| The longest ID a pattern may match | 64 characters |
| The ways a pattern can match (the product of its repeats' ranges) | 256 |
| Keys in a path | 5 |
| A path's length | 200 characters |
| Lines in an error message | 10 |
| A line of an error message | 200 characters |

## Templates

The arguments of a tool call, and the words of a hint, are templates: JSON values that ARIA fills in for each call. A string holds placeholders, `{name}`;
write `{{` and `}}` for a literal brace. A value goes in as it is, by concatenation, so `$&` or `{x}` inside a value stays as it is and is never
expanded again. An object with a key that starts with `$` is a **directive**:

| Directive | Gives |
| --- | --- |
| `{ "$json": T }` | `JSON.stringify` of `T`, filled in: a tool that takes its argument as one JSON string. |
| `{ "$each": "rows", "item": T }` | An array: `T` filled in once for each item of the list `rows`, with that item's variables. |
| `{ "$join": "ids", "with": "," }` | The list joined into one string; `with` defaults to a comma and is at most 10 characters. |
| `{ "$list": "ids" }` | The list as an array of strings. |
| `{ "$if": "taskId", "value": T }` | As the value of an object's key: the key is left out when the variable is empty. |
| `{ "$literal": V }` | `V` as it is, with no placeholders and no directives: for a real key that starts with `$`. |

**Which variables each template may use** (a variable a template doesn't know is an error, and so is a "required" one that it leaves out):

| Template | Variables |
| --- | --- |
| `tasks.byId.args` | `{ids}` (required, a list) |
| `timeLogs.byRange.args` | `{from}` (required), `{until}` |
| `timeLogs.create.args` | `{rows}` (required, a list); in each row: `{taskId}` (required), `{projectId}`, `{customerId}`, `{date}`, `{start}`, `{end}`, `{minutes}`, `{comment}` (may be empty) |
| `timeLogs.update.args` | `{entryId}` (required), `{date}`, `{start}`, `{end}`, `{minutes}`, `{comment}` (may be empty), `{taskId}`, `{projectId}`, `{customerId}` |
| `timeLogs.delete.args` | `{ids}` (required, a list) |
| `projects.search.args` | `{query}` (required) |
| `timekeeper.steps` | `{prefix}` |
| `timekeeper.dateRangeHint` | `{date}`, `{nextDay}` |
| `timekeeper.resolveIdsHint` | `{prefix}`, `{ids}` |
| `timekeeper.commentHint` | `{prefix}` |
| `messages.invalidTaskRef` | `{input}` |
| `messages.invalidRuleTaskRef` | `{input}` |

`{start}` and `{end}` are written as `timeLogs.time` says; `{minutes}` is a number written as text; `{comment}` is trimmed. A value that is empty
when a template needs it (a row with no task ID, say) stops the call before anything is sent, except a comment, which goes as an empty string.
A template can't have integer-like keys (`JSON.parse` would move them to the front, and the order of the arguments is the order you wrote), nor
`__proto__`, `constructor` or `prototype`, nor an unknown directive; its strings are at most 2,000 characters.

## What the loader refuses

A config that breaks any of these doesn't load, and ARIA shows why. The page and the chat show at most 10 lines of at most 200 characters, each as
`path: message`; if there are more, the last says how many. A control character in a message is shown as a space, and an invisible one as `�`, so
what the file holds can't hide.

- **The file.** A name that isn't `<id>.json` with a valid id; a file larger than 256 KB; text that isn't JSON; an `id` that differs from the file name.
- **Unknown keys, wrong types and limits.** Everything in the reference above: a key that isn't there (`unknown key "tasks.field"`), a value of the wrong kind,
  a list that is too long or too short, a text that is empty or too long, a tool name with a character it can't have, a path that isn't one.
- **Bad patterns.** An ID pattern outside the grammar, or one that can match more than 64 characters or in too many ways, or an empty ID; a
  reference pattern that can match whitespace or `/`; a URL pattern with a scheme or without exactly one `{id}`; an `info.urlTemplate` that isn't
  `https://`, has a user name or password, or holds a brace that isn't `{id}`.
- **Bad templates.** An unknown directive or placeholder, a missing required variable, a bad brace, too many levels or values.
- **A read that isn't a read.** Any tool ARIA calls without asking (`tasks.myTasks`, `tasks.byId.tools`, `timeLogs.byRange.tools`, `projects.search.tool`,
  the tools of `tools.rawCompanions`, `tools.testConnection`) must be named like a read tool (see [`PLAN.md`](../PLAN.md) §4.13, "Tool classes from the name")
  and must not be in `tools.reserved`.
- **A write that isn't reserved.** The `create`, `update` and `delete` tools of `timeLogs` must be in `tools.reserved`, so only the Time view calls them.
- **Routes that read the wrong way.** A route that has both or neither of `anyOf` and `equals`; `history` on a handler that isn't `tasks`, or `dateRange` on one that
  isn't `timeLogs`; a task read, a date-range read or a project search that another route reaches first.
- **A time log without its parts.** `requiresProjectCustomer` with a create template that leaves out `{projectId}` or `{customerId}`; a create `result` with none of `perRow`,
  `created` and `textIds`; a `knownIds.customers` ID that doesn't fit `ids.entity`.
- **A pattern that can't be built.** The regular expressions ARIA builds around your patterns (the reference, the keywords, the links) must compile.

## A second example

Globex Desk is another made-up tracker, with other names, other shapes and times in UTC, to show that the same format reads a different
payload. It is the file `packages/core/test/fixtures/trackers/globex.json` as it is.

```json config
{
  "schema": 1,
  "id": "globex",
  "label": "Globex Desk",
  "info": {
    "urlTemplate": "https://globex.example/tickets/{id}",
    "taskRefPlaceholder": "Ticket (e.g. GLX-42) or globex.example link",
    "serverHint": "Globex Cloud"
  },
  "servers": { "match": ["globex"], "fallback": "Globex" },
  "taskRef": {
    "id": "GLX-[1-9]\\d{0,6}",
    "prefixes": ["ticket"],
    "bare": true,
    "urls": ["globex.example/tickets/{id}"],
    "caseInsensitive": true,
    "normalize": "upper"
  },
  "ids": { "task": "GLX-[1-9]\\d{0,6}", "entity": "[A-Za-z0-9][A-Za-z0-9_-]{0,39}", "timeLog": "[1-9]\\d{0,11}" },
  "objectKeys": { "id": ["id", "ref"], "text": ["name", "label"], "name": ["fullName", "name"] },
  "tools": {
    "testConnection": "get_profile",
    "reserved": ["log_hours", "change_hours", "remove_hours"],
    "confirm": ["remove_hours"]
  },
  "tasks": {
    "myTasks": ["fetch_my_tickets"],
    "byId": { "tools": ["fetch_tickets"], "args": { "refs": { "$list": "ids" } } },
    "lists": ["tickets"],
    "fields": {
      "id": ["ref"],
      "title": ["subject"],
      "status": ["state"],
      "priority": ["urgency"],
      "taskType": ["kind"],
      "projectId": ["board.code"],
      "projectName": ["board.title"],
      "customerId": ["client.id"],
      "customerName": ["client.name"],
      "dueDate": ["due"],
      "modifiedAt": ["changed"]
    },
    "comments": { "list": ["notes"], "text": ["text"], "by": ["by"], "id": ["id"] },
    "closedStatuses": ["resolved", "dropped"],
    "statusRank": ["active", "waiting", "new"]
  },
  "timeLogs": {
    "byRange": { "tools": ["fetch_hours"], "args": { "from": "{from}", "to": "{until}" } },
    "lists": ["hours"],
    "emptyText": ["no hours"],
    "fields": {
      "id": ["id"], "taskId": ["ticket"], "taskTitle": ["ticketSubject"],
      "start": ["from"], "end": ["to"], "comment": ["note"]
    },
    "time": "utc",
    "create": {
      "tool": "log_hours",
      "args": { "hours": { "$each": "rows", "item": {
        "ticket": "{taskId}", "from": "{start}", "to": "{end}", "note": "{comment}"
      } } },
      "result": {
        "perRow": { "list": ["logged"], "index": "index", "id": ["id"], "error": "error" },
        "match": { "start": ["from"], "end": ["to"], "task": ["ticket"] }
      }
    },
    "update": {
      "tool": "change_hours",
      "args": { "id": "{entryId}", "from": "{start}", "to": "{end}", "note": "{comment}",
                "ticket": { "$if": "taskId", "value": "{taskId}" } }
    },
    "delete": { "tool": "remove_hours", "args": { "ids": { "$list": "ids" } } }
  },
  "timekeeper": {
    "steps": [
      "The user's open Globex tickets ({prefix}fetch_my_tickets) and any ticket refs that need their details ({prefix}fetch_tickets).",
      "Hours already logged for the target date ({prefix}fetch_hours)."
    ],
    "taskUpdatesName": "Globex ticket updates"
  }
}
```

## Trying a config without a model

The app has a scripted runtime for demos and UI work: it replaces the model and the Copilot runtime, uses no credits, and exists only in a build that is run from source
(`npm run dev`), never in an installed one. Two ways to try a config in it, with the data folder pointed at an empty folder so your own data is not touched:

- **Choose it by id.** Put your config in `<data folder>\trackers\<id>.json` and start with `ARIA_FAKE_RUNTIME=ui-cards`, `ARIA_DATA_DIR=<the data folder>` and
  `ARIA_FAKE_TRACKER=<id>`. The scenario has a made-up server called `Acme`, with the tools of the Acme example above, so Acme's config works as it is.
- **Choose it in the window.** Start with `ARIA_FAKE_RUNTIME=ui-tracker` and `ARIA_DATA_DIR=<an empty folder>`. The scenario has no tracker yet and a server called
  `Acme Cloud` with the tools of the Acme example. In Customize › Integrations, **Import config…** the Acme file and click **Use as task tracker** on that server.

The README has the exact commands. A config for your own tracker is tried against the real server: import it, click **Use as task tracker** on the server's card, which shows
which of the config's tools that server has, and then **Test** on the card.
