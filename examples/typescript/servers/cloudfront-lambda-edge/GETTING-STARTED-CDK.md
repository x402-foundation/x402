# Getting Started (CDK): Monetize Any HTTP App with x402 + CloudFront + Lambda@Edge

This guide deploys the same architecture as the [Console guide](./GETTING-STARTED-CONSOLE.md) — x402 payment verification at the CloudFront edge — but with a single `cdk deploy` command instead of clicking through the AWS Console.

**What CDK is:** The AWS Cloud Development Kit lets you describe infrastructure in TypeScript. You write code that defines your Lambda functions, CloudFront distribution, IAM roles, and how they connect — then CDK translates that into AWS resources automatically. The benefits for this workshop:

- `cdk deploy` replaces all of Parts 2, 3, and 4 from the Console guide (~45 minutes of clicking)
- `cdk destroy` tears everything down cleanly in one command
- IAM trust policies, Lambda versions, and ARN wiring are handled for you
- The stack is repeatable and version-controlled

---

## Prerequisites

- **AWS account** ([aws.amazon.com](https://aws.amazon.com))
- **AWS CLI** installed and configured — [install guide](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)
  ```bash
  brew install awscli   # macOS
  aws configure         # enter your Access Key ID, Secret, region (any), output: json
  aws sts get-caller-identity  # verify it works
  ```
- **Node.js 20+** and **pnpm** — verify with `node --version` and `pnpm --version`
- **Ethereum wallet address on Base Sepolia** — install [MetaMask](https://metamask.io) and copy your `0x...` address. Base Sepolia is a testnet — no real money required.

---

## Part 1 — Build the Lambda Bundle

The CDK stack references the built Lambda output, so you need to build it first.

**1a. Enter the lambda directory**

```bash
cd examples/typescript/servers/cloudfront-lambda-edge/lambda
```

**1b. Configure your wallet address**

Open `src/config.ts` and replace the placeholder:

```typescript
export const PAY_TO = '0xYourActualAddressHere';
```

**1c. Install and build**

```bash
pnpm install
pnpm build
```

You should see:
```
dist/index.js  206.8kb
⚡ Done in 44ms
```

The CDK stack reads from `lambda/dist/` — no manual zipping needed, CDK handles packaging.

---

## Part 2 — Bootstrap CDK

CDK needs a one-time setup in your AWS account to create an S3 bucket and IAM roles it uses internally for deployments. This only runs once per account/region.

```bash
cd ../cdk
pnpm install
npx cdk bootstrap
```

You'll see output like:
```
✅  Environment aws://123456789012/us-east-1 bootstrapped.
```

> If you see an error about credentials, make sure `aws sts get-caller-identity` returns your account info.

---

## Part 3 — Deploy

```bash
npx cdk deploy
```

CDK will show you a summary of what it's about to create and ask for confirmation:

```
This deployment will make potentially sensitive changes according to your current security approval level.

Do you wish to deploy these changes (y/n)?
```

Type `y` and press Enter.

**What CDK is creating for you:**
- IAM execution role with the correct `lambda.amazonaws.com` and `edgelambda.amazonaws.com` trust policy
- `x402-origin-request` Lambda function in us-east-1 (required for Lambda@Edge)
- `x402-origin-response` Lambda function in us-east-1
- Published Lambda versions with the correct handlers
- CloudFront distribution pointed at `httpbin.org`
- Lambda@Edge associations on the default cache behavior

> **Non-EU/NA notice:** The stack deploys with `PriceClass.PRICE_CLASS_100`, which limits CloudFront edge locations to North America and Europe. This is the cheapest option and sufficient for testing. If you need global coverage for production, update `cdk/lib/x402-stack.ts` and change it to `cloudfront.PriceClass.PRICE_CLASS_ALL`, then redeploy with `npx cdk deploy`.

This takes **5–10 minutes** — CloudFront propagates to edge locations worldwide.

When complete, CDK prints your domain:

```
Outputs:
X402CloudFrontStack.DistributionDomain = https://d1234abcde.cloudfront.net
```

Copy that URL.

---

## Part 4 — Validate

Replace `[YOUR_DOMAIN]` with your CloudFront URL in all commands below.

**Test 1 — No payment → 402**

```bash
curl -i https://[YOUR_DOMAIN]/api/test
```

Expected response:
```
HTTP/2 402

{
  "x402Version": 1,
  "error": "Payment required",
  "accepts": [{
    "scheme": "exact",
    "network": "eip155:84532",
    "payTo": "0xYourAddress...",
    "price": "$0.001"
  }]
}
```

x402 is working — the Lambda function rejected the request at the edge before it ever reached httpbin.

**Test 2 — Unprotected route → 200**

```bash
curl -i https://[YOUR_DOMAIN]/get
```

The path `/get` is not in your `ROUTES` config, so it passes through to httpbin and returns 200. This confirms CloudFront and the origin are connected correctly.

**Test 3 — Full payment flow**

Use the [`fetch` client example](../../../../clients/fetch/) to make a paid request:

```bash
cd ../../../../clients/fetch
cp .env-local .env
```

Edit `.env`:
```
EVM_PRIVATE_KEY=0xYourBaseSepoliaPrivateKey
RESOURCE_SERVER_URL=https://[YOUR_DOMAIN]
ENDPOINT_PATH=/api/test
```

Then run:
```bash
pnpm install && pnpm start
```

The client automatically detects the `402`, constructs and signs the payment, attaches it as a `PAYMENT-SIGNATURE` header, and retries — returning the 200 response from httpbin.

> **Never use a mainnet private key here.** Use a throwaway Base Sepolia wallet with test funds only.

---

## Updating the Stack

If you change `config.ts` (e.g., different pricing or routes), rebuild and redeploy:

```bash
# In lambda/
pnpm build

# In cdk/
npx cdk deploy
```

CDK detects only the changed resources and updates them — it won't recreate the distribution from scratch.

To preview what will change before deploying:

```bash
npx cdk diff
```

---

## Cleanup

When done, destroy all AWS resources with one command:

```bash
npx cdk destroy
```

CDK will confirm and then delete the CloudFront distribution, Lambda functions, and IAM role. Nothing is left running.

---

## Using Your Own Origin

Replace `httpbin.org` in `cdk/lib/x402-stack.ts` with your own server:

```typescript
origin: new origins.HttpOrigin('your-api.example.com', {
  protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
}),
```

Then `npx cdk deploy` to update. Your origin needs no changes — that's the point.

---

## Going to Mainnet

Update `src/config.ts` in the lambda directory:

```typescript
export const NETWORK = 'eip155:8453'; // Base mainnet
export const FACILITATOR_URL = 'https://your-mainnet-facilitator-url';
export const PAY_TO = '0xYourMainnetWalletAddress';
```

Rebuild and redeploy:

```bash
cd ../lambda && pnpm build
cd ../cdk && npx cdk deploy
```

Browse available mainnet facilitators at the [x402 ecosystem](https://www.x402.org/ecosystem?filter=facilitators).

---

## File Structure

```
cloudfront-lambda-edge/
├── lambda/                  # Lambda source — edit config.ts here
│   ├── src/config.ts        # ← your wallet address, routes, pricing
│   └── dist/                # built output (referenced by CDK)
├── cdk/                     # Infrastructure as code
│   ├── bin/app.ts           # CDK app entry point
│   ├── lib/x402-stack.ts    # Stack definition (all AWS resources)
│   ├── cdk.json             # CDK configuration
│   └── package.json
├── GETTING-STARTED-CONSOLE.md  # Step-by-step AWS Console guide
└── GETTING-STARTED-CDK.md      # This file
```
