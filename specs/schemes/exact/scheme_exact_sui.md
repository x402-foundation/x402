# Scheme: `exact` on `Sui`

## Summary

The `exact` scheme on Sui relies on the `0x2::coin::Coin<T>` standard to transfer a specific amount of a particular coin type `T` from the payer to the resource server. The current approach requires the payer to form a complete signed transaction which results in the facilitator having no ability to adjust the transaction and direct funds anywhere but the address specified by the resource server in PaymentRequirements.

## Protocol Sequencing

![](../../../static/sui-exact-flow.png)

The following outlines the flow of the `exact` scheme on `Sui`:

1. Client makes a request to a `resource server` and receives a payment required response.
2. If the client doesn't already have local information about the Coin object's it owns it can make a request to an RPC service to get a list of objects which can be used in transaction construction.
3. If the server/facilitator supports sponsorship, and the client wants to make use of sponsorship, it can make a request to the provided sponsorship service following the sponsorship protocol that exists in Sui.
4. Craft and sign a transaction to be used as payment.
5. Resend the request to the `resource server` including the `PaymentPayload`.
6. `resource server` passes the `PaymentPayload` to the `facilitator` for verification.
7. `resource server` does the work to fulfill the request.
8. `resource server` requests settlement from the `facilitator`
9. If sponsorship was used, the `facilitator` can provide its signature on the payload.
10. `facilitator` submits the transaction to the `Sui` network for execution and reports back to the `resource server` the result of the transaction.
11. `resource server` returns the response to the client.

## PaymentPayload `payload` Field

The `payload` field of the `PaymentPayload` must contain the following fields:

- `signature`: The user signature over the Sui transaction which transfers funds to the resource server.
- `transaction`: The Base64 encoded Sui transaction itself.

Example `payload`:

```json
{
  "signature": "99X8xzbQkOBY3yUnaeCvDslpGdMfB81aqEf7QQC8RhXJ6rripVz2Z21Vboc/CAmodHZkcDjiraFbJlzqQJKkBQ==",
  "transaction": "AAAIAQDi1HwjSnS6M+WGvD73iEyUY2FRKNj0MlRp7+3SHZM3xCvMdB0AAAAAIFRgPKOstGBLCnbcyGoOXugUYAWwVzNrpMjPCzXK4KQWAQCMoE29VLGwftex8rhIlOuFLFNfxLIJlHqGXoXA8hx6l+LMdB0AAAAAIHbPucTRIEWgO6lzqukswPZ6i72IHEKK5LyM1l9HJNZNAQBthSeHDVK8Xr5/zp3JMZPLtG5uAoVgedTA4pEnp+h8qUlUzRwAAAAAIACH0swYW/QfGCFczGnjAVPHPqZrQE5vfvJr36i6KVEFAQAC7W4K5vCwB+nprjxcNlLiOQ7SIIfyCZjmj2qSis2iTsCuzBwAAAAAIAkSUkXOoeq52GNdhwpbs+jZqqrqPdmiN3oPw5EzDIanAQAIyFNGWD6OxiFIyXSxrNEcFG0npm+nImk6InUssXb1EZgx1hwAAAAAILhsjmMKyM0n75Cd7z6ufH2LNhOMibFOGhNlLgV5RFuEAQC+Mh4kGkLwrw/11729oUQnt3xOmOreE6PcnuN6M68ZBcCuzBwAAAAAIO2PQhSSqSAawCbRr005lfjBgFOqIHo4zb2GcQ/WCxAlAAgA+QKVAAAAAAAgjiAHD0X4HNSdVPpJtf2E6W2uRc8kbvCHYkgEQ1B+w1MDAwEAAAUBAQABAgABAwABBAABBQACAQAAAQEGAAEBAgEAAQcAHrfFfj8r0Pxsudz/0UPqlX5NmPgFw1hzP3be4GZ/4LEB5XXrONxGw0qOUsq3yNKeUhOCOgCIwaa4pswKaer66EKqPGwdAAAAACBrOIN4poutFUmHfB6FbFJu8GgXoPPTGQWREqFpPfvO1B63xX4/K9D8bLnc/9FD6pV+TZj4BcNYcz923uBmf+Cx7gIAAAAAAABg4xYAAAAAAAA="
}
```

Full `PaymentPayload` object:

```json
{
  "x402Version": 2,
  "resource": {
    "url": "https://api.example.com/resource",
    "description": "Access to protected content",
    "mimeType": "application/json"
  },
  "accepted": {
    "scheme": "exact",
    "network": "sui:mainnet",
    "amount": "10000000",
    "asset": "0x2::sui::SUI",
    "payTo": "0x1eb7c57e3f2bd0fc6cb9dcffd143ea957e4d98f805c358733f76dee0667fe0b1",
    "maxTimeoutSeconds": 60,
    "extra": {}
  },
  "payload": {
    "signature": "99X8xzbQkOBY3yUnaeCvDslpGdMfB81aqEf7QQC8RhXJ6rripVz2Z21Vboc/CAmodHZkcDjiraFbJlzqQJKkBQ==",
    "transaction": "AAAIAQDi1HwjSnS6M+WGvD73iEyUY2FRKNj0MlRp7+3SHZM3xCvMdB0AAAAAIFRgPKOstGBLCnbcyGoOXugUYAWwVzNrpMjPCzXK4KQWAQCMoE29VLGwftex8rhIlOuFLFNfxLIJlHqGXoXA8hx6l+LMdB0AAAAAIHbPucTRIEWgO6lzqukswPZ6i72IHEKK5LyM1l9HJNZNAQBthSeHDVK8Xr5/zp3JMZPLtG5uAoVgedTA4pEnp+h8qUlUzRwAAAAAIACH0swYW/QfGCFczGnjAVPHPqZrQE5vfvJr36i6KVEFAQAC7W4K5vCwB+nprjxcNlLiOQ7SIIfyCZjmj2qSis2iTsCuzBwAAAAAIAkSUkXOoeq52GNdhwpbs+jZqqrqPdmiN3oPw5EzDIanAQAIyFNGWD6OxiFIyXSxrNEcFG0npm+nImk6InUssXb1EZgx1hwAAAAAILhsjmMKyM0n75Cd7z6ufH2LNhOMibFOGhNlLgV5RFuEAQC+Mh4kGkLwrw/11729oUQnt3xOmOreE6PcnuN6M68ZBcCuzBwAAAAAIO2PQhSSqSAawCbRr005lfjBgFOqIHo4zb2GcQ/WCxAlAAgA+QKVAAAAAAAgjiAHD0X4HNSdVPpJtf2E6W2uRc8kbvCHYkgEQ1B+w1MDAwEAAAUBAQABAgABAwABBAABBQACAQAAAQEGAAEBAgEAAQcAHrfFfj8r0Pxsudz/0UPqlX5NmPgFw1hzP3be4GZ/4LEB5XXrONxGw0qOUsq3yNKeUhOCOgCIwaa4pswKaer66EKqPGwdAAAAACBrOIN4poutFUmHfB6FbFJu8GgXoPPTGQWREqFpPfvO1B63xX4/K9D8bLnc/9FD6pV+TZj4BcNYcz923uBmf+Cx7gIAAAAAAABg4xYAAAAAAAA="
  }
}
```

## Verification

Steps to verify a payment for the `exact` scheme:

1. Verify the network is for the agreed upon chain.
2. Verify the signature is valid over the provided transaction.
3. Simulate the transaction to ensure it would succeed and has not already been executed/committed to the chain.
4. Verify the outputs of the simulation/execution to ensure the resource server's address sees a balance change equal to the value in the `PaymentRequirements.amount` in the agreed upon `asset`.

## Settlement

Settlement is performed via the facilitator broadcasting the transaction, along with the client's signature, to the network for execution.

## Appendix

### Sponsored Transactions

Sui supports sponsored or gas-less transaction via an interactive transaction construction protocol with a gas station. If a facilitator supports sponsoring of transactions then it should communicate this to the client by providing a URL via the `PaymentRequirements.extra.gasStation` field. If a client wants to make use of transaction sponsorship, then flow will be as follows:

1. Client makes request and gets payment required response from the service.
2. Client constructs a partial transaction (without gas payment) to pay for the request based on the provided `PaymentRequirements`.
3. Client sends the partial transaction to the gas station at `PaymentRequirements.extra.gasStation`. The gas station fills in the necessary gas information (gas objects, budget, etc) and sends back a fully formed transaction to the client.
4. Client signs the transaction and sends it along with its request.
5. When the facilitator goes to settle the transaction, it'll notice that its the sponsor of the transaction (and that the gas payment information is the same as was previously provided to the client) and will provide its own signature over the transaction before broadcasting to the network for execution.

### Future Work

One inefficiency in the above described spec is that the gas cost for such a payment is slightly elevated due to the need to pay for the storage cost of the newly created coin object that is sent to the resource server. The resource server will be able to get a bit more of a payment (in the case where the client pays gas) by smashing the received coin into an already existing coin it may have, recouping a majority of the storage fee.

The in-development feature "Address Balances" will reduce the overall gas cost for micro-payment transaction by eliminating the need to create a coin object to send, and thus eliminate the extra storage gas cost needed. This feature will also enable the sponsorship protocol to no longer need to be interactive due to no longer needing to perform coin selection.

The "Address Balances" feature may also be able to be extended to support `EIP-3009` and/or `EIP-2612` style authorizations that would allow for a client to authorize a payment without needing to craft a fully formed transaction.

### Recommendation

- Use the spec defined above for the first version of the protocol and only support payments of specific amounts where the client pays for gas fees or engages in the interactive sponsorship protocol with the facilitator.
- In a follow up, once the "Address Balances" feature has been implemented and rolled out, leverage it to be able to reduce the required gas fees, simplify the sponsorship flow, as well as investigate how `EIP-3009` and/or `EIP-2612` style authorizations could be implemented on top of "Address Balances".
