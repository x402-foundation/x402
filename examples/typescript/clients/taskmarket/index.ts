import { config } from "dotenv";
import { x402Client, wrapFetchWithPayment, x402HTTPClient } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import {
  atomicUnitsToUsd,
  assertWithinSpendingLimit,
  buildCreateTaskBody,
  buildCreateTaskHeaders,
  buildTaskListParams,
  createIdempotencyKey,
  usdToAtomicUnits,
  type TaskListFilters,
} from "./lib";

config();

const baseURL = process.env.TASKMARKET_API_URL || "https://api.taskmarket.dev/api";

/**
 * TaskMarket (https://taskmarket.dev) is a third-party x402-paid task
 * marketplace, not part of the x402 Foundation. `GET /tasks` is free to
 * browse; `POST /tasks` requires an x402 payment settled in USDC on Base
 * mainnet, so creating a task moves real funds.
 *
 * Prints CLI usage and exits with a non-zero status.
 *
 * @returns never
 */
function usage(): never {
  console.error(
    [
      "Usage:",
      "  tsx index.ts list [--mode bounty] [--status open] [--min-reward 1.00] [--max-reward 10.00] [--tags a,b] [--limit 10]",
      "  tsx index.ts submissions <taskId>",
      "  tsx index.ts create --description <text> --reward <usd> --duration-hours <n> --tags <a,b> [--yes]",
      "",
      "create requires MAX_TASK_REWARD_USDC in the environment (or .env) as a hard spending cap,",
      "and refuses to submit unless --yes is also passed. Without --yes it prints a dry run only.",
    ].join("\n"),
  );
  process.exit(1);
}

/**
 * Parses `--flag value` pairs out of argv, ignoring the leading command name.
 *
 * @param argv - process.argv.slice(3) (after node, script, and subcommand)
 * @returns a map of flag name (without leading --) to its value
 */
function parseFlags(argv: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const name = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        flags[name] = "true";
      } else {
        flags[name] = next;
        i += 1;
      }
    }
  }
  return flags;
}

/**
 * Browses open TaskMarket work. This is a plain read, no payment required.
 *
 * @param flags - parsed CLI flags for the `list` subcommand
 */
async function listTasks(flags: Record<string, string>): Promise<void> {
  const filters: TaskListFilters = {
    mode: flags.mode as TaskListFilters["mode"],
    status: (flags.status as TaskListFilters["status"]) ?? "open",
    minReward: flags["min-reward"] ? usdToAtomicUnits(flags["min-reward"]) : undefined,
    maxReward: flags["max-reward"] ? usdToAtomicUnits(flags["max-reward"]) : undefined,
    tags: flags.tags ? flags.tags.split(",") : undefined,
    limit: flags.limit ? Number(flags.limit) : 20,
    sort: (flags.sort as TaskListFilters["sort"]) ?? "newest",
  };
  const params = buildTaskListParams(filters);
  const response = await fetch(`${baseURL}/tasks?${params.toString()}`);
  if (!response.ok) {
    throw new Error(`GET /tasks failed: ${response.status} ${await response.text()}`);
  }
  const body = (await response.json()) as { tasks: Array<Record<string, unknown>> };
  for (const task of body.tasks) {
    const reward = atomicUnitsToUsd(String(task.reward));
    const description = String(task.description).slice(0, 80).replace(/\n/g, " ");
    console.log(`${task.id}  $${reward} USDC  [${task.status}]  ${description}`);
  }
  console.log(`\n${body.tasks.length} task(s) shown.`);
}

/**
 * Lists submissions already made against a task. A plain read, no payment
 * required.
 *
 * @param taskId - the TaskMarket task id
 */
async function listSubmissions(taskId: string): Promise<void> {
  if (!taskId) usage();
  const response = await fetch(`${baseURL}/tasks/${taskId}/submissions`);
  if (!response.ok) {
    throw new Error(`GET /tasks/${taskId}/submissions failed: ${response.status}`);
  }
  const submissions = (await response.json()) as Array<Record<string, unknown>>;
  for (const submission of submissions) {
    console.log(
      `${submission.id}  worker=${submission.workerAddress}  at=${submission.submittedAt}`,
    );
  }
  console.log(`\n${submissions.length} submission(s) shown.`);
}

/**
 * Creates a bounty task, paying TaskMarket's x402-gated `POST /tasks` in
 * USDC on Base mainnet. Enforces two independent controls before any
 * network call touches money:
 *
 * 1. `MAX_TASK_REWARD_USDC` must be set and the reward must not exceed it.
 * 2. `--yes` must be passed explicitly; otherwise this prints a dry run
 *    (the exact request that would be sent) and exits without spending.
 *
 * @param flags - parsed CLI flags for the `create` subcommand
 */
async function createTask(flags: Record<string, string>): Promise<void> {
  if (!flags.description || !flags.reward || !flags["duration-hours"]) usage();

  const rewardAtomic = usdToAtomicUnits(flags.reward);
  const capUsd = process.env.MAX_TASK_REWARD_USDC;
  if (!capUsd) {
    throw new Error(
      "MAX_TASK_REWARD_USDC is not set. Refusing to create a task without an explicit spending cap.",
    );
  }
  assertWithinSpendingLimit(rewardAtomic, usdToAtomicUnits(capUsd));

  const body = buildCreateTaskBody({
    description: flags.description,
    rewardAtomic,
    durationSeconds: Math.round(Number(flags["duration-hours"]) * 3600),
    tags: flags.tags ? flags.tags.split(",") : [],
  });

  // Generated once per invocation (not per retry) so the dry run shows the
  // exact key that would be sent, and TaskMarket sees one logical request.
  const idempotencyKey = createIdempotencyKey();
  const headers = buildCreateTaskHeaders(idempotencyKey);

  console.log("About to create a TaskMarket task:");
  console.log(JSON.stringify(body, null, 2));
  console.log(`Reward: $${flags.reward} USDC (cap: $${capUsd} USDC)`);
  console.log(`Headers: ${JSON.stringify(headers)}`);

  if (flags.yes !== "true") {
    console.log("\nDry run only. Re-run with --yes to submit and pay for real.");
    return;
  }

  const evmPrivateKey = process.env.EVM_PRIVATE_KEY as `0x${string}` | undefined;
  if (!evmPrivateKey) {
    throw new Error("EVM_PRIVATE_KEY is not set. Cannot sign the x402 payment.");
  }

  const signer = privateKeyToAccount(evmPrivateKey);
  const client = new x402Client();
  client.register("eip155:*", new ExactEvmScheme(signer));
  const fetchWithPayment = wrapFetchWithPayment(fetch, client);
  const httpClient = new x402HTTPClient(client);

  const response = await fetchWithPayment(`${baseURL}/tasks`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const result = await httpClient.processResponse(response);
  console.log("\nTask created:");
  console.dir(result, { depth: null });
}

/**
 * CLI entry point: dispatches to list, submissions, or create.
 */
async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "list":
      await listTasks(parseFlags(rest));
      break;
    case "submissions":
      await listSubmissions(rest[0]);
      break;
    case "create":
      await createTask(parseFlags(rest));
      break;
    default:
      usage();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
