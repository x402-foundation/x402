/**
 * Payment API routes with delegation support
 * Part of the ext-delegation feature for x402
 */

import { Router } from 'express';
import { DelegationHandler } from '../../extensions/delegation/handler';
import { PaymentVerifier } from '../../services/payment/verifier';
import { PaymentProcessor } from '../../services/payment/processor';
import { PaymentRequiredExtensions } from '../../types/payment';

const router = Router();

export function setupPaymentRoutes(
  delegationHandler: DelegationHandler,
  paymentVerifier: PaymentVerifier,
  paymentProcessor: PaymentProcessor,
) {
  // ... existing routes

  // Get payment requirements with delegation support
  router.get('/payment-required', async (req, res) => {
    try {
      const paymentRequired: PaymentRequiredExtensions = {
        // ... other extensions
        delegation: {
          required: false, // Can be configured per server
          supportedPrivacyModes: ['full', 'attestation', 'none'],
        },
      };

      const processed = await delegationHandler.processPaymentRequired(paymentRequired);
      res.json(processed);
    } catch (error) {
      res.status(500).json({ error: 'Failed to get payment requirements' });
    }
  });

  // ... rest of routes
}

export default router;
