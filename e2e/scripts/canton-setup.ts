/**
 * Makes sure the e2e Canton payee can be paid.
 *
 * The `exact` scheme settles to a merchant only when it holds a live Canton Coin
 * `TransferPreapproval`. This script creates one for SERVER_CANTON_ADDRESS, or
 * renews it when it expires within a week, signing with the payee's own key.
 * The payee pays the preapproval fee from its own Canton Coin, so fund it first
 * (on DevNet, from your validator wallet's tap).
 *
 *   pnpm canton:setup
 */
import { config } from "dotenv";
import { ensureTransferPreapproval } from "@x402/canton";

config();

const required = [
  "CANTON_PARTICIPANT_URL",
  "CANTON_TOKEN",
  "CANTON_USER_ID",
  "CANTON_SYNCHRONIZER_ID",
  "CANTON_SCAN_URL",
  "SERVER_CANTON_ADDRESS",
  "SERVER_CANTON_PRIVATE_KEY",
] as const;
const missing = required.filter(name => !process.env[name]);
if (missing.length > 0) {
  console.error(`Missing ${missing.join(", ")} (see e2e/.env-local)`);
  process.exit(1);
}
const env = process.env as Record<(typeof required)[number], string>;

async function main(): Promise<void> {
  const result = await ensureTransferPreapproval(
    {
      participantUrl: env.CANTON_PARTICIPANT_URL,
      token: env.CANTON_TOKEN,
      userId: env.CANTON_USER_ID,
      synchronizerId: env.CANTON_SYNCHRONIZER_ID,
      scanUrl: env.CANTON_SCAN_URL,
      ...(process.env.CANTON_SCAN_TOKEN ? { scanToken: process.env.CANTON_SCAN_TOKEN } : {}),
      party: env.SERVER_CANTON_ADDRESS,
      privateKeyPem: env.SERVER_CANTON_PRIVATE_KEY,
    },
    { expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000) },
  );
  console.log(
    `TransferPreapproval for ${env.SERVER_CANTON_ADDRESS}: ${result.action}, expires ${result.expiresAt}` +
      (result.updateId ? ` (update ${result.updateId})` : ""),
  );
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
