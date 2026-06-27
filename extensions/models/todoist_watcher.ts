/**
 * Multi-machine Todoist task watcher / dispatcher for swamp.
 *
 * Scans Todoist projects owned by the current machine for tasks carrying
 * trigger labels (plan-it, build, quick, …), respects per-project schedule
 * windows, deduplicates work across poll cycles and machines via TTL claims,
 * and applies rate-limit backoff. The result is a structured dispatch list that
 * a host bridge script consumes to route work to an executor (e.g. an ADW
 * pipeline). Helper methods manage claims, rate limits, label swaps, and bot
 * comments on the underlying Todoist tasks via the `td` CLI.
 *
 * The model is environment-agnostic: the machine identity, the `td` binary
 * path, the timezone, and the entire project→config map (executor, working
 * directory, providers, schedule) are supplied via global arguments, so the
 * same published extension can drive any fleet of machines and projects.
 *
 * @module
 */

import { z } from "npm:zod@4";

/** Per-project configuration within the {@link GlobalArgsSchema} `projects` map. */
const ProjectConfigSchema = z.object({
  executor: z.string().describe("Machine identity that owns this project"),
  workingDirectory: z.string().describe("Absolute path to the project repo"),
  obsidianVault: z.string().optional().describe(
    "Path to Obsidian vault for artifact storage",
  ),
  browserAlwaysRun: z.boolean().default(false),
  providers: z.object({
    default: z.string().default("claude"),
    plan: z.string().optional(),
    fallback: z.string().optional(),
  }).default({ default: "claude" }),
  schedule: z.object({
    weekday: z.string().optional().describe("HH:MM-HH:MM window for weekdays"),
    weekend: z.string().optional().describe("HH:MM-HH:MM window for weekends"),
    daily: z.string().optional().describe(
      "HH:MM-HH:MM,HH:MM-HH:MM windows for all days",
    ),
  }).default({}),
});

/** Global configuration shared across all method invocations. */
const GlobalArgsSchema = z.object({
  machine: z.string().describe(
    "This machine's identity (used to claim tasks and filter projects)",
  ),
  tdPath: z.string().default("td"),
  tdTimeoutMs: z.number().default(30_000),
  claimTtlSec: z.number().default(7200).describe(
    "Auto-expire claims after this many seconds",
  ),
  timezone: z.string().default("America/Denver").describe(
    "IANA timezone for schedule window evaluation",
  ),
  projects: z.record(z.string(), ProjectConfigSchema).describe(
    "Todoist project name → config",
  ),
});

/**
 * Todoist label → canonical action name. A task carrying one of these labels is
 * dispatched with the mapped action. Several spellings map to the same action
 * (e.g. "plan-it"/"plan it"/"planet" → plan) to tolerate human entry.
 */
const TRIGGER_LABELS: Record<string, string> = {
  "plan-it": "plan",
  "plan it": "plan",
  "planet": "plan",
  "plan-approved": "convert",
  "replan": "replan",
  "reconvert": "reconvert",
  "build": "build",
  "quick": "quick",
  "troubleshoot": "troubleshoot",
  "adw-fix": "adwFix",
  "rate-limited": "retryRateLimited",
  "approve-pr": "approvePr",
};

/** Todoist label → provider override. Lets a task force a specific executor. */
const PROVIDER_LABELS: Record<string, string> = {
  claude: "claude",
  anthropic: "claude",
  opencode: "opencode",
  ollama: "opencode",
  local: "opencode",
  gemini: "gemini",
};

/** One dispatchable unit of work produced by a poll cycle. */
const DispatchItemSchema = z.object({
  taskId: z.string(),
  taskContent: z.string(),
  action: z.string(),
  projectName: z.string(),
  workingDirectory: z.string(),
  obsidianVault: z.string().optional(),
  provider: z.string(),
  providerOverride: z.string().optional(),
  browserAlwaysRun: z.boolean(),
});

/** Structured summary of a single poll cycle. */
const PollResultSchema = z.object({
  machine: z.string(),
  polledAt: z.string(),
  projectsScanned: z.number(),
  tasksFound: z.number(),
  dispatched: z.number(),
  skippedClaimed: z.number(),
  skippedRateLimited: z.number(),
  dispatchList: z.array(DispatchItemSchema),
});

/** A TTL claim that prevents duplicate dispatch of a task across cycles/machines. */
const ClaimSchema = z.object({
  taskId: z.string(),
  action: z.string(),
  machine: z.string(),
  claimedAt: z.string(),
  expiresAt: z.string(),
  released: z.boolean().default(false),
  releasedAt: z.string().optional(),
});

/** Rate-limit backoff state for a task/provider pair. */
const RateLimitSchema = z.object({
  taskId: z.string(),
  provider: z.string(),
  attempts: z.number(),
  lastHitAt: z.string(),
  backoffUntil: z.string(),
});

/** Result of a shelled `td` invocation. */
type TdResult = { stdout: string; success: boolean };

/**
 * Run a `td` (Todoist CLI) command with a wall-clock timeout guard. Throws if
 * the call ran past `timeoutMs`.
 */
async function runTd(
  tdPath: string,
  args: string[],
  timeoutMs: number,
): Promise<TdResult> {
  const cmd = new Deno.Command(tdPath, {
    args: [...args, "--no-spinner"],
    stdout: "piped",
    stderr: "piped",
  });

  const start = performance.now();
  const output = await cmd.output();

  const elapsed = performance.now() - start;
  if (elapsed >= timeoutMs) {
    throw new Error(`td timed out after ${Math.round(elapsed)}ms`);
  }

  return {
    stdout: new TextDecoder().decode(output.stdout),
    success: output.success,
  };
}

/** List Todoist tasks in a project carrying a label. Returns [] on failure. */
async function tdListTasks(
  tdPath: string,
  timeoutMs: number,
  project: string,
  label: string,
): Promise<Array<Record<string, unknown>>> {
  try {
    const result = await runTd(tdPath, [
      "task",
      "list",
      "--json",
      "--project",
      project,
      "--label",
      label,
    ], timeoutMs);
    if (!result.success) return [];
    const parsed = JSON.parse(result.stdout);
    return Array.isArray(parsed) ? parsed : (parsed?.results ?? []);
  } catch {
    return [];
  }
}

/** Fetch a single Todoist task with full detail. Throws on failure. */
async function tdViewTask(
  tdPath: string,
  timeoutMs: number,
  taskId: string,
): Promise<Record<string, unknown>> {
  const result = await runTd(tdPath, [
    "task",
    "view",
    taskId,
    "--json",
    "--full",
  ], timeoutMs);
  if (!result.success) throw new Error(`td task view failed for ${taskId}`);
  return JSON.parse(result.stdout);
}

/** Replace the full label set on a Todoist task. Throws on failure. */
async function tdUpdateLabels(
  tdPath: string,
  timeoutMs: number,
  taskId: string,
  labels: string[],
): Promise<void> {
  const result = await runTd(tdPath, [
    "task",
    "update",
    taskId,
    "--labels",
    labels.join(","),
  ], timeoutMs);
  if (!result.success) throw new Error(`td label update failed for ${taskId}`);
}

/** Post a bot-prefixed comment on a Todoist task via `td comment add --stdin`. */
async function tdAddComment(
  tdPath: string,
  _timeoutMs: number,
  taskId: string,
  content: string,
): Promise<void> {
  const cmd = new Deno.Command(tdPath, {
    args: ["comment", "add", taskId, "--stdin", "--no-spinner"],
    stdout: "piped",
    stderr: "piped",
    stdin: "piped",
  });
  const child = cmd.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(`\u{1F916} ${content}`));
  await writer.close();
  await child.output();
}

/** Local wall-clock components for a moment in a given IANA timezone. */
export function getLocalTime(
  now: Date,
  timezone: string,
): { hours: number; minutes: number; dayOfWeek: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const hours = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const minutes = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  const weekdayStr = parts.find((p) => p.type === "weekday")?.value ?? "";
  const dayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return { hours, minutes, dayOfWeek: dayMap[weekdayStr] ?? 0 };
}

/**
 * Whether `now` falls inside a project's active schedule window. A project with
 * no configured windows is always active. Weekend windows take precedence on
 * Sat/Sun, falling back to the `daily` window; weekdays use `weekday` then
 * `daily`. Each window string may list comma-separated `HH:MM-HH:MM` ranges.
 */
export function inPeakWindow(
  now: Date,
  schedule: z.infer<typeof ProjectConfigSchema>["schedule"],
  timezone: string,
): boolean {
  if (!schedule.weekday && !schedule.weekend && !schedule.daily) return true;

  const local = getLocalTime(now, timezone);
  const isWeekend = local.dayOfWeek === 0 || local.dayOfWeek === 6;
  const windowStr = isWeekend
    ? (schedule.weekend ?? schedule.daily)
    : (schedule.weekday ?? schedule.daily);

  if (!windowStr) return true;

  const currentMinutes = local.hours * 60 + local.minutes;
  return windowStr.split(",").some((window) => {
    const [startStr, endStr] = window.trim().split("-");
    const [sh, sm] = startStr.split(":").map(Number);
    const [eh, em] = endStr.split(":").map(Number);
    return currentMinutes >= sh * 60 + (sm || 0) &&
      currentMinutes < eh * 60 + (em || 0);
  });
}

/** First provider-override label found on a task, or undefined. */
export function detectProviderOverride(
  taskLabels: string[],
): string | undefined {
  for (const label of taskLabels) {
    const override = PROVIDER_LABELS[label.toLowerCase()];
    if (override) return override;
  }
  return undefined;
}

/** Runtime context handed to every method's `execute`. */
type MethodContext = {
  globalArgs: z.infer<typeof GlobalArgsSchema>;
  definition: { id: string; name: string };
  modelType: string;
  modelId: string;
  logger: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warning: (msg: string, props?: Record<string, unknown>) => void;
    error: (msg: string, props?: Record<string, unknown>) => void;
  };
  writeResource: (
    specName: string,
    instanceName: string,
    data: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  readResource?: (
    instanceName: string,
    version?: number,
  ) => Promise<Record<string, unknown> | null>;
  dataRepository: {
    findAllForModel: (type: string, modelId: string) => Promise<
      Array<{
        name: string;
        tags?: Record<string, string>;
        content?: Uint8Array;
      }>
    >;
    getContent: (
      type: string,
      modelId: string,
      dataName: string,
    ) => Promise<Uint8Array | null>;
  };
};

/**
 * The todoist-watcher model: a configurable, multi-machine Todoist task
 * dispatcher. See the module doc for the full lifecycle.
 */
export const model = {
  type: "@mgreten/todoist-watcher",
  version: "2026.06.27.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    pollResult: {
      description:
        "Structured output of a poll cycle — projects scanned, tasks found, dispatch list",
      schema: PollResultSchema,
      lifetime: "7d" as const,
      garbageCollection: 50,
    },
    claim: {
      description:
        "Task claim record for dedup across poll cycles and machines",
      schema: ClaimSchema,
      lifetime: "1d" as const,
      garbageCollection: 20,
    },
    rateLimit: {
      description: "Rate limit backoff state for a task/provider",
      schema: RateLimitSchema,
      lifetime: "1d" as const,
      garbageCollection: 20,
    },
  },
  methods: {
    poll: {
      description:
        "Scan all projects owned by this machine for tasks with trigger labels. " +
        "Produces a structured dispatch list. Respects schedule windows, claim dedup, and rate limit backoff.",
      arguments: z.object({
        dryRun: z.boolean().default(false).describe(
          "Log dispatch list without claiming tasks",
        ),
      }),
      execute: async (
        args: { dryRun: boolean },
        context: MethodContext,
      ) => {
        const {
          machine,
          tdPath,
          tdTimeoutMs,
          claimTtlSec,
          timezone,
          projects,
        } = context.globalArgs;
        const now = new Date();
        const dispatchList: z.infer<typeof DispatchItemSchema>[] = [];
        let tasksFound = 0;
        let skippedClaimed = 0;
        let skippedRateLimited = 0;
        let projectsScanned = 0;

        const activeClaims = await loadActiveClaims(context, claimTtlSec);
        const activeRateLimits = await loadActiveRateLimits(context);

        for (const [projectName, config] of Object.entries(projects)) {
          if (config.executor !== machine) continue;

          if (!inPeakWindow(now, config.schedule, timezone)) {
            context.logger.info(
              "Skipping {project} — outside schedule window",
              { project: projectName },
            );
            continue;
          }

          projectsScanned++;

          for (const [label, action] of Object.entries(TRIGGER_LABELS)) {
            const tasks = await tdListTasks(
              tdPath,
              tdTimeoutMs,
              projectName,
              label,
            );

            for (const task of tasks) {
              tasksFound++;
              const taskId = String(task.id ?? task.taskId ?? "");
              if (!taskId) continue;

              if (activeClaims.has(taskId)) {
                skippedClaimed++;
                continue;
              }

              // Rate-limit backoff. The dedicated `retryRateLimited` action is
              // the only one allowed to run a still-backed-off task (it IS the
              // retry); it then degrades to a normal build.
              let effectiveAction = action;
              if (action === "retryRateLimited") {
                if (activeRateLimits.has(taskId)) {
                  skippedRateLimited++;
                  continue;
                }
                effectiveAction = "build";
              } else if (activeRateLimits.has(taskId)) {
                skippedRateLimited++;
                continue;
              }

              const taskLabels = (task.labels as string[]) ?? [];
              const providerOverride = detectProviderOverride(taskLabels);
              const effectiveProvider = providerOverride ??
                config.providers.default;

              dispatchList.push({
                taskId,
                taskContent: String(task.content ?? ""),
                action: effectiveAction,
                projectName,
                workingDirectory: config.workingDirectory,
                obsidianVault: config.obsidianVault,
                provider: effectiveProvider,
                providerOverride,
                browserAlwaysRun: config.browserAlwaysRun,
              });
            }
          }
        }

        const pollResult = {
          machine,
          polledAt: now.toISOString(),
          projectsScanned,
          tasksFound,
          dispatched: dispatchList.length,
          skippedClaimed,
          skippedRateLimited,
          dispatchList,
        };

        // Auto-claim all dispatched tasks (unless dry run) so a concurrent or
        // next-cycle poll won't re-dispatch them.
        if (!args.dryRun) {
          for (const item of dispatchList) {
            const expiresAt = new Date(now.getTime() + claimTtlSec * 1000);
            await context.writeResource("claim", `claim-${item.taskId}`, {
              taskId: item.taskId,
              action: item.action,
              machine,
              claimedAt: now.toISOString(),
              expiresAt: expiresAt.toISOString(),
              released: false,
            } as unknown as Record<string, unknown>);
          }
        }

        context.logger.info(
          "Poll complete: {projects} projects, {found} tasks, {dispatched} dispatched, {claimed} skipped (claimed), {rateLimited} skipped (rate-limited)",
          {
            projects: projectsScanned,
            found: tasksFound,
            dispatched: dispatchList.length,
            claimed: skippedClaimed,
            rateLimited: skippedRateLimited,
          },
        );

        const handle = await context.writeResource(
          "pollResult",
          `poll-${Date.now()}`,
          pollResult as unknown as Record<string, unknown>,
        );
        return { dataHandles: [handle] };
      },
    },

    claim: {
      description: "Manually claim a task ID to prevent duplicate dispatch",
      arguments: z.object({
        taskId: z.string(),
        action: z.string(),
      }),
      execute: async (
        args: { taskId: string; action: string },
        context: MethodContext,
      ) => {
        const { machine, claimTtlSec } = context.globalArgs;
        const now = new Date();
        const expiresAt = new Date(now.getTime() + claimTtlSec * 1000);

        const handle = await context.writeResource(
          "claim",
          `claim-${args.taskId}`,
          {
            taskId: args.taskId,
            action: args.action,
            machine,
            claimedAt: now.toISOString(),
            expiresAt: expiresAt.toISOString(),
            released: false,
          } as unknown as Record<string, unknown>,
        );

        context.logger.info("Claimed task {taskId} for {action}", {
          taskId: args.taskId,
          action: args.action,
        });

        return { dataHandles: [handle] };
      },
    },

    release: {
      description:
        "Release a claim on a task (marks it as available for future polls)",
      arguments: z.object({
        taskId: z.string(),
      }),
      execute: async (
        args: { taskId: string },
        context: MethodContext,
      ) => {
        const existing = await context.readResource?.(`claim-${args.taskId}`) as
          | z.infer<typeof ClaimSchema>
          | null;

        if (!existing) {
          context.logger.warning("No claim found for task {taskId}", {
            taskId: args.taskId,
          });
          return { dataHandles: [] };
        }

        const handle = await context.writeResource(
          "claim",
          `claim-${args.taskId}`,
          {
            ...existing,
            released: true,
            releasedAt: new Date().toISOString(),
          } as unknown as Record<string, unknown>,
        );

        context.logger.info("Released claim on task {taskId}", {
          taskId: args.taskId,
        });
        return { dataHandles: [handle] };
      },
    },

    recordRateLimit: {
      description: "Record a rate limit hit for backoff tracking",
      arguments: z.object({
        taskId: z.string(),
        provider: z.string(),
      }),
      execute: async (
        args: { taskId: string; provider: string },
        context: MethodContext,
      ) => {
        const BACKOFF_SCHEDULE = [1800, 3600, 7200]; // 30min, 1hr, 2hr

        const existing = await context.readResource?.(
          `ratelimit-${args.taskId}`,
        ) as
          | z.infer<typeof RateLimitSchema>
          | null;

        const attempts = (existing?.attempts ?? 0) + 1;
        const backoffIndex = Math.min(
          attempts - 1,
          BACKOFF_SCHEDULE.length - 1,
        );
        const backoffSec = BACKOFF_SCHEDULE[backoffIndex];
        const now = new Date();

        const handle = await context.writeResource(
          "rateLimit",
          `ratelimit-${args.taskId}`,
          {
            taskId: args.taskId,
            provider: args.provider,
            attempts,
            lastHitAt: now.toISOString(),
            backoffUntil: new Date(now.getTime() + backoffSec * 1000)
              .toISOString(),
          } as unknown as Record<string, unknown>,
        );

        context.logger.info(
          "Rate limit recorded for {taskId}: attempt {attempts}, backoff {sec}s",
          {
            taskId: args.taskId,
            attempts,
            sec: backoffSec,
          },
        );

        return { dataHandles: [handle] };
      },
    },

    clearRateLimit: {
      description:
        "Clear rate limit backoff for a task (on successful completion)",
      arguments: z.object({
        taskId: z.string(),
      }),
      execute: async (
        args: { taskId: string },
        context: MethodContext,
      ) => {
        // Write a zeroed-out record (attempts=0, backoff in the past) so the
        // loader treats the task as un-throttled.
        const handle = await context.writeResource(
          "rateLimit",
          `ratelimit-${args.taskId}`,
          {
            taskId: args.taskId,
            provider: "cleared",
            attempts: 0,
            lastHitAt: new Date().toISOString(),
            backoffUntil: new Date(0).toISOString(),
          } as unknown as Record<string, unknown>,
        );

        context.logger.info("Cleared rate limit for task {taskId}", {
          taskId: args.taskId,
        });
        return { dataHandles: [handle] };
      },
    },

    swapLabels: {
      description:
        "Atomically swap labels on a Todoist task (remove old, add new)",
      arguments: z.object({
        taskId: z.string(),
        remove: z.array(z.string()).default([]),
        add: z.array(z.string()).default([]),
      }),
      execute: async (
        args: { taskId: string; remove: string[]; add: string[] },
        context: MethodContext,
      ) => {
        const { tdPath, tdTimeoutMs } = context.globalArgs;
        const task = await tdViewTask(tdPath, tdTimeoutMs, args.taskId);
        const currentLabels = (task.labels as string[]) ?? [];
        const newLabels = [
          ...currentLabels.filter((l) => !args.remove.includes(l)),
          ...args.add.filter((l) => !currentLabels.includes(l)),
        ];
        await tdUpdateLabels(tdPath, tdTimeoutMs, args.taskId, newLabels);

        context.logger.info("Labels swapped on {taskId}: -{remove} +{add}", {
          taskId: args.taskId,
          remove: args.remove.join(","),
          add: args.add.join(","),
        });

        return { dataHandles: [] };
      },
    },

    comment: {
      description: "Post a bot comment on a Todoist task",
      arguments: z.object({
        taskId: z.string(),
        content: z.string(),
      }),
      execute: async (
        args: { taskId: string; content: string },
        context: MethodContext,
      ) => {
        const { tdPath, tdTimeoutMs } = context.globalArgs;
        await tdAddComment(tdPath, tdTimeoutMs, args.taskId, args.content);
        context.logger.info("Comment posted on task {taskId}", {
          taskId: args.taskId,
        });
        return { dataHandles: [] };
      },
    },
  },
};

/**
 * Load the set of task ids with a live, unreleased claim. Expired and released
 * claims are ignored so the caller treats those tasks as dispatchable.
 */
async function loadActiveClaims(
  context: MethodContext,
  _claimTtlSec: number,
): Promise<Set<string>> {
  const claimed = new Set<string>();
  const now = Date.now();

  try {
    const allData = await context.dataRepository.findAllForModel(
      context.modelType,
      context.modelId,
    );

    for (const data of allData) {
      if (data.tags?.specName !== "claim") continue;
      if (!data.name.startsWith("claim-")) continue;

      const content = await context.dataRepository.getContent(
        context.modelType,
        context.modelId,
        data.name,
      );
      if (!content) continue;

      try {
        const claim = JSON.parse(new TextDecoder().decode(content));
        if (claim.released) continue;

        const expiresAt = new Date(claim.expiresAt).getTime();
        if (expiresAt > now) {
          claimed.add(claim.taskId);
        }
      } catch { /* skip corrupt data */ }
    }
  } catch { /* no data yet */ }

  return claimed;
}

/**
 * Load the set of task ids currently inside a rate-limit backoff window.
 * Cleared (attempts=0) and elapsed-backoff records are ignored.
 */
async function loadActiveRateLimits(
  context: MethodContext,
): Promise<Set<string>> {
  const rateLimited = new Set<string>();
  const now = Date.now();

  try {
    const allData = await context.dataRepository.findAllForModel(
      context.modelType,
      context.modelId,
    );

    for (const data of allData) {
      if (data.tags?.specName !== "rateLimit") continue;
      if (!data.name.startsWith("ratelimit-")) continue;

      const content = await context.dataRepository.getContent(
        context.modelType,
        context.modelId,
        data.name,
      );
      if (!content) continue;

      try {
        const rl = JSON.parse(new TextDecoder().decode(content));
        if (rl.attempts === 0) continue;

        const backoffUntil = new Date(rl.backoffUntil).getTime();
        if (backoffUntil > now) {
          rateLimited.add(rl.taskId);
        }
      } catch { /* skip */ }
    }
  } catch { /* no data yet */ }

  return rateLimited;
}
