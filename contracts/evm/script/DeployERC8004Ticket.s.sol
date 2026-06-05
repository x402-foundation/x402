// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";

import {X402AgentReputation} from "../src/erc8004/X402AgentReputation.sol";
import {MockIdentityRegistry} from "../test/erc8004/mocks/MockIdentityRegistry.sol";

/// @title DeployERC8004Ticket
/// @notice Deploys X402AgentReputation (v2 wrapper) and wires the facilitator allowlist.
/// @dev Env vars (all optional, sensible defaults for local Anvil):
///        - OWNER: wrapper owner (defaults to broadcaster).
///        - FACILITATOR: address whitelisted on the wrapper (defaults to broadcaster).
///        - IDENTITY_REGISTRY: existing ERC-8004 IdentityRegistry; if unset, a
///            MockIdentityRegistry is deployed (Anvil only).
///        - PERMIT2_ADDRESS: canonical Permit2 (0x000000000022D473030F116dDEE9F6B43aC78BA3
///            by default; set to address(0) to disable Permit2 path).
///
/// Run: forge script script/DeployERC8004Ticket.s.sol \
///        --rpc-url $RPC_URL --broadcast
contract DeployERC8004Ticket is Script {
    address constant CANONICAL_PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    function run() public {
        address broadcaster = msg.sender;
        address owner = vm.envOr("OWNER", broadcaster);
        address facilitator = vm.envOr("FACILITATOR", broadcaster);
        address permit2 = vm.envOr("PERMIT2_ADDRESS", CANONICAL_PERMIT2);
        address identityRegistry = vm.envOr("IDENTITY_REGISTRY", address(0));

        bool isLocal = block.chainid == 31_337 || block.chainid == 1337;

        console2.log("");
        console2.log("============================================================");
        console2.log("  ERC-8004 Ticket Deployment");
        console2.log("============================================================");
        console2.log("chainId          :", block.chainid);
        console2.log("owner            :", owner);
        console2.log("facilitator      :", facilitator);
        console2.log("permit2          :", permit2);
        console2.log("identityRegistry :", identityRegistry);
        console2.log("");

        vm.startBroadcast();

        if (identityRegistry == address(0)) {
            require(isLocal, "IDENTITY_REGISTRY is required on non-local networks");
            MockIdentityRegistry mock = new MockIdentityRegistry();
            identityRegistry = address(mock);
            console2.log("Deployed MockIdentityRegistry:", identityRegistry);
        }

        X402AgentReputation wrapper = new X402AgentReputation(owner, permit2, identityRegistry);
        console2.log("Deployed X402AgentReputation:", address(wrapper));

        // setFacilitator requires msg.sender == wrapper owner.
        if (broadcaster == owner) {
            wrapper.setFacilitator(facilitator, true);
            console2.log("Wired facilitator on the wrapper.");
        } else {
            console2.log("");
            console2.log("Owner is not the broadcaster. Run this as owner:");
            console2.log("  wrapper.setFacilitator(", facilitator, ", true)");
        }

        vm.stopBroadcast();

        console2.log("");
        console2.log("Done.");
    }
}
