---
title: "Migration Guide: V1 to V2"
description: "This guide helps you migrate from x402 V1 to V2. The V2 protocol introduces standardized identifiers, improved type safety, and a more modular architecture."
---

## Overview

| Aspect | V1 | V2 |
|--------|----|----|
| Payment Header | `X-PAYMENT` | `PAYMENT-SIGNATURE` |
| Response Header | `X-PAYMENT-RESPONSE` | `PAYMENT-RESPONSE` |
| Network Format | String (`base-sepolia`) | CAIP-2 (`eip155:84532`) |
| Version Field | `x402Version: 1` | `x402Version: 2` |
| Packages | `x402`, `x402-express`, `x402-axios` | `@x402/core`, `@x402/express`, `@x402/axios`, `@x402/evm` |

## For Buyers

### Before (V1)

<Tabs>
  <Tab title="TypeScript">
    ```typescript
    import { withPaymentInterceptor } from "x402-axios";
    import { createWalletClient, http } from "viem";
    import { privateKeyToAccount } from "viem/accounts";
    import { baseSepolia } from "viem/chains";
    import axios from "axios";

    const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);
    const walletClient = createWalletClient({
      account,
      chain: baseSepolia,
      transport: http(),
    });

    // V1 pattern
    const api = withPaymentInterceptor(
      axios.create({ baseURL: "https://api.example.com" }),
      walletClient,
    );

    const response = await api.get("/paid-endpoint");
    ```
  </Tab>
  <Tab title="Python">
    ```python
    import os

    from eth_account import Account

    from x402.clients.httpx import x402HttpxClient

    # V1 pattern
    account = Account.from_key(os.getenv("PRIVATE_KEY"))

    async with x402HttpxClient(account=account, base_url="https://api.example.com") as client:
        response = await client.get("/protected-endpoint")
        print(await response.aread())
    ```
  </Tab>
</Tabs>

### After (V2)

<Tabs>
  <Tab title="TypeScript">
    ```typescript
    import { x402Client, wrapAxiosWithPayment } from "@x402/axios";
    import { ExactEvmScheme } from "@x402/evm/exact/client";
    import { privateKeyToAccount } from "viem/accounts";
    import axios from "axios";

    const signer = privateKeyToAccount(process.env.EVM_PRIVATE_KEY as `0x${string}`);

    // V2 pattern: Create client and register scheme using the builder pattern
    const client = new x402Client();
    client.register("eip155:*", new ExactEvmScheme(signer));

    // Wrap axios with payment handling
    const api = wrapAxiosWithPayment(
      axios.create({ baseURL: "https://api.example.com" }),
      client,
    );

    const response = await api.get("/paid-endpoint");
    ```
  </Tab>
  <Tab title="Python">
    ```python
    import asyncio
    import os

    from eth_account import Account

    from x402 import x402Client
    from x402.http import x402HTTPClient
    from x402.http.clients import x402HttpxClient
    from x402.mechanisms.evm import EthAccountSigner
    from x402.mechanisms.evm.exact.register import register_exact_evm_client


    async def main() -> None:
        # V2 pattern: Create client and register scheme separately
        client = x402Client()
        account = Account.from_key(os.getenv("EVM_PRIVATE_KEY"))
        register_exact_evm_client(client, EthAccountSigner(account))

        http_client = x402HTTPClient(client)

        async with x402HttpxClient(client) as http:
            response = await http.get("https://api.example.com/paid-endpoint")
            await response.aread()

            print(f"Response: {response.text}")

            if response.is_success:
                settle_response = http_client.get_payment_settle_response(
                    lambda name: response.headers.get(name)
                )
                print(f"Payment settled: {settle_response}")


    asyncio.run(main())
    ```
  </Tab>
</Tabs>

### Key Changes

<Tabs>
  <Tab title="TypeScript">
    1. **Package rename**: `x402-axios` → `@x402/axios`
    2. **Function rename**: `withPaymentInterceptor` → `wrapAxiosWithPayment`
    3. **Wallet setup**: Use `x402Client` with `.register()` builder pattern instead of passing wallet directly
    4. **No chain-specific configuration**: The V2 client automatically handles network selection based on payment requirements
  </Tab>
  <Tab title="Python">
    1. **Import path changes**: `x402.clients.httpx` → `x402.http.clients`
    2. **Signer wrapper**: Wrap `eth_account.Account` with `EthAccountSigner`
    3. **Client construction**: Create `x402Client()` first, then register schemes
    4. **Environment variable**: `PRIVATE_KEY` → `EVM_PRIVATE_KEY`
    5. **Async/Sync variants**: Use `x402Client` for httpx (async), `x402ClientSync` for requests (sync)
  </Tab>
</Tabs>

## For Sellers

### Before (V1)

<Tabs>
  <Tab title="TypeScript">
    ```typescript
    import { paymentMiddleware, FacilitatorConfig } from "x402-express";
    import express from "express";

    const app = express();

    const facilitatorConfig: FacilitatorConfig = {
      url: "https://x402.org/facilitator",
    };

    app.use(
      paymentMiddleware(facilitatorConfig, {
        "GET /weather": {
          price: "$0.001",
          network: "base-sepolia", // V1 string format
          config: {
            description: "Get weather data",
          },
        },
      }),
    );
    ```
  </Tab>
  <Tab title="Python">
    ```python
    from typing import Any, Dict

    from fastapi import FastAPI

    from x402.fastapi.middleware import require_payment

    app = FastAPI()

    # V1 pattern
    app.middleware("http")(
        require_payment(
            path="/weather",
            price="$0.001",
            pay_to_address="0xYourAddress",
            network="base-sepolia",  # V1 string identifier
        )
    )

    @app.get("/weather")
    async def get_weather() -> Dict[str, Any]:
        return {"report": {"weather": "sunny", "temperature": 70}}
    ```
  </Tab>
</Tabs>

### After (V2)

<Tabs>
  <Tab title="TypeScript">
    ```typescript
    import express from "express";
    import { paymentMiddleware } from "@x402/express";
    import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
    import { ExactEvmScheme } from "@x402/evm/exact/server";

    const app = express();
    const payTo = "0xYourAddress";

    // V2 pattern: Create facilitator client and resource server
    const facilitatorClient = new HTTPFacilitatorClient({
      url: "https://x402.org/facilitator"
    });

    const server = new x402ResourceServer(facilitatorClient);
    server.register("eip155:*", new ExactEvmScheme());

    app.use(
      paymentMiddleware(
        {
          "GET /weather": {
            accepts: [
              {
                scheme: "exact",
                price: "$0.001",
                network: "eip155:84532", // V2 CAIP-2 format
                payTo,
              },
            ],
            description: "Get weather data",
            mimeType: "application/json",
          },
        },
        server,
      ),
    );
    ```
  </Tab>
  <Tab title="Python">
    ```python
    from typing import Any

    from fastapi import FastAPI

    from x402.http import FacilitatorConfig, HTTPFacilitatorClient, PaymentOption
    from x402.http.middleware.fastapi import PaymentMiddlewareASGI
    from x402.http.types import RouteConfig
    from x402.mechanisms.evm.exact import ExactEvmServerScheme
    from x402.server import x402ResourceServer

    app = FastAPI()

    # V2 pattern: Create facilitator client and resource server
    facilitator = HTTPFacilitatorClient(
        FacilitatorConfig(url="https://x402.org/facilitator")
    )

    server = x402ResourceServer(facilitator)
    server.register("eip155:84532", ExactEvmServerScheme())

    # V2: Route config uses accepts array with explicit scheme, network, and pay_to
    routes: dict[str, RouteConfig] = {
        "GET /weather": RouteConfig(
            accepts=[
                PaymentOption(
                    scheme="exact",
                    pay_to="0xYourAddress",
                    price="$0.001",
                    network="eip155:84532",  # V2 CAIP-2 format
                ),
            ],
            mime_type="application/json",
            description="Get weather data",
        ),
    }

    app.add_middleware(PaymentMiddlewareASGI, routes=routes, server=server)


    @app.get("/weather")
    async def get_weather() -> dict[str, Any]:
        return {"report": {"weather": "sunny", "temperature": 70}}
    ```
  </Tab>
</Tabs>

### Key Changes

<Tabs>
  <Tab title="TypeScript">
    1. **Package rename**: `x402-express` → `@x402/express`
    2. **Configuration structure**: Route config now uses `accepts` array with explicit `scheme`, `network`, and `payTo`
    3. **Network format**: `base-sepolia` → `eip155:84532` (CAIP-2 standard)
    4. **Resource server**: Create `x402ResourceServer` with facilitator client and register schemes using the `.register()` builder pattern
    5. **Price recipient**: Explicitly specify `payTo` address per route
  </Tab>
  <Tab title="Python">
    1. **Import path changes**: `x402.fastapi.middleware` → `x402.http.middleware.fastapi`
    2. **Middleware pattern**: `require_payment` decorator → `PaymentMiddlewareASGI` class
    3. **Configuration structure**: Route config now uses `RouteConfig` and `PaymentOption` Pydantic models
    4. **Network format**: `base-sepolia` → `eip155:84532` (CAIP-2 standard)
    5. **Resource server**: Create `x402ResourceServer` and register schemes explicitly
    6. **Type hints**: Use modern Python type hints (`dict[str, Any]` instead of `Dict[str, Any]`)
    7. **Async/Sync variants**: Use `x402ResourceServer` + `HTTPFacilitatorClient` for FastAPI (async), use `x402ResourceServerSync` + `HTTPFacilitatorClientSync` for Flask (sync)
  </Tab>
</Tabs>

### Schema Declaration

In V2, hand-rolling `extensions.bazaar.schema` on a route config passes through `@x402/core` unchanged but fails silently during discovery-crawler verification, because the required envelope fields (`type`, `method`, `bodyType`, `body` for input; `type`, `example` for output) are only populated by the `declareDiscoveryExtension()` helper from `@x402/extensions/bazaar`. V1 declared these as `config.inputSchema` / `config.outputSchema` and relied on middleware forwarding; V2 requires the helper and spreads its return value into `extensions.bazaar`. See the [Bazaar Discovery Extension](/extensions/bazaar) documentation for full helper usage.

## Network Identifier Mapping

| V1 Name | V2 CAIP-2 ID | Chain ID | Description |
|---------|--------------|----------|-------------|
| `base-sepolia` | `eip155:84532` | 84532 | Base Sepolia Testnet |
| `base` | `eip155:8453` | 8453 | Base Mainnet |
| `ethereum` | `eip155:1` | 1 | Ethereum Mainnet |
| `sepolia` | `eip155:11155111` | 11155111 | Ethereum Sepolia Testnet |
| `solana-devnet` | `solana:devnet` | - | Solana Devnet |
| `solana` | `solana:mainnet` | - | Solana Mainnet |

## Package Migration Reference

<Tabs>
  <Tab title="TypeScript">
    | V1 Package | V2 Package(s) |
    |------------|---------------|
    | `x402` | `@x402/core` |
    | `x402-express` | `@x402/express` |
    | `x402-axios` | `@x402/axios` |
    | `x402-fetch` | `@x402/fetch` |
    | `x402-hono` | `@x402/hono` |
    | `x402-next` | `@x402/next` |
    | (built-in) | `@x402/evm` (EVM support) |
    | (built-in) | `@x402/svm` (Solana support) |
  </Tab>
  <Tab title="Python">
    | V1 Import Path | V2 Import Path |
    |----------------|----------------|
    | `x402.clients.httpx` | `x402.http.clients.x402HttpxClient` |
    | `x402.clients.requests` | `x402.http.clients.x402_requests` |
    | `x402.fastapi.middleware` | `x402.http.middleware.fastapi` |
    | `x402.flask.middleware` | `x402.http.middleware.flask` |
    | `x402.facilitator` | `x402.http.HTTPFacilitatorClient` |
    | (new) | `x402.mechanisms.evm.EthAccountSigner` |
    | (new) | `x402.mechanisms.evm.exact.register_exact_evm_client` |
    | (new) | `x402.mechanisms.svm.KeypairSigner` |
    | (new) | `x402.mechanisms.svm.exact.register_exact_svm_client` |
    | (new) | `x402.server.x402ResourceServer` |

    **Installation with extras:**

    ```bash
    # V1
    pip install x402

    # V2 - install with specific extras
    pip install "x402[httpx]"      # For async HTTP clients
    pip install "x402[requests]"   # For sync HTTP clients
    pip install "x402[fastapi]"    # For FastAPI servers
    pip install "x402[flask]"      # For Flask servers
    pip install "x402[svm]"        # For Solana support
    ```
  </Tab>
</Tabs>

## Header Changes

If you're implementing custom HTTP handling, update your header names:

<Tabs>
  <Tab title="TypeScript">
    ```typescript
    // V1
    const payment = req.header("X-PAYMENT");
    res.setHeader("X-PAYMENT-RESPONSE", responseData);

    // V2
    const payment = req.header("PAYMENT-SIGNATURE");
    res.setHeader("PAYMENT-RESPONSE", responseData);
    ```
  </Tab>
  <Tab title="Python">
    ```python
    # V1
    payment = request.headers.get("X-PAYMENT")
    response.headers["X-PAYMENT-RESPONSE"] = response_data

    # V2
    payment = request.headers.get("PAYMENT-SIGNATURE")
    response.headers["PAYMENT-RESPONSE"] = response_data
    ```
  </Tab>
</Tabs>

## Troubleshooting

<Tabs>
  <Tab title="TypeScript">
    ### "Cannot find module" errors

    Ensure you've installed all V2 packages:

    ```bash
    # For buyers
    npm install @x402/axios @x402/evm

    # For sellers (Express)
    npm install @x402/express @x402/core @x402/evm
    ```
  </Tab>
  <Tab title="Python">
    ### "ModuleNotFoundError" errors

    Ensure you've installed the x402 package with the correct extras:

    ```bash
    # For async HTTP clients (httpx)
    pip install "x402[httpx]"

    # For sync HTTP clients (requests)
    pip install "x402[requests]"

    # For FastAPI servers
    pip install "x402[fastapi]"

    # For Flask servers
    pip install "x402[flask]"

    # For Solana support
    pip install "x402[svm]"
    ```
  </Tab>
</Tabs>

### Payment verification failures

- Check you're using CAIP-2 network identifiers (`eip155:84532` not `base-sepolia`)
- Verify your `payTo` address is correctly configured
- Ensure the facilitator URL is correct for your network (testnet vs mainnet)

### Mixed V1/V2 compatibility

The facilitator supports both V1 and V2 protocols. During migration, your V2 server can still accept payments from V1 clients, but we recommend updating clients to V2 for full feature support.

## Next Steps

- [Quickstart for Buyers](/getting-started/quickstart-for-buyers)
- [Quickstart for Sellers](/getting-started/quickstart-for-sellers)
- [Network and Token Support](/core-concepts/network-and-token-support)
