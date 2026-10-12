/**
 * Example of creating and using a delegation grant
 * Part of the ext-delegation feature for x402
 */

import { DelegationGrant } from '../src/extensions/delegation/types';
import { signGrant } from '../src/crypto/signature';

// Example: Principal grants agent permission to make payments
async function createDelegationGrant() {
  const grant: DelegationGrant = {
    principal: 'did:ethr:0x123...abc', // Principal's DID
    agent: '0x456...def', // Agent's address (must match authorization.from)
    audience: ['x402-foundation/x402'], // Which servers this grant is valid for
    maxAmount: '1000000', // Max 1.0 in minor units (e.g., wei)
    asset: 'eip155:1/erc20:0x6B175474E89094C44Da98b954EedeAC495271d0F', // USDC on Ethereum
    allowedNetworks: ['eip155:1', 'eip155:137'], // Ethereum and Polygon
    allowedRecipients: ['0x789...ghi', '0xabc...xyz'], // Allowed recipient addresses
    expiry: Math.floor(Date.now() / 1000) + 86400, // Expires in 24 hours
    id: 'grant_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
    disclosure: 'full', // Full disclosure mode
    budgetRef: 'https://budget.example.com/grants/123',
    constraints: {
      'vendor:acme/category': 'software',
      'purpose': 'recurring-payments',
    },
  };

  // Sign the grant with principal's private key
  const privateKey = '0x...'; // Principal's private key
  const signature = await signGrant(privateKey, grant);

  // Add signature to grant
  grant.signature = signature;

  return grant;
}

// Example usage
createDelegationGrant().then(grant => {
  console.log('Delegation Grant:', JSON.stringify(grant, null, 2));
});
<<<ENDFILE>>
