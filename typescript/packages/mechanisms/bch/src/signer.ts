import { secp256k1 } from '@bitauth/libauth';
import { encodeCashAddr, hash160 } from './crypto';
import type { BchSigner } from './types';

/** Create a standard compressed-key BCH P2PKH signer from a 32-byte secret. */
export function createSecp256k1BchSigner(privateKey: Uint8Array): BchSigner {
  const publicKey = secp256k1.derivePublicKeyCompressed(privateKey);
  if (typeof publicKey === 'string') throw new Error(publicKey);
  return {
    getPublicKey: () => publicKey.slice(),
    signDigest: (digest) => {
      const signature = secp256k1.signMessageHashDER(privateKey, digest);
      if (typeof signature === 'string') throw new Error(signature);
      return Promise.resolve(signature);
    },
    getAddress: (network) => encodeCashAddr(hash160(publicKey), network),
  };
}
