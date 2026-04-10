# x402 Extensions

This directory contains **extension helpers** for the x402 protocol.

## What are Extensions?

**Extensions** are optional metadata that can be attached to payment-protected resources to enable additional functionality beyond basic payment requirements. Extensions provide a standardized way for servers, clients, and facilitators to communicate additional information about resources.

## Key Concept: Helpers, Not Implementations

**Important:** Extensions in this package are **helpers for declaring and detecting extension support**. They do not dictate how extensions must be implemented by applications.

The extension helpers facilitate the conversation between:
- **Servers** declaring "I support this extension and here's the metadata"
- **Clients** detecting "This resource has this extension data"
- **Facilitators** extracting "Let me catalog this extension information"

**The actual implementation of what to do with extension data is an application-level decision**, not enforced by these helpers.

## How Extensions Work

### 1. Server Declares Extension

Servers use helpers to attach extension metadata to payment requirements:

```go
import "github.com/x402-foundation/x402/go/extensions/bazaar"

// Server declares: "This resource supports Bazaar discovery"
extension, _ := bazaar.DeclareDiscoveryExtension(...)

routes := x402http.RoutesConfig{
    "GET /api/data": {
        Accepts: x402http.PaymentOptions{
            {Scheme: "exact", PayTo: "0x...", Price: "$0.001", Network: "eip155:84532"},
        },
        Extensions: map[string]interface{}{
            "bazaar": extension,  // Attach extension metadata
        },
    },
}
```

### 2. Extension Flows Through Protocol

The extension metadata flows through the payment protocol automatically:

```
PaymentRequired (Server → Client):
{
  "accepts": [...],
  "resource": {...},
  "extensions": {
    "bazaar": {
      "info": {...},      // The actual extension data
      "schema": {...}     // JSON Schema validating the data
    }
  }
}

PaymentPayload (Client → Server → Facilitator):
{
  "payload": {...},
  "extensions": {
    "bazaar": {...}  // Client copies extensions from PaymentRequired
  }
}
```

### 3. Recipients Detect and Use Extension

Recipients (clients, facilitators) can extract extension data:

```go
import "github.com/x402-foundation/x402/go/extensions/bazaar"

// Facilitator extracts from client payment (in hook context)
discovered, _ := bazaar.ExtractDiscoveredResourceFromPaymentPayload(
    payloadBytes, 
    requirementsBytes, 
    true,
)

// Client extracts from 402 response
discovered, _ := bazaar.ExtractDiscoveredResourceFromPaymentRequired(
    paymentRequiredBytes,
    true,
)

if discovered != nil {
    // Application decides what to do with the data
    // Examples:
    // - Catalog in a database
    // - Generate API documentation
    // - Build a discovery index
    // - Expose via search API
}
```

## Extension Architecture

Extensions follow a two-part pattern:

### Part 1: Declaration (`info` + `schema`)

Extensions contain:

- **`info`**: The actual extension data (values, examples, metadata)
- **`schema`**: JSON Schema that validates the structure of `info`

This pattern allows:
- Self-validating extensions
- Machine-readable metadata
- Consistent structure across different extension types

### Part 2: Helpers for Each Role

Extension packages provide helpers for different roles:

#### Server Helpers

Functions to declare extension support:

- **Purpose**: Make it easy for servers to attach extension metadata
- **Example**: `DeclareDiscoveryExtension()` creates properly formatted discovery metadata
- **Integration**: Works with resource server's `Extensions` field

#### Facilitator Helpers

Functions to extract and validate extension data:

- **Purpose**: Make it easy for facilitators to parse extension metadata
- **Example**: `ExtractDiscoveredResourceFromPaymentPayload()` extracts discovered resources from client payment payloads
- **Validation**: Optional validation against JSON Schema

#### Client Helpers

Functions to extract extension data from server responses:

- **Purpose**: Help clients understand server capabilities from 402 responses
- **Example**: `ExtractDiscoveredResourceFromPaymentRequired()` extracts discovered resources from PaymentRequired responses
- **Use Case**: Building auto-discovery UI, generating client code, API exploration tools

## Available Extensions

Extensions are modular protocol additions. This directory contains implemented extension helpers:

### Bazaar (API Discovery)

The **Bazaar** extension is one example of a server-facilitator extension for automatic API discovery and cataloging.

**Import Path:**
```
github.com/x402-foundation/x402/go/extensions/bazaar
```

**Purpose:**
- Servers declare how their API should be called (input/output schemas)
- Facilitators can catalog and index discoverable APIs
- Enables building API marketplaces and search engines

**What it provides:**
- `DeclareDiscoveryExtension()` - Server helper to declare discovery metadata
- `ExtractDiscoveredResourceFromPaymentPayload()` - Facilitator helper to extract discovered resources from client payments
- `ExtractDiscoveredResourceFromPaymentRequired()` - Client helper to extract discovered resources from 402 responses
- `ValidateDiscoveryExtension()` - Validation helper
- JSON Schema types for structure validation

**What it does NOT dictate:**
- How facilitators should catalog the data
- What database or storage to use
- How to expose the cataloged data
- Whether to use the data at all

The Bazaar extension just facilitates the data exchange between servers and facilitators - the implementation is yours.

### Future Extensions

Extensions can serve many purposes. Planned extensions include:

#### Sign in with X

Authentication and identity extension:

- **Purpose**: Allow servers to request user authentication via x402 payments
- **Helpers**: Declaration of auth requirements, extraction of identity claims
- **Implementation**: Applications decide how to verify identity and manage sessions

#### Rate Limiting

Rate limit policy declaration:

- **Purpose**: Servers declare rate limits to clients/facilitators
- **Helpers**: Declaration of limits, extraction of policy
- **Implementation**: Applications enforce limits however they choose

#### Caching

Cache policy declaration:

- **Purpose**: Servers indicate caching rules for paid resources
- **Helpers**: Declaration of cache headers, extraction of policy
- **Implementation**: Clients decide how to cache responses

Each extension will follow the same pattern: helpers for declaration and extraction, but implementation remains flexible.

## Extension Data Flow

```
1. Server Declaration
   ↓
   Extension helper creates structured metadata
   ↓
2. PaymentRequired Response
   ↓
   Extensions included in response to client
   ↓
3. Client Processing
   ↓
   Client copies extensions to PaymentPayload
   ↓
4. PaymentPayload Request
   ↓
   Extensions sent to server with payment
   ↓
5. Server → Facilitator
   ↓
   Server forwards to facilitator for settlement
   ↓
6. Facilitator Extraction
   ↓
   Extension helper parses structured metadata
   ↓
7. Application Logic (Implementation-Specific)
   ↓
   Facilitator does whatever it wants with the data
```

## Types Package

The `types/` subdirectory contains shared type definitions:

**Import Path:**
```
github.com/x402-foundation/x402/go/extensions/types
```

**Exports:**
- Extension identifier constants (`BAZAAR`)
- Common type definitions for extensions
- Shared structures used across multiple extensions

## Extension Types

Extensions can serve different communication patterns:

### Server ↔ Facilitator Extensions

These enable communication between servers and facilitators:

- **Bazaar** (Current): API discovery and cataloging
- **Rate Limiting** (Planned): Policy declaration
- **Analytics** (Planned): Usage tracking metadata

### Server ↔ Client Extensions

These enable communication between servers and clients:

- **Caching** (Planned): Cache policy hints
- **Retry Policy** (Planned): Retry guidance

### Client ↔ Facilitator Extensions

These enable communication between clients and facilitators:

- **Sign in with X** (Planned): Identity and authentication
- **Payment Preferences** (Planned): Token or network preferences

All extensions follow the same helper pattern while leaving implementation details to applications.

## Creating New Extensions

We welcome contributions of new extension types! Extensions can enable new communication patterns between servers, clients, and facilitators.

### Extension Requirements

When creating a new extension, provide:

1. **Specification**: Define what metadata the extension carries and why
2. **Declaration Helpers**: Functions to help servers/clients declare extension support
3. **Extraction Helpers**: Functions to help recipients parse extension data
4. **Validation**: JSON Schema or other validation mechanism
5. **Documentation**: Explain purpose and recommended usage patterns (not required implementation)

### Guidelines for New Extensions

**DO:**
- ✅ Provide helpers for declaration and extraction
- ✅ Use JSON Schema for validation when possible
- ✅ Document the extension's purpose and use cases
- ✅ Keep the helpers generic and reusable
- ✅ Support both v1 and v2 protocols where applicable
- ✅ Give examples of possible implementations (not requirements)
- ✅ Explain what role(s) can use the extension (server, client, facilitator)

**DON'T:**
- ❌ Enforce specific implementation choices
- ❌ Require specific databases, storage, or frameworks
- ❌ Dictate how applications must use the data
- ❌ Create tight coupling to specific technologies
- ❌ Make the extension mandatory for basic functionality

### Extension Philosophy

**Extensions are helpers that facilitate communication, not implementations.**

Extensions should:
- **Enable** new capabilities through metadata exchange
- **Facilitate** conversations between protocol participants
- **Provide structure** via helpers and schemas
- **Remain optional** - never required for core functionality
- **Stay flexible** - support multiple implementation approaches

**Example:** The Bazaar extension helps servers declare "here's my API structure" and helps facilitators extract "I received API metadata", but it doesn't dictate how facilitators must catalog, store, or expose that data.

The goal is to make it easy for protocol participants to exchange structured information while leaving implementation decisions to the application developer.

## Contributing New Extensions

We welcome contributions of new extension types!

To contribute an extension:

1. **Propose the extension**: Open an issue describing the use case
2. **Define the metadata**: What information does the extension carry?
3. **Create helpers**: Server declaration and extraction functions
4. **Add validation**: JSON Schema or equivalent
5. **Document usage**: Explain the purpose and recommended patterns
6. **Provide examples**: Show server and facilitator usage

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for contribution guidelines.

## Directory Structure

```
extensions/
├── README.md              - This file
├── types/                 - Shared type definitions
│   └── types.go           - Extension constants and common types
│
├── bazaar/                - Bazaar discovery extension (example implementation)
│   ├── doc.go             - Package documentation
│   ├── server.go          - Server-side helpers
│   ├── facilitator.go     - Facilitator-side helpers
│   ├── types.go           - Bazaar-specific types
│   └── resource_service.go - Declaration helpers
│
├── v1/                    - V1 protocol extension support
│   └── facilitator.go     - V1 extraction helpers
│
└── [future extensions]    - New extensions welcome via PR!
    ├── sign-in-with-x/    - (Planned) Identity extension
    ├── rate-limiting/     - (Planned) Rate limit policies
    └── caching/           - (Planned) Cache policies
```

**Note:** Bazaar is just one example of how extensions can work. Each new extension will have its own subdirectory following a similar pattern of declaration helpers, extraction helpers, and validation.

## Related Documentation

- **[Bazaar Extension](bazaar/)** - API discovery extension implementation
- **[Main README](../README.md)** - Package overview
- **[SERVER.md](../SERVER.md)** - Using extensions in servers
- **[FACILITATOR.md](../FACILITATOR.md)** - Extracting extensions in facilitators

