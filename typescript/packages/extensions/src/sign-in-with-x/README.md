# Sign-In-With-X (SIWx) extension

Part of [`@x402/extensions`](../README.md). Import from `@x402/extensions/sign-in-with-x`.

The Sign-In-With-X extension implements [CAIP-122](https://chainagnostic.org/CAIPs/caip-122) for chain-agnostic wallet authentication. It allows clients to prove control of a wallet that previously paid for a resource, enabling access without repurchase.

## How It Works

1. Server returns 402 with `sign-in-with-x` extension containing challenge parameters
2. Client signs the CAIP-122 message with their wallet
3. Client sends signed proof in `SIGN-IN-WITH-X` header
4. Server verifies signature and grants access either because the route is auth-only or because the wallet has previously paid

## Server Usage

### Recommended: Extension Factories

```typescript
import {
  declareSIWxExtension,
  createSIWxResourceServerExtension,
  InMemorySIWxStorage,
} from '@x402/extensions/sign-in-with-x';

// Storage for tracking paid addresses
const storage = new InMemorySIWxStorage();

// Register extension
const resourceServer = new x402ResourceServer(facilitatorClient)
  .register(NETWORK, new ExactEvmScheme())
  .registerExtension(createSIWxResourceServerExtension({ storage }));

// Declare SIWX support in routes
const routes = {
  "GET /data": {
    accepts: [{scheme: "exact", price: "$0.01", network: "eip155:8453", payTo}],
    extensions: declareSIWxExtension({
      statement: 'Sign in to access your purchased content',
    }),
  },
  "GET /profile": {
    accepts: [],
    extensions: declareSIWxExtension({
      network: ["eip155:8453", "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"],
      statement: 'Sign in to view your profile',
      expirationSeconds: 300,
    }),
  },
};

// Optional: Enable smart wallet support (EIP-1271/EIP-6492)
import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';

const publicClient = createPublicClient({ chain: base, transport: http() });
const resourceServerWithSmartWallets = new x402ResourceServer(facilitatorClient)
  .register(NETWORK, new ExactEvmScheme())
  .registerExtension(createSIWxResourceServerExtension({
    storage,
    verifyOptions: { evmVerifier: publicClient.verifyMessage },
  }));
```

The server extension derives challenge fields from request context, records successful payments, and validates SIWX proofs for declared HTTP routes.

### Manual Usage (Advanced)

```typescript
import {
  declareSIWxExtension,
  parseSIWxHeader,
  validateSIWxMessage,
  verifySIWxSignature,
} from '@x402/extensions/sign-in-with-x';

// 1. Declare in PaymentRequired response
const extensions = declareSIWxExtension({
  domain: 'api.example.com',
  resourceUri: 'https://api.example.com/data',
  network: 'eip155:8453',
  statement: 'Sign in to access your purchased content',
});

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
  if (await isAuthOnlyRoute(request) || await checkPaymentHistory(verification.address)) {
    // Grant access
  }
}
```

## Client Usage

### Recommended: Client Extension

```typescript
import { createSIWxClientExtension } from '@x402/extensions/sign-in-with-x';
import { x402HTTPClient } from '@x402/fetch';

client.registerExtension(createSIWxClientExtension({ signers: [signer] }));
const httpClient = new x402HTTPClient(client);

// Requests automatically use SIWX auth when server supports it
const response = await httpClient.fetch(url);
```

The client extension automatically:
- Detects SIWX support in 402 responses
- Matches your wallet's chain with server's `supportedChains`
- Signs and sends the authentication proof
- Falls back to payment if SIWX auth fails

### Manual Usage (Advanced)

```typescript
import {
  createSIWxPayload,
  encodeSIWxHeader,
} from '@x402/extensions/sign-in-with-x';

// 1. Get extension and network from 402 response
const paymentRequired = await response.json();
const extension = paymentRequired.extensions['sign-in-with-x'];
const paymentNetwork = paymentRequired.accepts[0]?.network; // undefined for auth-only routes

// 2. Find matching chain in supportedChains
const matchingChain = paymentNetwork
  ? extension.supportedChains.find(chain => chain.chainId === paymentNetwork)
  : extension.supportedChains[0];

if (!matchingChain) {
  // No chain supported by this signer / route combination
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

## SIWx API Reference

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

**Automatic derivation:** When using `createSIWxResourceServerExtension`, omitted fields are derived:
- `network` → from `accepts[].network` in route config
- `resourceUri` → from request URL
- `domain` → parsed from resourceUri

For auth-only routes declared with `accepts: []`, `network` cannot be inferred from payment requirements and should be provided explicitly.

**Multi-chain support:** When `network` is an array (or multiple networks in `accepts`), `supportedChains` will contain one entry per network.

### `createSIWxResourceServerExtension(options)`

Creates the server extension that enriches SIWX challenges, records successful payments, and verifies HTTP SIWX proofs for declared routes.

### `createSIWxClientExtension({ signers })`

Creates the client extension that signs compatible SIWX challenges before falling back to payment.

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

**Smart Wallet Support (EIP-1271 / EIP-6492):**

By default, only EOA (Externally Owned Account) signatures are verified. To support smart contract wallets (like Coinbase Smart Wallet, Safe, etc.), pass `publicClient.verifyMessage` from viem:

```typescript
import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';

const publicClient = createPublicClient({
  chain: base,
  transport: http()
});

// In your request hook
const result = await verifySIWxSignature(payload, {
  evmVerifier: publicClient.verifyMessage,
});
```

This enables:
- **EIP-1271**: Verification of deployed smart contract wallets
- **EIP-6492**: Verification of counterfactual (not-yet-deployed) wallets

Note: Smart wallet verification requires RPC calls, while EOA verification is purely local.

### `createSIWxPayload(serverInfo, signer)`

Client helper that creates and signs a complete payload.

### `encodeSIWxHeader(payload)`

Encodes a payload as base64 for the SIGN-IN-WITH-X header.

### `SIGN_IN_WITH_X`

Extension identifier constant (`"sign-in-with-x"`).

## Supported Signature Schemes

| Scheme | Description |
|--------|-------------|
| `eip191` | personal_sign (default for EVM EOAs) |
| `eip1271` | Smart contract wallet verification |
| `eip6492` | Counterfactual smart wallet verification |
| `siws` | Sign-In-With-Solana |

## Troubleshooting

### SIWx signature verification fails

**Problem:** `verifySIWxSignature` returns `valid: false`.

**Solutions:**

- Ensure the message was signed with the correct wallet
- Check that the signature scheme matches the wallet type
- For smart wallets, enable `checkSmartWallet` option with a provider

### SIWx message validation fails

**Problem:** `validateSIWxMessage` returns `valid: false`.

**Solutions:**

- Check that `issuedAt` is recent (within `maxAge`, default 5 minutes)
- Verify `expirationTime` has not passed
- Ensure `domain` matches the server's domain
- Confirm `uri` matches the resource URI

## Related resources

- [CAIP-122 specification](https://chainagnostic.org/CAIPs/caip-122) — Sign-In-With-X standard
