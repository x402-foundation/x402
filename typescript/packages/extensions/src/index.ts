// Shared extension utilities
export { WithExtensions } from "./types";

// Bazaar extension
export * from "./bazaar";
export { bazaarResourceServerExtension } from "./bazaar/server";

// Sign-in-with-x extension
export * from "./sign-in-with-x";

// Offer/Receipt extension
export * from "./offer-receipt";

// Payment-identifier extension
export * from "./payment-identifier";
export { paymentIdentifierResourceServerExtension } from "./payment-identifier/resourceServer";

// EIP-2612 Gas Sponsoring extension
export * from "./eip2612-gas-sponsoring";

// ERC-20 Approval Gas Sponsoring extension
export * from "./erc20-approval-gas-sponsoring";
