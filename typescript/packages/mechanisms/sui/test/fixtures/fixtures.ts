// AUTO-GENERATED fixtures for the @x402/sui unit tests — committed so the default
// test run is fully network-free. Generated ONCE by `test/fixtures/gen.ts` against
// Sui testnet (signed gasless Address-Balance payments + one gas-paying object-write
// transaction; the balanceChanges are the real dry-run output). Regenerate with a
// funded key; see gen.ts.
//

import { SUI_TESTNET_CAIP2, USDC_TESTNET } from "../../src/constants";

/** The funded payer that signed every fixture (Sui testnet). */
export const PAYER = "0x087aa862ca645c0b94400c49e11b491011fca35db837361ccfc4c6f69d356e86";

/** Throwaway recipients minted at generation time. */
export const RECIPIENT_1 = "0xa071949ae86e2d817e1675988a619a41fff34203dfab23defdc5b3033378a557";
export const RECIPIENT_2 = "0xc2995dd3edace45879f773527c46c510a5c84258e25af7cfc216644c4a5c96bd";

export const NETWORK = SUI_TESTNET_CAIP2;
export const ASSET = USDC_TESTNET;

/** A real signed, gasless, single-output payment (10000 atomic USDC to RECIPIENT_1). */
export const VALID_SINGLE = {
  transaction:
    "AAACACCgcZSa6G4tgX4WdZiKYZpB//NCA9+rI979xbMDM3ilVwIAECcAAAAAAAAAB6Hsf8AKb0DblpOtFBXQwZOtOQZJRCjPJSYhA3vXEX4pBHVzZGMEVVNEQwAAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgdiYWxhbmNlDHJlZGVlbV9mdW5kcwEHoex/wApvQNuWk60UFdDBk605BklEKM8lJiEDe9cRfikEdXNkYwRVU0RDAAEBAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIHYmFsYW5jZQpzZW5kX2Z1bmRzAQeh7H/ACm9A25aTrRQV0MGTrTkGSUQozyUmIQN71xF+KQR1c2RjBFVTREMAAgMAAAAAAQAACHqoYspkXAuUQAxJ4RtJEBH8o124NzYcz8TG9p01boYACHqoYspkXAuUQAxJ4RtJEBH8o124NzYcz8TG9p01boYAAAAAAAAAAAAAAAAAAAAAAgFnBAAAAAAAAAFoBAAAAAAAAAAAIEx4razyovWtgPJ+19VKpp06ePHKZ/3vns9XVPW4u3ewWCqrzA==",
  signature:
    "AHCT5WJvtWEAbWRM4j7+KlQo0Fj5RcBNRFZyS3v5DnztcP0YxBBYayl3pICbPcW5We55Lr1tT5LaN7cTOLb9hA0eLBUhjBcukNXOW1y0WQWY5tEWP9PMUDd/jQX+PmYWHA==",
  sender: PAYER,
} as const;

/** The dry-run balanceChanges captured for VALID_SINGLE (JSON-RPC shape). */
export const VALID_SINGLE_BALANCE_CHANGES = [
  {
    coinType: "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC",
    owner: { AddressOwner: "0x087aa862ca645c0b94400c49e11b491011fca35db837361ccfc4c6f69d356e86" },
    amount: "-10000",
  },
  {
    coinType: "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC",
    owner: { AddressOwner: "0xa071949ae86e2d817e1675988a619a41fff34203dfab23defdc5b3033378a557" },
    amount: "10000",
  },
];

/** A real signed, gasless, two-output split (9800 to RECIPIENT_1, 200 to RECIPIENT_2). */
export const VALID_SPLIT = {
  transaction:
    "AAAEACCgcZSa6G4tgX4WdZiKYZpB//NCA9+rI979xbMDM3ilVwAgwpld0+2s5Fh593NSfEbFEKXIQljiWvfPwhZkTEpclr0CAEgmAAAAAAAAAAeh7H/ACm9A25aTrRQV0MGTrTkGSUQozyUmIQN71xF+KQR1c2RjBFVTREMAAAIAyAAAAAAAAAAAB6Hsf8AKb0DblpOtFBXQwZOtOQZJRCjPJSYhA3vXEX4pBHVzZGMEVVNEQwAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgdiYWxhbmNlDHJlZGVlbV9mdW5kcwEHoex/wApvQNuWk60UFdDBk605BklEKM8lJiEDe9cRfikEdXNkYwRVU0RDAAEBAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIHYmFsYW5jZQpzZW5kX2Z1bmRzAQeh7H/ACm9A25aTrRQV0MGTrTkGSUQozyUmIQN71xF+KQR1c2RjBFVTREMAAgMAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACB2JhbGFuY2UMcmVkZWVtX2Z1bmRzAQeh7H/ACm9A25aTrRQV0MGTrTkGSUQozyUmIQN71xF+KQR1c2RjBFVTREMAAQEDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgdiYWxhbmNlCnNlbmRfZnVuZHMBB6Hsf8AKb0DblpOtFBXQwZOtOQZJRCjPJSYhA3vXEX4pBHVzZGMEVVNEQwACAwIAAAABAQAIeqhiymRcC5RADEnhG0kQEfyjXbg3NhzPxMb2nTVuhgAIeqhiymRcC5RADEnhG0kQEfyjXbg3NhzPxMb2nTVuhgAAAAAAAAAAAAAAAAAAAAACAWcEAAAAAAAAAWgEAAAAAAAAAAAgTHitrPKi9a2A8n7X1UqmnTp48cpn/e+ez1dU9bi7d7BMm5o6",
  signature:
    "APaG9nSW0qAx8Lg3/J6a6IxQgUpMl6GeSGTDZ9T1Gblqc/OshkBtgVokLFHIGlGj00038AFtxsKstaVEc+Sf8AMeLBUhjBcukNXOW1y0WQWY5tEWP9PMUDd/jQX+PmYWHA==",
  sender: PAYER,
} as const;

/** The dry-run balanceChanges captured for VALID_SPLIT (JSON-RPC shape). */
export const VALID_SPLIT_BALANCE_CHANGES = [
  {
    coinType: "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC",
    owner: { AddressOwner: "0x087aa862ca645c0b94400c49e11b491011fca35db837361ccfc4c6f69d356e86" },
    amount: "-10000",
  },
  {
    coinType: "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC",
    owner: { AddressOwner: "0xa071949ae86e2d817e1675988a619a41fff34203dfab23defdc5b3033378a557" },
    amount: "9800",
  },
  {
    coinType: "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC",
    owner: { AddressOwner: "0xc2995dd3edace45879f773527c46c510a5c84258e25af7cfc216644c4a5c96bd" },
    amount: "200",
  },
];

/**
 * A real GAS-PAYING object-write transaction (coin split + transfer). It violates
 * every gasless-shape rule at once: non-zero gasPrice, non-empty gasPayment, and a
 * non-allowlisted command — used to fixture the facilitator's step-3 rejection.
 */
export const BAD_GAS_PAYING_TX =
  "AAACAAgBAAAAAAAAAAAgdtgT4eT48gvZTnAlKOJMbTgr6JeIBFVQ4PKDKYfPU5UCAgABAQAAAQEDAAAAAAEBAAh6qGLKZFwLlEAMSeEbSRAR/KNduDc2HM/ExvadNW6GAYeTp0xeISkdiyqe4BFeW5gZN49jaNmko2eH/uwXGVf2ufebNQAAAAAgygG4vx5T2QDmwme4r01LEy9xQXIEGwnN4e8ZWdbqsIYIeqhiymRcC5RADEnhG0kQEfyjXbg3NhzPxMb2nTVuhugDAAAAAAAA4JctAAAAAAAA";

/**
 * The COIN-OBJECT payer that signed the coin-only fixture below — a fresh address
 * funded with USDC as a classic `Coin<T>` OBJECT (zero Address Balance). This is the
 * COMMON real-world case: anyone who just received USDC via a classic coin transfer.
 */
export const COIN_ONLY_PAYER = "0x1e5c9282e118ffccc232f7cad4856cc03a2b73d51043d482fbaab9d94c66896e";

/**
 * A REAL signed gasless payment built by THIS package's client for a coin-object payer
 * (10000 atomic USDC to RECIPIENT_1). The `tx.balance({ type, balance })` intent
 * resolves a `Coin<T>` source to the PTB `[SplitCoins, coin::into_balance,
 * balance::send_funds, coin::send_funds]` — `gasPrice = 0`, `gasPayment = []`. The
 * OLD command allowlist wrongly rejected this ("disallowed command: SplitCoins"), so
 * the facilitator refused payloads its own client builds.
 */
export const COIN_ONLY = {
  transaction:
    "AAAEACCgcZSa6G4tgX4WdZiKYZpB//NCA9+rI979xbMDM3ilVwEAIqs/0eGgPT1l//kHd24x3021kdf5L2LsrojUzgqXJ2vT95s1AAAAACD3jMirePnjvLMEgfnJak5PZyncOrjlcbum2QOtcOXDPwAIECcAAAAAAAAAIB5ckoLhGP/MwjL3ytSFbMA6K3PVEEPUgvuqudlMZoluBAIBAQABAQIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACBGNvaW4MaW50b19iYWxhbmNlAQeh7H/ACm9A25aTrRQV0MGTrTkGSUQozyUmIQN71xF+KQR1c2RjBFVTREMAAQMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACB2JhbGFuY2UKc2VuZF9mdW5kcwEHoex/wApvQNuWk60UFdDBk605BklEKM8lJiEDe9cRfikEdXNkYwRVU0RDAAIDAQAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgRjb2luCnNlbmRfZnVuZHMBB6Hsf8AKb0DblpOtFBXQwZOtOQZJRCjPJSYhA3vXEX4pBHVzZGMEVVNEQwACAQEAAQMAHlySguEY/8zCMvfK1IVswDorc9UQQ9SC+6q52UxmiW4AHlySguEY/8zCMvfK1IVswDorc9UQQ9SC+6q52UxmiW4AAAAAAAAAAAAAAAAAAAAAAgFoBAAAAAAAAAFpBAAAAAAAAAAAIEx4razyovWtgPJ+19VKpp06ePHKZ/3vns9XVPW4u3ewotX1Qg==",
  signature:
    "AMYZO2xXvCtau1ii1A77MB/CA9/kV4dd4UCFphmcbjaza647Ia6AhrTJKy41tu+CIDxqHvxINs7F/IKQKSJq3Ae5mTYEVwFgtslyCYJtsM4lTqzm0BkSXHk6Mepd7hB4Ew==",
  sender: COIN_ONLY_PAYER,
} as const;

/** The dry-run balanceChanges captured for COIN_ONLY (JSON-RPC shape). */
export const COIN_ONLY_BALANCE_CHANGES = [
  {
    coinType: "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC",
    owner: { AddressOwner: "0x1e5c9282e118ffccc232f7cad4856cc03a2b73d51043d482fbaab9d94c66896e" },
    amount: "-10000",
  },
  {
    coinType: "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC",
    owner: { AddressOwner: "0xa071949ae86e2d817e1675988a619a41fff34203dfab23defdc5b3033378a557" },
    amount: "10000",
  },
];

/**
 * A PTB with GASLESS gas fields (`gasPrice = 0`, `gasPayment = []`) carrying a single
 * `TransferObjects` command — the object-leak vector. The gasless-shape guard MUST
 * still reject it (`disallowed command: TransferObjects`) even though the gas fields
 * look gasless: only `SplitCoins`/`MergeCoins` coin-plumbing is tolerated.
 */
export const TRANSFER_OBJECTS_TX =
  "AAACAQCHk6dMXiEpHYsqnuARXluYGTePY2jZpKNnh/7sFxlX9tX3mzUAAAAAIApKxRpfoVEEuCcpwzmvKMq73RdbNRF0OPMurO4V2XLoACCgcZSa6G4tgX4WdZiKYZpB//NCA9+rI979xbMDM3ilVwEBAQEAAAEBAAh6qGLKZFwLlEAMSeEbSRAR/KNduDc2HM/ExvadNW6GAAh6qGLKZFwLlEAMSeEbSRAR/KNduDc2HM/ExvadNW6GAAAAAAAAAAAAAAAAAAAAAAIBaAQAAAAAAAABaQQAAAAAAAAAACBMeK2s8qL1rYDyftfVSqadOnjxymf9757PV1T1uLt3sCep+Qk=";
