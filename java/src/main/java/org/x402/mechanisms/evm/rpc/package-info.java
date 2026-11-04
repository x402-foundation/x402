/**
 * Onchain access for EVM facilitators.
 *
 * <p>{@link org.x402.mechanisms.evm.rpc.FacilitatorEvmSigner} is what the exact scheme's facilitator reads chain
 * state and settles through. {@link org.x402.mechanisms.evm.rpc.JsonRpcFacilitatorEvmSigner} implements it over
 * Ethereum JSON-RPC with {@code java.net.http}, building and signing EIP-1559 transactions itself, so no Ethereum
 * client library is needed. {@link org.x402.mechanisms.evm.rpc.Abi} encodes the contract calls involved.
 *
 * <p>Failures to reach the chain are {@link java.io.IOException}s:
 * {@link org.x402.mechanisms.evm.rpc.JsonRpcException} when the node answered with a JSON-RPC error,
 * {@link org.x402.mechanisms.evm.rpc.ContractRevertException} when the EVM reverted a call, and
 * {@link org.x402.mechanisms.evm.rpc.BroadcastOutcomeUnknownException} when the answer to a broadcast was lost.
 * Invalid caller input is rejected with {@link java.lang.IllegalArgumentException} and, unless noted, a
 * {@code null} argument with {@link java.lang.NullPointerException}. Everything public here is thread-safe.
 */
package org.x402.mechanisms.evm.rpc;
