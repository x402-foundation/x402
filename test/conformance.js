const { ethers } = require("ethers");
const fs = require("fs");

const DOMAIN = {
  name: "x402-AgentGrant",
  version: "1",
  chainId: 8453,
  verifyingContract: "0x0000000000000000000000000000000000000000",
};

const TYPES = {
  x402Grant: [
    { name: "grantId", type: "uint256" },
    { name: "principal", type: "address" },
    { name: "agent", type: "address" },
    { name: "issuedAt", type: "uint256" },
    { name: "expiration", type: "uint256" },
    { name: "totalBudget", type: "uint256" },
    { name: "perRequestCap", type: "uint256" },
    { name: "scopes", type: "bytes32[]" },
    { name: "salt", type: "bytes32" },
  ],
};

function verifyGrant(grant, signature, expectedAgent, now = Math.floor(Date.now() / 1000)) {
  // 1. Check time bounds (with 30-second grace)
  if (grant.expiration < now - 30 || grant.issuedAt > now + 30) {
    return false;
  }

  // 2. Recover signer from signature
  let recoveredSigner;
  try {
    recoveredSigner = ethers.verifyTypedData(DOMAIN, TYPES, grant, signature);
  } catch (e) {
    return false;
  }

  // 3. Verify signer matches principal
  if (recoveredSigner.toLowerCase() !== grant.principal.toLowerCase()) {
    return false;
  }

  // 4. Verify agent matches expected
  if (grant.agent.toLowerCase() !== expectedAgent.toLowerCase()) {
    return false;
  }

  // 5. Verify budget is non-zero
  if (BigInt(grant.totalBudget) <= 0n) {
    return false;
  }

  return true;
}

async function runConformanceTests() {
  console.log("=== x402 Conformance Test Suite ===\n");

  const vectors = JSON.parse(fs.readFileSync("./specs/test-vectors.json", "utf8")).test_vectors;

  let passed = 0;
  let failed = 0;

  for (const test of vectors) {
    const result = verifyGrant(
      test.grant,
      test.signature,
      test.expectedAgent,
      parseInt(test.now)
    );

    const expected = test.expected === "pass";
    const status = result === expected ? "✅ PASS" : "❌ FAIL";

    if (result === expected) passed++;
    else failed++;

    console.log(`${status} | Test ${test.id}: ${test.name}`);
    console.log(`      Expected: ${expected ? "pass" : "fail"}, Got: ${result ? "pass" : "fail"}`);
    if (test.note) console.log(`      Note: ${test.note}`);
    console.log();
  }

  console.log(`\n=== Results ===`);
  console.log(`Passed: ${passed}/${vectors.length}`);
  console.log(`Failed: ${failed}/${vectors.length}`);

  if (failed === 0) {
    console.log("\n✨ All tests passed! x402 implementation is conformant.");
    process.exit(0);
  } else {
    console.log(`\n⚠️  ${failed} test(s) failed.`);
    process.exit(1);
  }
}

runConformanceTests().catch(console.error);
