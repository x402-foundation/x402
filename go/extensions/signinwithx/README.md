# Sign-In-With-X Extension

This package provides Go support for the `sign-in-with-x` extension.

It includes:

- Extension declaration helpers
- `SIGN-IN-WITH-X` header encoding and parsing
- SIWE message construction for `eip155:*` chains
- SIWX payload validation
- EVM EOA EIP-191 signature verification
- Server-side storage, request hooks, and settle hooks
- Client-side EVM SIWX payload/header creation
- HTTP client retry hooks that attempt SIWX auth before payment

## Server

```go
storage := signinwithx.NewInMemoryStorage()
extension := signinwithx.MustCreateResourceServerExtension(signinwithx.ServerOptions{
    Storage: storage,
})

server := x402http.Newx402HTTPResourceServer(routes)
server.RegisterExtension(extension)
```

Routes declare SIWX through `Extensions`. Auth-only routes use an empty
`Accepts` list and rely on the SIWX protected-request hook.

```go
Extensions: map[string]interface{}{
    signinwithx.ExtensionKey: signinwithx.DeclareExtension(signinwithx.DeclareOptions{
        Networks: []string{"eip155:8453"},
    })[signinwithx.ExtensionKey],
}
```

## Client

```go
signer, _ := evmsigner.NewClientSignerFromPrivateKey(privateKey)

httpClient := x402http.Newx402HTTPClient(x402.Newx402Client()).
    OnPaymentRequired(signinwithx.CreateClientHook(signer.(signinwithx.EVMSigner)))
```

The HTTP client first tries to satisfy a `sign-in-with-x` challenge by sending a
`SIGN-IN-WITH-X` header. If auth fails, the normal x402 payment flow continues.

Solana SIWS, EIP-1271, and EIP-6492 support are not implemented yet.
