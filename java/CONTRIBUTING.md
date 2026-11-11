# Java Development Guide

## Layout

| Path | What |
|---|---|
| `x402-core` | Wire types, SPI, resource server, client, facilitator, framework-free HTTP layer (`org.x402.core`, `org.x402.http`) |
| `x402-mechanism-cardano` | Cardano `exact` scheme: client, server (Masumi terms binding), facilitator |
| `x402-extensions` | Bazaar discovery declarations |
| `x402-spring-boot-autoconfigure` | Spring Boot auto-configuration (WebMvc, WebFlux, clients, facilitator server) |
| `x402-spring-boot-starter` | What applications add, next to the mechanisms they use (no mechanism bundled; `X402MechanismCheck` fails startup for a configured but missing one) |
| `legacy/` | The v1 SDK, unchanged, built on its own |
| `tools/ts-vectors/` | Exports TypeScript reference behaviour as JSON fixtures for the tests |

Requirements: JDK 17+ and Maven 3.9.

## Build and test

```bash
cd java
mvn -B verify -Pcoverage checkstyle:check spotbugs:check      # what CI runs (v2)
mvn -B -pl x402-core verify                                    # one module
cd legacy && mvn clean test -Pcoverage                         # v1
```

The `coverage` profile enforces instruction coverage ≥ 0.85 and branch coverage ≥ 0.75 per module.

## Conventions

- Core is synchronous and framework-free; `ArchitectureTest` forbids Spring and mechanism imports there. Time comes from an injected `java.time.Clock`.
- Wire types are immutable records whose JSON is byte-identical to TS `JSON.stringify`. When TS behaviour changes, re-export the fixtures (`cd tools/ts-vectors && npm run export`, after `pnpm install` in `typescript/`) and commit them with the Java change.
- Behaviour follows the TypeScript reference. A deliberate divergence gets a row in the README's [Differences from the TypeScript SDK](README.md#differences-from-the-typescript-sdk) and a one-line reason in the code that implements it.
- Write the test first and see it fail; do not weaken an existing test to make a change pass.
- Public types and methods carry Javadoc (checkstyle).

## Examples

`examples/java/` holds a Spring Boot server, two clients and a facilitator. They depend on the installed `2.0.0-SNAPSHOT` artifacts: run `mvn -B install -DskipTests` in `java/` first.
