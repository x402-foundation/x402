# Batch-Settlement Hedera Scheme (`@x402/hedera/batch-settlement`)

The **batch-settlement** scheme enables high-throughput, low-cost payments on Hedera via **stateless unidirectional payment channels**, with the same mechanics as the EVM implementation: clients deposit HTS tokens (e.g. USDC) into an onchain escrow once, then sign off-chain **cumulative vouchers** per request. Servers verify vouchers with a fast signature check and claim them onchain in batches; claimed funds are swept to the receiver with a separate `settle` call.

What is Hedera-native:

- **Any Hedera key type.** Vouchers, claim batches, refunds and deposit authorizations are raw ED25519 or ECDSA account signatures, verified onchain by the Hedera Account Service (HIP-632 `isAuthorizedRaw`).
- **HTS allowance deposits.** The payer grants the deposit collector an HTS allowance once (`AccountAllowanceApproveTransaction`); each deposit is a signed authorization that binds the channel. No Permit2 / ERC-3009.
- **HAPI transport.** The facilitator submits `ContractExecuteTransaction`s from its own account and reads state from the Mirror Node. Clients never submit transactions during a paid request.

See the [scheme specification](../../../../../../specs/schemes/batch-settlement/scheme_batch_settlement_hedera.md) for the protocol and the [EVM scheme README](../../../evm/src/batch-settlement/README.md) for the shared channel-manager / deposit-policy concepts.

## Import Paths

| Role | Import |
| --- | --- |
| Shared (signers, addresses, constants) | `@x402/hedera/batch-settlement` |
| Client | `@x402/hedera/batch-settlement/client` |
| Server | `@x402/hedera/batch-settlement/server` |
| Facilitator | `@x402/hedera/batch-settlement/facilitator` |

## Deployments

| Network | Escrow | Collector |
| --- | --- | --- |
| `hedera:testnet` | [`0.0.10463847`](https://hashscan.io/testnet/contract/0.0.10463847) (Sourcify verified) | [`0.0.10463851`](https://hashscan.io/testnet/contract/0.0.10463851) (Sourcify verified) |

Escrow (`x402BatchSettlementHedera`) and collector (`HederaAllowanceDepositCollector`) addresses are configured per network in `BATCH_SETTLEMENT_DEPLOYMENTS`. Use `registerBatchSettlementDeployment(network, { settlement, settlementId, collector, collectorId })` to point the SDK at your own deployment (see `scripts/deploy-batch-settlement.ts`).

## Client Usage

```typescript
import { x402Client } from "@x402/core/client";
import { createClientHederaBatchSigner, parseHederaPrivateKey } from "@x402/hedera/batch-settlement";
import { BatchSettlementHederaScheme, ensureHtsAllowance } from "@x402/hedera/batch-settlement/client";

const network = "hedera:testnet";
const key = parseHederaPrivateKey(process.env.HEDERA_PRIVATE_KEY!); // ED25519 or ECDSA (DER, raw or 0x hex)

// One-time: allow the deposit collector to pull USDC deposits from this account.
await ensureHtsAllowance({
  network,
  ownerAccountId: "0.0.1111",
  ownerPrivateKey: key,
  tokenId: "0.0.429274",
  required: 10_000_000n,
});

const signer = await createClientHederaBatchSigner("0.0.1111", key, { network });
const scheme = new BatchSettlementHederaScheme(signer, { depositPolicy: { depositMultiplier: 5 } });

const client = new x402Client();
client.register("hedera:*", scheme);
```

Prerequisites for the payer account: associated with the token, holds enough USDC for the deposit, single ED25519 or ECDSA key (threshold / key-list accounts are not supported), HTS allowance to the network's collector.

A separate voucher signer (`voucherSigner` option) can be committed as `payerAuthorizer`; cooperative refunds work as in the EVM scheme (`scheme.refund(url, { amount })`).

## Server Usage

```typescript
import { x402ResourceServer } from "@x402/core/server";
import { createHederaAuthorizerSigner, parseHederaPrivateKey } from "@x402/hedera/batch-settlement";
import { BatchSettlementHederaScheme } from "@x402/hedera/batch-settlement/server";
import { FileChannelStorage } from "@x402/hedera/batch-settlement/server/file-storage";

const network = "hedera:testnet";
const scheme = new BatchSettlementHederaScheme("0.0.5001" /* payTo account */, {
  receiverAuthorizerSigner: await createHederaAuthorizerSigner("0.0.5002", parseHederaPrivateKey(AUTH_KEY), { network }),
  withdrawDelay: 86400,
  storage: new FileChannelStorage({ directory: "./channels" }),
});

const server = new x402ResourceServer(facilitatorClient).register(network, scheme);
const manager = scheme.createChannelManager(facilitatorClient, network);
manager.start({ claimIntervalSecs: 60, settleIntervalSecs: 300, refundIntervalSecs: 3600, maxClaimsPerBatch: 25 });
```

Route `payTo` is the server's Hedera account id and `asset` an HTS token id; `$` prices resolve to USDC. The receiver account must be associated with the token. Plain vouchers are verified locally by resolving the payer's key from the Mirror Node (`localVoucherVerification`, `mirrorNodeUrl` options).

## Facilitator Usage

```typescript
import { x402Facilitator } from "@x402/core/facilitator";
import { createFacilitatorHederaBatchSigner, createHederaAuthorizerSigner, parseHederaPrivateKey } from "@x402/hedera/batch-settlement";
import { BatchSettlementHederaScheme } from "@x402/hedera/batch-settlement/facilitator";

const signer = createFacilitatorHederaBatchSigner({
  accountId: "0.0.9001",
  privateKey: parseHederaPrivateKey(process.env.HEDERA_PRIVATE_KEY!),
  network: "hedera:testnet",
});
const authorizer = await createHederaAuthorizerSigner("0.0.9002", parseHederaPrivateKey(AUTH_KEY), { network: "hedera:testnet" }); // optional

new x402Facilitator().register("hedera:testnet", new BatchSettlementHederaScheme(signer, authorizer));
```

The facilitator account pays gas for `deposit`, `claimWithSignature`, `settle` and `refundWithSignature`; gas limits come from `HEDERA_GAS` and can be overridden via the scheme config. Calls are simulated through the Mirror Node before submission (`simulateBeforeSend`). A facilitator that advertises a `receiverAuthorizer` must authenticate refund requests (see the spec).

## Deploying the contracts

```bash
cd contracts/evm && forge build
cd typescript/packages/mechanisms/hedera
HEDERA_OPERATOR_ID=0.0.x HEDERA_OPERATOR_KEY=... HEDERA_NETWORK=hedera:testnet pnpm deploy:batch-settlement
```

The script deploys both contracts with unlimited automatic token associations, associates the escrow with USDC, and prints the `BATCH_SETTLEMENT_DEPLOYMENTS` entry.
