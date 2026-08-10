# TaskMarket Client Example

Example client showing how to use `@x402/fetch` against [TaskMarket](https://taskmarket.dev)
([docs](https://docs.taskmarket.dev), [OpenAPI spec](https://api.taskmarket.dev/openapi.json)),
a third-party task marketplace where creating a task is paid for over x402 in USDC on Base
mainnet. TaskMarket is not affiliated with the x402 Foundation; this example just demonstrates
the protocol against a real x402-paid API.

This example covers three things TaskMarket's own CLI does not group together in one place:

- **Browsing** open work (`list`), a free read.
- **Tracking** submissions on a task you posted (`submissions`), a free read.
- **Creating** a task (`create`), which is x402-gated and moves real USDC. This path is guarded:
  it requires an explicit spending cap and an explicit `--yes` flag before anything is paid.

## Prerequisites

- Node.js v20+
- pnpm v10
- An EVM private key funded with Base mainnet USDC, only needed for `create`

## Setup

```bash
cd ../../
pnpm install && pnpm build
cd clients/taskmarket
cp .env-local .env
```

Edit `.env`:

- `EVM_PRIVATE_KEY` - required only for `create`. The wallet that pays for the task.
- `TASKMARKET_API_URL` - defaults to `https://api.taskmarket.dev/api`.
- `MAX_TASK_REWARD_USDC` - required for `create`. A hard cap: `create` refuses to run if the
  requested reward is above this value, regardless of what `--reward` asks for.

## Usage

`list` and `create` collide with pnpm's own built-in commands (`pnpm list`/`pnpm ls`, `pnpm create`),
so use `pnpm run <script> -- ...` (not bare `pnpm <script> -- ...`) for all three, or those flags
go to pnpm itself and silently do nothing from this CLI.

Browse open bounty tasks:

```bash
pnpm run list -- --mode bounty --status open --min-reward 1.00 --limit 10
```

Check submissions on a task you posted:

```bash
pnpm run submissions -- 0xTASK_ID
```

Create a task (dry run first, no money moves without `--yes`):

```bash
pnpm run create -- --description "Fix the flaky login test" --reward 2.00 --duration-hours 48 --tags bugfix,ci
```

The dry run prints the exact request body, headers (including the idempotency key that will be
sent), and the configured cap. Re-run with `--yes` appended to actually sign and pay:

```bash
pnpm run create -- --description "Fix the flaky login test" --reward 2.00 --duration-hours 48 --tags bugfix,ci --yes
```

If `--reward` exceeds `MAX_TASK_REWARD_USDC`, the command exits with an error before any network
call is made, on both the dry run and the `--yes` path.

## Tests

`lib.ts` holds the network-free pieces (USDC unit conversion, the spending-limit guard, and the
request builders) so they can be unit tested without mocking HTTP or wallet signing:

```bash
pnpm test
```
