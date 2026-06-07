// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";

import {X402AgentReputation} from "../src/erc8004/X402AgentReputation.sol";
import {FeedbackGateway} from "../src/erc8004/FeedbackGateway.sol";
import {MockIdentityRegistry} from "../test/erc8004/mocks/MockIdentityRegistry.sol";

/// @title DeployERC8004Ticket
/// @notice Deploys the X402AgentReputation (v2 wrapper). Settlement is permissionless —
///         there is no facilitator allowlist to wire.
/// @dev Env vars (all optional, sensible defaults for local Anvil):
///        - OWNER: reserved admin handle (defaults to broadcaster; no privileged functions today).
///        - IDENTITY_REGISTRY: existing ERC-8004 IdentityRegistry; if unset, a
///            MockIdentityRegistry is deployed (Anvil only).
///        - PERMIT2_PROXY_ADDRESS: canonical x402ExactPermit2Proxy
///            (0x402085c248EeA27D92E8b30b2C58ed07f9E20001 by default; set to address(0)
///            to disable the Permit2 path).
///
/// Run: forge script script/DeployERC8004Ticket.s.sol \
///        --rpc-url $RPC_URL --broadcast
contract DeployERC8004Ticket is Script {
    address constant CANONICAL_PERMIT2_PROXY = 0x402085c248EeA27D92E8b30b2C58ed07f9E20001;

    function run() public {
        address broadcaster = msg.sender;
        address owner = vm.envOr("OWNER", broadcaster);
        address permit2Proxy = vm.envOr("PERMIT2_PROXY_ADDRESS", CANONICAL_PERMIT2_PROXY);
        address identityRegistry = vm.envOr("IDENTITY_REGISTRY", address(0));

        bool isLocal = block.chainid == 31_337 || block.chainid == 1337;

        console2.log("");
        console2.log("============================================================");
        console2.log("  ERC-8004 Ticket Deployment");
        console2.log("============================================================");
        console2.log("chainId          :", block.chainid);
        console2.log("owner            :", owner);
        console2.log("permit2Proxy     :", permit2Proxy);
        console2.log("identityRegistry :", identityRegistry);
        console2.log("");

        vm.startBroadcast();

        if (identityRegistry == address(0)) {
            require(isLocal, "IDENTITY_REGISTRY is required on non-local networks");
            MockIdentityRegistry mock = new MockIdentityRegistry();
            identityRegistry = address(mock);
            console2.log("Deployed MockIdentityRegistry:", identityRegistry);
        }

        X402AgentReputation wrapper = new X402AgentReputation(owner, permit2Proxy, identityRegistry);
        console2.log("Deployed X402AgentReputation:", address(wrapper));

        // Chain-level singleton: the EIP-7702 delegate clients delegate to for ticket-gated,
        // client-authored feedback on the canonical ReputationRegistry.
        FeedbackGateway gateway = new FeedbackGateway();
        console2.log("Deployed FeedbackGateway:", address(gateway));

        vm.stopBroadcast();

        console2.log("");
        console2.log("Done.");
    }
}
