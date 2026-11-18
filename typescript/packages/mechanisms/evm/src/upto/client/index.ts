// Note: The upto scheme does not provide register.ts convenience helpers (unlike exact).
// The exact scheme's register helpers exist primarily for V1 backward compatibility,
// which is not needed for upto. Use direct class instantiation instead:
//   client.register("eip155:*", new UptoEvmScheme(signer, options))
export { UptoEvmScheme } from "./scheme";
export type {
  UptoEvmSchemeConfig,
  UptoEvmSchemeConfigByChainId,
  UptoEvmSchemeOptions,
} from "./rpc";
export {
  createPermit2ApprovalTx,
  getPermit2AllowanceReadParams,
  type Permit2AllowanceParams,
} from "./permit2";
export { erc20AllowanceAbi } from "../../constants";
