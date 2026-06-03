---
title: "Lifecycle Hooks"
description: "This page explains how to use lifecycle hooks to customize x402 payment flows."
---

Hooks allow you to intercept and modify payment lifecycle events on clients, servers and facilitators.

## Server Hooks

### x402ResourceServer (Transport-agnostic)

Register hooks on the core resource server for verification and settlement lifecycle events. Use cases include logging payments, recording analytics, implementing custom access control or recovering from transient failures.

* **onBeforeVerify** — Runs before payment verification. Return `{ abort: true, reason }` to reject, or `{ skip: true, result }` to use a locally produced verification result.
* **onAfterVerify** — Runs after successful verification. Return `{ skipHandler: true, response? }` to settle without invoking the resource handler.
* **onVerifyFailure** — Runs on verification failure. Return `{ recovered: true, result }` to override.
* **onBeforeSettle** — Runs before settlement. Return `{ abort: true, reason }` to reject, or `{ skip: true, result }` to use a locally produced settlement result.
* **onAfterSettle** — Runs after successful settlement.
* **onSettleFailure** — Runs on settlement failure. Return `{ recovered: true, result }` to override.
* **onVerifiedPaymentCanceled** — Runs when a verified payment is not settled because the protected handler throws or returns an error response.

These server-level hooks run for every payment regardless of which extensions are active. Extensions and schemes can also contribute lifecycle hook adapters that run only when their extension key or scheme/network is used. See [Extensions Overview](/extensions/overview) for extension-level behavior.

<Tabs>
  <Tab title="TypeScript">
    ```typescript
    import { x402ResourceServer } from "@x402/core";

    const server = new x402ResourceServer(facilitatorClient);

    server.onAfterSettle(async (context) => {
      await recordPayment({
        payer: context.result.payer,
        transaction: context.result.transaction,
        amount: context.requirements.amount,
        network: context.requirements.network,
      });
    });
    ```
  </Tab>
  <Tab title="Python">
    ```python
    from x402 import x402ResourceServer

    server = x402ResourceServer(facilitator_client)

    async def record_payment(context):
        await db.record_payment(
            payer=context.result.payer,
            transaction=context.result.transaction,
            amount=context.requirements.amount,
            network=context.requirements.network,
        )

    server.on_after_settle(record_payment)
    ```

    For synchronous applications, use `x402ResourceServerSync`:

    ```python
    from x402 import x402ResourceServerSync

    server = x402ResourceServerSync(facilitator_client)

    def record_payment(context):
        db.record_payment(
            payer=context.result.payer,
            transaction=context.result.transaction,
        )

    server.on_after_settle(record_payment)
    ```
  </Tab>
  <Tab title="Go">
    ```go
    import x402 "github.com/x402-foundation/x402/go/v2"

    server := x402.Newx402ResourceServer(facilitatorClient)

    server.OnAfterSettle(func(ctx x402.SettleResultContext) error {
        return db.RecordPayment(Payment{
            Payer:       ctx.Result.Payer,
            Transaction: ctx.Result.Transaction,
            Amount:      ctx.Requirements.Amount,
            Network:     ctx.Requirements.Network,
        })
    })
    ```
  </Tab>
</Tabs>

### x402HTTPResourceServer (HTTP)

Register hooks for HTTP-specific request handling before payment processing. Use cases include bypassing payment for API key holders, granting access to subscribers or blocking specific clients.

* **onProtectedRequest** — Runs on every request to a protected route.
  * Return `{ grantAccess: true }` to bypass payment.
  * Return `{ abort: true, reason }` to return 403.
  * Return `void` to continue to payment flow.

<Tabs>
  <Tab title="TypeScript">
    ```typescript
    import { x402ResourceServer, x402HTTPResourceServer } from "@x402/core";

    const server = new x402ResourceServer(facilitatorClient);
    const httpServer = new x402HTTPResourceServer(server, routes);

    httpServer.onProtectedRequest(async (context, routeConfig) => {
      const apiKey = context.adapter.getHeader("X-API-Key");

      if (apiKey && await isValidApiKey(apiKey)) {
        return { grantAccess: true };
      }

      // No valid API key — continue to payment flow
    });
    ```
  </Tab>
  <Tab title="Python">
    ```python
    from x402 import x402ResourceServer
    from x402.http import x402HTTPResourceServer
    from x402.schemas.hooks import GrantAccessResult

    server = x402ResourceServer(facilitator_client)
    http_server = x402HTTPResourceServer(server, routes)

    async def allow_subscribers(context, route_config):
        api_key = context.adapter.get_header("X-API-Key")
        if api_key and await is_valid_api_key(api_key):
            return GrantAccessResult()

    http_server.on_protected_request(allow_subscribers)
    ```
  </Tab>
  <Tab title="Go">
    ```go
    import (
        "context"
        x402 "github.com/x402-foundation/x402/go/v2"
        x402http "github.com/x402-foundation/x402/go/v2/http"
    )

    // Create resource server
    resourceServer := x402.Newx402ResourceServer(
        x402.WithFacilitatorClient(facilitatorClient),
    )

    // Wrap with HTTP server and register hook
    httpServer := x402http.Wrappedx402HTTPResourceServer(routes, resourceServer).
        OnProtectedRequest(func(ctx context.Context, reqCtx x402http.HTTPRequestContext, routeConfig x402http.RouteConfig) (*x402http.ProtectedRequestHookResult, error) {
            apiKey := reqCtx.Adapter.GetHeader("X-API-Key")

            if apiKey != "" && isValidApiKey(apiKey) {
                return &x402http.ProtectedRequestHookResult{GrantAccess: true}, nil
            }

            // No valid API key — continue to payment flow
            return nil, nil
        })
    ```
  </Tab>
</Tabs>

## Client Hooks

### x402Client (Transport-agnostic)

Register hooks on the core client for payment payload creation lifecycle events. Common use cases include enforcing spending limits, requiring approval for large payments or logging outgoing transactions.

* **onBeforePaymentCreation** — Runs before creating a payment payload. Return `{ abort: true, reason }` to cancel.
* **onAfterPaymentCreation** — Runs after successful payload creation.
* **onPaymentCreationFailure** — Runs on failure. Return `{ recovered: true, payload }` to provide fallback.
* **onPaymentResponse** — Runs after a paid request completes. Return `{ recovered: true }` to tell the transport to retry with a fresh payload.

<Tabs>
  <Tab title="TypeScript">
    ```typescript
    import { x402Client } from "@x402/core";

    const client = new x402Client();

    client.onBeforePaymentCreation(async (context) => {
      const maxAmount = BigInt("10000000"); // 10 USDC
      const requestedAmount = BigInt(context.selectedRequirements.amount);

      if (requestedAmount > maxAmount) {
        return { abort: true, reason: "Payment exceeds spending limit" };
      }
    });
    ```
  </Tab>
  <Tab title="Python">
    ```python
    from x402 import x402Client, AbortResult

    client = x402Client()

    async def enforce_spending_limit(context):
        max_amount = 10_000_000  # 10 USDC
        requested_amount = int(context.selected_requirements.amount)

        if requested_amount > max_amount:
            return AbortResult(reason="Payment exceeds spending limit")

    client.on_before_payment_creation(enforce_spending_limit)
    ```

    For synchronous applications, use `x402ClientSync`:

    ```python
    from x402 import x402ClientSync, AbortResult

    client = x402ClientSync()

    def enforce_spending_limit(context):
        max_amount = 10_000_000  # 10 USDC
        requested_amount = int(context.selected_requirements.amount)

        if requested_amount > max_amount:
            return AbortResult(reason="Payment exceeds spending limit")

    client.on_before_payment_creation(enforce_spending_limit)
    ```
  </Tab>
  <Tab title="Go">
    ```go
    import x402 "github.com/x402-foundation/x402/go/v2"

    client := x402.Newx402Client()

    client.OnBeforePaymentCreation(func(ctx x402.PaymentCreationContext) (*x402.BeforePaymentCreationResult, error) {
        maxAmount := big.NewInt(10_000_000) // 10 USDC
        requestedAmount := new(big.Int)
        requestedAmount.SetString(ctx.Requirements.Amount, 10)

        if requestedAmount.Cmp(maxAmount) > 0 {
            return &x402.BeforePaymentCreationResult{
                Abort:  true,
                Reason: "Payment exceeds spending limit",
            }, nil
        }
        return nil, nil
    })
    ```
  </Tab>
</Tabs>

### x402HTTPClient (HTTP)

Register hooks for HTTP-specific payment required handling. Use cases include trying API key authentication before paying or prompting users for payment confirmation.

* **onPaymentRequired** — Runs when a 402 response is received.
  * Return `{ headers }` to retry with alternate headers before paying.
  * Return `void` to proceed directly to payment.

<Tabs>
  <Tab title="TypeScript">
    ```typescript
    import { x402Client, x402HTTPClient } from "@x402/core";

    const client = new x402Client();
    const httpClient = new x402HTTPClient(client);

    httpClient.onPaymentRequired(async ({ paymentRequired }) => {
      // Try API key authentication first
      const apiKey = process.env.API_KEY;
      if (apiKey) {
        return { headers: { "Authorization": `Bearer ${apiKey}` } };
      }
      // Return void to proceed with payment
    });
    ```
  </Tab>
  <Tab title="Python">
    ```python
    import os

    from x402 import x402Client
    from x402.http import x402HTTPClient
    from x402.schemas.hooks import PaymentRequiredHeadersResult

    client = x402Client()
    http_client = x402HTTPClient(client)

    async def try_api_key(context):
        api_key = os.environ.get("API_KEY")
        if api_key:
            return PaymentRequiredHeadersResult(
                headers={"Authorization": f"Bearer {api_key}"}
            )

    http_client.on_payment_required(try_api_key)
    ```
  </Tab>
  <Tab title="Go">
    *Coming soon.*
  </Tab>
</Tabs>

## Facilitator Hooks

### x402Facilitator

Register hooks on the facilitator for verification and settlement lifecycle events. Use cases include populating a bazaar discovery catalog, compliance checks or collecting metrics across all processed payments.

* **onBeforeVerify / onAfterVerify / onVerifyFailure** — Same pattern as server hooks.
* **onBeforeSettle / onAfterSettle / onSettleFailure** — Same pattern as server hooks.

<Tabs>
  <Tab title="TypeScript">
    ```typescript
    import { x402Facilitator } from "@x402/core";
    import { extractDiscoveryInfo } from "@x402/extensions/bazaar";

    const facilitator = new x402Facilitator();

    facilitator.onAfterVerify(async (context) => {
      // Extract resource info from payment for bazaar catalog
      const discovered = extractDiscoveryInfo(
        context.paymentPayload,
        context.requirements,
        true, // validate
      );

      if (discovered) {
        bazaarCatalog.add({
          resource: discovered.resourceUrl,
          description: discovered.description,
          mimeType: discovered.mimeType,
          x402Version: discovered.x402Version,
          accepts: [context.requirements],
          lastUpdated: new Date().toISOString(),
        });
      }
    });
    ```
  </Tab>
  <Tab title="Python">
    ```python
    from x402 import x402Facilitator

    facilitator = x402Facilitator()

    async def update_bazaar_catalog(context):
        discovered = extract_discovery_info(
            context.payment_payload,
            context.requirements,
            validate=True,
        )

        if discovered:
            await bazaar_catalog.add(
                resource=discovered.resource_url,
                description=discovered.description,
                mime_type=discovered.mime_type,
                accepts=[context.requirements],
            )

    facilitator.on_after_verify(update_bazaar_catalog)
    ```

    For synchronous applications, use `x402FacilitatorSync`:

    ```python
    from x402 import x402FacilitatorSync

    facilitator = x402FacilitatorSync()

    def log_verification(context):
        print(f"Verified payment from {context.result.payer}")

    facilitator.on_after_verify(log_verification)
    ```
  </Tab>
  <Tab title="Go">
    ```go
    import x402 "github.com/x402-foundation/x402/go/v2"

    facilitator := x402.Newx402Facilitator()

    facilitator.OnAfterVerify(func(ctx x402.FacilitatorVerifyResultContext) error {
        discovered := extractDiscoveryInfo(ctx.PaymentPayload, ctx.Requirements)

        if discovered != nil {
            return bazaarCatalog.Add(BazaarEntry{
                Resource:    discovered.ResourceURL,
                Description: discovered.Description,
                MimeType:    discovered.MimeType,
                Accepts:     []PaymentRequirements{ctx.Requirements},
            })
        }
        return nil
    })
    ```
  </Tab>
</Tabs>

## MCP Hooks

### x402MCPClient (MCP client)

Register hooks on the MCP client for payment lifecycle events specific to tool calls. Use cases include logging payments, enforcing per-tool spending limits or auditing payment receipts.

* **onPaymentRequired** — Runs when a 402 payment required response is received from a tool call. First hook to return a result wins. Return `{ abort: true }` to cancel, `{ payment }` to supply a pre-built payload, or `void` to proceed with normal payment flow.
* **onBeforePayment** — Runs after payment approval but before the payment payload is created.
* **onAfterPayment** — Runs after the payment payload is submitted and the tool result is received.

```typescript
import { x402MCPClient } from "@x402/mcp";

const client = new x402MCPClient(mcpClient, paymentClient);

client
  .onPaymentRequired(async ({ toolName, paymentRequired }) => {
    if (blocklist.has(toolName)) {
      return { abort: true };
    }
    // Return undefined to proceed with normal payment flow
  })
  .onBeforePayment(async ({ toolName, paymentRequired }) => {
    console.log(`Creating payment for tool: ${toolName}`);
  })
  .onAfterPayment(async ({ toolName, paymentPayload, result, settleResponse }) => {
    await auditLog.record({
      tool: toolName,
      transaction: settleResponse?.transaction,
    });
  });
```

### x402MCPServer payment wrapper (MCP server)

Register hooks in the `PaymentWrapperConfig.hooks` object when creating a payment wrapper. Use cases include rate limiting, logging tool executions or sending payment receipts.

* **onBeforeExecution** — Runs after payment verification, before the tool handler executes. Return `false` to abort execution.
* **onAfterExecution** — Runs after the tool handler returns, before settlement.
* **onAfterSettlement** — Runs after successful payment settlement.

```typescript
import { createPaymentWrapper } from "@x402/mcp";

const paid = createPaymentWrapper(resourceServer, {
  accepts,
  hooks: {
    onBeforeExecution: async ({ toolName, paymentPayload }) => {
      if (await isRateLimited(paymentPayload.payer)) {
        return false; // Abort execution
      }
    },
    onAfterExecution: async ({ toolName, result }) => {
      console.log(`Tool ${toolName} executed successfully`);
    },
    onAfterSettlement: async ({ settlement }) => {
      await sendReceipt({ transaction: settlement.transaction });
    },
  },
});
```

## Hook Chaining

Hooks can be chained when registering multiple handlers:

<Tabs>
  <Tab title="TypeScript">
    ```typescript
    server
      .onBeforeVerify(validatePayment)
      .onAfterVerify(logVerification)
      .onBeforeSettle(checkBalance)
      .onAfterSettle(recordTransaction);
    ```
  </Tab>
  <Tab title="Python">
    ```python
    (
        server
        .on_before_verify(validate_payment)
        .on_after_verify(log_verification)
        .on_before_settle(check_balance)
        .on_after_settle(record_transaction)
    )
    ```
  </Tab>
  <Tab title="Go">
    ```go
    server.
        OnBeforeVerify(validatePayment).
        OnAfterVerify(logVerification).
        OnBeforeSettle(checkBalance).
        OnAfterSettle(recordTransaction)
    ```
  </Tab>
</Tabs>

---

Next, explore:

* [Client / Server](/core-concepts/client-server) — roles and responsibilities
* [Facilitator](/core-concepts/facilitator) — verification and settlement service
