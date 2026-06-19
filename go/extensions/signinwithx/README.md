# Sign-In-With-X Extension

This package provides Go support for the `sign-in-with-x` extension.

It includes:

- Extension declaration helpers
- `SIGN-IN-WITH-X` header encoding and parsing
- SIWE message construction for `eip155:*` chains
- SIWX payload validation
- EVM EOA EIP-191 signature verification
- Optional EVM smart wallet verification through EIP-1271
- Server-side storage, request hooks, and settle hooks
- Client-side EVM SIWX payload/header creation
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

To verify smart wallet signatures, provide an on-chain EVM verifier. The signer
must support account code checks and contract reads for EIP-1271.

```go
extension := signinwithx.MustCreateResourceServerExtension(signinwithx.ServerOptions{
    Storage: storage,
    VerifyOptions: signinwithx.VerifyOptions{
        EVMVerifier: signinwithx.NewUniversalEVMVerifier(facilitatorSigner),
    },
})
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

x402Client := x402.Newx402Client().
    RegisterExtension(signinwithx.CreateClientExtension(signer.(signinwithx.EVMSigner)))
httpClient := x402http.Newx402HTTPClient(x402Client)
```

The HTTP client first tries to satisfy a `sign-in-with-x` challenge by sending a
`SIGN-IN-WITH-X` header. If auth fails, the normal x402 payment flow continues.

Solana SIWS support is planned as a follow-up.
