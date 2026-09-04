# @x402/hono on Cloudflare Workers

Deploying an x402 seller to the edge with `@x402/hono`. Nearly identical to the
[hono](../hono/) example — same middleware, same route — the differences are
all in how a Worker's lifecycle differs from a long-running Node process.

```typescript
import { Hono } from "hono";
import { env } from "cloudflare:workers";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";

const app = new Hono();
let x402Middleware: ReturnType<typeof paymentMiddleware> | undefined;

function getPaymentMiddleware() {
  return (x402Middleware ??= paymentMiddleware(
    {
      "GET /weather": {
        accepts: {
          scheme: "exact",
          price: "$0.001",
          network: "eip155:84532",
          payTo: env.EVM_ADDRESS,
        },
        description: "Weather data",
        mimeType: "application/json",
      },
    },
    new x402ResourceServer(
      new HTTPFacilitatorClient({ url: env.FACILITATOR_URL }),
    ).register("eip155:84532", new ExactEvmScheme()),
  ));
}

app.use((c, next) => getPaymentMiddleware()(c, next));

app.get("/weather", (c) => c.json({ weather: "sunny", temperature: 70 }));

// No server to start: a Worker's fetch handler *is* the deployable unit.
export default app;
```

## Prerequisites

- Node.js v22+ (install via [nvm](https://github.com/nvm-sh/nvm))
- pnpm v11 (install via [pnpm.io/installation](https://pnpm.io/installation))
- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (the free tier is enough)
- A valid EVM address for receiving payments
- URL of a facilitator supporting the desired payment network, see [facilitator list](https://www.x402.org/ecosystem?category=facilitators)

## Setup

1. Copy `.dev.vars.example` to `.dev.vars`:

```bash
cp .dev.vars.example .dev.vars
```

and set `EVM_ADDRESS` to your payout address. `FACILITATOR_URL` is already set
as a `vars` entry in `wrangler.jsonc` — override it in `.dev.vars` if you want
a different facilitator locally.

2. Install and build all packages from the typescript examples root:

```bash
cd ../../
pnpm install && pnpm build
cd servers/cloudflare-workers
```

3. Run the Worker locally:

```bash
pnpm dev
```

This starts [`wrangler dev`](https://developers.cloudflare.com/workers/wrangler/commands/#dev),
which runs the real Workers runtime (`workerd`) locally — not a Node
emulation — so behavior matches production.

## Testing the Server

Same as the other server examples — point any client example at
`http://localhost:8787` instead of `http://localhost:4021`:

```bash
cd ../../clients/fetch
# Ensure .env is setup
pnpm dev
```

## Deploying

```bash
pnpm exec wrangler login
pnpm exec wrangler secret put EVM_ADDRESS
pnpm deploy
```

`EVM_ADDRESS` is set as a [secret](https://developers.cloudflare.com/workers/configuration/secrets/),
not a `vars` entry — it never needs to appear in `wrangler.jsonc` or get
committed to source control.

## Workers-Specific Notes

**`nodejs_compat` is required.** `@x402/hono` pulls in a few Node built-ins
transitively (`url`, used by the Bazaar-discovery check that runs even when
you don't declare a Bazaar extension). Without the flag, `wrangler dev` fails
at build time with `Could not resolve "url"`. Already set in this example's
`wrangler.jsonc`:

```jsonc
{
  "compatibility_flags": ["nodejs_compat"],
}
```

**Bindings are generated and globally importable.** `pnpm cf-typegen` creates
`worker-configuration.d.ts` from `wrangler.jsonc` and `.dev.vars.example`, so
`env.EVM_ADDRESS` and `env.FACILITATOR_URL` stay type-safe without a handwritten
binding interface.

**Initialization happens in request context.** Creating `paymentMiddleware`
starts facilitator I/O, which Workers does not allow during module evaluation.
`getPaymentMiddleware` creates it on the first request and reuses it for the
lifetime of the isolate, avoiding both global-scope I/O and per-request setup.

**No process to keep alive.** `export default app` is the entire deployment —
there's no `serve({ fetch: app.fetch, port })` call, no port to pick, nothing
to keep running. Cloudflare's edge network handles routing traffic to your
Worker.

## Extending the Example

Same pattern as the other framework examples — add more routes to the
`paymentMiddleware` config and matching Hono handlers. See the
[hono example](../hono/#extending-the-example) for the general shape, and
[Advanced Examples](../advanced/) for lifecycle hooks, dynamic pricing, and
Bazaar discovery.

If a paid resource can only be claimed once, a Workers-specific option is to
arbitrate concurrent claims with a D1 uniqueness constraint. For a deployed
project built around that pattern, see [404 Humans](https://404humans.xyz), an
x402 pixel-block marketplace on Workers and D1.
