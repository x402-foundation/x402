---
title: "EIP-2612 Gas Sponsoring"
description: "Gasless Permit2 approval for ERC-20 tokens that implement EIP-2612. The facilitator submits the permit onchain, so the client never pays gas for the approval step."
---

The EIP-2612 gas sponsoring extension enables gasless Permit2 approval for tokens that implement the [EIP-2612](https://eips.ethereum.org/EIPS/eip-2612) `permit()` function (e.g., USDC). The client signs an off-chain permit authorizing the Permit2 contract, and the facilitator submits it atomically during settlement via `x402ExactPermit2Proxy.settleWithPermit`.

## Overview

When using the Permit2 asset transfer method, the user must first approve the Permit2 contract to spend their tokens. For tokens that support EIP-2612, this approval can be done entirely off-chain:

* **For Buyers**: No gas needed — sign a permit off-chain and the facilitator handles the rest
* **For Sellers**: Advertise this extension so clients using EIP-2612 tokens get a seamless experience
* **For Facilitators**: Accept the permit signature and call `settleWithPermit` to atomically approve + settle in one transaction

## How It Works

1. **Server** advertises `eip2612GasSponsoring` in the `PaymentRequired` response extensions
2. **Client** checks if Permit2 allowance is insufficient; if so, signs an EIP-2612 permit off-chain
3. **Client** includes the permit data in the `extensions.eip2612GasSponsoring.info` field of the payment payload
4. **Facilitator** calls `x402ExactPermit2Proxy.settleWithPermit()`, which atomically submits the EIP-2612 permit and executes the Permit2 transfer in a single transaction

## Server Usage

Advertise support for this extension in your route configuration:

<Tabs>
  <Tab title="TypeScript">
    ```typescript
    import { declareEip2612GasSponsoringExtension } from "@x402/extensions/eip2612-gas-sponsoring";

    const routes = {
      "GET /api/data": {
        accepts: [{
          scheme: "exact",
          network: "eip155:84532",
          price: "$0.01",
          payTo: "0xYourAddress",
        }],
        extensions: {
          ...declareEip2612GasSponsoringExtension(),
        },
      },
    };
    ```
  </Tab>
  <Tab title="Go">
    ```go
    import (
        "github.com/x402-foundation/x402/go/v2/extensions/eip2612gassponsor"
    )

    extensions := eip2612gassponsor.DeclareEip2612GasSponsoringExtension()
    // Include in your route's Extensions field
    ```
  </Tab>
  <Tab title="Python">
    ```python
    from x402.extensions.eip2612_gas_sponsoring import declare_eip2612_gas_sponsoring_extension

    routes = {
        "GET /api/data": {
            "accepts": {
                "scheme": "exact",
                "network": "eip155:84532",
                "price": "$0.01",
                "payTo": "0xYourAddress",
            },
            "extensions": {
                **declare_eip2612_gas_sponsoring_extension(),
            },
        },
    }
    ```
  </Tab>
</Tabs>

## Client Usage

The `ExactEvmScheme` handles EIP-2612 gas sponsoring automatically. When the server advertises this extension and the client's Permit2 allowance is insufficient, the scheme signs the EIP-2612 permit and includes it in the payment payload.

Signing the EIP-2612 permit requires reading `allowance` and `nonces` from the chain. The scheme gets this capability from either:

- A signer that includes `readContract` (e.g., `toClientEvmSigner(account, publicClient)`), or
- An `rpcUrl` passed to `ExactEvmScheme` options

If neither is provided and the server advertises this extension, the scheme logs a warning and skips the permit. A wallet with no Permit2 allowance will then receive a `412 permit2_allowance_required` error.

<Tabs>
  <Tab title="TypeScript">
    ```typescript
    import { ExactEvmScheme } from "@x402/evm/exact/client";

    // Option 1: pass rpcUrl so the scheme can read the chain
    const scheme = new ExactEvmScheme(signer, { rpcUrl: "https://mainnet.base.org" });
    client.register("eip155:*", scheme);

    // Option 2: use a signer that already has readContract
    // const scheme = new ExactEvmScheme(toClientEvmSigner(account, publicClient));

    // The scheme automatically signs an EIP-2612 permit when:
    // 1. The server advertises eip2612GasSponsoring
    // 2. The asset transfer method is "permit2"
    // 3. The client's Permit2 allowance is insufficient
    ```
  </Tab>
  <Tab title="Go">
    ```go
    import (
        exactevm "github.com/x402-foundation/x402/go/v2/mechanisms/evm/exact/client"
        evmsigners "github.com/x402-foundation/x402/go/v2/signers/evm"
    )

    // The signer must be able to read contracts (to check allowance and nonce).
    // Use an RPC-backed signer or configure RPCURL in the scheme options.
    signer, _ := evmsigners.NewClientSignerFromPrivateKeyWithClient(
        os.Getenv("EVM_PRIVATE_KEY"),
        "https://your-rpc.example",
    )

    scheme := exactevm.NewExactEvmScheme(signer, nil)
    // Or configure RPC separately:
    // scheme := exactevm.NewExactEvmScheme(signer, &exactevm.ExactEvmSchemeConfig{
    //     RPCURL: "https://your-rpc.example",
    // })
    client.Register("eip155:*", scheme)

    // EIP-2612 permit signing is handled automatically when the server
    // advertises the extension. If the signer lacks read-contract capability,
    // the extension is skipped and a warning is logged once per network.
    ```
  </Tab>
  <Tab title="Python">
    ```python
    from x402 import x402Client
    from x402.mechanisms.evm import EthAccountSignerWithRPC
    from x402.mechanisms.evm.exact import register_exact_evm_client

    account = Account.from_key("0xYourPrivateKey")
    signer = EthAccountSignerWithRPC(account, rpc_url="https://sepolia.base.org")

    client = x402Client()
    register_exact_evm_client(client, signer)
    # Automatically signs EIP-2612 permit when needed
    ```
  </Tab>
</Tabs>

## When to Use

Use this extension when:

- Your payment token implements EIP-2612 (has a `permit()` function)
- You want fully gasless Permit2 onboarding for your users
- You're using the `permit2` asset transfer method

Common EIP-2612 tokens include USDC, DAI, and many modern ERC-20 tokens.

## SDK Support

| SDK | Supported |
|-----|-----------|
| TypeScript | ✅ |
| Go | ✅ |
| Python | ✅ |
