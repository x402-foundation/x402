// EIP-3009 TransferWithAuthorization types for EIP-712 signing
export const authorizationTypes = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/**
 * Permit2 EIP-712 types for signing PermitWitnessTransferFrom (exact scheme).
 * Must match the exact format expected by the Permit2 contract.
 * Note: Types must be in ALPHABETICAL order after the primary type (TokenPermissions < Witness).
 */
export const permit2WitnessTypes = {
  PermitWitnessTransferFrom: [
    { name: "permitted", type: "TokenPermissions" },
    { name: "spender", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "witness", type: "Witness" },
  ],
  TokenPermissions: [
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
  ],
  Witness: [
    { name: "to", type: "address" },
    { name: "validAfter", type: "uint256" },
  ],
} as const;

/**
 * Permit2 EIP-712 types for signing PermitWitnessTransferFrom (upto scheme).
 * The upto witness includes a `facilitator` field that the exact witness does not.
 * This ensures only the authorized facilitator can settle the payment.
 * Must match: Witness(address to,address facilitator,uint256 validAfter)
 */
export const uptoPermit2WitnessTypes = {
  PermitWitnessTransferFrom: [
    { name: "permitted", type: "TokenPermissions" },
    { name: "spender", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "witness", type: "Witness" },
  ],
  TokenPermissions: [
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
  ],
  Witness: [
    { name: "to", type: "address" },
    { name: "facilitator", type: "address" },
    { name: "validAfter", type: "uint256" },
  ],
} as const;

// EIP3009 ABI for transferWithAuthorization function
export const eip3009ABI = [
  {
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
    name: "transferWithAuthorization",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "signature", type: "bytes" },
    ],
    name: "transferWithAuthorization",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "version",
    outputs: [{ name: "", type: "string" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "name",
    outputs: [{ name: "", type: "string" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { name: "authorizer", type: "address" },
      { name: "nonce", type: "bytes32" },
    ],
    name: "authorizationState",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

/**
 * EIP-2612 Permit EIP-712 types for signing token.permit().
 */
export const eip2612PermitTypes = {
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

/**
 * EIP-2612 nonces ABI for querying current nonce.
 */
export const eip2612NoncesAbi = [
  {
    type: "function",
    name: "nonces",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
] as const;

/** ERC-20 approve(address,uint256) ABI for encoding/decoding approval calldata. */
export const erc20ApproveAbi = [
  {
    type: "function",
    name: "approve",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
    stateMutability: "nonpayable",
  },
] as const;

/** ERC-20 allowance(address,address) ABI for checking spender approval. */
export const erc20AllowanceAbi = [
  {
    type: "function",
    name: "allowance",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
] as const;

/** Gas limit for a standard ERC-20 approve() transaction. */
export const ERC20_APPROVE_GAS_LIMIT = 70_000n;

/** Fallback max fee per gas (1 gwei) when fee estimation fails. */
export const DEFAULT_MAX_FEE_PER_GAS = 1_000_000_000n;

/** Fallback max priority fee per gas (0.1 gwei) when fee estimation fails. */
export const DEFAULT_MAX_PRIORITY_FEE_PER_GAS = 100_000_000n;

/**
 * Canonical Permit2 contract address.
 * Same address on all EVM chains via CREATE2 deployment.
 *
 * @see https://github.com/Uniswap/permit2
 */
export const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as const;

/**
 * x402ExactPermit2Proxy contract address.
 * Vanity address: 0x4020...0001 for easy recognition.
 * This address is deterministic based on:
 * - Arachnid's deterministic deployer (0x4e59b44847b379578588920cA78FbF26c0B4956C)
 * - Vanity-mined salt for prefix 0x4020 and suffix 0001
 * - Contract bytecode + constructor args (PERMIT2_ADDRESS)
 */
export const x402ExactPermit2ProxyAddress = "0x402085c248EeA27D92E8b30b2C58ed07f9E20001" as const;

/**
 * x402UptoPermit2Proxy contract address.
 * Vanity address: 0x4020...0002 for easy recognition.
 * This address is deterministic based on:
 * - Arachnid's deterministic deployer (0x4e59b44847b379578588920cA78FbF26c0B4956C)
 * - Vanity-mined salt for prefix 0x4020 and suffix 0002
 * - Contract bytecode + constructor args (PERMIT2_ADDRESS)
 */
export const x402UptoPermit2ProxyAddress = "0x4020A4f3b7b90ccA423B9fabCc0CE57C6C240002" as const;

/**
 * ABI components for the exact Permit2 witness tuple: Witness(address to, uint256 validAfter).
 */
const permit2WitnessABIComponents = [
  { name: "to", type: "address", internalType: "address" },
  { name: "validAfter", type: "uint256", internalType: "uint256" },
] as const;

/**
 * ABI components for the upto Permit2 witness tuple:
 * Witness(address to, address facilitator, uint256 validAfter).
 */
const uptoPermit2WitnessABIComponents = [
  { name: "to", type: "address", internalType: "address" },
  { name: "facilitator", type: "address", internalType: "address" },
  { name: "validAfter", type: "uint256", internalType: "uint256" },
] as const;

/**
 * x402UptoPermit2Proxy ABI — settle/settleWithPermit for the upto payment scheme.
 * Key differences from exact: settle() takes a `uint256 amount` parameter, and the
 * Witness struct includes an `address facilitator` field.
 */
export const x402UptoPermit2ProxyABI = [
  {
    type: "function",
    name: "PERMIT2",
    inputs: [],
    outputs: [{ name: "", type: "address", internalType: "contract ISignatureTransfer" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "WITNESS_TYPEHASH",
    inputs: [],
    outputs: [{ name: "", type: "bytes32", internalType: "bytes32" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "WITNESS_TYPE_STRING",
    inputs: [],
    outputs: [{ name: "", type: "string", internalType: "string" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "settle",
    inputs: [
      {
        name: "permit",
        type: "tuple",
        internalType: "struct ISignatureTransfer.PermitTransferFrom",
        components: [
          {
            name: "permitted",
            type: "tuple",
            internalType: "struct ISignatureTransfer.TokenPermissions",
            components: [
              { name: "token", type: "address", internalType: "address" },
              { name: "amount", type: "uint256", internalType: "uint256" },
            ],
          },
          { name: "nonce", type: "uint256", internalType: "uint256" },
          { name: "deadline", type: "uint256", internalType: "uint256" },
        ],
      },
      { name: "amount", type: "uint256", internalType: "uint256" },
      { name: "owner", type: "address", internalType: "address" },
      {
        name: "witness",
        type: "tuple",
        internalType: "struct x402UptoPermit2Proxy.Witness",
        components: uptoPermit2WitnessABIComponents,
      },
      { name: "signature", type: "bytes", internalType: "bytes" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "settleWithPermit",
    inputs: [
      {
        name: "permit2612",
        type: "tuple",
        internalType: "struct x402UptoPermit2Proxy.EIP2612Permit",
        components: [
          { name: "value", type: "uint256", internalType: "uint256" },
          { name: "deadline", type: "uint256", internalType: "uint256" },
          { name: "r", type: "bytes32", internalType: "bytes32" },
          { name: "s", type: "bytes32", internalType: "bytes32" },
          { name: "v", type: "uint8", internalType: "uint8" },
        ],
      },
      {
        name: "permit",
        type: "tuple",
        internalType: "struct ISignatureTransfer.PermitTransferFrom",
        components: [
          {
            name: "permitted",
            type: "tuple",
            internalType: "struct ISignatureTransfer.TokenPermissions",
            components: [
              { name: "token", type: "address", internalType: "address" },
              { name: "amount", type: "uint256", internalType: "uint256" },
            ],
          },
          { name: "nonce", type: "uint256", internalType: "uint256" },
          { name: "deadline", type: "uint256", internalType: "uint256" },
        ],
      },
      { name: "amount", type: "uint256", internalType: "uint256" },
      { name: "owner", type: "address", internalType: "address" },
      {
        name: "witness",
        type: "tuple",
        internalType: "struct x402UptoPermit2Proxy.Witness",
        components: uptoPermit2WitnessABIComponents,
      },
      { name: "signature", type: "bytes", internalType: "bytes" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  { type: "event", name: "Settled", inputs: [], anonymous: false },
  { type: "event", name: "SettledWithPermit", inputs: [], anonymous: false },
  { type: "error", name: "AmountExceedsPermitted", inputs: [] },
  { type: "error", name: "InvalidDestination", inputs: [] },
  { type: "error", name: "InvalidOwner", inputs: [] },
  { type: "error", name: "InvalidPermit2Address", inputs: [] },
  { type: "error", name: "PaymentTooEarly", inputs: [] },
  { type: "error", name: "Permit2612AmountMismatch", inputs: [] },
  { type: "error", name: "ReentrancyGuardReentrantCall", inputs: [] },
  { type: "error", name: "UnauthorizedFacilitator", inputs: [] },
] as const;

/**
 * x402ExactPermit2Proxy ABI - settle function for exact payment scheme.
 */
export const x402ExactPermit2ProxyABI = [
  {
    type: "function",
    name: "PERMIT2",
    inputs: [],
    outputs: [{ name: "", type: "address", internalType: "contract ISignatureTransfer" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "WITNESS_TYPEHASH",
    inputs: [],
    outputs: [{ name: "", type: "bytes32", internalType: "bytes32" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "WITNESS_TYPE_STRING",
    inputs: [],
    outputs: [{ name: "", type: "string", internalType: "string" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "settle",
    inputs: [
      {
        name: "permit",
        type: "tuple",
        internalType: "struct ISignatureTransfer.PermitTransferFrom",
        components: [
          {
            name: "permitted",
            type: "tuple",
            internalType: "struct ISignatureTransfer.TokenPermissions",
            components: [
              { name: "token", type: "address", internalType: "address" },
              { name: "amount", type: "uint256", internalType: "uint256" },
            ],
          },
          { name: "nonce", type: "uint256", internalType: "uint256" },
          { name: "deadline", type: "uint256", internalType: "uint256" },
        ],
      },
      { name: "owner", type: "address", internalType: "address" },
      {
        name: "witness",
        type: "tuple",
        internalType: "struct x402ExactPermit2Proxy.Witness",
        components: permit2WitnessABIComponents,
      },
      { name: "signature", type: "bytes", internalType: "bytes" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "settleWithPermit",
    inputs: [
      {
        name: "permit2612",
        type: "tuple",
        internalType: "struct x402ExactPermit2Proxy.EIP2612Permit",
        components: [
          { name: "value", type: "uint256", internalType: "uint256" },
          { name: "deadline", type: "uint256", internalType: "uint256" },
          { name: "r", type: "bytes32", internalType: "bytes32" },
          { name: "s", type: "bytes32", internalType: "bytes32" },
          { name: "v", type: "uint8", internalType: "uint8" },
        ],
      },
      {
        name: "permit",
        type: "tuple",
        internalType: "struct ISignatureTransfer.PermitTransferFrom",
        components: [
          {
            name: "permitted",
            type: "tuple",
            internalType: "struct ISignatureTransfer.TokenPermissions",
            components: [
              { name: "token", type: "address", internalType: "address" },
              { name: "amount", type: "uint256", internalType: "uint256" },
            ],
          },
          { name: "nonce", type: "uint256", internalType: "uint256" },
          { name: "deadline", type: "uint256", internalType: "uint256" },
        ],
      },
      { name: "owner", type: "address", internalType: "address" },
      {
        name: "witness",
        type: "tuple",
        internalType: "struct x402ExactPermit2Proxy.Witness",
        components: permit2WitnessABIComponents,
      },
      { name: "signature", type: "bytes", internalType: "bytes" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  { type: "event", name: "Settled", inputs: [], anonymous: false },
  { type: "event", name: "SettledWithPermit", inputs: [], anonymous: false },
  { type: "error", name: "InvalidAmount", inputs: [] },
  { type: "error", name: "InvalidDestination", inputs: [] },
  { type: "error", name: "InvalidOwner", inputs: [] },
  { type: "error", name: "InvalidPermit2Address", inputs: [] },
  { type: "error", name: "PaymentTooEarly", inputs: [] },
  { type: "error", name: "Permit2612AmountMismatch", inputs: [] },
  { type: "error", name: "ReentrancyGuardReentrantCall", inputs: [] },
] as const;
