/**
 * Advanced Express Server Examples
 *
 * This package demonstrates advanced patterns for production-ready x402 servers:
 *
 * - all-networks: All supported networks with optional chain configuration
 * - bazaar: Bazaar discovery extension for API discoverability
 * - hooks: Payment lifecycle hooks for verification and settlement
 * - dynamic-price: Dynamic pricing based on request context
 * - dynamic-pay-to: Route payments to different addresses
 * - custom-money-definition: Use alternative tokens for payments
 *
 * Usage:
 *   npm start all-networks
 *   npm start bazaar
 *   npm start hooks
 *   npm start dynamic-price
 *   npm start dynamic-pay-to
 *   npm start custom-money-definition
 */

const example = process.argv[2] || "bazaar";

console.log(`\n🚀 Running advanced server example: ${example}\n`);

switch (example) {
  case "all-networks":
    await import("./all_networks.js");
    break;
  case "bazaar":
    await import("./bazaar.js");
    break;
  case "hooks":
    await import("./hooks.js");
    break;
  case "dynamic-price":
    await import("./dynamic-price.js");
    break;
  case "dynamic-pay-to":
    await import("./dynamic-pay-to.js");
    break;
  case "custom-money-definition":
    await import("./custom-money-definition.js");
    break;
  default:
    console.error(`❌ Unknown example: ${example}`);
    console.error(
      "Available examples: all-networks, bazaar, hooks, dynamic-price, dynamic-pay-to, custom-money-definition",
    );
    process.exit(1);
}
