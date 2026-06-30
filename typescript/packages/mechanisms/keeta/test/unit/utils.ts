import * as KeetaNet from "@keetanetwork/keetanet-client";

export function getNewKeetaAccount() {
  return KeetaNet.lib.Account.fromSeed(
    KeetaNet.lib.Account.generateRandomSeed({ asString: true }),
    0,
  );
}
