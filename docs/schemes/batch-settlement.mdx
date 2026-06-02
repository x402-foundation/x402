---
title: "Batch Settlement"
description: "High-throughput EVM payments with escrow, off-chain vouchers, and batched onchain redemption."
---

The `batch-settlement` scheme is for high-throughput payments where many requests are authorized individually and redeemed later in batches. The EVM implementation uses stateless unidirectional payment channels: a buyer deposits funds into onchain escrow once, then signs off-chain cumulative vouchers for each request. The seller verifies vouchers quickly and redeems them onchain later in batches.

Use `batch-settlement` for repeated paid API calls, usage-metered endpoints, and other workloads where many small payments would be too expensive or slow to settle one-by-one.

### How It Works

1. **Deposit:** the client opens or tops up a channel by depositing ERC-20 funds into escrow. Deposits use EIP-3009 or Permit2 and are submitted by the facilitator.
2. **Voucher:** each paid request includes a signed cumulative voucher for the channel's total claimable amount.
3. **Verify:** the server verifies the voucher and serves the response without waiting for an onchain transfer.
4. **Claim:** the server's channel manager periodically claims the latest vouchers from many channels in one transaction.
5. **Settle:** claimed funds are swept to the receiver in a separate settle transaction.
6. **Refund:** idle channels can be cooperatively refunded after outstanding vouchers are claimed.

The route `price` is still a per-request maximum. For dynamic pricing, the server can charge less than that maximum with settlement overrides.

### Server Setup

Register the scheme with a resource server, protect routes with `scheme: "batch-settlement"`, configure server-side channel storage, and run a channel manager to claim, settle, and refund channels.

<Tabs>
  <Tab title="TypeScript">
    ```typescript
    import { HTTPFacilitatorClient } from "@x402/core/server";
    import { BatchSettlementEvmScheme } from "@x402/evm/batch-settlement/server";
    import { FileChannelStorage } from "@x402/evm/batch-settlement/server/file-storage";
    import { paymentMiddleware, setSettlementOverrides, x402ResourceServer } from "@x402/express";

    const network = "eip155:84532" as const;
    const facilitatorClient = new HTTPFacilitatorClient({ url: process.env.FACILITATOR_URL! });

    const batchScheme = new BatchSettlementEvmScheme(receiverAddress, {
      receiverAuthorizerSigner,
      withdrawDelay: 86400,
      storage: new FileChannelStorage({ directory: "./channels" }),
    });

    const resourceServer = new x402ResourceServer(facilitatorClient)
      .register(network, batchScheme);

    const channelManager = batchScheme.createChannelManager(facilitatorClient, network);
    channelManager.start({
      claimIntervalSecs: 60,
      settleIntervalSecs: 300,
      refundIntervalSecs: 3600,
      maxClaimsPerBatch: 100,
    });

    app.use(paymentMiddleware({
      "GET /weather": {
        accepts: {
          scheme: "batch-settlement",
          price: "$0.01",
          network,
          payTo: receiverAddress,
        },
        description: "Weather data",
        mimeType: "application/json",
      },
    }, resourceServer));

    app.get("/weather", (req, res) => {
      setSettlementOverrides(res, { amount: "50%" });
      res.json({ report: { weather: "sunny", temperature: 70 } });
    });
    ```
  </Tab>
  <Tab title="Go">
    ```go
    cfg := &batchedserver.BatchSettlementEvmSchemeServerConfig{
        ReceiverAuthorizerSigner: receiverAuthorizerSigner,
        WithdrawDelay:            86400,
        Storage: batchedserver.NewFileChannelStorage(batchsettlement.FileChannelStorageOptions{
            Directory: "./channels",
        }),
    }

    scheme := batchedserver.NewBatchSettlementEvmScheme(receiverAddress, cfg)
    manager := scheme.CreateChannelManager(facilitatorClient, x402.Network("eip155:84532"))
    manager.Start(batchedserver.AutoSettlementConfig{
        ClaimIntervalSecs:  60,
        SettleIntervalSecs: 300,
        RefundIntervalSecs: 3600,
        MaxClaimsPerBatch:  100,
    })

    routes := x402http.RoutesConfig{
        "GET /weather": {
            Accepts: x402http.PaymentOptions{
                {
                    Scheme:  batchsettlement.SchemeBatched,
                    Price:   "$0.01",
                    Network: x402.Network("eip155:84532"),
                    PayTo:   receiverAddress,
                },
            },
            Description: "Weather data",
            MimeType:    "application/json",
        },
    }

    mux.HandleFunc("GET /weather", func(w http.ResponseWriter, r *http.Request) {
        nethttpmw.SetSettlementOverrides(w, &x402.SettlementOverrides{Amount: "50%"})
        _ = json.NewEncoder(w).Encode(map[string]any{
            "report": map[string]any{"weather": "sunny", "temperature": 70},
        })
    })
    ```
  </Tab>
  <Tab title="Python">
    ```python
    from x402 import x402ResourceServer
    from x402.http import FacilitatorConfig, HTTPFacilitatorClient
    from x402.http.middleware.fastapi import payment_middleware, set_settlement_overrides
    from x402.mechanisms.evm.batch_settlement import SCHEME_BATCH_SETTLEMENT
    from x402.mechanisms.evm.batch_settlement.authorizer_signer import LocalAuthorizerSigner
    from x402.mechanisms.evm.batch_settlement.server import (
        AutoSettlementConfig,
        BatchSettlementEvmScheme,
        BatchSettlementEvmSchemeServerConfig,
        FileChannelStorage,
    )

    network = "eip155:84532"
    facilitator = HTTPFacilitatorClient(FacilitatorConfig(url=FACILITATOR_URL))

    scheme_config = BatchSettlementEvmSchemeServerConfig(
        withdraw_delay=86400,
        receiver_authorizer_signer=LocalAuthorizerSigner(RECEIVER_AUTH_KEY),
        storage=FileChannelStorage("./channels"),
    )
    scheme = BatchSettlementEvmScheme(receiver_address, scheme_config)

    server = x402ResourceServer(facilitator)
    server.register(network, scheme)

    manager = scheme.create_channel_manager(facilitator, network)
    manager.start(AutoSettlementConfig(
        claim_interval_secs=60,
        settle_interval_secs=300,
        refund_interval_secs=3600,
        max_claims_per_batch=100,
    ))

    routes = {
        "GET /weather": {
            "accepts": {
                "scheme": SCHEME_BATCH_SETTLEMENT,
                "payTo": receiver_address,
                "price": "$0.01",
                "network": network,
            },
        },
    }

    @app.middleware("http")
    async def x402_payment_middleware(request, call_next):
        return await payment_middleware(routes, server)(request, call_next)

    @app.get("/weather")
    async def weather(response):
        set_settlement_overrides(response, {"amount": "50%"})
        return {"report": {"weather": "sunny", "temperature": 70}}
    ```
  </Tab>
</Tabs>

### Server Storage

Server storage keeps the latest voucher and channel session state that the channel manager uses to claim, settle, and refund later. In-memory storage is useful for local demos, but production servers should configure durable storage so outstanding vouchers survive restarts.

Use file storage for single-process deployments. For serverless or multi-instance deployments, use Redis/Valkey storage so channel updates are shared atomically across processes. See the [Next.js batch-settlement Redis example](https://github.com/x402-foundation/x402/tree/main/examples/typescript/fullstack/next-batch-settlement-redis) for a full `withX402` setup with `RedisChannelStorage` and cron-based claim/settle routes.

### Client Setup

Register `BatchSettlementEvmScheme` for `eip155:*`. The client SDK handles deposits, voucher signing, channel recovery, and corrective 402 resync.

<Tabs>
  <Tab title="TypeScript">
    ```typescript
    import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
    import { toClientEvmSigner } from "@x402/evm";
    import { BatchSettlementEvmScheme } from "@x402/evm/batch-settlement/client";
    import { createPublicClient, http } from "viem";
    import { baseSepolia } from "viem/chains";
    import { privateKeyToAccount } from "viem/accounts";

    const account = privateKeyToAccount(process.env.EVM_PRIVATE_KEY as `0x${string}`);
    const publicClient = createPublicClient({ chain: baseSepolia, transport: http() });
    const signer = toClientEvmSigner(account, publicClient);

    const batchScheme = new BatchSettlementEvmScheme(signer, {
      depositPolicy: { depositMultiplier: 5 },
    });

    const client = new x402Client();
    client.register("eip155:*", batchScheme);

    const fetchWithPayment = wrapFetchWithPayment(fetch, client);
    const response = await fetchWithPayment("https://api.example.com/weather");
    ```
  </Tab>
  <Tab title="Go">
    ```go
    import (
        x402 "github.com/x402-foundation/x402/go/v2"
        x402http "github.com/x402-foundation/x402/go/v2/http"
        "github.com/ethereum/go-ethereum/ethclient"
        batchedclient "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement/client"
        evmsigners "github.com/x402-foundation/x402/go/v2/signers/evm"
    )

    ethClient, err := ethclient.Dial("https://sepolia.base.org")
    if err != nil {
        log.Fatal(err)
    }

    evmSigner, err := evmsigners.NewClientSignerFromPrivateKeyWithClient(os.Getenv("EVM_PRIVATE_KEY"), ethClient)
    if err != nil {
        log.Fatal(err)
    }

    batchScheme := batchedclient.NewBatchSettlementEvmScheme(evmSigner, &batchedclient.BatchSettlementEvmSchemeOptions{
        DepositMultiplier: 5,
    })

    x402Client := x402.Newx402Client().
        Register("eip155:*", batchScheme)

    httpClient := x402http.WrapHTTPClientWithPayment(
        http.DefaultClient,
        x402http.Newx402HTTPClient(x402Client),
    )
    ```
  </Tab>
  <Tab title="Python">
    ```python
    import httpx
    from eth_account import Account
    from x402 import x402Client
    from x402.http.clients import x402_httpx_transport
    from x402.mechanisms.evm import EthAccountSignerWithRPC
    from x402.mechanisms.evm.batch_settlement.client import (
        BatchSettlementDepositPolicy,
        BatchSettlementEvmScheme,
        BatchSettlementEvmSchemeOptions,
        InMemoryClientChannelStorage,
    )

    account = Account.from_key(EVM_PRIVATE_KEY)
    signer = EthAccountSignerWithRPC(account, rpc_url="https://sepolia.base.org")

    batch_scheme = BatchSettlementEvmScheme(
        signer,
        BatchSettlementEvmSchemeOptions(
            deposit_policy=BatchSettlementDepositPolicy(deposit_multiplier=5),
            storage=InMemoryClientChannelStorage(),
        ),
    )
    client = x402Client().register("eip155:*", batch_scheme)

    async with httpx.AsyncClient(transport=x402_httpx_transport(client)) as http:
        response = await http.get("https://api.example.com/weather")
    ```
  </Tab>
</Tabs>

### Deposit Policy

The deposit policy controls how much the client deposits when a channel needs funding or top-up.

| Field | Description |
|-------|-------------|
| `depositMultiplier` / `DepositMultiplier` | Deposits `amount x multiplier` for the advertised per-request maximum. The default is `5`; the minimum is `3`. |
| `depositStrategy` / `DepositStrategy` | Optional callback for caps, dynamic deposits, or opting out of automatic top-up. |

<Tabs>
  <Tab title="TypeScript">
    ```typescript
    const maxDeposit = 1_000_000n;

    const batchScheme = new BatchSettlementEvmScheme(signer, {
      depositPolicy: { depositMultiplier: 5 },
      depositStrategy: ({ depositAmount }) => {
        const amount = BigInt(depositAmount);
        return amount > maxDeposit ? maxDeposit : undefined;
      },
    });
    ```
  </Tab>
  <Tab title="Go">
    ```go
    batchScheme := batchedclient.NewBatchSettlementEvmScheme(evmSigner, &batchedclient.BatchSettlementEvmSchemeOptions{
        DepositMultiplier: 5,
        DepositStrategy: func(_ context.Context, c batchedclient.DepositStrategyContext) (batchedclient.DepositStrategyResult, error) {
            capped, _ := new(big.Int).SetString("1000000", 10)
            proposed, _ := new(big.Int).SetString(c.DepositAmount, 10)
            if proposed.Cmp(capped) > 0 {
                return batchedclient.DepositStrategyResult{Amount: capped.String()}, nil
            }
            return batchedclient.DepositStrategyResult{}, nil
        },
    })
    ```
  </Tab>
  <Tab title="Python">
    ```python
    from x402.mechanisms.evm.batch_settlement.client import (
        BatchSettlementDepositPolicy,
        BatchSettlementEvmScheme,
        BatchSettlementEvmSchemeOptions,
    )

    max_deposit = 1_000_000

    batch_scheme = BatchSettlementEvmScheme(
        signer,
        BatchSettlementEvmSchemeOptions(
            deposit_policy=BatchSettlementDepositPolicy(deposit_multiplier=5),
            deposit_strategy=lambda ctx: str(max_deposit) if int(ctx.deposit_amount) > max_deposit else None,
        ),
    )
    ```
  </Tab>
</Tabs>

### Voucher Signer Delegation

By default, vouchers are signed by the payer key. For higher-throughput clients, especially smart wallets using EIP-1271, delegate voucher signing to a dedicated EOA. The delegated address is committed into the channel as `payerAuthorizer`, which lets the facilitator verify vouchers with ECDSA recovery instead of an onchain smart-wallet signature check.

<Tabs>
  <Tab title="TypeScript">
    ```typescript
    const voucherSigner = toClientEvmSigner(
      privateKeyToAccount(process.env.EVM_VOUCHER_SIGNER_PRIVATE_KEY as `0x${string}`),
    );

    const batchScheme = new BatchSettlementEvmScheme(signer, {
      voucherSigner,
    });
    ```
  </Tab>
  <Tab title="Go">
    ```go
    voucherSigner, err := evmsigners.NewClientSignerFromPrivateKey(os.Getenv("EVM_VOUCHER_SIGNER_PRIVATE_KEY"))
    if err != nil {
        log.Fatal(err)
    }

    batchScheme := batchedclient.NewBatchSettlementEvmScheme(evmSigner, &batchedclient.BatchSettlementEvmSchemeOptions{
        VoucherSigner: voucherSigner,
    })
    ```
  </Tab>
  <Tab title="Python">
    ```python
    from eth_account import Account
    from x402.mechanisms.evm.signers import EthAccountSigner
    from x402.mechanisms.evm.batch_settlement.client import (
        BatchSettlementEvmScheme,
        BatchSettlementEvmSchemeOptions,
    )

    voucher_signer = EthAccountSigner(Account.from_key(EVM_VOUCHER_SIGNER_PRIVATE_KEY))

    batch_scheme = BatchSettlementEvmScheme(
        signer,
        BatchSettlementEvmSchemeOptions(voucher_signer=voucher_signer),
    )
    ```
  </Tab>
</Tabs>

### Client Persistence and Refunds

Client channel state is stored in memory by default. Persistent client storage is optional because the SDK can recover channel state through corrective 402 responses and onchain state on the next paid request. Long-lived clients can still persist state to avoid that recovery round trip after restarts.

<Tabs>
  <Tab title="TypeScript">
    ```typescript
    import { FileClientChannelStorage } from "@x402/evm/batch-settlement/client/file-storage";

    const batchScheme = new BatchSettlementEvmScheme(signer, {
      storage: new FileClientChannelStorage({ directory: "./channels" }),
    });

    await batchScheme.refund("https://api.example.com/weather");
    await batchScheme.refund("https://api.example.com/weather", { amount: "1000000" });
    ```
  </Tab>
  <Tab title="Go">
    ```go
    import "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"

    batchScheme := batchedclient.NewBatchSettlementEvmScheme(evmSigner, &batchedclient.BatchSettlementEvmSchemeOptions{
        Storage: batchedclient.NewFileClientChannelStorage(batchsettlement.FileChannelStorageOptions{
            Directory: "./channels",
        }),
    })

    settle, err := batchScheme.Refund(ctx, "https://api.example.com/weather", &batchedclient.RefundOptions{
        Amount: "1000000",
    })
    ```
  </Tab>
  <Tab title="Python">
    ```python
    from x402.mechanisms.evm.batch_settlement.client import (
        BatchSettlementEvmScheme,
        BatchSettlementEvmSchemeOptions,
        FileChannelStorageOptions,
        FileClientChannelStorage,
        RefundOptions,
    )

    batch_scheme = BatchSettlementEvmScheme(
        signer,
        BatchSettlementEvmSchemeOptions(
            storage=FileClientChannelStorage(FileChannelStorageOptions(directory="./channels")),
        ),
    )

    # Full refund
    result = batch_scheme.refund("https://api.example.com/weather")
    # Partial refund
    result = batch_scheme.refund("https://api.example.com/weather", RefundOptions(amount="1000000"))
    ```
  </Tab>
</Tabs>

### Receiver Authorizer

Every channel commits to a `receiverAuthorizer`, which signs claim and refund authorizations.

| Strategy | When to use it |
|----------|----------------|
| Self-managed `receiverAuthorizerSigner` | Recommended for production. Channels survive facilitator changes because any facilitator can relay your signed claims and refunds. |
| Facilitator-delegated authorizer | Simpler to run. If you switch facilitators, claim and refund old channels before opening new ones. |

### Settlement Policy

Choose claim, settle, and refund intervals based on throughput and gas cost:

* Claim often enough that outstanding vouchers are claimed before a payer's timed withdrawal can finalize after `withdrawDelay`.
* Settle less often when gas savings matter more than cash-flow latency.
* Refund idle channels to return unclaimed balance to payers.

Set `withdrawDelay` greater than your claim cadence plus an operational safety margin.

### Examples

* [TypeScript client](https://github.com/x402-foundation/x402/tree/main/examples/typescript/clients/batch-settlement)
* [TypeScript server](https://github.com/x402-foundation/x402/tree/main/examples/typescript/servers/batch-settlement)
* [Next.js server + Redis storage](https://github.com/x402-foundation/x402/tree/main/examples/typescript/fullstack/next-batch-settlement-redis)
* [Go client](https://github.com/x402-foundation/x402/tree/main/examples/go/clients/batch-settlement)
* [Go server](https://github.com/x402-foundation/x402/tree/main/examples/go/servers/batch-settlement)
* [Python client](https://github.com/x402-foundation/x402/tree/main/examples/python/clients/batch-settlement)
* [Python server](https://github.com/x402-foundation/x402/tree/main/examples/python/servers/batch-settlement)
* [Python facilitator](https://github.com/x402-foundation/x402/tree/main/examples/python/facilitator/batch-settlement)

### Specs

* [`batch-settlement` spec](https://github.com/x402-foundation/x402/blob/main/specs/schemes/batch-settlement/scheme_batch_settlement.md)
* [`batch-settlement` EVM spec](https://github.com/x402-foundation/x402/blob/main/specs/schemes/batch-settlement/scheme_batch_settlement_evm.md)

### See Also

* [Payment schemes overview](/schemes/overview)
* [Exact](/schemes/exact)
* [Upto](/schemes/upto)
