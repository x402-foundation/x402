# ts-vectors

Generates the JSON fixtures that the Java v2 tests compare against, from the TypeScript reference SDK in this repo.

- `export-core.ts`: wire types, header encoding, route patterns → `java/x402-core/src/test/resources/vectors/`.
- `export-bazaar.ts`: bazaar discovery declarations → `java/x402-extensions/src/test/resources/vectors/`.
- `export-facilitator.ts`: request bodies the TS `HTTPFacilitatorClient` sends → `java/x402-core/src/test/resources/vectors/facilitator/`.
- `export-cardano.ts`: Cardano verify fixtures (requirements, payload, chain-stub snapshot, `now`, TS result) → `java/x402-mechanism-cardano/src/test/resources/vectors/`.

Prerequisite: the TypeScript workspace is installed (`cd typescript && pnpm install`). Then:

```bash
cd java/tools/ts-vectors
npm run export
```

The scripts import TS sources by relative path and run with the workspace's `tsx`; nothing here is installed separately and no TypeScript file is edited. Re-run after a TS change and commit the regenerated fixtures together with the Java change.
