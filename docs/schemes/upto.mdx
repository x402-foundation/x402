---
title: "Upto"
description: "Usage-based x402 payments where the buyer authorizes a maximum and the seller charges actual usage."
---

The `upto` scheme lets a seller advertise a maximum price for one request, then settle for the actual amount used. The buyer signs once for the maximum, and the server chooses a final amount that is less than or equal to that maximum.

Use `upto` for one-request usage metering, such as LLM token generation, bandwidth, compute time, or dynamic data queries.

### Server Setup

Set the route `price` to the maximum authorized amount. In the handler, use settlement overrides to charge the actual amount.

<Tabs>
  <Tab title="TypeScript">
    ```typescript
    import { paymentMiddleware, setSettlementOverrides, x402ResourceServer } from "@x402/express";
    import { UptoEvmScheme } from "@x402/evm/upto/server";

    const resourceServer = new x402ResourceServer(facilitatorClient)
      .register("eip155:84532", new UptoEvmScheme());

    app.use(paymentMiddleware({
      "GET /api/generate": {
        accepts: {
          scheme: "upto",
          price: "$0.10",
          network: "eip155:84532",
          payTo: "0xYourAddress",
        },
        description: "AI text generation billed by usage",
      },
    }, resourceServer));

    app.get("/api/generate", (req, res) => {
      const actualUsage = computeActualCost();
      setSettlementOverrides(res, { amount: String(actualUsage) });
      res.json({ result: "..." });
    });
    ```
  </Tab>
  <Tab title="Go">
    ```go
    routes := x402http.RoutesConfig{
        "GET /api/generate": {
            Accepts: x402http.PaymentOptions{
                {
                    Scheme:  "upto",
                    Price:   "$0.10",
                    Network: "eip155:84532",
                    PayTo:   "0xYourAddress",
                },
            },
            Description: "AI text generation billed by usage",
        },
    }

    mux.HandleFunc("GET /api/generate", func(w http.ResponseWriter, r *http.Request) {
        actualUsage := computeActualCost()
        nethttpmw.SetSettlementOverrides(w, &x402.SettlementOverrides{
            Amount: fmt.Sprintf("%d", actualUsage),
        })
        _ = json.NewEncoder(w).Encode(map[string]string{"result": "..."})
    })
    ```
  </Tab>
  <Tab title="Python">
    ```python
    from fastapi import FastAPI, Response

    from x402.http import FacilitatorConfig, HTTPFacilitatorClient, PaymentOption
    from x402.http.middleware.fastapi import PaymentMiddlewareASGI, set_settlement_overrides
    from x402.http.types import RouteConfig
    from x402.mechanisms.evm.upto import UptoEvmServerScheme
    from x402.server import x402ResourceServer

    app = FastAPI()
    facilitator = HTTPFacilitatorClient(FacilitatorConfig(url="https://x402.org/facilitator"))

    server = x402ResourceServer(facilitator)
    server.register("eip155:84532", UptoEvmServerScheme())

    routes = {
        "GET /api/generate": RouteConfig(
            accepts=[
                PaymentOption(
                    scheme="upto",
                    price="$0.10",
                    network="eip155:84532",
                    pay_to="0xYourAddress",
                )
            ],
            description="AI text generation billed by usage",
        )
    }

    app.add_middleware(PaymentMiddlewareASGI, routes=routes, server=server)

    @app.get("/api/generate")
    async def generate(response: Response) -> dict[str, str]:
        actual_usage = compute_actual_cost()
        set_settlement_overrides(response, {"amount": str(actual_usage)})
        return {"result": "..."}
    ```
  </Tab>
</Tabs>

### Client Setup

Register `UptoEvmScheme` alongside `ExactEvmScheme` if your client may call both fixed-price and usage-based EVM resources.

<Tabs>
  <Tab title="TypeScript">
    ```typescript
    import { x402Client } from "@x402/core/client";
    import { ExactEvmScheme } from "@x402/evm/exact/client";
    import { UptoEvmScheme } from "@x402/evm/upto/client";
    import { privateKeyToAccount } from "viem/accounts";

    const signer = privateKeyToAccount(process.env.EVM_PRIVATE_KEY as `0x${string}`);

    const client = new x402Client();
    client.register("eip155:*", new ExactEvmScheme(signer));
    client.register("eip155:*", new UptoEvmScheme(signer));
    ```
  </Tab>
  <Tab title="Go">
    ```go
    import (
        x402 "github.com/x402-foundation/x402/go/v2"
        exactevm "github.com/x402-foundation/x402/go/v2/mechanisms/evm/exact/client"
        uptoevm "github.com/x402-foundation/x402/go/v2/mechanisms/evm/upto/client"
        evmsigners "github.com/x402-foundation/x402/go/v2/signers/evm"
    )

    evmSigner, err := evmsigners.NewClientSignerFromPrivateKey(os.Getenv("EVM_PRIVATE_KEY"))
    if err != nil {
        log.Fatal(err)
    }

    x402Client := x402.Newx402Client().
        Register("eip155:*", exactevm.NewExactEvmScheme(evmSigner, nil)).
        Register("eip155:*", uptoevm.NewUptoEvmScheme(evmSigner, nil))
    ```
  </Tab>
  <Tab title="Python">
    ```python
    import os

    from eth_account import Account

    from x402 import x402Client
    from x402.mechanisms.evm import EthAccountSigner
    from x402.mechanisms.evm.exact.register import register_exact_evm_client
    from x402.mechanisms.evm.upto import UptoEvmScheme

    account = Account.from_key(os.getenv("EVM_PRIVATE_KEY"))
    signer = EthAccountSigner(account)

    client = x402Client()
    register_exact_evm_client(client, signer)
    client.register("eip155:*", UptoEvmScheme(signer))
    ```
  </Tab>
</Tabs>

### Settlement Override Formats

`amount` can be expressed as:

| Format | Example | Meaning |
|--------|---------|---------|
| Raw atomic units | `"50000"` | Settle exactly 50,000 token base units |
| Percentage | `"50%"` | Settle 50% of the route maximum |
| Dollar price | `"$0.05"` | Convert a dollar-denominated route price to base units |

Setting the amount to `"0"` means no charge for that request.

### EVM Implementation

`upto` uses Permit2 because the settled amount is not known when the buyer signs. The facilitator advertises a `facilitatorAddress` in the payment requirements, and the client binds the authorization to that facilitator.

### Examples

* [TypeScript server example](https://github.com/x402-foundation/x402/tree/main/examples/typescript/servers/upto)
* [Go server example](https://github.com/x402-foundation/x402/tree/main/examples/go/servers/upto)

### Specs

* [`upto` spec](https://github.com/x402-foundation/x402/blob/main/specs/schemes/upto/scheme_upto.md)
* [`upto` EVM spec](https://github.com/x402-foundation/x402/blob/main/specs/schemes/upto/scheme_upto_evm.md)

### See Also

* [Payment schemes overview](/schemes/overview)
* [Exact](/schemes/exact)
* [Batch settlement](/schemes/batch-settlement)
