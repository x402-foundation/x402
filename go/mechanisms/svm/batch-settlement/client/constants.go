package client

// Deposit target when the client sets neither a deposit amount nor a server hint.
const DefaultDepositMultiplier = 5

// MinDepositMultiplier is the smallest deposit multiplier the client accepts.
const MinDepositMultiplier = 3

// OperationKeySeparator splits a channel key from a request id.
// Neither side contains NUL, so the pair cannot collide with another channel's key.
const OperationKeySeparator = "\x00"
