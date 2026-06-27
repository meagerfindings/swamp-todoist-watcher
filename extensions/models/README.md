# @mgreten/todoist-watcher

A configurable, multi-machine Todoist task watcher and dispatcher for
[swamp](https://swamp.club). It scans the Todoist projects owned by the current
machine for tasks carrying trigger labels (`plan-it`, `build`, `quick`,
`approve-pr`, …), respects per-project schedule windows, deduplicates work
across poll cycles and machines via TTL claims, and applies rate-limit backoff.
The result is a structured **dispatch list** that a host bridge script consumes
to route work to an executor (an ADW pipeline, a CI job, a custom agent — that
part is yours). Helper methods manage claims, rate limits, label swaps, and bot
comments on the underlying Todoist tasks via the `td` CLI.

The model is environment-agnostic: the machine identity, the `td` binary path,
the timezone, and the entire project → config map (executor, working directory,
providers, schedule) are supplied via global arguments, so one published
extension can drive any fleet of machines and projects.

## Installation

```bash
swamp extension pull @mgreten/todoist-watcher
```

This extension shells out to the [`td`](https://github.com/sachaos/todoist) (or
compatible) Todoist CLI, which must be installed and authenticated on each
machine.

## Setup

Create one instance per machine. The `projects` map is keyed by Todoist project
name; only projects whose `executor` equals this instance's `machine` are polled
here (so every machine can carry the full map and self-select its own work):

```bash
swamp model create my-machine @mgreten/todoist-watcher \
  --global-arg machine=my-laptop \
  --global-arg timezone=America/Denver
```

Then edit the instance YAML to add the `projects` map:

```yaml
globalArguments:
  machine: my-laptop
  timezone: America/Denver
  projects:
    MyProject:
      executor: my-laptop
      workingDirectory: ~/git/my-project
      browserAlwaysRun: false
      providers:
        default: claude
      schedule:
        weekday: "06:00-23:00"
        weekend: "09:00-22:00"
```

## Usage

Poll for dispatchable tasks (dry run logs the list without claiming):

```bash
swamp model method run my-machine poll --input "dryRun:json=true" --json
swamp model method run my-machine poll --json
```

Manage claims, rate limits, labels, and comments:

```bash
swamp model method run my-machine release --input taskId=123 --json
swamp model method run my-machine clearRateLimit --input taskId=123 --json
swamp model method run my-machine swapLabels \
  --input taskId=123 --input "remove:json=[\"plan-it\"]" \
  --input "add:json=[\"in-progress\"]" --json
```

## Global Arguments

| Argument | Type | Default | Purpose |
|----------|------|---------|---------|
| `machine` | string | (required) | This machine's identity; claims tasks and filters `projects` |
| `tdPath` | string | `td` | Path to the Todoist CLI binary |
| `tdTimeoutMs` | number | `30000` | Wall-clock timeout per `td` call |
| `claimTtlSec` | number | `7200` | Auto-expire claims after this many seconds |
| `timezone` | string | `America/Denver` | IANA timezone for schedule windows |
| `projects` | map | (required) | Todoist project name → project config (below) |

### Project config

| Field | Type | Default | Purpose |
|-------|------|---------|---------|
| `executor` | string | (required) | Machine that owns this project |
| `workingDirectory` | string | (required) | Absolute repo path for dispatched work |
| `obsidianVault` | string | — | Optional artifact-store path passed through to dispatch |
| `browserAlwaysRun` | boolean | `false` | Pass-through dispatch flag |
| `providers.default` | string | `claude` | Default executor provider |
| `providers.plan` / `providers.fallback` | string | — | Optional per-phase providers |
| `schedule.weekday` / `weekend` / `daily` | string | — | `HH:MM-HH:MM[,…]` active windows (empty = always active) |

## Method: poll

Scan owned, in-window projects for trigger-labelled tasks and emit a dispatch
list. Auto-claims dispatched tasks unless `dryRun`.

| Argument | Type | Required | Purpose |
|----------|------|----------|---------|
| `dryRun` | boolean | no (default false) | Log the dispatch list without claiming |

## Method: claim / release

`claim` records a TTL claim on a task; `release` marks an existing claim
available again.

| Argument | Type | Required |
|----------|------|----------|
| `taskId` | string | yes |
| `action` | string | yes (`claim` only) |

## Method: recordRateLimit / clearRateLimit

`recordRateLimit` advances backoff (30m → 1h → 2h); `clearRateLimit` zeroes it
on success.

| Argument | Type | Required |
|----------|------|----------|
| `taskId` | string | yes |
| `provider` | string | yes (`recordRateLimit` only) |

## Method: swapLabels / comment

`swapLabels` atomically removes and adds labels on a task; `comment` posts a
bot-prefixed comment.

| Argument | Type | Required |
|----------|------|----------|
| `taskId` | string | yes |
| `remove` / `add` | string[] | no (`swapLabels`) |
| `content` | string | yes (`comment`) |

## How It Works

`poll` iterates the `projects` map, skips projects this machine doesn't own and
projects outside their schedule window, then lists tasks per trigger label via
`td`. It filters out already-claimed and rate-limited tasks, resolves a provider
(honoring a per-task override label), and builds a `pollResult` record (7-day
lifetime) containing the dispatch list. Dispatched tasks get a `claim` record
(default 2-hour TTL) so a concurrent or next-cycle poll — on any machine sharing
the datastore — won't re-dispatch them. Rate-limit state (`rateLimit` records)
gates retries with exponential backoff.

**Prerequisites:** an authenticated `td` CLI on each machine, and a host bridge
(launchd / systemd / cron) that calls `poll` on an interval and routes the
dispatch list to an executor.

## License

MIT — see LICENSE for details.
