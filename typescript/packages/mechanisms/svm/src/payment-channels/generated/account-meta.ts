/**
 * Self-contained replacement for the `getAccountMetaFactory` helper from
 * `@solana/program-client-core`, so the vendored Payment Channels client
 * needs no dependency beyond `@solana/kit`. Behaviour matches the upstream
 * helper: a null account resolves to the program id (READONLY), a signer
 * value upgrades the role to its `*_SIGNER` variant and is attached as
 * `signer`, everything else maps writable/readonly by `isWritable`.
 */

import {
  AccountRole,
  type Address,
  isTransactionSigner,
  type TransactionSigner,
  upgradeRoleToSigner,
} from "@solana/kit";

/** A resolved instruction account: an address or signer value plus its writability. */
export type ResolvedInstructionAccount = {
  isWritable: boolean;
  value: Address | TransactionSigner | null;
};

/**
 *
 * @param value
 */
function isSigner(value: Address | TransactionSigner): value is TransactionSigner {
  return (
    typeof value === "object" &&
    value !== null &&
    "address" in value &&
    typeof (value as { address: unknown }).address === "string" &&
    isTransactionSigner(value as TransactionSigner)
  );
}

/**
 * Build the account-meta resolver used by the generated instruction builders.
 *
 * @param programAddress - The program id used to fill omitted optional accounts
 * @param optionalAccountStrategy - "programId" fills null accounts with the program id; "omitted" drops them
 * @returns A function mapping a resolved account to its `AccountMeta`
 */
export function getAccountMetaFactory(
  programAddress: Address,
  optionalAccountStrategy: "programId" | "omitted",
) {
  return (_inputName: string, account: ResolvedInstructionAccount) => {
    if (!account.value) {
      if (optionalAccountStrategy === "omitted") return undefined;
      return Object.freeze({ address: programAddress, role: AccountRole.READONLY });
    }
    const writableRole = account.isWritable ? AccountRole.WRITABLE : AccountRole.READONLY;
    const signer = isSigner(account.value);
    const address =
      typeof account.value === "object" && "address" in account.value
        ? account.value.address
        : account.value;
    return Object.freeze({
      address,
      role: signer ? upgradeRoleToSigner(writableRole) : writableRole,
      ...(signer ? { signer: account.value } : {}),
    });
  };
}
