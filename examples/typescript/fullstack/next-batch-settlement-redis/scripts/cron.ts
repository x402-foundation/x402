import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
for (const file of [".env.local", ".env"]) {
  const path = resolve(packageDir, file);
  if (!existsSync(path)) continue;

  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
    if (!match || match[1].startsWith("#")) continue;

    const value = (match[2] ?? "").replace(/^['"]|['"]$/g, "");
    process.env[match[1]] ??= value;
  }
}

const command = process.argv[2];
const [{ runClaimAndSettleCron, runClaimCron, runSettleCron }, { disconnectRedisChannelStorage }] =
  await Promise.all([import("../lib/cron"), import("../lib/server")]);

let summary;
switch (command) {
  case "claim":
    summary = await runClaimCron({ maxClaimsPerBatch: 100 });
    break;
  case "settle":
    summary = await runSettleCron();
    break;
  case "claim-and-settle":
    summary = await runClaimAndSettleCron({ maxClaimsPerBatch: 100 });
    break;
}

if (!summary) {
  console.error("Usage: tsx scripts/cron.ts <claim|settle|claim-and-settle>");
  process.exit(1);
}

console.log(JSON.stringify(summary, null, 2));
await disconnectRedisChannelStorage();
