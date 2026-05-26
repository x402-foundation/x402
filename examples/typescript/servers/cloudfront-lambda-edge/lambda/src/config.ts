/**
 * x402 Configuration
 * 
 * Customize these values for your deployment.
 * Lambda@Edge doesn't support environment variables, so config is bundled.
 */

import type { RoutesConfig } from '@x402/core/server';

// Payment configuration
export const FACILITATOR_URL = 'https://x402.org/facilitator';
export const PAY_TO = '0xYourPaymentAddressHere';
export const NETWORK = 'eip155:84532'; // Base Sepolia testnet

// Route configuration
export const ROUTES: RoutesConfig = {
  '/api/*': {
    accepts: {
      scheme: 'exact',
      network: NETWORK,
      payTo: PAY_TO,
      price: '$0.001',
    },
    description: 'API access',
  },
  '/api/premium/**': {
    accepts: {
      scheme: 'exact',
      network: NETWORK,
      payTo: PAY_TO,
      price: '$0.01',
    },
    description: 'Premium API access',
  },
  '/content/**': {
    accepts: {
      scheme: 'exact',
      network: NETWORK,
      payTo: PAY_TO,
      price: '$0.005',
    },
    description: 'Premium content',
  },
};
