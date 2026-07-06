// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";

import {FeedbackGateway} from "../src/erc8004/FeedbackGateway.sol";
import {MockIdentityRegistry} from "../test/erc8004/mocks/MockIdentityRegistry.sol";

/// @title DeployERC8004Ticket
/// @notice Deploys the single merged FeedbackGateway (settle + mint + feedback). Settlement is
///         permissionless — there is no facilitator allowlist to wire.
/// @dev Env vars (all optional, sensible defaults for local Anvil):
///        - OWNER: reserved admin handle (defaults to broadcaster).
///        - IDENTITY_REGISTRY: existing ERC-8004 IdentityRegistry; if unset, a
///            MockIdentityRegistry is deployed (Anvil only).
///        - REPUTATION_REGISTRY: canonical ERC-8004 ReputationRegistry feedback is submitted to
///            (mainnet 0x8004BAa17C55a88189AE136b182e5fdA19dE9b63 by default).
///        - PERMIT2_PROXY_ADDRESS: canonical x402ExactPermit2Proxy
///            (0x402085c248EeA27D92E8b30b2C58ed07f9E20001 by default; address(0) disables Permit2).
///
/// Run: forge script script/DeployERC8004Ticket.s.sol --rpc-url $RPC_URL --broadcast
contract DeployERC8004Ticket is Script {
    address constant CANONICAL_PERMIT2_PROXY = 0x402085c248EeA27D92E8b30b2C58ed07f9E20001;
    address constant CANONICAL_REPUTATION_REGISTRY = 0x8004BAa17C55a88189AE136b182e5fdA19dE9b63;

    function run() public {
        address broadcaster = msg.sender;
        address owner = vm.envOr("OWNER", broadcaster);
        address permit2Proxy = vm.envOr("PERMIT2_PROXY_ADDRESS", CANONICAL_PERMIT2_PROXY);
        address identityRegistry = vm.envOr("IDENTITY_REGISTRY", address(0));
        address reputationRegistry = vm.envOr("REPUTATION_REGISTRY", CANONICAL_REPUTATION_REGISTRY);

        bool isLocal = block.chainid == 31_337 || block.chainid == 1337;

        console2.log("");
        console2.log("============================================================");
        console2.log("  ERC-8004 Ticket Deployment (one contract)");
        console2.log("============================================================");
        console2.log("chainId            :", block.chainid);
        console2.log("owner              :", owner);
        console2.log("permit2Proxy       :", permit2Proxy);
        console2.log("identityRegistry   :", identityRegistry);
        console2.log("reputationRegistry :", reputationRegistry);
        console2.log("");

        vm.startBroadcast();

        if (identityRegistry == address(0)) {
            require(isLocal, "IDENTITY_REGISTRY is required on non-local networks");
            MockIdentityRegistry mock = new MockIdentityRegistry();
            identityRegistry = address(mock);
            console2.log("Deployed MockIdentityRegistry:", identityRegistry);
        }

        FeedbackGateway gateway = new FeedbackGateway(owner, permit2Proxy, identityRegistry, reputationRegistry);
        console2.log("Deployed FeedbackGateway:", address(gateway));

        vm.stopBroadcast();

        console2.log("");
        console2.log("Done.");
    }
}
