/**
 * SPL token account fixtures for facilitator unit tests: account data in the
 * 165-byte base layout, and a `getAccountInfo` stand-in that serves a healthy
 * settlement ATA for each named owner.
 */

import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { findAssociatedTokenPda, TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022";
import { address, getAddressEncoder } from "@solana/kit";

/** Token account fields a fixture may override. */
export interface TokenAccountFixture {
  mint: string;
  owner: string;
  amount?: bigint;
  /** 1 initialized (default), 2 frozen. */
  state?: number;
  /** Owning token program; defaults to SPL Token. */
  program?: string;
  /** Raw Token-2022 extension bytes appended after the base layout. */
  extensionBytes?: Uint8Array;
}

/**
 * Raw token account data.
 *
 * @param fixture - Account fields
 * @returns The account data bytes
 */
export function tokenAccountData(fixture: TokenAccountFixture): Uint8Array {
  const base = new Uint8Array(165);
  base.set(getAddressEncoder().encode(address(fixture.mint)) as Uint8Array, 0);
  base.set(getAddressEncoder().encode(address(fixture.owner)) as Uint8Array, 32);
  new DataView(base.buffer).setBigUint64(64, fixture.amount ?? 1_000_000_000n, true);
  base[108] = fixture.state ?? 1;
  if (!fixture.extensionBytes) return base;
  const out = new Uint8Array(base.length + fixture.extensionBytes.length);
  out.set(base, 0);
  out.set(fixture.extensionBytes, base.length);
  return out;
}

/**
 * The `getAccountInfo` result for a token account.
 *
 * @param fixture - Account fields
 * @returns A facilitator account info
 */
export function tokenAccountInfo(fixture: TokenAccountFixture) {
  return {
    data: [Buffer.from(tokenAccountData(fixture)).toString("base64"), "base64"] as [string, string],
    lamports: 2_039_280n,
    owner: fixture.program ?? TOKEN_PROGRAM_ADDRESS,
  };
}

/**
 * A `getAccountInfo` implementation serving a healthy, funded ATA for each
 * owner (under either token program) and `fallback` for every other address.
 *
 * @param args - Reader configuration
 * @param args.mint - Mint every ATA holds
 * @param args.owners - Owners with an ATA; read lazily so test keys can be generated late
 * @param args.fallback - Result for any other address
 * @param args.override - Per-owner field overrides (e.g. a frozen state)
 * @returns An async account reader
 */
export function settlementAtaReader(args: {
  mint: string;
  owners: () => readonly string[];
  fallback?: unknown;
  override?: (owner: string) => Partial<TokenAccountFixture> | undefined;
}) {
  return async (accountAddress: string) => {
    for (const owner of args.owners()) {
      for (const program of [TOKEN_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS]) {
        const [ata] = await findAssociatedTokenPda({
          mint: address(args.mint),
          owner: address(owner),
          tokenProgram: program,
        });
        if (ata === accountAddress) {
          return tokenAccountInfo({ mint: args.mint, owner, program, ...args.override?.(owner) });
        }
      }
    }
    return args.fallback === undefined ? { owner: TOKEN_PROGRAM_ADDRESS } : args.fallback;
  };
}
