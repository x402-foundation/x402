/**
 * Signature utilities for delegation grants
 * Part of the ext-delegation feature for x402
 */

import { ethers } from 'ethers';

export async function verifySignature(
  signerAddress: string,
  signature: string,
  message: string,
): Promise<boolean> {
  try {
    const address = ethers.utils.verifyMessage(message, signature);
    return address.toLowerCase() === signerAddress.toLowerCase();
  } catch (error) {
    return false;
  }
}

export async function signGrant(
  privateKey: string,
  grant: any,
): Promise<string> {
  const message = JSON.stringify(grant);
  const wallet = new ethers.Wallet(privateKey);
  return await wallet.signMessage(message);
}
