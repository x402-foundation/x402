// Scheme identifier for the auth-capture payment scheme.
export const AUTH_CAPTURE_SCHEME = "auth-capture" as const;

// Canonical AuthCaptureEscrow + token collector deployments from
// base/commerce-payments (https://github.com/base/commerce-payments). These are
// the audited, live addresses listed in the upstream README and are the source
// of truth for this scheme. They are universal constants, not configurable per
// merchant.
export const AUTH_CAPTURE_ESCROW_ADDRESS =
  "0xBdEA0D1bcC5966192B070Fdf62aB4EF5b4420cff" as const satisfies `0x${string}`;
export const EIP3009_TOKEN_COLLECTOR_ADDRESS =
  "0x0E3dF9510de65469C4518D7843919c0b8C7A7757" as const satisfies `0x${string}`;
export const PERMIT2_TOKEN_COLLECTOR_ADDRESS =
  "0x992476B9Ee81d52a5BdA0622C333938D0Af0aB26" as const satisfies `0x${string}`;

// ERC-3009 ReceiveWithAuthorization EIP-712 types
export const RECEIVE_AUTHORIZATION_TYPES = {
  ReceiveWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

// Uniswap Permit2 PermitTransferFrom EIP-712 types
export const PERMIT2_TRANSFER_FROM_TYPES = {
  PermitTransferFrom: [
    { name: "permitted", type: "TokenPermissions" },
    { name: "spender", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  TokenPermissions: [
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
  ],
} as const;
