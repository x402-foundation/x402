# Getting Started: Monetize Any HTTP App with x402 + CloudFront + Lambda@Edge

In this workshop, you will deploy a monetization layer that sits at the global edge. By leveraging AWS CloudFront and Lambda@Edge, you can gate any existing HTTP origin with crypto payments — without modifying a single line of your backend code.

## The Request Lifecycle

```
Client Request
    → CloudFront (global edge network)
        → Lambda@Edge origin-request: verify payment (or return 402)
            → Your origin server (unchanged)
        → Lambda@Edge origin-response: settle payment (only on success)
    → Response
```

1. **Client Request** — a request hits the CloudFront global edge network
2. **Verify (Origin Request)** — a Lambda function intercepts the request and verifies the x402 payment header. If missing or invalid, it returns `402 Payment Required`
3. **Origin Process** — if valid, the request proceeds to your origin server
4. **Settle (Origin Response)** — a second Lambda function settles the payment only if the origin returns a success code (status < 400)
5. **Client Response** — the client receives their data

The "verify then settle" pattern ensures clients are never charged for failed requests.

---

## Prerequisites

- **AWS account** ([aws.amazon.com](https://aws.amazon.com)) — free tier is sufficient
- **Node.js 20+** and **pnpm** — verify with `node --version` and `pnpm --version`
- **Ethereum wallet address on Base Sepolia** — the quickest option is [MetaMask](https://metamask.io); copy your `0x...` address. Base Sepolia is a testnet — no real money required.

---

## Part 1 — Build the Lambda Bundle

This step packages the x402 logic into a single zip file ready for AWS deployment. Everything runs locally.

**1a. Clone the repository**

```bash
git clone https://github.com/coinbase/x402.git
cd x402/examples/typescript/servers/cloudfront-lambda-edge/lambda
```

**1b. Configure your wallet address**

Open `src/config.ts` and replace the placeholder with your wallet address:

```typescript
export const PAY_TO = '0xYourActualAddressHere';
```

Leave `FACILITATOR_URL` and `NETWORK` as-is — they point to the public testnet facilitator on Base Sepolia.

**1c. Install dependencies and build**

```bash
pnpm install
pnpm build
```

You should see:
```
dist/index.js  206.8kb
⚡ Done in 44ms
```

**1d. Zip the bundle**

```bash
cd dist && zip -r ../function.zip index.js
```

You now have `lambda/function.zip` (~40KB). This is the file you will upload to AWS in Part 3.

---

## Part 2 — Create the IAM Role

Lambda needs an execution role — permission to run on AWS infrastructure and write logs. You create one role and reuse it for both Lambda functions.

1. In the black search bar at the top of the AWS Console, type **IAM** → click **IAM**
2. In the left sidebar, click **Roles** → click **Create role**
3. On "Select trusted entity":
   - Choose **AWS service**
   - Under "Use case", select **Lambda**
   - Click **Next**
4. On "Add permissions", search for and check **`AWSLambdaBasicExecutionRole`** → click **Next**
5. On "Name, review, and create":
   - Role name: `x402-lambda-edge-role`
   - Click **Create role**

**Update the trust policy to support Lambda@Edge**

By default the role only trusts `lambda.amazonaws.com`. CloudFront also needs `edgelambda.amazonaws.com` to invoke your functions at the edge.

1. Find `x402-lambda-edge-role` in the Roles list and click it
2. Click the **Trust relationships** tab → **Edit trust policy**
3. Replace the entire contents with:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": [
          "lambda.amazonaws.com",
          "edgelambda.amazonaws.com"
        ]
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
```

4. Click **Update policy**

---

## Part 3 — Create the Lambda Functions

> **Critical:** Lambda@Edge functions **must** be deployed in **us-east-1 (N. Virginia)**. Before creating anything, check the region selector in the top-right corner of the console. If it shows anything other than N. Virginia, click it and switch now. You can confirm you're in the right place by checking your browser URL — it should contain `us-east-1.console.aws.amazon.com`.

You will create two functions from the same zip file. They use different handler names to call different exported functions from the bundle.

---

### Function 1: `x402-origin-request`

**Step 1 — Open Lambda**

Search bar → **Lambda** → click **Create function**

**Step 2 — Author from scratch**

Select **Author from scratch**, then fill in:

| Field | Value |
|---|---|
| Function name | `x402-origin-request` |
| Runtime | **Node.js 20.x** |
| Architecture | **x86_64** |

**Step 3 — Set the execution role**

Still on the Create function page, expand **"Change default execution role"**:
- Select **"Use an existing role"**
- Choose `x402-lambda-edge-role` from the dropdown

Click **Create function**.

**Step 4 — Upload the zip**

On the function detail page, find the **Code source** panel:
1. Click **Upload from** → **.zip file**
2. Click **Upload** → select your `function.zip` → click **Save**

**Step 5 — Set the handler**

Still on the **Code** tab, scroll to the very bottom and find the **Runtime settings** panel. Click **Edit**:

| Field | Value |
|---|---|
| Handler | `index.originRequestHandler` |

Click **Save**.

> The handler format is `filename.exportedFunctionName`. Your bundle exports `originRequestHandler` from `index.js`, so the handler is `index.originRequestHandler`.

**Step 6 — Set the timeout**

Click the **Configuration** tab → **General configuration** in the left sidebar → **Edit**:

| Field | Value |
|---|---|
| Timeout | `0 min 30 sec` |
| Memory | `256 MB` |

Click **Save**. The default timeout is 3 seconds — payment verification calls the facilitator over the network so it needs more headroom.

**Step 7 — Publish a version**

Lambda@Edge cannot use `$LATEST` — CloudFront requires a specific published version number in the ARN.

1. Click **Actions** → **Publish new version**
2. Description: `initial`
3. Click **Publish**

The page reloads showing **Version: 1**. **Copy the full ARN from the top of the page** — it ends in `:1`:

```
arn:aws:lambda:us-east-1:123456789012:function:x402-origin-request:1
```

Save this — you will paste it into CloudFront in Part 4.

---

### Function 2: `x402-origin-response`

Repeat every step above with these two differences:

| Field | Value |
|---|---|
| Function name | `x402-origin-response` |
| Handler | `index.originResponseHandler` |

Everything else is identical — same zip file, same role, same timeout and memory, same publish step.

Copy its `:1` ARN too.

---

### Why two functions from one zip?

Both Lambda functions are built into the same `index.js` bundle — they just export different handler functions. The **Handler** field tells Lambda which export to call. Same code, different entry points, different CloudFront event types.

---

## Part 4 — Create the CloudFront Distribution

For this workshop, you will use `httpbin.org` as a dummy origin — it echoes back whatever hits it, so you can verify the full x402 flow without building any backend.

### Phase 1: Create the distribution

1. Search bar → **CloudFront** → click **Create a CloudFront distribution**

**Origin settings**

At the top of the form, under "Origin domain", click **Other origin** and enter `httpbin.org` in the Custom origin field:

| Field | Value |
|---|---|
| Origin type | **Other origin** |
| Custom origin domain | `httpbin.org` |
| Protocol | **HTTPS only** |

**Default cache behavior**

| Field | Value |
|---|---|
| Viewer protocol policy | **Redirect HTTP to HTTPS** |
| Allowed HTTP methods | **GET, HEAD, OPTIONS, PUT, POST, PATCH, DELETE** |
| Cache policy | **CachingDisabled** |
| Origin request policy | **AllViewerExceptHostHeader** |
| Response headers policy | **SimpleCORS** |

> Setting Cache policy to **CachingDisabled** is critical for testing — otherwise CloudFront may serve cached responses and bypass your Lambda functions entirely.

**WAF**

When asked about Web Application Firewall, select **Do not enable security protections** for now.

**Settings**

| Field | Value |
|---|---|
| Price class | **Use only North America and Europe** |
| Description | `x402 workshop test` |

Click **Create distribution**.

CloudFront will show **Status: Deploying** — this takes **5–10 minutes** while AWS propagates your configuration to edge locations worldwide.

**Copy your domain name** from the distributions list now — it looks like `d1234abcde.cloudfront.net`.

---

### Phase 2: Add Lambda@Edge associations

The Lambda function associations live on the **Behavior**, not the distribution creation form. Once your distribution status changes to **Enabled**:

1. Click on your distribution to open its details
2. Click the **Behaviors** tab
3. Check the box next to the **Default (`*`)** behavior
4. Click **Edit**
5. Scroll down to **Function associations** and fill in:

| Event type | Function type | ARN | Include Body |
|---|---|---|---|
| Origin request | **Lambda@Edge** | `arn:...:x402-origin-request:1` | ✅ Yes |
| Origin response | **Lambda@Edge** | `arn:...:x402-origin-response:1` | — |

> **Include Body** must be checked for Origin Request — this ensures POST/PUT request bodies are forwarded correctly.

6. Click **Save changes**

CloudFront will redeploy for a few more minutes. Wait for Status to return to **Enabled** before testing.

---

## Part 5 — Validate

Replace `[YOUR_DOMAIN]` with your `d1234abcde.cloudfront.net` domain in all commands below.

**Test 1 — No payment → 402**

```bash
curl -i https://[YOUR_DOMAIN].cloudfront.net/api/test
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
curl -i https://[YOUR_DOMAIN].cloudfront.net/get
```

The path `/get` is not in your `ROUTES` config, so it passes through to httpbin and returns a 200. This confirms CloudFront and the origin are connected correctly.

**Test 3 — Full payment flow**

Use the [`fetch` client example](../../../../clients/fetch/) from this repo to make a paid request:

```bash
cd ../../../../clients/fetch
cp .env-local .env
```

Edit `.env`:
```
EVM_PRIVATE_KEY=0xYourBaseSepoliaPrivateKey
RESOURCE_SERVER_URL=https://[YOUR_DOMAIN].cloudfront.net
ENDPOINT_PATH=/api/test
```

Then run:
```bash
pnpm install && pnpm start
```

The client will automatically detect the `402`, construct and sign the payment, attach it as a `PAYMENT-SIGNATURE` header, and retry — returning the 200 response from httpbin.

> **Never use a mainnet private key here.** Use a throwaway Base Sepolia wallet with test funds only.

---

## Architecture Insights

**The "aha" moment:** `httpbin.org` is a generic public API with zero knowledge of crypto or payments. By placing it behind CloudFront with x402, you transformed a free endpoint into a monetized asset in under 30 minutes — with no changes to the origin.

**Why verify then settle?** Charging a client for a failed request (e.g., a 500 error from the origin) is poor practice. The two-Lambda architecture enforces this: `origin-request` verifies and holds the payment, `origin-response` settles it only when the origin returns status < 400.

**Why Lambda@Edge?** Payment verification happens at the CloudFront edge location closest to the client — not in a central data center. This minimizes latency and means your origin never receives unpaid requests.

---

## Cleanup

To avoid ongoing AWS charges, delete resources when done:

1. **CloudFront** → select your distribution → **Disable** → wait ~5 min → **Delete**
2. **Lambda** → delete `x402-origin-request` and `x402-origin-response` (in us-east-1)
3. **IAM** → delete `x402-lambda-edge-role`

CloudFront's free tier covers 1TB data transfer and 10M requests/month, so workshop usage costs essentially nothing — but leaving a distribution running indefinitely adds up.

---

## Next Steps

- **Use your own origin** — replace `httpbin.org` with any HTTP server (AWS, GCP, Azure, on-prem, SaaS)
- **Adjust pricing and routes** — edit `src/config.ts`, rebuild, re-upload the zip, and publish a new version
- **Add WAF bot protection** — charge only bot/scraper traffic while keeping humans free (see [Advanced Patterns](./README.md#advanced-patterns))
- **Go to mainnet** — update `NETWORK` to `eip155:8453` and `FACILITATOR_URL` to a mainnet facilitator from the [x402 ecosystem](https://www.x402.org/ecosystem?filter=facilitators)
