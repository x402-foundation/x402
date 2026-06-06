# IssueOps x402 Payer

Example of a human-gated x402 payment server. Payments are authorized by GitHub issue
comments, not triggered automatically. This suits use cases where explicit human approval
is required before funds leave a vault.

```typescript
const APPROVAL_PATTERN = /^@gitbankbot\s+pay\b/i;

// Only fires when a human types "@gitbankbot pay" in a GitHub issue
if (!isApproved(comment.body)) return;
await executePayment(client);
```

## How it works

1. A GitHub webhook forwards `issue_comment` events to `POST /webhook`
2. The handler checks the comment body against the approval pattern
3. On match: probes the resource server for x402 requirements (402 response)
4. Signs EIP-3009 with the relayer key and retries with `PAYMENT-SIGNATURE` header
5. Logs settlement details from the `PAYMENT-RESPONSE` header

This pattern is used in production by [Gitbank](https://gitbank.io), an IssueOps
platform where GitHub bot mentions authorize vault payments on Base L2. The full
implementation is at [gitbankio/x402](https://github.com/gitbankio/x402).

## Prerequisites

- Node.js v20+
- pnpm v10
- A running x402 server (see [express server example](../../servers/express))
- An EVM private key whose address holds enough tokens for the payment

## Setup

1. Install and build from the typescript examples root:

```bash
cd ../../
pnpm install && pnpm build
cd clients/issueops-payer
```

2. Copy `.env-local` to `.env` and fill in your values:

```bash
cp .env-local .env
```

## Run

```bash
pnpm start
```

Send a test webhook:

```bash
curl -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -d '{"action":"created","comment":{"body":"@gitbankbot pay for the weather report"}}'
```

## Production checklist

In a production GitHub App:

- Set the webhook URL to `https://your-server.com/webhook`
- Subscribe to `issue_comment` events
- Verify `X-Hub-Signature-256` before processing (omitted here for clarity)
- Store `EVM_PRIVATE_KEY` encrypted at rest (see [AES-256-GCM key engine](https://github.com/gitbankio/x402))
