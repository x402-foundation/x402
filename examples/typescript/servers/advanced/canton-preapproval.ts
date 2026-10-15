/**
 * One-time Canton merchant setup for the `all_networks` server.
 *
 * Canton's `exact` scheme settles to a merchant only while it holds a live Canton
 * Coin `TransferPreapproval`. This creates one for CANTON_ADDRESS, or renews it
 * when it expires within a week, signing with the merchant's own key. The
 * merchant pays the preapproval fee from its own Canton Coin.
 *
 *   pnpm setup:canton-preapproval
 */
import { config } from "dotenv";
import { ensureTransferPreapproval } from "@x402/canton";

config();

const {
  CANTON_ADDRESS,
  CANTON_PRIVATE_KEY,
  CANTON_PARTICIPANT_URL,
  CANTON_TOKEN,
  CANTON_USER_ID,
  CANTON_SYNCHRONIZER_ID,
  CANTON_SCAN_URL,
} = process.env;
if (
  !CANTON_ADDRESS ||
  !CANTON_PRIVATE_KEY ||
  !CANTON_PARTICIPANT_URL ||
  !CANTON_TOKEN ||
  !CANTON_USER_ID ||
  !CANTON_SYNCHRONIZER_ID ||
  !CANTON_SCAN_URL
) {
  console.error(
    "❌ CANTON_ADDRESS, CANTON_PRIVATE_KEY, CANTON_PARTICIPANT_URL, CANTON_TOKEN, CANTON_USER_ID, CANTON_SYNCHRONIZER_ID and CANTON_SCAN_URL are required",
  );
  process.exit(1);
}

const result = await ensureTransferPreapproval(
  {
    participantUrl: CANTON_PARTICIPANT_URL,
    token: CANTON_TOKEN,
    userId: CANTON_USER_ID,
    synchronizerId: CANTON_SYNCHRONIZER_ID,
    scanUrl: CANTON_SCAN_URL,
    party: CANTON_ADDRESS,
    privateKeyPem: CANTON_PRIVATE_KEY,
  },
  { expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000) },
);
console.log(`✅ TransferPreapproval ${result.action}, expires ${result.expiresAt}`);
