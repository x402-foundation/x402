# Extension: `caller-attribution`

## Summary

The `caller-attribution` extension lets trusted settlement participants attach signed caller-classification assertions to a successful x402 `SettlementResponse`.

The extension addresses a narrow analytics problem: a successful payment proves that value settled, but it does not prove why the caller paid. Verifier checks, prearranged integration tests, and catalog referrals can otherwise be misclassified as organic customer demand.

This extension:

- binds every assertion to the settlement network, transaction, and payer,
- distinguishes verifier and prearranged integration activity from unresolved demand,
- records catalog referral provenance without claiming buyer intent,
- supports multiple independently signed assertions for one settlement,
- forbids wallet, IP address, user-agent, and fingerprint-based attribution, and
- keeps gross settled revenue separate from organic customer revenue.

This specification applies to x402 version 2.

---

## 1. Relationship to Other Extensions

The `builder-code` extension records applications, wallets, and services that participated in an x402 payment. Its service code is client supplied and is not a trusted statement of acquisition intent.

The `offer-receipt` extension proves server terms and delivery. Caller attribution has different issuers and trust semantics, so it is a separate composable extension. This specification reuses the signed artifact formats and signer-authorization principles defined by `offer-receipt`.

An implementation MAY use `builder-code`, `offer-receipt`, and `caller-attribution` in the same payment.

---

## 2. Caller Classes

Version 1 defines four caller classes:

| Class                     | Meaning                                                                           | Analytics treatment                          |
| ------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------- |
| `verifier`                | A known automated verification, challenge, crawler, or quality-assurance program  | Exclude from organic customer-demand metrics |
| `prearranged_integration` | A payment made as part of an operator-coordinated integration or validation test  | Exclude from organic customer-demand metrics |
| `catalog_referral`        | The caller reached the resource through an identified catalog or discovery system | Record acquisition provenance only           |
| `unknown`                 | The issuer has no trustworthy caller classification                               | Treat as unresolved                          |

A `catalog_referral` assertion does not establish that a caller is an organic customer. It MAY coexist with any other caller class.

Absence of this extension, an empty `assertions` array, and a verified `unknown` assertion all mean that caller intent is unresolved. Consumers MUST NOT interpret any of those states as evidence of organic demand.

---

## 3. Extension Flow

### 3.1 `PaymentRequired`

A resource server that accepts caller attribution advertises the extension in `PaymentRequired.extensions`:

```json
{
  "extensions": {
    "caller-attribution": {
      "info": {
        "version": 1
      },
      "schema": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "required": ["version"],
        "properties": {
          "version": {
            "const": 1
          }
        },
        "additionalProperties": false
      }
    }
  }
}
```

### 3.2 `PaymentPayload`

The client MUST echo the advertised extension as required by the x402 version 2 extension rules.

Clients MUST NOT append caller assertions. A facilitator or resource server MUST ignore caller assertions added by a client to `PaymentPayload`. Client-supplied metadata from this or any other extension MUST NOT be treated as trusted caller attribution.

### 3.3 `SettlementResponse`

After a successful settlement, an authorized facilitator or catalog MAY add one or more signed assertions:

```json
{
  "success": true,
  "transaction": "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
  "network": "eip155:8453",
  "payer": "0x857b06519E91e3A54538791bDbb0E22373e36b66",
  "extensions": {
    "caller-attribution": {
      "info": {
        "version": 1,
        "assertions": [
          {
            "format": "eip712",
            "payload": {
              "version": 1,
              "callerClass": "verifier",
              "assertedBy": "facilitator",
              "issuer": "https://facilitator.example",
              "sourceId": "https://facilitator.example/verifiers/daily-catalog-check",
              "network": "eip155:8453",
              "transaction": "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
              "payer": "0x857b06519E91e3A54538791bDbb0E22373e36b66",
              "issuedAt": 1703123456
            },
            "signature": "0x1234567890abcdef..."
          }
        ]
      },
      "schema": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "required": ["version", "assertions"],
        "properties": {
          "version": {
            "const": 1
          },
          "assertions": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/assertion"
            }
          }
        },
        "$defs": {
          "assertion": {
            "oneOf": [
              {
                "type": "object",
                "required": ["format", "payload", "signature"],
                "properties": {
                  "format": {
                    "const": "eip712"
                  },
                  "payload": {
                    "$ref": "#/$defs/payload"
                  },
                  "signature": {
                    "type": "string",
                    "pattern": "^0x[0-9a-fA-F]{130}$"
                  }
                },
                "additionalProperties": false
              },
              {
                "type": "object",
                "required": ["format", "signature"],
                "properties": {
                  "format": {
                    "const": "jws"
                  },
                  "signature": {
                    "type": "string",
                    "pattern": "^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$"
                  }
                },
                "additionalProperties": false
              }
            ]
          },
          "payload": {
            "type": "object",
            "required": [
              "version",
              "callerClass",
              "assertedBy",
              "issuer",
              "sourceId",
              "network",
              "transaction",
              "payer",
              "issuedAt"
            ],
            "properties": {
              "version": {
                "const": 1
              },
              "callerClass": {
                "enum": [
                  "verifier",
                  "prearranged_integration",
                  "catalog_referral",
                  "unknown"
                ]
              },
              "assertedBy": {
                "enum": ["facilitator", "catalog"]
              },
              "issuer": {
                "type": "string",
                "format": "uri"
              },
              "sourceId": {
                "anyOf": [
                  {
                    "type": "string",
                    "format": "uri"
                  },
                  {
                    "const": ""
                  }
                ]
              },
              "network": {
                "type": "string"
              },
              "transaction": {
                "type": "string",
                "minLength": 1
              },
              "payer": {
                "type": "string",
                "minLength": 1
              },
              "issuedAt": {
                "type": "integer",
                "minimum": 0
              }
            },
            "additionalProperties": false
          }
        },
        "additionalProperties": false
      }
    }
  }
}
```

The `schema` in the example is normative for version 1 extension `info`. Producers MAY omit descriptions and formatting annotations when serializing an equivalent schema, but MUST preserve its validation behavior.

Assertions MUST be emitted only for successful settlements. A failed `SettlementResponse` MUST NOT contain caller assertions.

---

## 4. Signed Assertion Structure

Each element of `info.assertions` is a signed artifact with the same format-dependent shape used by `offer-receipt`:

| Field       | Type   | Required     | Description                          |
| ----------- | ------ | ------------ | ------------------------------------ |
| `format`    | string | Yes          | `"eip712"` or `"jws"`                |
| `payload`   | object | EIP-712 only | Canonical caller-attribution payload |
| `signature` | string | Yes          | Format-specific signature            |

For `format = "eip712"`:

- `payload` MUST be present.
- `signature` MUST be a `0x`-prefixed, 65-byte ECDSA signature.

For `format = "jws"`:

- `payload` MUST be omitted.
- `signature` MUST be a JWS Compact Serialization string.
- The protected JWS header MUST contain `alg` and `kid`.
- The decoded JWS payload MUST have the canonical fields in section 4.1.

### 4.1 Payload Fields

| Field         | Type   | Required | Description                                                                                    |
| ------------- | ------ | -------- | ---------------------------------------------------------------------------------------------- |
| `version`     | number | Yes      | Payload schema version, currently `1`                                                          |
| `callerClass` | string | Yes      | One of the caller classes in section 2                                                         |
| `assertedBy`  | string | Yes      | Issuer role, either `facilitator` or `catalog`                                                 |
| `issuer`      | string | Yes      | Absolute URI naming the asserting organization or service                                      |
| `sourceId`    | string | Yes      | Globally namespaced URI naming the attribution source; empty string only where permitted below |
| `network`     | string | Yes      | Settlement network in CAIP-2 format                                                            |
| `transaction` | string | Yes      | Settlement transaction identifier                                                              |
| `payer`       | string | Yes      | Payer from the surrounding successful `SettlementResponse`                                     |
| `issuedAt`    | number | Yes      | Unix timestamp in seconds when the assertion was issued                                        |

`sourceId` MUST be a non-empty absolute URI for `catalog_referral`. The URI SHOULD identify a specific catalog surface or referral program.

`sourceId` SHOULD be a non-empty absolute URI for `verifier`. It SHOULD identify the verification program rather than a transient crawler instance.

`sourceId` MAY be an empty string for `prearranged_integration`. It MUST be an empty string for `unknown`. An empty string is used instead of omission because the EIP-712 schema is fixed.

The `issuer` URI is an identity anchor for signer authorization. It MUST NOT contain a fragment. For a catalog assertion, `sourceId` MUST be controlled by `issuer` or covered by an explicit delegation from `issuer`.

### 4.2 Multiple Assertions

`assertions` is an array because independently trusted parties can know different facts about the same payment. For example, a catalog can assert referral provenance while a facilitator identifies the payer as part of a verifier program.

Producers MUST NOT combine claims from different issuers into one assertion. Each assertion MUST carry its own signature.

Consumers MUST verify each assertion independently. An invalid assertion MUST NOT invalidate another valid assertion in the same array.

---

## 5. EIP-712 Format

### 5.1 Domain

All EIP-712 caller-attribution assertions use:

```javascript
{
  name: "x402 caller attribution",
  version: "1",
  chainId: 1
}
```

As with `offer-receipt`, EIP-712 is used as an off-chain signing format. The constant domain `chainId` does not identify the payment network. The signed `network` field identifies the payment network.

### 5.2 Normative Schema

The following `types` and `primaryType` are normative and MUST NOT be transmitted:

```javascript
{
  "primaryType": "CallerAttribution",
  "types": {
    "EIP712Domain": [
      { "name": "name", "type": "string" },
      { "name": "version", "type": "string" },
      { "name": "chainId", "type": "uint256" }
    ],
    "CallerAttribution": [
      { "name": "version", "type": "uint256" },
      { "name": "callerClass", "type": "string" },
      { "name": "assertedBy", "type": "string" },
      { "name": "issuer", "type": "string" },
      { "name": "sourceId", "type": "string" },
      { "name": "network", "type": "string" },
      { "name": "transaction", "type": "string" },
      { "name": "payer", "type": "string" },
      { "name": "issuedAt", "type": "uint256" }
    ]
  }
}
```

Signers and verifiers MUST use the payload exactly as transmitted. They MUST NOT infer or reconstruct missing fields from the surrounding response when calculating the signature digest.

---

## 6. JWS Format

The JWS protected header MUST include:

| Field | Type   | Required | Description                                        |
| ----- | ------ | -------- | -------------------------------------------------- |
| `alg` | string | Yes      | JWS signing algorithm, such as `ES256K` or `EdDSA` |
| `kid` | string | Yes      | DID URL identifying the verification key           |

The JWS payload MUST be a UTF-8 JSON object containing exactly the fields in section 4.1. The JWS MUST use compact serialization.

Verifiers MUST reject an unsupported `alg`. Verifiers MUST resolve `kid`, verify the signature over the complete JWS, and then verify that the resolved key is authorized for `issuer`.

---

## 7. Producing Assertions

An issuer MUST assert only facts for which it has direct, trustworthy operational knowledge.

A facilitator MAY issue:

- `verifier` when it can authenticate the payer or request as part of a known verification program,
- `prearranged_integration` when the test was coordinated with the facilitator or resource operator,
- `catalog_referral` when it has authenticated referral evidence from the named catalog, or
- `unknown` when no trustworthy classification is available.

A catalog MAY issue `catalog_referral` when it directly routed or selected the paid resource. A catalog MUST NOT issue `verifier` or `prearranged_integration` unless it also operates and authenticates that program.

An issuer MUST NOT classify a settlement using payer-wallet reuse, IP address, user-agent, browser fingerprint, or probabilistic identity correlation.

An issuer MUST NOT assert `catalog_referral` from an unauthenticated HTTP `Referer` header or unverified client parameter.

Producers SHOULD minimize repeated assertions. Assertions with identical `issuer`, `callerClass`, `sourceId`, `network`, `transaction`, and `payer` add no information and SHOULD be deduplicated.

---

## 8. Verification

A consumer MUST complete all of the following checks before treating an assertion as verified:

1. Validate the signed artifact structure and payload version.
2. Verify the EIP-712 or JWS signature.
3. Verify that the signing key is authorized for `issuer`.
4. Verify under local trust policy that `issuer` is recognized in the role named by `assertedBy`.
5. Validate `callerClass`, `assertedBy`, `issuer`, and `sourceId`.
6. Confirm that `network`, `transaction`, and `payer` exactly match the surrounding successful `SettlementResponse`.
7. Evaluate whether `issuedAt` is acceptable under local freshness and key-rotation policy.
8. For `catalog_referral`, verify that `sourceId` is controlled by `issuer` or covered by a trusted delegation.

Signature validity, signer authorization, and issuer-role trust are separate checks. A valid signature from an unauthorized key or an unrecognized issuer MUST be treated as invalid attribution.

Implementations SHOULD support the authorization approaches described by `offer-receipt`, including `did:web`, DNS controller records, and external key registries. Consumers verifying historical assertions SHOULD preserve or reference authorization evidence that was valid at `issuedAt`.

Consumers MUST ignore invalid or unsupported assertions. They MAY retain them for debugging, but MUST NOT use them in demand, customer, revenue, or acquisition metrics.

---

## 9. Analytics Semantics

This extension does not redefine settlement success or gross settled value. A successful payment remains part of gross settlement counts and gross settled revenue.

For organic customer analytics:

1. If any verified assertion has class `verifier`, the settlement MUST be excluded from organic customer count, organic payment count, and organic customer revenue.
2. If any verified assertion has class `prearranged_integration`, the same exclusion MUST apply.
3. A verified `catalog_referral` MAY populate an acquisition-source dimension, but MUST NOT by itself classify the settlement as organic customer demand.
4. A verified `unknown`, an empty array, no verified assertions, or an absent extension MUST remain unresolved.
5. Client-supplied values, including `builder-code.s`, MUST NOT be promoted to verified caller attribution without an independently authorized assertion.

If verified assertions conflict, consumers MUST apply the conservative rule: a verified `verifier` or `prearranged_integration` classification takes precedence over referral or unresolved classifications for organic customer metrics.

Implementations SHOULD report at least these categories separately:

- gross successful settlements and gross settled revenue,
- verified verifier settlements,
- verified prearranged integration settlements,
- settlements with verified catalog referral provenance, and
- unresolved settlements.

---

## 10. Security and Privacy Considerations

### 10.1 Forged Attribution

An attacker can sign a syntactically valid assertion with an unrelated key or claim a role it does not hold. Consumers MUST verify signer authorization for `issuer` and MUST recognize that issuer in the asserted role under local trust policy.

### 10.2 Replay

The signed `network`, `transaction`, and `payer` fields bind an assertion to one settlement. Consumers MUST compare all three fields with the surrounding `SettlementResponse`.

### 10.3 Misclassification

Attribution changes analytics, not settlement validity. Consumers SHOULD preserve the original assertion and verification result so classifications remain auditable.

### 10.4 Privacy

The extension intentionally omits IP addresses, user agents, device identifiers, wallet labels, and natural-person identity fields. Implementers MUST NOT add fingerprint-derived identity data to `sourceId` or `issuer`.

`sourceId` SHOULD identify a program or catalog surface, not a person, browser session, or transient request.

### 10.5 Key Rotation

Mutable DID documents and DNS records describe current authorization. Historical analytics SHOULD retain authorization evidence or an immutable reference sufficient to evaluate authorization at `issuedAt`.

---

## 11. Versioning

Version 1 defines the caller classes, payload fields, signature formats, and analytics rules in this document.

Adding a caller class, changing a signed payload field, or changing the canonical EIP-712 schema is a breaking change and requires a new payload version.
