# Sign-In-With-X Extension

This package provides Go support for the `sign-in-with-x` extension.

It includes:

- Extension declaration helpers
- `SIGN-IN-WITH-X` header encoding and parsing
- SIWE message construction for `eip155:*` chains
- SIWS message construction for `solana:*` chains
- SIWX payload validation
- EVM EOA EIP-191 signature verification
- Optional EVM smart wallet verification through EIP-1271 and EIP-6492
- Solana Ed25519 signature verification
- Server-side storage, request hooks, and settle hooks
- Client-side EVM and Solana SIWX payload/header creation
- HTTP client extension hooks that attempt SIWX auth before payment

## Server

```go
storage := signinwithx.NewInMemoryStorage()
extension := signinwithx.MustCreateResourceServerExtension(signinwithx.ServerOptions{
    Storage: storage,
})

server := x402http.Newx402HTTPResourceServer(routes)
server.RegisterExtension(extension)
```

To verify smart wallet signatures, provide an EVM contract verifier. An
`ethclient.Client` satisfies the `siwe-go` caller interface used for deployed
EIP-1271 and counterfactual EIP-6492 verification.

```go
contractVerifier := siwe.NewEthCallerVerifier(ethClient)
extension := signinwithx.MustCreateResourceServerExtension(signinwithx.ServerOptions{
    Storage: storage,
    VerifyOptions: signinwithx.VerifyOptions{
        EVMContractVerifier: contractVerifier,
    },
})
```

Routes declare SIWX through `Extensions`. Auth-only routes use an empty
`Accepts` list and rely on the SIWX protected-request hook.

```go
Extensions: map[string]interface{}{
    signinwithx.ExtensionKey: signinwithx.DeclareExtension(signinwithx.DeclareOptions{
        Networks: []string{"eip155:8453", signinwithx.SolanaMainnet},
    })[signinwithx.ExtensionKey],
}
```

## Client

```go
signer, _ := evmsigner.NewClientSignerFromPrivateKey(privateKey)
evmSigner := signer.(signinwithx.EVMSigner)

x402Client := x402.Newx402Client().
    RegisterExtension(signinwithx.CreateClientExtension(evmSigner))
httpClient := x402http.Newx402HTTPClient(x402Client)
```

For multi-chain clients, pass ordered chain-aware signers. The first compatible
signer for the server declaration is used.

```go
x402Client := x402.Newx402Client().
    RegisterExtension(signinwithx.CreateClientExtensionWithSigners(
        signinwithx.NewSolanaSIWXSigner(solanaSigner),
        signinwithx.NewEVMSIWXSigner(evmSigner),
    ))
```

The HTTP client first tries to satisfy a `sign-in-with-x` challenge by sending a
`SIGN-IN-WITH-X` header. If auth fails, the normal x402 payment flow continues.
