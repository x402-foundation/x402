import { Network, PaymentRequirements } from "../types";
import { getUsdcChainConfigForChain } from "../shared/evm";
import { getNetworkId } from "../shared/network";

/**
 * Default selector for payment requirements.
 * Default behavior is to select the first payment requirement that has a USDC asset.
 * If no USDC payment requirement is found, the first payment requirement is selected.
 *
 * @param paymentRequirements - The payment requirements to select from.
 * @param network - The network to check against. If not provided, the network will not be checked.
 * @param scheme - The scheme to check against. If not provided, the scheme will not be checked.
 * @returns The payment requirement that is the most appropriate for the user.
 */
export function selectPaymentRequirements(paymentRequirements: PaymentRequirements[], network?: Network | Network[], scheme?: "exact"): PaymentRequirements {
  // Filter down to the scheme/network if provided
  const broadlyAcceptedPaymentRequirements = paymentRequirements.filter(requirement => {
    // If the scheme is not provided, we accept any scheme.
    const isExpectedScheme = !scheme || requirement.scheme === scheme;
    // If the chain is not provided, we accept any chain.
    const isExpectedChain = !network || (Array.isArray(network) ? network.includes(requirement.network) : network == requirement.network);

    return isExpectedScheme && isExpectedChain;
  });

  // Filter down to USDC requirements
  const usdcRequirements = broadlyAcceptedPaymentRequirements.filter(requirement => {
    // If the address is a USDC address, we return it.
    return requirement.asset === getUsdcChainConfigForChain(getNetworkId(requirement.network))?.usdcAddress;
  });

  // Prioritize USDC requirements if available
  if (usdcRequirements.length > 0) {
    return usdcRequirements[0];
  }
  // If no USDC requirements are found, return the first broadly accepted requirement.
  if (broadlyAcceptedPaymentRequirements.length > 0) {
    return broadlyAcceptedPaymentRequirements[0];
  }
  // If no matching requirements are found, return the first requirement.
  return paymentRequirements[0];
}

/**
 * Selector for payment requirements.
 *
 * @param paymentRequirements - The payment requirements to select from.
 * @param network - The network to check against. If not provided, the network will not be checked.
 * @param scheme - The scheme to check against. If not provided, the scheme will not be checked.
 * @returns The payment requirement that is the most appropriate for the user.
 */
export type PaymentRequirementsSelector = (paymentRequirements: PaymentRequirements[], network?: Network | Network[], scheme?: "exact") => PaymentRequirements;

