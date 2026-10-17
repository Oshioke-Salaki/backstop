// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BackstopEscrow} from "../src/BackstopEscrow.sol";

/// @notice Deploys and wires BackstopEscrow, then hands ownership to the long-term owner (a multisig).
/// @dev Env: USDC, OWNER, FEE_RECIPIENT, DEPOSITOR, SETTLER, REGISTRAR, FEE_BPS (default 100), MAX_ESCROW (default 10_000 USDC).
///      Ownership transfer is two-step: OWNER must call acceptOwnership() afterwards.
///      Usage: forge script script/Deploy.s.sol --rpc-url $RPC_URL --broadcast --private-key $DEPLOYER_KEY
contract Deploy is Script {
    function run() external returns (BackstopEscrow escrow) {
        address usdc = vm.envAddress("USDC");
        address owner = vm.envAddress("OWNER");
        address feeRecipient = vm.envAddress("FEE_RECIPIENT");
        address depositor = vm.envAddress("DEPOSITOR");
        address settler = vm.envAddress("SETTLER");
        address registrar = vm.envAddress("REGISTRAR");
        uint16 feeBps = uint16(vm.envOr("FEE_BPS", uint256(100)));
        uint96 maxEscrow = uint96(vm.envOr("MAX_ESCROW", uint256(10_000e6)));

        require(depositor != settler, "depositor and settler must differ");

        vm.startBroadcast();
        address deployer = msg.sender;
        escrow = new BackstopEscrow(IERC20(usdc), deployer, feeRecipient, feeBps, maxEscrow);
        escrow.setOperator(depositor, true);
        escrow.setOperator(settler, true);
        escrow.setRegistrar(registrar);
        if (owner != deployer) escrow.transferOwnership(owner);
        vm.stopBroadcast();

        console2.log("BackstopEscrow", address(escrow));
        console2.log("pending owner (must acceptOwnership)", owner);
    }
}
