Exact Payment Scheme for TRON (TVM) (exact)
This document specifies the exact payment scheme for the x402 protocol on TRON networks. This scheme facilitates payments of a specific amount of a TRC-20 token (e.g., USDT, USDC) on the TRON blockchain.
Scheme Name
exact
Supported Networks
NetworkCAIP-2 IdentifierTRON Mainnettron:27LqcwShasta Testnettron:4oPwXBNile Testnettron:6FhfKq
Wildcard: tron:* matches all TRON networks.
Supported Assets
TokenContract Address (Mainnet)DecimalsUSDTTR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t6USDCTEkxiTehnzSmSe2XqrBj4w32RUN966rdz86
Protocol Flow
The protocol flow for exact on TRON is client-driven:

Client makes an HTTP request to a Resource Server.
Resource Server responds with a 402 Payment Required status containing PaymentRequired with an accepts array that includes the exact scheme on a tron:* network.
Client reads the PaymentRequirements, noting the asset, amount, payTo, and maxTimeoutSeconds.
Client constructs a TriggerSmartContract transaction calling transfer(address,uint256) on the TRC-20 token contract, with the recipient set to payTo and the value set to amount.
Client signs the transaction using their TRON private key via trx.sign(). This produces a complete signed transaction object including txID, raw_data, raw_data_hex, and signature.
The client does NOT broadcast the transaction. The signed transaction is passed to the facilitator via the payment payload.
Client constructs the PaymentPayload containing the signed transaction and the payer's address, base64-encodes it, and sends it in the X-PAYMENT header with the original HTTP request.
Resource Server receives the request and forwards the PaymentPayload and PaymentRequirements to a Facilitator's /verify endpoint.
Facilitator performs all verification checks (see Facilitator Verification Rules below).
If verification passes, Facilitator returns { "isValid": true } to the Resource Server.
Resource Server serves the requested resource to the Client.
Resource Server (or Facilitator) calls the Facilitator's /settle endpoint.
Facilitator broadcasts the signed transaction to the TRON network via trx.sendRawTransaction().
Facilitator returns the SettlementResponse containing the on-chain transaction ID.

PaymentRequirements
json{
  "scheme": "exact",
  "network": "tron:27Lqcw",
  "amount": "1000000",
  "asset": "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
  "payTo": "TXYZabc123merchantAddress",
  "maxTimeoutSeconds": 60,
  "extra": {
    "name": "USDT",
    "decimals": 6
  }
}

scheme: MUST be "exact".
network: A CAIP-2 identifier for the TRON network.
amount: The amount to be transferred in the token's smallest unit. For USDT/USDC with 6 decimals, "1000000" = $1.00.
asset: The TRC-20 token contract address in base58check format (T-prefix).
payTo: The TRON address (base58check format) of the resource server receiving the funds.
maxTimeoutSeconds: Maximum time in seconds the payment authorization remains valid.
extra.name: Human-readable token name (informational).
extra.decimals: Token decimal places (informational).

PaymentPayload
json{
  "x402Version": 2,
  "resource": {
    "url": "https://example.com/weather",
    "description": "Access to protected content",
    "mimeType": "application/json"
  },
  "accepted": {
    "scheme": "exact",
    "network": "tron:27Lqcw",
    "amount": "1000000",
    "asset": "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
    "payTo": "TXYZabc123merchantAddress",
    "maxTimeoutSeconds": 60,
    "extra": {
      "name": "USDT",
      "decimals": 6
    }
  },
  "payload": {
    "signedTransaction": {
      "txID": "a1b2c3d4e5f6...",
      "raw_data": {
        "contract": [{
          "parameter": {
            "value": {
              "data": "a9059cbb000000000000000000000000...",
              "owner_address": "41...",
              "contract_address": "41..."
            },
            "type_url": "type.googleapis.com/protocol.TriggerSmartContract"
          },
          "type": "TriggerSmartContract"
        }],
        "ref_block_bytes": "...",
        "ref_block_hash": "...",
        "expiration": 1740672154000,
        "timestamp": 1740672089000
      },
      "raw_data_hex": "0a02...",
      "signature": ["3045..."]
    },
    "from": "TXYZabc123payerAddress"
  }
}
Payload Fields

signedTransaction: The complete signed TRON transaction object as returned by TronWeb's trx.sign(). This MUST be a TriggerSmartContract transaction calling transfer(address,uint256) on the TRC-20 token contract.
signedTransaction.raw_data: JSON representation of the transaction body. Provided for informational convenience only (see Verification Rules).
signedTransaction.raw_data_hex: Hex-encoded serialized transaction body. This is the authoritative representation used for signature verification and field extraction.
signedTransaction.signature: Array containing the secp256k1 signature over raw_data_hex.
from: The payer's TRON address (base58check format). Used for verification against the transaction's owner_address.

SettlementResponse
json{
  "success": true,
  "transaction": "a1b2c3d4e5f6...",
  "network": "tron:27Lqcw",
  "payer": "TXYZabc123payerAddress"
}

transaction: The TRON transaction ID (txID) of the broadcast transaction.
payer: The TRON address of the client that signed the transaction.

Facilitator Verification Rules (MUST)
A facilitator verifying an exact-scheme TRON payment MUST enforce all of the following checks before broadcasting the transaction.

Authoritative data source: raw_data_hex is the authoritative representation of the transaction body. All field extractions during verification — including recipient address, token contract address, call value, and call data — MUST be derived by parsing raw_data_hex directly. The raw_data JSON object is provided for informational convenience only and MUST NOT be trusted for verification purposes. This prevents a class of attacks where a malicious client provides a valid signature over raw_data_hex while supplying inconsistent field values in the raw_data JSON to mislead facilitator verification logic.

1. Transaction Layout

The transaction MUST be a TriggerSmartContract type.
The contract array MUST contain exactly one contract invocation.
The first 4 bytes of parameter.value.data (extracted from raw_data_hex) MUST match the transfer(address,uint256) function selector (a9059cbb).

2. Token Contract Address

The contract_address extracted from raw_data_hex MUST match the asset from PaymentRequirements after address format normalization (see Rule 3 for canonical conversion).

3. Recipient Address

The decoded recipient address (bytes 16–35 of the ABI-encoded address parameter in the transfer call data, extracted from raw_data_hex) MUST match the payTo address from PaymentRequirements.
Because payTo is expressed as a base58check TRON address (T-prefix) while ABI-decoded addresses are 20-byte hex values (with the 0x41 network prefix stripped for EVM ABI encoding), implementations MUST convert both addresses to a common format before comparison. The canonical conversion path is: decode the base58check payTo address to bytes, strip the leading 0x41 network byte and the 4-byte checksum to yield 20 raw bytes, then compare against the 20-byte ABI-decoded address. Alternatively, implementations MAY convert the ABI-decoded 20 bytes back to base58check by prepending 0x41, computing the double-SHA256 checksum, appending the first 4 bytes, and base58-encoding — then compare the resulting T-address string directly against payTo.

4. Transfer Amount

The uint256 value decoded from the transfer call data (extracted from raw_data_hex) MUST be greater than or equal to the amount in PaymentRequirements.

5. Signature Verification

The facilitator MUST verify that the signature is a valid secp256k1 signature over the SHA-256 hash of the hex-decoded raw_data_hex.
The recovered public key MUST correspond to the owner_address in the transaction AND to the from field in the payment payload.

6. Transaction Expiration

The expiration field in the transaction (extracted from raw_data_hex) MUST be in the future at the time of verification.
The facilitator SHOULD reject transactions with an expiration more than maxTimeoutSeconds beyond the current time.

7. Sender Balance

The facilitator MUST verify that the from address holds a TRC-20 token balance greater than or equal to the transfer amount by querying the token contract's balanceOf function.
The facilitator SHOULD re-query balanceOf immediately before broadcasting during settlement (see Settlement step 1) to mitigate time-of-check-to-time-of-use (TOCTOU) race conditions. This is a single read call (~100ms on TronGrid) and closes the window for the common case where the client's balance changes between verification and settlement. If the balance is insufficient at broadcast time, the on-chain TRC-20 transfer reverts, the facilitator absorbs the energy cost (~65,000 energy, approximately 27 TRX), no funds move, and no resource is served. The system fails closed.

8. Replay Protection

The facilitator MUST maintain a set of recently seen txID values and reject any payment whose txID has already been processed.
The replay protection window SHOULD be at least as long as maxTimeoutSeconds.

9. Network Match

The network field in the PaymentPayload.accepted MUST match the network in the PaymentRequirements.

10. Scheme Match

The scheme field MUST be "exact".

11. Amount Consistency

The amount in PaymentPayload.accepted MUST match the amount in the original PaymentRequirements.

Settlement
Upon settlement, the facilitator:

Re-checks sender balance — The facilitator SHOULD query the TRC-20 balanceOf for the sender immediately before broadcasting to detect balance changes since verification (see Verification Rule 7). If the balance is insufficient, the facilitator MUST return an error and MUST NOT broadcast the transaction.
Broadcasts the signed transaction to the TRON network via trx.sendRawTransaction().
Waits for confirmation — Recommended: at least 19 confirmations for finality on TRON mainnet.
Verifies the transaction was successful on-chain by checking the transaction receipt.
Returns the SettlementResponse with the on-chain txID.

The facilitator pays the energy and bandwidth costs for broadcasting. The client and resource server do not need TRX for gas.
Settlement Failure Modes
FailureCauseOutcomeInsufficient balance at broadcastClient spent funds between verify and settleTRC-20 transfer reverts on-chain. Facilitator absorbs energy cost (~65,000 energy, ~27 TRX). No funds move. No resource served. Fails closed.Expired transactionFacilitator delayed beyond expirationTRON network rejects the transaction outright. Cannot be mined. No energy consumed. No funds move.Network errorTronGrid/fullnode unavailableFacilitator retries or returns settlement failure. Transaction may still be unbroadcast and safe to retry within expiration window.
Security Considerations
Trust Model
The TRON exact scheme provides strong trust-minimization guarantees through two properties inherent to TRON's transaction format:
Temporal Bound (Expiration Control). Every signed TRON transaction contains an expiration field in raw_data that the client sets at signing time (typically current time + maxTimeoutSeconds). If the facilitator sits on the transaction and attempts to broadcast after this window, the TRON network rejects it outright — it cannot be mined. The client controls this value, not the facilitator. This prevents a class of attacks where a facilitator might hold a signed transaction and broadcast it at an advantageous time.
Recipient Lock (Signed Calldata). The destination address is baked into the signed transaction's calldata (transfer(address,uint256)). The recipient cannot be changed without breaking the signature. Even within the valid expiration window, the facilitator can only send funds where the client already agreed to. Combined with amount exactness (the uint256 parameter is also signed), the facilitator has exactly two options: broadcast the transaction as-is, or discard it.
PropertyGuaranteeRecipientLocked by signature — facilitator cannot redirect fundsAmountLocked by signature — facilitator cannot alter the transfer valueTimingBounded by expiration — facilitator cannot delay indefinitelyScopeSingle transfer call — facilitator cannot add operationsGasPaid by facilitator — client needs no TRX
Unlike EVM chain specs that use a delegated authorization pattern (e.g., ERC-3009 transferWithAuthorization), the TRON scheme requires the client to construct and sign a complete TriggerSmartContract transaction. The facilitator holds this fully-formed signed transaction between verification and settlement. The broadcast window is bounded by TRON's ref_block mechanism — every transaction references a recent block hash and has an expiration field (typically 60 seconds from creation). If the facilitator does not broadcast within this window, the transaction becomes invalid on-chain and cannot be executed. Implementors SHOULD set the expiration field to the minimum acceptable window (recommended: 60–120 seconds) to minimize the period during which the facilitator holds a valid signed transaction.
Replay Protection
TRON transactions are uniquely identified by their txID (SHA-256 of raw_data_hex). Once broadcast and confirmed, the network rejects duplicate transaction IDs. Facilitators MUST additionally maintain an in-memory or persistent set of processed txID values to prevent replay at the application layer before broadcast.
Address Format
TRON addresses use base58check encoding with a 0x41 network prefix (yielding addresses starting with "T"). Implementations MUST validate address format before processing and MUST handle the hex-to-base58check conversion correctly when comparing addresses across different representations (see Verification Rule 3).
Double-Spend Risk
Because the client signs a complete transaction rather than a meta-transaction authorization, the client could theoretically broadcast the transaction themselves before the facilitator does, or move their TRC-20 balance between verification and settlement. Facilitators SHOULD minimize the time between verification and settlement. The facilitator SHOULD re-query balanceOf immediately before broadcasting (see Verification Rule 7 and Settlement step 1) to catch the common case where balance has changed. If the broadcast fails due to insufficient balance, the on-chain transfer reverts, the facilitator absorbs the energy cost (~65,000 energy, approximately 27 TRX), no funds move, and the facilitator MUST return an error and MUST NOT serve the resource. The system fails closed.
Token Contract Trust
The facilitator SHOULD maintain an allowlist of known TRC-20 token contracts (e.g., USDT: TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t, USDC: TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8). Accepting arbitrary token contracts may expose the facilitator to malicious contracts that behave unexpectedly (e.g., fee-on-transfer tokens, pausable tokens, or contracts with hidden approve side effects).
Transaction Malleability
TRON transaction IDs are derived from raw_data_hex. The facilitator MUST verify against raw_data_hex (not a reconstructed version) to prevent malleability attacks where the transaction content is preserved but the hash changes.
Differences from EVM Exact Scheme
FeatureEVM (eip155:*)TRON (tron:*)Meta-transactionsEIP-3009 transferWithAuthorizationSigned TriggerSmartContract (not broadcast by client)Gas modelETH gas feesEnergy / Bandwidth (TRX)SigningEIP-712 typed dataTRON secp256k1 over raw_data_hexAddress format0x-prefixed hex (20 bytes)Base58check (T-prefix, 21 bytes + 4 checksum)Block time~2s (Base L2)~3sPrimary stablecoinUSDCUSDT ($61B+ circulation on TRON)Smart contract languageSolidity (EVM)Solidity (TVM, EVM-compatible)Authoritative tx dataN/A (EIP-712 typed struct)raw_data_hex (NOT raw_data JSON)
Reference Implementation
ComponentLocationnpm package@erudite-intelligence/x402-tron-v2GitHubEruditeIntelligence/x402-tron-v2FacilitatorErudite Intelligence LLC (FinCEN-registered MSB #31000283503553)
