package core

// PaymentInfoTypehash is the EIP-712 type string for the on-chain PaymentInfo struct (from AuthCaptureEscrow).
const PaymentInfoTypehash = "PaymentInfo(address operator,address payer,address receiver,address token,uint120 maxAmount,uint48 preApprovalExpiry,uint48 authorizationExpiry,uint48 refundExpiry,uint16 minFeeBps,uint16 maxFeeBps,address feeReceiver,uint256 salt)"
