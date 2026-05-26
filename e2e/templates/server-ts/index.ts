/**
 * Express E2E Test Server with x402 Payment Middleware
 *
 * This server demonstrates how to integrate x402 payment middleware
 * with an Express application for end-to-end testing.
 */

/**
 * Environment variables
 * - PORT: Port to listen on
 * - EVM_PAYEE_ADDRESS: EVM address to receive payments
 * - SVM_PAYEE_ADDRESS: SVM address to receive payments
 * - FACILITATOR_URL: URL of the facilitator
 */

/**
 * Implement Server app
 * - Create server
 * - Register x402 middleware
 * - Configure payment required endpoints in middleware
 * - Implement payment required endpoints
 * - Implement health check endpoint
 * - Implement shutdown endpoint
 * 
 * On startup, log the server details and endpoints
╔════════════════════════════════════════════════════════╗
║           x402 <Framework> E2E Test Server             ║
╠════════════════════════════════════════════════════════╣
║  Server:     http://localhost:<port>                   ║
║  Protocol Family: <protocol family>                    ║
║  Network:    <network>                                 ║
║  Payee:      <payee address>                           ║
║                                                        ║
║  Endpoints:                                            ║
║  • GET  /protected  (requires <payment amount> <currency> payment)    ║
║  • GET  /health     (no payment required)              ║
║  • POST /close      (shutdown server)                  ║
╚════════════════════════════════════════════════════════╝
 */
