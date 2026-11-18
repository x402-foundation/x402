/**
 * MCP Client Example Entry Point
 *
 * Routes to either simple or advanced example based on CLI arguments.
 *
 * Usage:
 *   pnpm dev           - Run simple example (createx402MCPClient factory)
 *   pnpm dev:advanced  - Run advanced example (x402MCPClient with manual setup)
 */

const mode = process.argv[2] || "simple";

/**
 * Runs the MCP client example based on the selected mode.
 *
 * @returns Promise that resolves when the example completes
 */
async function run(): Promise<void> {
  if (mode === "advanced") {
    const { main } = await import("./advanced.js");
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
