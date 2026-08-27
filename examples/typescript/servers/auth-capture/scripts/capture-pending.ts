import { config } from "dotenv";

config();

const baseUrl = process.env.RESOURCE_SERVER_URL?.trim() || "http://localhost:4021";
const voidRemainder = process.argv.includes("--void");

/**
 * Capture the most recent authorized payment via the deferred server's admin API.
 *
 * @returns Resolves after the capture (or void) request completes.
 */
async function main(): Promise<void> {
  const listResponse = await fetch(`${baseUrl}/admin/payments`);
  if (!listResponse.ok) {
    throw new Error(`Failed to list payments: ${listResponse.status} ${await listResponse.text()}`);
  }

  const payments = (await listResponse.json()) as Array<{
    paymentInfoHash: `0x${string}`;
    capturableAmount: string;
  }>;

  if (payments.length === 0) {
    console.log(
      "No authorized payments in storage. Pay GET /weather first, then rerun this script.",
    );
    return;
  }

  const latest = payments[payments.length - 1]!;
  console.log(`Latest payment: ${latest.paymentInfoHash} (capturable: ${latest.capturableAmount})`);

  if (voidRemainder) {
    const voidResponse = await fetch(`${baseUrl}/admin/void`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paymentInfoHash: latest.paymentInfoHash }),
    });
    const voidBody = await voidResponse.json();
    console.log("Void response:", JSON.stringify(voidBody, null, 2));
    return;
  }

  const captureResponse = await fetch(`${baseUrl}/admin/capture`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      paymentInfoHash: latest.paymentInfoHash,
      voidRemainder: true,
    }),
  });
  const captureBody = await captureResponse.json();
  console.log("Capture response:", JSON.stringify(captureBody, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
