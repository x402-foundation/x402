/**
 * x402 Configuration
 * 
 * Customize these values for your deployment.
 * Lambda@Edge doesn't support environment variables, so config is bundled.
 */

import type { RoutesConfig } from '@x402/core/server';

// Payment configuration
export const FACILITATOR_URL = 'https://x402.org/facilitator';
export const EVM_NETWORK = 'eip155:84532'; // Base Sepolia testnet
export const EVM_PAY_TO = '0xYourEvmPaymentAddressHere';
export const SVM_NETWORK = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'; // Solana Devnet
export const SVM_PAY_TO = 'YourSolanaPaymentAddressHere';

// Route configuration
// Each route offers both networks, and the client picks one.
export const ROUTES: RoutesConfig = {
  '/api/*': {
    accepts: [
      {
        scheme: 'exact',
        network: EVM_NETWORK,
        payTo: EVM_PAY_TO,
        price: '$0.001',
      },
      {
        scheme: 'exact',
        network: SVM_NETWORK,
        payTo: SVM_PAY_TO,
        price: '$0.001',
      },
    ],
    description: 'API access',
  },
  '/api/premium/**': {
    accepts: [
      {
        scheme: 'exact',
        network: EVM_NETWORK,
        payTo: EVM_PAY_TO,
        price: '$0.01',
      },
      {
        scheme: 'exact',
        network: SVM_NETWORK,
        payTo: SVM_PAY_TO,
        price: '$0.01',
      },
    ],
    description: 'Premium API access',
  },
  '/content/**': {
    accepts: [
      {
        scheme: 'exact',
        network: EVM_NETWORK,
        payTo: EVM_PAY_TO,
        price: '$0.005',
      },
      {
        scheme: 'exact',
        network: SVM_NETWORK,
        payTo: SVM_PAY_TO,
        price: '$0.005',
      },
    ],
    description: 'Premium content',
  },
};
