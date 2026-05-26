/**
 * MCP Server Example Entry Point
 *
 * Routes to simple, advanced, or existing-server example based on CLI arguments.
 *
 * Usage:
 *   pnpm dev           - Run simple example (createPaymentWrapper)
 *   pnpm dev:advanced  - Run advanced example (createPaymentWrapper with hooks)
 *   pnpm dev:existing  - Run existing server example (createPaymentWrapper with existing server)
 */

const mode = process.argv[2] || "simple";

/**
 * Runs the MCP server example based on the selected mode.
 *
 * @returns Promise that resolves when the server starts
 */
async function run(): Promise<void> {
  if (mode === "advanced") {
    const { main } = await import("./advanced.js");
    await main();
  } else if (mode === "existing") {
    const { main } = await import("./existing-server.js");
    await main();
  } else {
    const { main } = await import("./simple.js");
    await main();
  }
}

run().catch(error => {
  console.error("Fatal error:", error);
  process.exit(1);
});
