// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {BackstopEscrow} from "../src/BackstopEscrow.sol";
import {MockUSDC, FeeOnTransferUSDC} from "../src/mocks/MockUSDC.sol";

abstract contract EscrowFixture is Test {
    MockUSDC internal usdc;
    BackstopEscrow internal escrow;

    address internal owner = makeAddr("owner");
    address internal operator = makeAddr("operator");
    address internal registrar = makeAddr("registrar");
    address internal feeRecipient = makeAddr("feeRecipient");
    address internal payee = makeAddr("payee");
    address internal stranger = makeAddr("stranger");

    uint256 internal payerKey = 0xA11CE;
    address internal payer;

    uint16 internal constant FEE_BPS = 100; // 1%
    uint96 internal constant MAX_AMOUNT = 10_000e6;

    function setUp() public virtual {
        vm.warp(1_750_000_000);
        payer = vm.addr(payerKey);
        usdc = new MockUSDC();
        escrow = new BackstopEscrow(IERC20(address(usdc)), owner, feeRecipient, FEE_BPS, MAX_AMOUNT);

        vm.startPrank(owner);
        escrow.setOperator(operator, true);
        escrow.setRegistrar(registrar);
        vm.stopPrank();
        vm.prank(registrar);
        escrow.setPayee(payee, true);

        usdc.mint(payer, 1_000_000e6);
    }

    function _sign(uint256 key, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        address from = vm.addr(key);
        bytes32 structHash = keccak256(
            abi.encode(usdc.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), from, to, value, validAfter, validBefore, nonce)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash));
        (v, r, s) = vm.sign(key, digest);
    }

    function _auth(uint256 value, bytes32 nonce) internal view returns (BackstopEscrow.Authorization memory a) {
        return _authFor(payerKey, value, nonce, address(escrow));
    }

    function _authFor(uint256 key, uint256 value, bytes32 nonce, address to)
        internal
        view
        returns (BackstopEscrow.Authorization memory a)
    {
        uint256 validAfter = block.timestamp - 1;
        uint256 validBefore = block.timestamp + 300;
        (uint8 v, bytes32 r, bytes32 s) = _sign(key, to, value, validAfter, validBefore, nonce);
        a = BackstopEscrow.Authorization(vm.addr(key), value, validAfter, validBefore, nonce, v, r, s);
    }

    function _deposit(uint256 value, bytes32 nonce) internal returns (bytes32 id) {
        BackstopEscrow.Authorization memory a = _auth(value, nonce);
        vm.prank(operator);
        id = escrow.deposit(a, payee, uint40(block.timestamp + 1 days));
    }
}

contract BackstopEscrowTest is EscrowFixture {
    // --- deposit -----------------------------------------------------------

    function test_deposit_holdsFundsAndRecordsTerms() public {
        bytes32 nonce = keccak256("n1");
        bytes32 id = _deposit(5e6, nonce);

        assertEq(id, escrow.escrowId(payer, nonce));
        BackstopEscrow.Escrow memory e = escrow.getEscrow(id);
        assertEq(e.payer, payer);
        assertEq(e.payee, payee);
        assertEq(e.amount, 5e6);
        assertEq(e.feeBps, FEE_BPS);
        assertEq(uint8(e.status), uint8(BackstopEscrow.Status.Held));
        assertEq(e.deadline, block.timestamp + 1 days);
        assertEq(e.hardDeadline, block.timestamp + escrow.MAX_HOLD());
        assertEq(usdc.balanceOf(address(escrow)), 5e6);
        assertEq(escrow.totalHeld(), 5e6);
    }

    function test_deposit_emitsEvent() public {
        bytes32 nonce = keccak256("n1");
        bytes32 id = escrow.escrowId(payer, nonce);
        BackstopEscrow.Authorization memory a = _auth(5e6, nonce);
        vm.expectEmit(address(escrow));
        emit BackstopEscrow.Deposited(id, payer, payee, 5e6, uint40(block.timestamp + 1 days), FEE_BPS);
        vm.prank(operator);
        escrow.deposit(a, payee, uint40(block.timestamp + 1 days));
    }

    function test_deposit_revertsForNonOperator() public {
        BackstopEscrow.Authorization memory a = _auth(5e6, keccak256("n1"));
        vm.prank(stranger);
        vm.expectRevert(BackstopEscrow.NotOperator.selector);
        escrow.deposit(a, payee, uint40(block.timestamp + 1 days));
    }

    function test_deposit_revertsForUnapprovedPayee() public {
        BackstopEscrow.Authorization memory a = _auth(5e6, keccak256("n1"));
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(BackstopEscrow.PayeeNotAllowed.selector, stranger));
        escrow.deposit(a, stranger, uint40(block.timestamp + 1 days));
    }

    function test_deposit_revertsForZeroAmount() public {
        BackstopEscrow.Authorization memory a = _auth(0, keccak256("n1"));
        vm.prank(operator);
        vm.expectRevert(BackstopEscrow.InvalidAmount.selector);
        escrow.deposit(a, payee, uint40(block.timestamp + 1 days));
    }

    function test_deposit_revertsAboveMax() public {
        BackstopEscrow.Authorization memory a = _auth(uint256(MAX_AMOUNT) + 1, keccak256("n1"));
        vm.prank(operator);
        vm.expectRevert(BackstopEscrow.InvalidAmount.selector);
        escrow.deposit(a, payee, uint40(block.timestamp + 1 days));
    }

    function test_deposit_revertsForDeadlineInPast() public {
        BackstopEscrow.Authorization memory a = _auth(5e6, keccak256("n1"));
        vm.prank(operator);
        vm.expectRevert(BackstopEscrow.InvalidDeadline.selector);
        escrow.deposit(a, payee, uint40(block.timestamp));
    }

    function test_deposit_revertsForDeadlineBeyondMaxHold() public {
        BackstopEscrow.Authorization memory a = _auth(5e6, keccak256("n1"));
        uint40 tooLate = uint40(block.timestamp + escrow.MAX_HOLD() + 1);
        vm.prank(operator);
        vm.expectRevert(BackstopEscrow.InvalidDeadline.selector);
        escrow.deposit(a, payee, tooLate);
    }

    function test_deposit_acceptsDeadlineAtMaxHold() public {
        BackstopEscrow.Authorization memory a = _auth(5e6, keccak256("n1"));
        uint40 atMax = uint40(block.timestamp + escrow.MAX_HOLD());
        vm.prank(operator);
        escrow.deposit(a, payee, atMax);
    }

    function test_deposit_revertsWhenAuthorizationReplayed() public {
        bytes32 nonce = keccak256("n1");
        BackstopEscrow.Authorization memory a = _auth(5e6, nonce);
        vm.prank(operator);
        escrow.deposit(a, payee, uint40(block.timestamp + 1 days));
        bytes32 id = escrow.escrowId(payer, nonce);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(BackstopEscrow.EscrowExists.selector, id));
        escrow.deposit(a, payee, uint40(block.timestamp + 1 days));
    }

    function test_deposit_revertsForSignatureToAnotherRecipient() public {
        // Payer signed a transfer to `stranger`; the contract always pulls to itself, so recovery fails.
        BackstopEscrow.Authorization memory a = _authFor(payerKey, 5e6, keccak256("n1"), stranger);
        vm.prank(operator);
        vm.expectRevert("FiatTokenV2: invalid signature");
        escrow.deposit(a, payee, uint40(block.timestamp + 1 days));
    }

    function test_deposit_revertsForTamperedValue() public {
        BackstopEscrow.Authorization memory a = _auth(5e6, keccak256("n1"));
        a.value = 6e6;
        vm.prank(operator);
        vm.expectRevert("FiatTokenV2: invalid signature");
        escrow.deposit(a, payee, uint40(block.timestamp + 1 days));
    }

    function test_deposit_revertsForExpiredAuthorization() public {
        BackstopEscrow.Authorization memory a = _auth(5e6, keccak256("n1"));
        vm.warp(a.validBefore);
        vm.prank(operator);
        vm.expectRevert("FiatTokenV2: authorization is expired");
        escrow.deposit(a, payee, uint40(block.timestamp + 1 days));
    }

    function test_deposit_revertsForInsufficientBalance() public {
        uint256 poorKey = 0xB0B;
        BackstopEscrow.Authorization memory a = _authFor(poorKey, 5e6, keccak256("n1"), address(escrow));
        vm.prank(operator);
        vm.expectRevert();
        escrow.deposit(a, payee, uint40(block.timestamp + 1 days));
    }

    function test_deposit_revertsWhenPaused() public {
        vm.prank(owner);
        escrow.pause();
        BackstopEscrow.Authorization memory a = _auth(5e6, keccak256("n1"));
        vm.prank(operator);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        escrow.deposit(a, payee, uint40(block.timestamp + 1 days));
    }

    function test_deposit_revertsForFeeOnTransferToken() public {
        FeeOnTransferUSDC bad = new FeeOnTransferUSDC();
        BackstopEscrow e2 = new BackstopEscrow(IERC20(address(bad)), owner, feeRecipient, FEE_BPS, MAX_AMOUNT);
        vm.startPrank(owner);
        e2.setOperator(operator, true);
        e2.setPayee(payee, true);
        vm.stopPrank();
        bad.mint(payer, 100e6);

        uint256 validAfter = block.timestamp - 1;
        uint256 validBefore = block.timestamp + 300;
        bytes32 nonce = keccak256("n1");
        bytes32 structHash = keccak256(
            abi.encode(bad.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), payer, address(e2), 5e6, validAfter, validBefore, nonce)
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(payerKey, keccak256(abi.encodePacked("\x19\x01", bad.DOMAIN_SEPARATOR(), structHash)));

        vm.prank(operator);
        vm.expectRevert(BackstopEscrow.TransferMismatch.selector);
        e2.deposit(
            BackstopEscrow.Authorization(payer, 5e6, validAfter, validBefore, nonce, v, r, s),
            payee,
            uint40(block.timestamp + 1 days)
        );
    }

    function test_deposit_locksFeeRateAtDepositTime() public {
        bytes32 id = _deposit(10e6, keccak256("n1"));
        vm.prank(owner);
        escrow.setFee(500, feeRecipient);
        vm.prank(operator);
        escrow.release(id);
        assertEq(usdc.balanceOf(feeRecipient), 0.1e6);
        assertEq(usdc.balanceOf(payee), 9.9e6);
    }

    // --- release -----------------------------------------------------------

    function test_release_paysPayeeMinusFee() public {
        bytes32 id = _deposit(10e6, keccak256("n1"));
        vm.prank(operator);
        escrow.release(id);
        assertEq(usdc.balanceOf(payee), 9.9e6);
        assertEq(usdc.balanceOf(feeRecipient), 0.1e6);
        assertEq(usdc.balanceOf(address(escrow)), 0);
        assertEq(escrow.totalHeld(), 0);
        assertEq(uint8(escrow.getEscrow(id).status), uint8(BackstopEscrow.Status.Released));
    }

    function test_release_feeRoundsDownForDust() public {
        bytes32 id = _deposit(99, keccak256("n1")); // 1% of 99 base units floors to 0
        vm.prank(operator);
        escrow.release(id);
        assertEq(usdc.balanceOf(payee), 99);
        assertEq(usdc.balanceOf(feeRecipient), 0);
    }

    function test_release_stillPaysBoundPayeeAfterDelisting() public {
        bytes32 id = _deposit(10e6, keccak256("n1"));
        vm.prank(registrar);
        escrow.setPayee(payee, false);
        vm.prank(operator);
        escrow.release(id);
        assertEq(usdc.balanceOf(payee), 9.9e6);
    }

    function test_release_revertsAtDeadline() public {
        bytes32 id = _deposit(10e6, keccak256("n1"));
        vm.warp(block.timestamp + 1 days);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(BackstopEscrow.DeadlinePassed.selector, id));
        escrow.release(id);
    }

    function test_release_revertsForNonOperator() public {
        bytes32 id = _deposit(10e6, keccak256("n1"));
        vm.prank(payee);
        vm.expectRevert(BackstopEscrow.NotOperator.selector);
        escrow.release(id);
    }

    function test_release_revertsTwice() public {
        bytes32 id = _deposit(10e6, keccak256("n1"));
        vm.startPrank(operator);
        escrow.release(id);
        vm.expectRevert(abi.encodeWithSelector(BackstopEscrow.NotHeld.selector, id));
        escrow.release(id);
        vm.expectRevert(abi.encodeWithSelector(BackstopEscrow.NotHeld.selector, id));
        escrow.refund(id);
        vm.stopPrank();
    }

    function test_release_revertsForUnknownEscrow() public {
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(BackstopEscrow.NotHeld.selector, bytes32(uint256(1))));
        escrow.release(bytes32(uint256(1)));
    }

    // --- refund ------------------------------------------------------------

    function test_refund_returnsFullAmountWithoutFee() public {
        uint256 before = usdc.balanceOf(payer);
        bytes32 id = _deposit(10e6, keccak256("n1"));
        vm.prank(operator);
        escrow.refund(id);
        assertEq(usdc.balanceOf(payer), before);
        assertEq(usdc.balanceOf(feeRecipient), 0);
        assertEq(uint8(escrow.getEscrow(id).status), uint8(BackstopEscrow.Status.Refunded));
    }

    function test_refund_worksAfterDeadlineAndWhilePaused() public {
        bytes32 id = _deposit(10e6, keccak256("n1"));
        vm.prank(owner);
        escrow.pause();
        vm.warp(block.timestamp + 2 days);
        vm.prank(operator);
        escrow.refund(id);
        assertEq(escrow.totalHeld(), 0);
    }

    // --- split -------------------------------------------------------------

    function test_split_dividesAndFeesOnlyPayeeShare() public {
        uint256 before = usdc.balanceOf(payer);
        bytes32 id = _deposit(10e6, keccak256("n1"));
        vm.prank(operator);
        escrow.split(id, 4e6);
        assertEq(usdc.balanceOf(payer), before - 6e6);
        assertEq(usdc.balanceOf(payee), 5.94e6);
        assertEq(usdc.balanceOf(feeRecipient), 0.06e6);
        assertEq(uint8(escrow.getEscrow(id).status), uint8(BackstopEscrow.Status.Split));
    }

    function test_split_fullToPayer() public {
        bytes32 id = _deposit(10e6, keccak256("n1"));
        vm.prank(operator);
        escrow.split(id, 10e6);
        assertEq(usdc.balanceOf(payee), 0);
        assertEq(usdc.balanceOf(feeRecipient), 0);
    }

    function test_split_revertsWhenPayerShareExceedsAmount() public {
        bytes32 id = _deposit(10e6, keccak256("n1"));
        vm.prank(operator);
        vm.expectRevert(BackstopEscrow.InvalidAmount.selector);
        escrow.split(id, 10e6 + 1);
    }

    function test_split_revertsAtDeadline() public {
        bytes32 id = _deposit(10e6, keccak256("n1"));
        vm.warp(block.timestamp + 1 days);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(BackstopEscrow.DeadlinePassed.selector, id));
        escrow.split(id, 1);
    }

    function testFuzz_split_conservesFunds(uint96 amount, uint96 payerShare, uint16 fee) public {
        amount = uint96(bound(amount, 1, MAX_AMOUNT));
        payerShare = uint96(bound(payerShare, 0, amount));
        fee = uint16(bound(fee, 0, escrow.MAX_FEE_BPS()));
        vm.prank(owner);
        escrow.setFee(fee, feeRecipient);

        uint256 payerBefore = usdc.balanceOf(payer);
        bytes32 id = _deposit(amount, keccak256(abi.encode(amount, payerShare, fee)));
        vm.prank(operator);
        escrow.split(id, payerShare);

        uint256 payerGot = usdc.balanceOf(payer) - (payerBefore - amount);
        uint256 total = payerGot + usdc.balanceOf(payee) + usdc.balanceOf(feeRecipient);
        assertEq(total, amount);
        assertEq(payerGot, payerShare);
        assertLe(usdc.balanceOf(feeRecipient), (uint256(amount - payerShare) * fee) / 10_000);
        assertEq(usdc.balanceOf(address(escrow)), 0);
    }

    // --- extend ------------------------------------------------------------

    function test_extend_movesDeadlineWithinHardLimit() public {
        bytes32 id = _deposit(10e6, keccak256("n1"));
        uint40 hard = escrow.getEscrow(id).hardDeadline;
        vm.prank(operator);
        escrow.extend(id, hard);
        assertEq(escrow.getEscrow(id).deadline, hard);
    }

    function test_extend_revertsBeyondHardDeadline() public {
        bytes32 id = _deposit(10e6, keccak256("n1"));
        uint40 hard = escrow.getEscrow(id).hardDeadline;
        vm.prank(operator);
        vm.expectRevert(BackstopEscrow.InvalidDeadline.selector);
        escrow.extend(id, hard + 1);
    }

    function test_extend_revertsWhenShortening() public {
        bytes32 id = _deposit(10e6, keccak256("n1"));
        uint40 current = escrow.getEscrow(id).deadline;
        vm.prank(operator);
        vm.expectRevert(BackstopEscrow.InvalidDeadline.selector);
        escrow.extend(id, current);
    }

    function test_extend_cannotReviveExpiredEscrow() public {
        bytes32 id = _deposit(10e6, keccak256("n1"));
        vm.warp(block.timestamp + 1 days);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(BackstopEscrow.DeadlinePassed.selector, id));
        escrow.extend(id, uint40(block.timestamp + 1 days));
    }

    // --- reclaim -----------------------------------------------------------

    function test_reclaim_anyoneCanReturnExpiredEscrowToPayer() public {
        uint256 before = usdc.balanceOf(payer);
        bytes32 id = _deposit(10e6, keccak256("n1"));
        vm.warp(block.timestamp + 1 days);
        vm.expectEmit(address(escrow));
        emit BackstopEscrow.Refunded(id, 10e6, true);
        vm.prank(stranger);
        escrow.reclaim(id);
        assertEq(usdc.balanceOf(payer), before);
        assertEq(usdc.balanceOf(stranger), 0);
    }

    function test_reclaim_revertsBeforeDeadline() public {
        bytes32 id = _deposit(10e6, keccak256("n1"));
        vm.warp(block.timestamp + 1 days - 1);
        vm.expectRevert(abi.encodeWithSelector(BackstopEscrow.DeadlineNotReached.selector, id));
        escrow.reclaim(id);
    }

    function test_reclaim_worksWhilePaused() public {
        bytes32 id = _deposit(10e6, keccak256("n1"));
        vm.prank(owner);
        escrow.pause();
        vm.warp(block.timestamp + 1 days);
        escrow.reclaim(id);
        assertEq(escrow.totalHeld(), 0);
    }

    function test_reclaim_revertsAfterRelease() public {
        bytes32 id = _deposit(10e6, keccak256("n1"));
        vm.prank(operator);
        escrow.release(id);
        vm.warp(block.timestamp + 1 days);
        vm.expectRevert(abi.encodeWithSelector(BackstopEscrow.NotHeld.selector, id));
        escrow.reclaim(id);
    }

    function test_reclaim_respectsExtendedDeadline() public {
        bytes32 id = _deposit(10e6, keccak256("n1"));
        vm.prank(operator);
        escrow.extend(id, uint40(block.timestamp + 3 days));
        vm.warp(block.timestamp + 2 days);
        vm.expectRevert(abi.encodeWithSelector(BackstopEscrow.DeadlineNotReached.selector, id));
        escrow.reclaim(id);
        vm.warp(block.timestamp + 1 days);
        escrow.reclaim(id);
    }

    // --- administration ----------------------------------------------------

    function test_admin_onlyOwnerConfigures() public {
        vm.startPrank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        escrow.setOperator(stranger, true);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        escrow.setFee(1, stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        escrow.setMaxEscrowAmount(1);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        escrow.pause();
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        escrow.setRegistrar(stranger);
        vm.expectRevert(BackstopEscrow.NotRegistrar.selector);
        escrow.setPayee(stranger, true);
        vm.stopPrank();
    }

    function test_admin_operatorCannotConfigure() public {
        vm.startPrank(operator);
        vm.expectRevert(BackstopEscrow.NotRegistrar.selector);
        escrow.setPayee(operator, true);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, operator));
        escrow.setOperator(stranger, true);
        vm.stopPrank();
    }

    function test_admin_feeCapped() public {
        uint16 maxFee = escrow.MAX_FEE_BPS();
        vm.prank(owner);
        vm.expectRevert(BackstopEscrow.InvalidFee.selector);
        escrow.setFee(maxFee + 1, feeRecipient);
    }

    function test_admin_constructorValidates() public {
        vm.expectRevert(BackstopEscrow.ZeroAddress.selector);
        new BackstopEscrow(IERC20(address(0)), owner, feeRecipient, FEE_BPS, MAX_AMOUNT);
        vm.expectRevert(BackstopEscrow.ZeroAddress.selector);
        new BackstopEscrow(IERC20(address(usdc)), owner, address(0), FEE_BPS, MAX_AMOUNT);
        vm.expectRevert(BackstopEscrow.InvalidFee.selector);
        new BackstopEscrow(IERC20(address(usdc)), owner, feeRecipient, 501, MAX_AMOUNT);
        vm.expectRevert(BackstopEscrow.InvalidAmount.selector);
        new BackstopEscrow(IERC20(address(usdc)), owner, feeRecipient, FEE_BPS, 0);
    }

    function test_admin_payeeValidation() public {
        vm.startPrank(registrar);
        vm.expectRevert(abi.encodeWithSelector(BackstopEscrow.InvalidPayee.selector, address(0)));
        escrow.setPayee(address(0), true);
        vm.expectRevert(abi.encodeWithSelector(BackstopEscrow.InvalidPayee.selector, address(escrow)));
        escrow.setPayee(address(escrow), true);
        vm.expectRevert(abi.encodeWithSelector(BackstopEscrow.InvalidPayee.selector, address(usdc)));
        escrow.setPayee(address(usdc), true);
        vm.stopPrank();
    }

    function test_admin_renounceDisabled() public {
        vm.prank(owner);
        vm.expectRevert(BackstopEscrow.RenounceDisabled.selector);
        escrow.renounceOwnership();
    }

    function test_admin_ownershipTransferIsTwoStep() public {
        vm.prank(owner);
        escrow.transferOwnership(stranger);
        assertEq(escrow.owner(), owner);
        vm.prank(stranger);
        escrow.acceptOwnership();
        assertEq(escrow.owner(), stranger);
    }

    function test_rescue_cannotTouchHeldFunds() public {
        _deposit(10e6, keccak256("n1"));
        usdc.mint(address(escrow), 3e6); // stray transfer
        vm.startPrank(owner);
        vm.expectRevert(BackstopEscrow.InsufficientFreeBalance.selector);
        escrow.rescue(IERC20(address(usdc)), owner, 3e6 + 1);
        escrow.rescue(IERC20(address(usdc)), owner, 3e6);
        vm.stopPrank();
        assertEq(usdc.balanceOf(address(escrow)), 10e6);
        assertEq(escrow.totalHeld(), 10e6);
    }

    function test_rescue_otherTokensFreely() public {
        MockUSDC other = new MockUSDC();
        other.mint(address(escrow), 7);
        vm.prank(owner);
        escrow.rescue(IERC20(address(other)), owner, 7);
        assertEq(other.balanceOf(owner), 7);
    }

    function test_revokedOperatorLosesAccess() public {
        bytes32 id = _deposit(10e6, keccak256("n1"));
        vm.prank(owner);
        escrow.setOperator(operator, false);
        vm.prank(operator);
        vm.expectRevert(BackstopEscrow.NotOperator.selector);
        escrow.release(id);
    }
}

/// @dev Drives random sequences of deposits and settlements for the invariant suite.
contract EscrowHandler is Test {
    BackstopEscrow internal escrow;
    MockUSDC internal usdc;
    address internal operator;
    address internal payee;
    uint256 internal payerKey;
    bytes32[] public ids;
    uint256 internal nonceCounter;

    constructor(BackstopEscrow escrow_, MockUSDC usdc_, address operator_, address payee_, uint256 payerKey_) {
        escrow = escrow_;
        usdc = usdc_;
        operator = operator_;
        payee = payee_;
        payerKey = payerKey_;
    }

    function idsLength() external view returns (uint256) {
        return ids.length;
    }

    function deposit(uint96 amount, uint32 holdFor) external {
        amount = uint96(bound(amount, 1, escrow.maxEscrowAmount()));
        holdFor = uint32(bound(holdFor, 1, escrow.MAX_HOLD()));
        address payer = vm.addr(payerKey);
        if (usdc.balanceOf(payer) < amount) usdc.mint(payer, amount);

        bytes32 nonce = keccak256(abi.encode(nonceCounter++));
        uint256 validAfter = block.timestamp - 1;
        uint256 validBefore = block.timestamp + 300;
        bytes32 structHash = keccak256(
            abi.encode(
                usdc.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), payer, address(escrow), amount, validAfter, validBefore, nonce
            )
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(payerKey, keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash)));
        vm.prank(operator);
        ids.push(
            escrow.deposit(
                BackstopEscrow.Authorization(payer, amount, validAfter, validBefore, nonce, v, r, s),
                payee,
                uint40(block.timestamp + holdFor)
            )
        );
    }

    function release(uint256 seed) external {
        if (ids.length == 0) return;
        vm.prank(operator);
        try escrow.release(ids[seed % ids.length]) {} catch {}
    }

    function refund(uint256 seed) external {
        if (ids.length == 0) return;
        vm.prank(operator);
        try escrow.refund(ids[seed % ids.length]) {} catch {}
    }

    function split(uint256 seed, uint96 payerShare) external {
        if (ids.length == 0) return;
        bytes32 id = ids[seed % ids.length];
        uint96 amount = escrow.getEscrow(id).amount;
        vm.prank(operator);
        try escrow.split(id, bound(payerShare, 0, amount)) {} catch {}
    }

    function reclaim(uint256 seed) external {
        if (ids.length == 0) return;
        try escrow.reclaim(ids[seed % ids.length]) {} catch {}
    }

    function warp(uint32 by) external {
        vm.warp(block.timestamp + bound(by, 1, 3 days));
    }
}

contract BackstopEscrowInvariantTest is EscrowFixture {
    EscrowHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new EscrowHandler(escrow, usdc, operator, payee, payerKey);
        vm.prank(owner);
        escrow.setOperator(address(handler), true);
        targetContract(address(handler));
    }

    /// @dev Held funds are always fully backed by the contract's balance.
    function invariant_balanceCoversHeld() public view {
        assertGe(usdc.balanceOf(address(escrow)), escrow.totalHeld());
    }

    /// @dev totalHeld equals the sum of escrows still in the Held state.
    function invariant_totalHeldMatchesEscrows() public view {
        uint256 sum;
        uint256 n = handler.idsLength();
        for (uint256 i; i < n; i++) {
            BackstopEscrow.Escrow memory e = escrow.getEscrow(handler.ids(i));
            if (e.status == BackstopEscrow.Status.Held) sum += e.amount;
        }
        assertEq(sum, escrow.totalHeld());
    }
}
