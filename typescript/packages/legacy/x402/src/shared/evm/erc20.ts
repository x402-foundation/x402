import { Account, Address, Chain, Transport } from "viem";
import { usdcABI as erc20PermitABI } from "../../types/shared/evm/erc20PermitABI";
import { ConnectedClient } from "../../types/shared/evm/wallet";

/**
 * Gets the USDC balance for a specific address
 *
 * @param client - The Viem client instance connected to the blockchain
 * @param erc20Address - The address of the ERC20 contract
 * @param address - The address to check the USDC balance for
 * @returns A promise that resolves to the USDC balance as a bigint
 */
export async function getERC20Balance<
  transport extends Transport,
  chain extends Chain,
  account extends Account | undefined = undefined,
>(
  client: ConnectedClient<transport, chain, account>,
  erc20Address: Address,
  address: Address,
): Promise<bigint> {
  const balance = await client.readContract({
    address: erc20Address,
    abi: erc20PermitABI,
    functionName: "balanceOf",
    args: [address],
  });
  return balance as bigint;
}
