import { describe, it, expect } from 'vitest';
import { verifyGrant, shouldCheckRevocation } from '../specs/grants';
import testVectors from '../specs/test-vectors.json';

describe('x402 Grant Conformance Suite', () => {
  testVectors.testVectors.forEach((vector: any) => {
    it(`[${vector.id}] ${vector.description}`, () => {
      const result = verifyGrant(
        vector.grant,
        vector.signature,
        vector.currentAgent,
        vector.now
      );

      expect(result).toBe(vector.expected.verifyGrant);

      const revocationCheck = shouldCheckRevocation(vector.grant, vector.now);
      expect(revocationCheck).toBe(vector.expected.shouldCheckRevocation);
    });
  });
});
