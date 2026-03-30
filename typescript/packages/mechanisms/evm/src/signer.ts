/**
 * ClientEvmSigner - Used by x402 clients to sign payment authorizations.
 *
 * Typically a viem WalletClient extended with publicActions:
 * ```typescript
 * const client = createWalletClient({
 *   account: privateKeyToAccount('0x...'),
 *   chain: baseSepolia,
 *   transport: http(),
 * }).extend(publicActions);
 * ```
 *
 * Or composed via `toClientEvmSigner(account, publicClient)`.
 */
export type ClientEvmSigner = {
  readonly address: `0x${string}`;
  signTypedData(message: {
    domain: Record<string, unknown>;
    types: Record<string, unknown>;
    primaryType: string;
    message: Record<string, unknown>;
  }): Promise<`0x${string}`>;
  /**
   * Optional on-chain reads.
   * Required only for extension enrichment (EIP-2612 / ERC-20 approval).
   */
  readContract?(args: {
    address: `0x${string}`;
    abi: readonly unknown[];
    functionName: string;
    args?: readonly unknown[];
  }): Promise<unknown>;
  /**
   * Optional: Signs a raw EIP-1559 transaction without broadcasting.
   * Required for ERC-20 approval gas sponsoring when the token lacks EIP-2612.
   */
  signTransaction?(args: {
    to: `0x${string}`;
    data: `0x${string}`;
    nonce: number;
    gas: bigint;
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
    chainId: number;
  }): Promise<`0x${string}`>;
  /**
   * Optional: Gets the current transaction count (nonce) for an address.
   * Required for ERC-20 approval gas sponsoring.
   */
  getTransactionCount?(args: { address: `0x${string}` }): Promise<number>;
  /**
   * Optional: Estimates current gas fees per gas.
   * Required for ERC-20 approval gas sponsoring.
   */
  estimateFeesPerGas?(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>;
};

/**
 * FacilitatorEvmSigner - Used by x402 facilitators to verify and settle payments
 * This is typically a viem PublicClient + WalletClient combination that can
 * read contract state, verify signatures, write transactions, and wait for receipts
 *
 * Supports multiple addresses for load balancing, key rotation, and high availability
 */
export type FacilitatorEvmSigner = {
  /**
   * Get all addresses this facilitator can use for signing
   * Enables dynamic address selection for load balancing and key rotation
   */
  getAddresses(): readonly `0x${string}`[];

  readContract(args: {
    address: `0x${string}`;
    abi: readonly unknown[];
    functionName: string;
    args?: readonly unknown[];
  }): Promise<unknown>;
  verifyTypedData(args: {
    address: `0x${string}`;
    domain: Record<string, unknown>;
    types: Record<string, unknown>;
    primaryType: string;
    message: Record<string, unknown>;
    signature: `0x${string}`;
  }): Promise<boolean>;
  writeContract(args: {
    address: `0x${string}`;
    abi: readonly unknown[];
    functionName: string;
    args: readonly unknown[];
    /** Optional gas limit. When provided, skips eth_estimateGas simulation. */
    gas?: bigint;
  }): Promise<`0x${string}`>;
  sendTransaction(args: { to: `0x${string}`; data: `0x${string}` }): Promise<`0x${string}`>;
  waitForTransactionReceipt(args: { hash: `0x${string}` }): Promise<{ status: string }>;
  getCode(args: { address: `0x${string}` }): Promise<`0x${string}` | undefined>;
};

/**
 * Composes a ClientEvmSigner from a local account and a public client.
 *
 * Use this when your signer (e.g., `privateKeyToAccount`) doesn't have
 * `readContract`. The `publicClient` provides the on-chain read capability.
 *
 * Alternatively, use a WalletClient extended with publicActions directly:
 * ```typescript
 * const signer = createWalletClient({
 *   account: privateKeyToAccount('0x...'),
 *   chain: baseSepolia,
 *   transport: http(),
 * }).extend(publicActions);
 * ```
 *
 * @param signer - A signer with `address` and `signTypedData` (and optionally `readContract`)
 * @param publicClient - A client with optional read/nonce/fee helpers
 * @param publicClient.readContract - The readContract method from the public client
 * @param publicClient.getTransactionCount - Optional getTransactionCount for ERC-20 approval
 * @param publicClient.estimateFeesPerGas - Optional estimateFeesPerGas for ERC-20 approval
 * @returns A ClientEvmSigner with any available optional capabilities
 *
 * @example
 * ```typescript
 * const account = privateKeyToAccount("0x...");
 * const publicClient = createPublicClient({ chain: baseSepolia, transport: http() });
 * const signer = toClientEvmSigner(account, publicClient);
 * ```
 */
export function toClientEvmSigner(
  signer: Omit<ClientEvmSigner, "readContract"> & {
    readContract?: ClientEvmSigner["readContract"];
  },
  publicClient?: {
    readContract(args: {
      address: `0x${string}`;
      abi: readonly unknown[];
      functionName: string;
      args?: readonly unknown[];
    }): Promise<unknown>;
    getTransactionCount?(args: { address: `0x${string}` }): Promise<number>;
    estimateFeesPerGas?(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>;
  },
): ClientEvmSigner {
  const readContract = signer.readContract ?? publicClient?.readContract.bind(publicClient);

  const result: ClientEvmSigner = {
    address: signer.address,
    signTypedData: msg => signer.signTypedData(msg),
  };

  if (readContract) {
    result.readContract = readContract;
  }

  // Forward optional capabilities from signer or publicClient
  const signTransaction = signer.signTransaction;
  if (signTransaction) {
    result.signTransaction = args => signTransaction(args);
  }

  const getTransactionCount =
    signer.getTransactionCount ?? publicClient?.getTransactionCount?.bind(publicClient);
  if (getTransactionCount) {
    result.getTransactionCount = args => getTransactionCount(args);
  }

  const estimateFeesPerGas =
    signer.estimateFeesPerGas ?? publicClient?.estimateFeesPerGas?.bind(publicClient);
  if (estimateFeesPerGas) {
    result.estimateFeesPerGas = () => estimateFeesPerGas();
  }

  return result;
}

/**
 * Converts a viem client with single address to a FacilitatorEvmSigner
 * Wraps the single address in a getAddresses() function for compatibility
 *
 * @param client - The client to convert (must have 'address' property)
 * @returns FacilitatorEvmSigner with getAddresses() support
 */
export function toFacilitatorEvmSigner(
  client: Omit<FacilitatorEvmSigner, "getAddresses"> & { address: `0x${string}` },
): FacilitatorEvmSigner {
  return {
    ...client,
    getAddresses: () => [client.address],
  };
}
