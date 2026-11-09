# Facilitator request-binding vectors

Seven vectors modeling the published `@x402/core`, `@x402/express` and `@x402/mcp` version 2.30.0 source, after [epistemedeus](https://github.com/epistemedeus) posted a finding on [#3776](https://github.com/x402-foundation/x402/pull/3776#issuecomment-6736524227): a remote facilitator never observes the original query string, body, or HTTP method of the request it verifies and settles.

## What this is, and what it is not

This is not a dupe of `specs/conformance/attempt-identity/` (#3958). That set tests whether an implementation's derivation of the attempt identity follows section 5.5's text, given a request snapshot it already has. This set tests something upstream: whether the snapshot a resource server hands to the facilitator ever contained the properties section 5.5 assumes are available.

This also does not establish that the gap is a vulnerability by itself. The resource server, not the facilitator, may be the component responsible for binding a payment to the specific operation it pays for. Whether that binding exists anywhere, outside the facilitator's view, is a separate, open question these vectors do not answer.

## What is here

| File | Claim |
| --- | --- |
| `query-collapses-under-configured-resource.json` | collapses |
| `query-distinguished-under-auto-resource.json` | stays distinguished (control case) |
| `body-never-reaches-facilitator-configured.json` | collapses |
| `body-never-reaches-facilitator-auto.json` | collapses |
| `method-never-reaches-facilitator-configured.json` | collapses |
| `method-never-reaches-facilitator-auto.json` | collapses |
| `mcp-tool-name-only-resource-real-world.json` | collapses |

One distinction sharper than the original framing: the query-string gap is conditional on whether a route configures a fixed `resource` string (it is carried inside `req.originalUrl` otherwise). The body and method gaps are not conditional on anything; neither has a field anywhere in the `/verify` or `/settle` request body, with or without a configured resource. The two auto-resource vectors exist specifically to make this visible.

The seventh vector is not hypothetical: `@x402/mcp` builds every paid tool call's `resource.url` from the tool name alone (`mcp://tool/${toolName}`), for every integration, including a real downstream consumer we maintain (`tokenizen/packages/capacity-attest`).

## Provenance

Each file carries its own `provenance` field with the exact source line it models (fetched via `npm pack @x402/core@2.30.0 @x402/express@2.30.0 @x402/mcp@2.30.0`, read, not executed against a running SDK) and a `limits` field. The files are copied from `vectors/facilitator-request-binding/` in [holistis/agent-receipt-verify](https://github.com/holistis/agent-receipt-verify/tree/feat/facilitator-request-binding/vectors/facilitator-request-binding), which also holds a runnable test, a worked example against the capacity-attest consumer above, and a mechanical prevalence scan (204 public projects checked via a fixed search query, 26 share the pattern).

## Related work

[#3838](https://github.com/x402-foundation/x402/issues/3838) (reported by [Leeziao](https://github.com/Leeziao)) and its fix [#3840](https://github.com/x402-foundation/x402/pull/3840) (by [epistemedeus](https://github.com/epistemedeus)) already addressed one concrete instance of the same underlying class in the SIWX extension: a settle hook recorded a payment under the client-supplied `resource.url` instead of the server-side request path. [#3280](https://github.com/x402-foundation/x402/issues/3280) and [#3873](https://github.com/x402-foundation/x402/issues/3873) discuss propagating resource-server-owned payment context through facilitator verify/settle at the design level. These vectors do not propose a design change; they document the gap as the current spec and SDKs leave it.

## Limits

- This models a pinned version (2.30.0) of three specific packages, read as source, not observed as traffic from a running server.
- This does not establish whether any downstream consumer (including capacity-attest) has an independent, out-of-band check that would still catch the mismatch this gap permits; see the worked example in the linked repository for that separate, tested claim.
- This does not demonstrate a successful replay against any live facilitator.
