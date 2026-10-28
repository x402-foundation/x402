# Solana browser batch client and wallet diagnostic

This example pairs a connected Kit browser signer with the shared batch client. Its diagnostic compares binary and proposed readable payer proofs without making a payment. The `text-v1` format is a draft in this branch. It requires matching support in each participating deployment.

## Enable readable proofs on the servers

The facilitator must first enable and advertise support:

```ts
import { BatchSvmScheme } from "@x402/svm/batch-settlement/facilitator";

const scheme = new BatchSvmScheme(facilitatorSigner, {
  authorizationFormats: ["binary", "text-v1"],
  // Retain the deployment's existing durable stores and other options.
});
```

Then the resource server opts in:

```ts
import { BatchSvmScheme } from "@x402/svm/batch-settlement/server";

const scheme = new BatchSvmScheme({
  operator,
  receiverAuthorizer,
  authorizationFormat: "text-v1",
  // Retain the resource server's existing stores and other options.
});
```

Resource-server requirement initialization throws if its facilitator does not advertise the configured format; it does not silently fall back to binary. Each validator checks the proof format against the accepted requirements. Binary remains the default, and unknown formats are rejected.

## Connect a browser signer to the shared client

Pass the connected Kit signer from your wallet integration, for example the signer returned by `useConnectedWallet()` after configuring `walletSigner({ chain: "solana:mainnet" })` in Kit's wallet plugin:

```ts
import type { MessageSigner, TransactionSigner } from "@solana/kit";
import { BatchSvmScheme, toBatchClientSigner } from "@x402/svm/batch-settlement/client";

function batchClient(wallet: TransactionSigner & MessageSigner, trustedOperator: string) {
  return new BatchSvmScheme(toBatchClientSigner(wallet), {
    serverSignedChannelsPolicy: {
      allowedOperators: [trustedOperator],
      maxDeposit: "$1",
    },
    // Supply channelStorage to preserve pending allocations across reloads.
  });
}
```

Register this scheme with your normal x402 client for the chosen Solana network. Obtain the trusted operator key out of band: a readable prompt does not remove the operator's existing authority over the escrow. The shared client uses the format advertised in `extra.authorizationFormat` for deposit, top-up, steady-state authorization, and refund. Custom controllers can pass that same format to `buildDepositPayload({ authorizationFormat, ... })` and `tracker.authorization(requestId, amount, expiry, authorizationFormat)`.

`toBatchClientSigner` supports Kit partial and modifying message signers. It exposes only the verified `signMessages` method for message signing, forwards independent copies of the message, and verifies the Ed25519 signature against the original bytes. Both a changed returned message and a signature over different bytes cause an error. There is no automatic text retry following a failed binary prompt.

## Run the expired-proof diagnostic

From `examples/typescript`, install/build the workspace dependencies using the repository's normal workflow, then:

```sh
cd clients/solana-batch-wallet
pnpm build
pnpm start
```

Open `http://127.0.0.1:3203` in the browser containing MetaMask, Solflare, Phantom, or Backpack. Select the wallet, connect, enter the extension version and installed Solana Snap version where applicable, and sign each diagnostic proof separately. Download the capture JSON.

The page uses Wallet Standard discovery and the upstream `signBatchAuthorization` helper. Each proof has `expiresAt: 1`, a random nonexistent channel and operator, and a random request ID. It requests no transaction, makes no payment or RPC call, and sends no captured output off the page. The local server binds to loopback, and its content security policy blocks network connections from the page.

The capture records original and returned bytes, input after the wallet call, signature, public key, and verification against both original and returned messages. It separately labels the simulated UTF-8 conversion candidate. The wallet's API version is recorded separately from manually confirmed extension/Snap versions. A successful capture establishes message-signing compatibility only; funded channel lifecycle tests remain separate.

## Compatibility evidence as of October 23, 2026

| Wallet | Existing binary payer proof | Draft readable proof |
| --- | --- | --- |
| MetaMask 13.53.0 (Blockrun binary capture) | [Reporter capture](https://github.com/MetaMask/internal-snaps/issues/506) independently verifies only against the lossy UTF-8 candidate, while returned bytes equal input. Official release locks Snap 7.0.0; runtime Snap version unqueried. | A separate installed-wallet capture below passes; versions for that capture remain unconfirmed. |
| Solflare 2.40.1 | Reporter says original-byte signing works, with an unreadable-message warning. Independent capture pending. | Installed-wallet test pending. |
| Phantom 26.34.0 (Chrome) | Local canonical binary proof rejected through Wallet Standard and the direct provider with a hex display hint. | Live expired text-v1 proof signs with unchanged bytes; independent Node crypto verification passes. |
| Phantom 25.16.0 (Firefox) | Local Wallet Standard test rejects the canonical binary proof with `You cannot sign solana transactions using sign message`. | Local expired-proof capture passes; returned bytes match the original and the signature independently verifies with Node crypto. |
| Backpack | Wallet documents message signing; no current-version capture of this exact proof yet. | Installed-wallet test pending. |

Phantom 26.34.0 was also tested live on supported Chrome. The canonical binary proof is rejected through both Wallet Standard and the direct provider's `signMessage(originalBytes, "hex")` path; the latter changes only the display hint. The same authorization fields in draft `text-v1` sign successfully, with unchanged returned bytes and independent Node crypto verification. Both proofs have `expiresAt: 1`, and neither diagnostic makes a payment or RPC call. This establishes message-signing behavior in the tested version; funded channel lifecycle validation remains separate.

Phantom no longer supports Firefox; its older 25.16.0 result is retained separately from the Chrome result. See [Phantom supported platforms](https://help.phantom.com/articles/48456789393811).

Wallet documentation: [Solflare signing](https://docs.solflare.com/solflare/technical/deeplinks/provider-methods/signmessage), [Backpack signing](https://docs.backpack.app/deeplinks/provider-methods/signmessage). Their `display` hint controls presentation, not a conversion of the signed proof into hex text. General signing documentation does not establish compatibility with every binary proof, extension version, hardware wallet, or adapter.

## Standard off-chain envelope tests (October 23, 2026)

Neither installed MetaMask nor Phantom exposed `solana:signOffchainMessage`, including after connection. Passing a Solana standard off-chain message (OCMS) v1 envelope to `solana:signMessage` did not provide a working alternative:

| Installed wallet | OCMS v1 through `solana:signMessage` | Matching `text-v1` authorization |
| --- | --- | --- |
| MetaMask (extension/Snap versions unconfirmed for this capture) | Returned the original 437 bytes, but its signature verified only against the 459-byte lossy UTF-8 conversion. Verification against the original and returned bytes failed. | Preserved all 387 bytes; signature verified against both original and returned bytes. The authorization fields were identical to the envelope test. |
| Phantom (extension version unconfirmed for this capture) | Rejected with `You cannot sign solana transactions using sign message`. | Earlier Chrome text-proof results are recorded separately above. |

Independent Node.js Ed25519 verification confirmed the captured signatures. Every authorization expired at Unix time 1 and used a random nonexistent channel. These tests made no payment, transaction, RPC, or facilitator calls. They establish signing behavior only; exact extension/Snap versions and full payment lifecycle compatibility still require confirmation. Wallet Standard feature versions are not extension versions.

Keep `text-v1` opt-in. Native off-chain signing is a future compatibility option once wallets expose a compatible feature; sending its binary envelope through `signMessage` is not a working replacement on these installed wallets. Refunds use the matching advertised accept before signing, including when client mode is listed first or channel state is restored after a restart.

## Blockrun follow-up

In an [October 27 report](https://github.com/x402-foundation/x402/pull/3905#issuecomment-6436981573), Blockrun says MetaMask, Solflare, and Phantom all preserved the expired `text-v1` message bytes and passed independent Node.js Ed25519 verification, including matching the public key to the payer address. The raw captures and exact installed extension/Snap versions remain to be collected; this is reporter evidence, not a new author-run test. Backpack and funded lifecycle tests remain pending.

Blockrun is building Franklin Agent, a browser AI chat application where users pay for model and tool calls with USDC. Batch channels avoid an onchain transaction for every call. The current client still signs a fresh payer authorization for each paid request; one approval covering multiple requests would require a separate session-authorization design. Readable proofs change the signed representation, not how many requests a proof authorizes.
