package paymentchannels

import "github.com/gagliardetto/solana-go/rpc"

// BasisPointsDenominator is the full distribution share. 10_000 basis points is 100%.
const BasisPointsDenominator uint16 = 10_000

// Commitment for reading account state the caller must act on. Opens are
// confirmed at this level, and the RPC default (finalized) lags a fresh open
// by seconds, reporting a live channel as missing.
const StateCommitment = rpc.CommitmentConfirmed

// Commitment for reading the slot used as an openSlot anchor. Clients pin
// openSlot at this level to keep openSlot <= clock.slot when the open lands,
// so verify and the reclaim gate must judge it in the same frame.
const SlotCommitment = rpc.CommitmentFinalized

// Commitment for reading transaction-lifetime blockhashes. A finalized hash
// cannot be dropped by a fork before the transaction lands.
const BlockhashCommitment = rpc.CommitmentFinalized
