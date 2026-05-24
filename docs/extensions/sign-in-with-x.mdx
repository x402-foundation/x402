---
title: "Sign-In-With-X (SIWX)"
description: "CAIP-122 wallet authentication for x402-protected resources. Prove wallet ownership to access previously purchased content without repaying."
---

The Sign-In-With-X (SIWX) extension implements [CAIP-122](https://chainagnostic.org/CAIPs/caip-122) for chain-agnostic wallet authentication. It allows clients to prove control of a wallet that previously paid for a resource, enabling access without requiring repurchase.

## Overview

SIWX solves two key problems in x402:

1. **Repeat access to purchased content**: Without SIWX, clients must pay every time they request a resource. With SIWX, sign in with your wallet to access content you've already paid for.
2. **Auth-only routes**: Protect resources with wallet authentication alone, without requiring payment.

**Key Features:**
* **For Buyers**: Sign in with your wallet to access content you've already paid for, or authenticate to access wallet-gated resources
* **For Sellers**: Grant access to returning customers without requiring repayment, or create auth-only routes that require wallet signatures but no payment
* **Chain-Agnostic**: Works with EVM (Ethereum, Base, etc.) and Solana wallets
* **Standards-Based**: Built on CAIP-122, EIP-4361 (SIWE), and Sign-In-With-Solana

## How It Works

1. **Server** returns 402 with `sign-in-with-x` extension containing challenge parameters
2. **Client** signs the CAIP-122 message with their wallet
3. **Client** sends signed proof in `SIGN-IN-WITH-X` HTTP header
4. **Server** verifies signature and grants access either because:
   - The route is auth-only (requires signature but no payment), or
   - The wallet has previously paid for the resource

This is a **Server ↔ Client** extension. The Facilitator is not involved in the authentication flow.

## Server Usage

### Recommended: Extension Factories

The easiest way to implement SIWX is registering the provided extension factories:

<Tabs>
  <Tab title="TypeScript">
    ```typescript
    import {
      declareSIWxExtension,
      createSIWxResourceServerExtension,
      InMemorySIWxStorage,
    } from '@x402/extensions/sign-in-with-x';
    import { x402ResourceServer } from '@x402/core/server';
    import { HTTPFacilitatorClient } from '@x402/core/http';
    import { ExactEvmScheme } from '@x402/evm/exact/server';

    const NETWORK = 'eip155:8453'; // Base mainnet
    const payTo = '0xYourAddress';

    // Storage for tracking paid addresses
    const storage = new InMemorySIWxStorage();

    const facilitatorClient = new HTTPFacilitatorClient({
      url: 'https://x402.org/facilitator'
    });

    // 1. Register extension
    const resourceServer = new x402ResourceServer(facilitatorClient)
      .register(NETWORK, new ExactEvmScheme())
      .registerExtension(createSIWxResourceServerExtension({ storage }));

    // 2. Declare SIWX support in routes
    const routes = {
      'GET /data': {
        accepts: [{
          scheme: 'exact',
          price: '$0.01',
          network: NETWORK,
          payTo
        }],
        extensions: declareSIWxExtension({
          statement: 'Sign in to access your purchased content',
        }),
      },
      'GET /profile': {
        accepts: [],  // Auth-only route: no payment required
        extensions: declareSIWxExtension({
          network: NETWORK,  // Required for auth-only routes (cannot be inferred from accepts)
          statement: 'Sign in to view your profile',
          expirationSeconds: 300,
        }),
      },
    };

    ```
  </Tab>
  <Tab title="Python">
    ```python
    from x402.extensions.sign_in_with_x import (
        CreateSIWxHookOptions,
        DeclareSIWxOptions,
        InMemorySIWxStorage,
        create_siwx_resource_server_extension,
        declare_siwx_extension,
    )
    from x402.http import FacilitatorConfig, HTTPFacilitatorClient
    from x402.http.middleware.fastapi import PaymentMiddlewareASGI
    from x402.http.types import PaymentOption, RouteConfig
    from x402.mechanisms.evm.exact import ExactEvmServerScheme
    from x402.server import x402ResourceServer

    NETWORK = "eip155:8453"  # Base mainnet
    PAY_TO = "0xYourAddress"

    # Storage for tracking paid addresses
    storage = InMemorySIWxStorage()

    facilitator = HTTPFacilitatorClient(FacilitatorConfig(url="https://x402.org/facilitator"))

    # 1. Register extension
    server = x402ResourceServer(facilitator)
    server.register(NETWORK, ExactEvmServerScheme())
    server.register_extension(
        create_siwx_resource_server_extension(CreateSIWxHookOptions(storage=storage))
    )

    # 2. Declare SIWX support in routes
    routes = {
        "GET /data": RouteConfig(
            accepts=[PaymentOption(scheme="exact", price="$0.01", network=NETWORK, pay_to=PAY_TO)],
            extensions=declare_siwx_extension(),
        ),
        "GET /profile": RouteConfig(
            accepts=[],  # Auth-only route: no payment required
            extensions=declare_siwx_extension(
                DeclareSIWxOptions(
                    network=[NETWORK],  # Required for auth-only routes
                    statement="Sign in to view your profile",
                    expiration_seconds=300,
                )
            ),
        ),
    }

    # 3. Add middleware to your FastAPI app
    app.add_middleware(PaymentMiddlewareASGI, routes=routes, server=server)
    ```
  </Tab>
</Tabs>

The server extension derives `network` from `accepts`, derives `domain`/`uri` from the request URL, refreshes nonce/timestamps per request, records successful payments, and validates SIWX proofs for declared HTTP routes.

**Auth-only routes** (declared with `accepts: []`) grant access based on a valid SIWX signature alone, without requiring payment. This is useful for wallet-gated content that doesn't need micropayments.

### Smart Wallet Support (EIP-1271 / EIP-6492)

By default, only EOA (Externally Owned Account) signatures are verified. To support smart contract wallets (like Coinbase Smart Wallet, Safe, etc.), pass a verifier via `verifyOptions`:

<Tabs>
  <Tab title="TypeScript">
    ```typescript
    import { createPublicClient, http } from 'viem';
    import { base } from 'viem/chains';

    const publicClient = createPublicClient({
      chain: base,
      transport: http()
    });

    const resourceServer = new x402ResourceServer(facilitatorClient)
      .register(NETWORK, new ExactEvmScheme())
      .registerExtension(createSIWxResourceServerExtension({
        storage,
        verifyOptions: { evmVerifier: publicClient.verifyMessage },
      }));
    ```
  </Tab>
  <Tab title="Python">
    ```python
    from web3 import Web3
    from x402.extensions.sign_in_with_x import (
        CreateSIWxHookOptions,
        SIWxVerifyOptions,
        create_siwx_resource_server_extension,
    )

    provider = Web3(Web3.HTTPProvider("https://mainnet.base.org")).provider

    server.register_extension(
        create_siwx_resource_server_extension(
            CreateSIWxHookOptions(
                storage=storage,
                verify_options=SIWxVerifyOptions(provider=provider),
            )
        )
    )
    ```
  </Tab>
</Tabs>

This enables:
- **EIP-1271**: Verification of deployed smart contract wallets
- **EIP-6492**: Verification of counterfactual (not-yet-deployed) wallets

Note: Smart wallet verification requires RPC calls, while EOA verification is purely local.

### Using Hook Adapters Directly

If you need more control over the integration, you can use the individual hook adapter functions instead of `createSIWxResourceServerExtension`. This is useful when you want to attach SIWX behavior to an existing server setup:

<Tabs>
  <Tab title="TypeScript">
    ```typescript
    import {
      createSIWxSettleHook,
      createSIWxRequestHook,
      InMemorySIWxStorage,
    } from '@x402/extensions/sign-in-with-x';
    import { x402ResourceServer } from '@x402/core/server';
    import { x402HTTPResourceServer } from '@x402/core/http';

    const storage = new InMemorySIWxStorage();

    // Attach settle hook to record payments after settlement
    const resourceServer = new x402ResourceServer(facilitatorClient)
      .register(NETWORK, new ExactEvmScheme())
      .onAfterSettle(createSIWxSettleHook({ storage }));

    // Attach request hook to validate SIWX proofs on incoming requests
    const httpServer = new x402HTTPResourceServer(resourceServer, routes)
      .onProtectedRequest(createSIWxRequestHook({ storage }));
    ```
  </Tab>
</Tabs>

Similarly, on the client side you can use `createSIWxClientHook` for a single signer, or attach it directly to an HTTP client:

<Tabs>
  <Tab title="TypeScript">
    ```typescript
    import { createSIWxClientHook } from '@x402/extensions/sign-in-with-x';
    import { x402HTTPClient } from '@x402/fetch';
    import { privateKeyToAccount } from 'viem/accounts';

    const signer = privateKeyToAccount(process.env.EVM_PRIVATE_KEY as `0x${string}`);

    const httpClient = new x402HTTPClient(client)
      .onPaymentRequired(createSIWxClientHook(signer));
    ```
  </Tab>
</Tabs>

### Manual Usage (Advanced)

For custom implementations, you can use the low-level functions directly:

<Tabs>
  <Tab title="TypeScript">
    ```typescript
    import {
      declareSIWxExtension,
      parseSIWxHeader,
      validateSIWxMessage,
      verifySIWxSignature,
      SIGN_IN_WITH_X,
    } from '@x402/extensions/sign-in-with-x';

    // 1. Declare in PaymentRequired response
    const extensions = {
      [SIGN_IN_WITH_X]: declareSIWxExtension({
        domain: 'api.example.com',
        resourceUri: 'https://api.example.com/data',
        network: 'eip155:8453',
        statement: 'Sign in to access your purchased content',
      }),
    };

    // 2. Verify incoming proof
    async function handleRequest(request: Request) {
      const header = request.headers.get('SIGN-IN-WITH-X');
      if (!header) return; // No auth provided

      // Parse the header
      const payload = parseSIWxHeader(header);

      // Validate message fields (expiry, nonce, domain, etc.)
      const validation = await validateSIWxMessage(
        payload,
        'https://api.example.com/data'
      );
      if (!validation.valid) {
        return { error: validation.error };
      }

      // Verify signature and recover address
      const verification = await verifySIWxSignature(payload);
      if (!verification.valid) {
        return { error: verification.error };
      }

      // verification.address is the verified wallet
      // Grant access for auth-only routes or if wallet has paid
      const isAuthOnly = await checkIfAuthOnlyRoute(request);
      const hasPaid = await checkPaymentHistory(verification.address);
      if (isAuthOnly || hasPaid) {
        // Grant access
      }
    }
    ```
  </Tab>
</Tabs>

## Client Usage

### Recommended: Client Extension

The easiest way to use SIWX as a client is with the provided client extension:

<Tabs>
  <Tab title="TypeScript">
    ```typescript
    import { createSIWxClientExtension } from '@x402/extensions/sign-in-with-x';
    import { x402HTTPClient } from '@x402/fetch';
    import { x402Client } from '@x402/core/client';
    import { privateKeyToAccount } from 'viem/accounts';

    const signer = privateKeyToAccount(process.env.EVM_PRIVATE_KEY as `0x${string}`);
    const client = new x402Client();

    client.registerExtension(createSIWxClientExtension({ signers: [signer] }));
    const httpClient = new x402HTTPClient(client);

    // Requests automatically use SIWX auth when server supports it
    const response = await httpClient.fetch('https://api.example.com/data');
    ```
  </Tab>
  <Tab title="Python">
    ```python
    from eth_account import Account
    from x402 import x402Client
    from x402.extensions.sign_in_with_x import (
        CreateSIWxClientExtensionOptions,
        create_siwx_client_extension,
    )
    from x402.http.clients import x402HttpxClient
    from x402.mechanisms.evm import EthAccountSigner
    from x402.mechanisms.evm.exact.register import register_exact_evm_client

    account = Account.from_key("0xYourPrivateKey")
    client = x402Client()
    register_exact_evm_client(client, EthAccountSigner(account))

    client.register_extension(
        create_siwx_client_extension(CreateSIWxClientExtensionOptions(signers=[account]))
    )

    async with x402HttpxClient(client) as http:
        # Requests automatically use SIWX auth when server supports it
        response = await http.get("https://api.example.com/data")
    ```
  </Tab>
</Tabs>

The client extension automatically:
- Detects SIWX support in 402 responses
- Matches your wallet's chain with server's `supportedChains`
- Signs and sends the authentication proof
- Falls back to payment if SIWX auth fails

### Manual Usage (Advanced)

For custom implementations:

<Tabs>
  <Tab title="TypeScript">
    ```typescript
    import {
      createSIWxPayload,
      encodeSIWxHeader,
    } from '@x402/extensions/sign-in-with-x';

    // 1. Get extension and network from 402 response
    const paymentRequired = await response.json();
    const extension = paymentRequired.extensions['sign-in-with-x'];
    const paymentNetwork = paymentRequired.accepts[0].network; // e.g., "eip155:8453"

    // 2. Find matching chain in supportedChains
    const matchingChain = extension.supportedChains.find(
      chain => chain.chainId === paymentNetwork
    );

    if (!matchingChain) {
      throw new Error('Chain not supported');
    }

    // 3. Build complete info with selected chain
    const completeInfo = {
      ...extension.info,
      chainId: matchingChain.chainId,
      type: matchingChain.type,
    };

    // 4. Create signed payload
    const payload = await createSIWxPayload(completeInfo, signer);

    // 5. Encode and send
    const header = encodeSIWxHeader(payload);
    const response = await fetch(url, {
      headers: { 'SIGN-IN-WITH-X': header }
    });
    ```
  </Tab>
</Tabs>

## Multi-Chain Support

Servers can support multiple chains (e.g., both EVM and Solana) by including multiple entries in `supportedChains`:

<Tabs>
  <Tab title="TypeScript">
    ```typescript
    const routes = {
      'GET /data': {
        accepts: [
          {
            scheme: 'exact',
            price: '$0.01',
            network: 'eip155:8453', // Base
            payTo: '0xYourAddress'
          },
          {
            scheme: 'exact',
            price: '$0.01',
            network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', // Solana mainnet
            payTo: 'YourSolanaAddress'
          }
        ],
        extensions: declareSIWxExtension({
          network: ['eip155:8453', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'],
          statement: 'Sign in to access your purchased content',
        }),
      },
    };
    ```
  </Tab>
</Tabs>

Clients match their wallet's `chainId` against `supportedChains` and use the first matching entry. The same `nonce` is shared across all chains, preventing replay attacks when authenticating with different wallets.

## Supported Chains

### EVM (Ethereum, Base, Polygon, etc.)

- **Chain ID Format**: `eip155:*` (e.g., `eip155:8453` for Base)
- **Signature Type**: `eip191`
- **Signature Schemes**: 
  - `eip191` (EOA - default)
  - `eip1271` (smart contract wallet)
  - `eip6492` (counterfactual wallet)
- **Message Format**: [EIP-4361 (SIWE)](https://eips.ethereum.org/EIPS/eip-4361)

### Solana

- **Chain ID Format**: `solana:*` (e.g., `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` for mainnet)
- **Signature Type**: `ed25519`
- **Signature Scheme**: `siws`
- **Message Format**: [Sign-In With Solana](https://github.com/phantom/sign-in-with-solana)

## API Reference

### `declareSIWxExtension(options?)`

Creates the extension declaration for servers to include in PaymentRequired. Most fields are derived automatically from request context when using `createSIWxResourceServerExtension`.

```typescript
declareSIWxExtension({
  // All fields optional - derived from context if omitted
  domain?: string;                     // Server domain (derived from request URL)
  resourceUri?: string;                // Full resource URI (derived from request URL)
  network?: string | string[];         // CAIP-2 network(s) (derived from accepts[].network)
  statement?: string;                  // Human-readable purpose
  version?: string;                    // CAIP-122 version (default: "1")
  expirationSeconds?: number;          // Challenge TTL in seconds
})
```

**Note for auth-only routes:** When using `accepts: []`, the `network` parameter cannot be inferred from payment requirements and must be provided explicitly.

### `createSIWxResourceServerExtension(options)`

Creates the server extension that enriches SIWX challenges, records successful payments, and verifies HTTP SIWX proofs for declared routes. Internally uses `createSIWxSettleHook` and `createSIWxRequestHook`.

### `createSIWxSettleHook(options)`

Creates an `onAfterSettle` hook that records payments for SIWX. Use this when you want to attach SIWX payment recording to an existing `x402ResourceServer` without registering the full extension.

```typescript
createSIWxSettleHook({
  storage: SIWxStorage;          // Storage for tracking paid addresses
  onEvent?: (event) => void;     // Optional callback for logging/debugging
})
// Returns: hook function for x402ResourceServer.onAfterSettle()
```

### `createSIWxRequestHook(options)`

Creates an `onProtectedRequest` hook that validates SIWX proofs on incoming HTTP requests. For paid routes, grants access when the signature is valid and the address has paid. For auth-only routes (`accepts: []`), grants access on a valid signature alone.

```typescript
createSIWxRequestHook({
  storage: SIWxStorage;                  // Storage for tracking paid addresses
  verifyOptions?: SIWxVerifyOptions;     // Optional smart wallet verification settings
  onEvent?: (event) => void;             // Optional callback for logging/debugging
})
// Returns: hook function for x402HTTPResourceServer.onProtectedRequest()
```

### `createSIWxClientHook(signer)`

Creates an `onPaymentRequired` hook for a single wallet signer. Matches the signer type (EVM or Solana) to a compatible chain in the server's `supportedChains` and signs the SIWX challenge.

```typescript
createSIWxClientHook(signer: SIWxSigner)
// Returns: hook function for x402HTTPClient.onPaymentRequired()
```

### `createSIWxClientExtension({ signers })`

Creates the client extension that signs compatible SIWX challenges before falling back to payment. Accepts multiple signers (tried in order until one succeeds).

### `parseSIWxHeader(header)`

Parses a base64-encoded SIGN-IN-WITH-X header into a payload object.

### `validateSIWxMessage(payload, resourceUri, options?)`

Validates message fields (expiry, domain binding, nonce, etc.).

```typescript
validateSIWxMessage(payload, resourceUri, {
  maxAge?: number;                    // Max age for issuedAt (default: 5 min)
  checkNonce?: (nonce) => boolean;    // Custom nonce validation
})
// Returns: { valid: boolean; error?: string }
```

### `verifySIWxSignature(payload, options?)`

Verifies the cryptographic signature and recovers the signer address.

```typescript
verifySIWxSignature(payload, {
  evmVerifier?: EVMMessageVerifier;  // For smart wallet support
})
// Returns: { valid: boolean; address?: string; error?: string }
```

### `createSIWxPayload(serverInfo, signer)`

Client helper that creates and signs a complete payload.

### `encodeSIWxHeader(payload)`

Encodes a payload as base64 for the SIGN-IN-WITH-X header.

### `SIWxHookEvent`

Event type emitted by SIWX hooks when `onEvent` is configured. Useful for logging and debugging:

```typescript
type SIWxHookEvent =
  | { type: "payment_recorded"; resource: string; address: string }
  | { type: "access_granted"; resource: string; address: string }
  | { type: "validation_failed"; resource: string; error?: string }
  | { type: "nonce_reused"; resource: string; nonce: string }
  | { type: "siwx_header_sent"; resource: string };
```

### Storage Interface

Implement `SIWxStorage` to track which wallets have paid:

```typescript
interface SIWxStorage {
  hasPaid(resource: string, address: string): boolean | Promise<boolean>;
  recordPayment(resource: string, address: string): void | Promise<void>;
  // Optional: nonce tracking to prevent signature replay attacks
  hasUsedNonce?(nonce: string): boolean | Promise<boolean>;
  recordNonce?(nonce: string): void | Promise<void>;
}
```

The package includes `InMemorySIWxStorage` for development. For production, implement persistent storage (database, Redis, etc.).

Optionally implement `hasUsedNonce` and `recordNonce` to prevent replay attacks where an intercepted SIWX header could be reused. Both methods must be implemented together — implementing only one will throw an error at startup.

## Security Considerations

- **Domain Binding**: The `domain` field prevents signature reuse across different services
- **Nonce Uniqueness**: Each challenge MUST have a unique nonce to prevent replay attacks
- **Temporal Bounds**: The `issuedAt`, `expirationTime`, and `notBefore` fields constrain signature validity windows
- **Chain-Specific Verification**: Signatures are verified using chain-appropriate algorithms, preventing cross-chain signature reuse
- **Smart Wallet Support**: EIP-1271 and EIP-6492 verification requires an RPC call to the wallet contract

## Troubleshooting

### Signature Verification Fails

**Problem:** `verifySIWxSignature` returns `valid: false`.

**Solutions:**
- Ensure the message was signed with the correct wallet
- Check that the signature scheme matches the wallet type
- For smart wallets, enable `evmVerifier` option with a viem public client
- Verify the chain ID matches between client and server

### Message Validation Fails

**Problem:** `validateSIWxMessage` returns `valid: false`.

**Solutions:**
- Check that `issuedAt` is recent (within `maxAge`, default 5 minutes)
- Verify `expirationTime` hasn't passed
- Ensure `domain` matches the server's domain
- Confirm `uri` matches the resource URI

### Client Hook Not Working

**Problem:** SIWX authentication not being attempted.

**Solutions:**
- Verify server is declaring SIWX extension in 402 response
- Check that client's wallet chain matches one of the `supportedChains`
- Ensure signer is properly configured for the wallet type

## Related Resources

- [CAIP-122 Specification](https://chainagnostic.org/CAIPs/caip-122) - Sign-In-With-X standard
- [EIP-4361 (SIWE)](https://eips.ethereum.org/EIPS/eip-4361) - Sign-In With Ethereum
- [Sign-In With Solana](https://github.com/phantom/sign-in-with-solana)
- [x402 Core Package](https://github.com/x402-foundation/x402/tree/main/typescript/packages/core)
- [Lifecycle Hooks](/advanced-concepts/lifecycle-hooks) - Custom payment flow logic
