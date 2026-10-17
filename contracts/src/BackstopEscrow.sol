// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice EIP-3009 subset implemented by USDC.
interface IERC3009 {
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

/// @title BackstopEscrow
/// @notice Holds x402 payments until delivery is verified, then releases them to the provider or refunds the payer.
/// @dev Trust model:
///  - Operators route funds, but only ever to the payer or to the payee bound at deposit time.
///  - The payer can always reclaim a held escrow once its deadline passes, with no operator involvement.
///  - The owner configures the contract but can never move escrowed funds.
///  - Pausing blocks new deposits only. Refunds and reclaims always work.
contract BackstopEscrow is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Status {
        None,
        Held,
        Released,
        Refunded,
        Split
    }

    struct Escrow {
        address payer;
        uint96 amount;
        address payee;
        uint40 deadline;
        uint40 hardDeadline;
        uint16 feeBps;
        Status status;
    }

    /// @dev Signed EIP-3009 TransferWithAuthorization whose `to` is this contract.
    struct Authorization {
        address from;
        uint256 value;
        uint256 validAfter;
        uint256 validBefore;
        bytes32 nonce;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    uint16 public constant MAX_FEE_BPS = 500;
    uint40 public constant MAX_HOLD = 30 days;
    uint16 private constant BPS = 10_000;

    IERC20 public immutable token;

    address public feeRecipient;
    uint16 public feeBps;
    uint96 public maxEscrowAmount;
    address public registrar;
    uint256 public totalHeld;

    mapping(address => bool) public isOperator;
    mapping(address => bool) public isPayee;
    mapping(bytes32 => Escrow) private _escrows;

    event Deposited(
        bytes32 indexed id,
        address indexed payer,
        address indexed payee,
        uint256 amount,
        uint40 deadline,
        uint16 feeBps
    );
    event Released(bytes32 indexed id, uint256 payeeAmount, uint256 fee);
    event Refunded(bytes32 indexed id, uint256 amount, bool reclaimedByDeadline);
    event SplitSettled(bytes32 indexed id, uint256 payerAmount, uint256 payeeAmount, uint256 fee);
    event DeadlineExtended(bytes32 indexed id, uint40 deadline);
    event OperatorSet(address indexed operator, bool allowed);
    event RegistrarSet(address indexed registrar);
    event PayeeSet(address indexed payee, bool allowed);
    event FeeSet(uint16 feeBps, address feeRecipient);
    event MaxEscrowAmountSet(uint96 amount);
    event Rescued(address indexed token, address indexed to, uint256 amount);

    error NotOperator();
    error NotRegistrar();
    error ZeroAddress();
    error InvalidPayee(address payee);
    error PayeeNotAllowed(address payee);
    error InvalidAmount();
    error InvalidDeadline();
    error InvalidFee();
    error EscrowExists(bytes32 id);
    error NotHeld(bytes32 id);
    error DeadlinePassed(bytes32 id);
    error DeadlineNotReached(bytes32 id);
    error TransferMismatch();
    error InsufficientFreeBalance();
    error RenounceDisabled();

    modifier onlyOperator() {
        if (!isOperator[msg.sender]) revert NotOperator();
        _;
    }

    modifier onlyRegistrar() {
        if (msg.sender != registrar && msg.sender != owner()) revert NotRegistrar();
        _;
    }

    constructor(
        IERC20 token_,
        address owner_,
        address feeRecipient_,
        uint16 feeBps_,
        uint96 maxEscrowAmount_
    ) Ownable(owner_) {
        if (address(token_) == address(0) || feeRecipient_ == address(0)) revert ZeroAddress();
        if (feeBps_ > MAX_FEE_BPS) revert InvalidFee();
        if (maxEscrowAmount_ == 0) revert InvalidAmount();
        token = token_;
        feeRecipient = feeRecipient_;
        feeBps = feeBps_;
        maxEscrowAmount = maxEscrowAmount_;
        emit FeeSet(feeBps_, feeRecipient_);
        emit MaxEscrowAmountSet(maxEscrowAmount_);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @notice Escrow ids are derived from the EIP-3009 authorization, which the token makes unique per payer.
    function escrowId(address payer, bytes32 nonce) public pure returns (bytes32) {
        return keccak256(abi.encode(payer, nonce));
    }

    function getEscrow(bytes32 id) external view returns (Escrow memory) {
        return _escrows[id];
    }

    /// @notice Fee taken from an amount paid to a payee under the given rate. Rounds down, in the payee's favour.
    function feeFor(uint256 payeeAmount, uint16 rateBps) public pure returns (uint256) {
        return (payeeAmount * rateBps) / BPS;
    }

    // ---------------------------------------------------------------------
    // Operator flow
    // ---------------------------------------------------------------------

    /// @notice Pull a signed payment into escrow for `payee`.
    function deposit(Authorization calldata a, address payee, uint40 deadline)
        external
        onlyOperator
        whenNotPaused
        nonReentrant
        returns (bytes32 id)
    {
        if (!isPayee[payee]) revert PayeeNotAllowed(payee);
        if (a.value == 0 || a.value > maxEscrowAmount) revert InvalidAmount();
        if (deadline <= block.timestamp || deadline > block.timestamp + MAX_HOLD) revert InvalidDeadline();

        id = escrowId(a.from, a.nonce);
        if (_escrows[id].status != Status.None) revert EscrowExists(id);

        uint256 balanceBefore = token.balanceOf(address(this));
        IERC3009(address(token)).transferWithAuthorization(
            a.from, address(this), a.value, a.validAfter, a.validBefore, a.nonce, a.v, a.r, a.s
        );
        if (token.balanceOf(address(this)) - balanceBefore != a.value) revert TransferMismatch();

        _escrows[id] = Escrow({
            payer: a.from,
            amount: uint96(a.value),
            payee: payee,
            deadline: deadline,
            hardDeadline: uint40(block.timestamp) + MAX_HOLD,
            feeBps: feeBps,
            status: Status.Held
        });
        totalHeld += a.value;

        emit Deposited(id, a.from, payee, a.value, deadline, feeBps);
    }

    /// @notice Pay the provider. Only before the deadline, after which the payer's reclaim right takes over.
    function release(bytes32 id) external onlyOperator nonReentrant {
        Escrow storage e = _held(id);
        if (block.timestamp >= e.deadline) revert DeadlinePassed(id);

        uint256 amount = e.amount;
        uint256 fee = feeFor(amount, e.feeBps);
        e.status = Status.Released;
        totalHeld -= amount;

        token.safeTransfer(e.payee, amount - fee);
        if (fee > 0) token.safeTransfer(feeRecipient, fee);
        emit Released(id, amount - fee, fee);
    }

    /// @notice Return the full amount to the payer. Always allowed while held; no fee is taken.
    function refund(bytes32 id) external onlyOperator nonReentrant {
        Escrow storage e = _held(id);
        _refund(id, e, false);
    }

    /// @notice Settle a dispute by splitting the escrow. The fee applies only to the payee's share.
    function split(bytes32 id, uint256 payerAmount) external onlyOperator nonReentrant {
        Escrow storage e = _held(id);
        if (block.timestamp >= e.deadline) revert DeadlinePassed(id);
        uint256 amount = e.amount;
        if (payerAmount > amount) revert InvalidAmount();

        uint256 payeeAmount = amount - payerAmount;
        uint256 fee = feeFor(payeeAmount, e.feeBps);
        e.status = Status.Split;
        totalHeld -= amount;

        if (payerAmount > 0) token.safeTransfer(e.payer, payerAmount);
        if (payeeAmount - fee > 0) token.safeTransfer(e.payee, payeeAmount - fee);
        if (fee > 0) token.safeTransfer(feeRecipient, fee);
        emit SplitSettled(id, payerAmount, payeeAmount - fee, fee);
    }

    /// @notice Push the deadline out, e.g. while a dispute is reviewed. Bounded by the hard deadline set at deposit.
    function extend(bytes32 id, uint40 newDeadline) external onlyOperator {
        Escrow storage e = _held(id);
        if (block.timestamp >= e.deadline) revert DeadlinePassed(id);
        if (newDeadline <= e.deadline || newDeadline > e.hardDeadline) revert InvalidDeadline();
        e.deadline = newDeadline;
        emit DeadlineExtended(id, newDeadline);
    }

    // ---------------------------------------------------------------------
    // Payer safety valve
    // ---------------------------------------------------------------------

    /// @notice Anyone may return an expired escrow to its payer. Works while paused.
    function reclaim(bytes32 id) external nonReentrant {
        Escrow storage e = _held(id);
        if (block.timestamp < e.deadline) revert DeadlineNotReached(id);
        _refund(id, e, true);
    }

    // ---------------------------------------------------------------------
    // Administration
    // ---------------------------------------------------------------------

    function setOperator(address operator, bool allowed) external onlyOwner {
        if (operator == address(0)) revert ZeroAddress();
        isOperator[operator] = allowed;
        emit OperatorSet(operator, allowed);
    }

    function setRegistrar(address registrar_) external onlyOwner {
        registrar = registrar_;
        emit RegistrarSet(registrar_);
    }

    /// @notice Approve a payout address. Held escrows keep the payee they were created with.
    function setPayee(address payee, bool allowed) external onlyRegistrar {
        if (payee == address(0) || payee == address(this) || payee == address(token)) revert InvalidPayee(payee);
        isPayee[payee] = allowed;
        emit PayeeSet(payee, allowed);
    }

    /// @notice New rates apply to future deposits only.
    function setFee(uint16 feeBps_, address feeRecipient_) external onlyOwner {
        if (feeBps_ > MAX_FEE_BPS) revert InvalidFee();
        if (feeRecipient_ == address(0)) revert ZeroAddress();
        feeBps = feeBps_;
        feeRecipient = feeRecipient_;
        emit FeeSet(feeBps_, feeRecipient_);
    }

    function setMaxEscrowAmount(uint96 amount) external onlyOwner {
        if (amount == 0) revert InvalidAmount();
        maxEscrowAmount = amount;
        emit MaxEscrowAmountSet(amount);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Recover tokens sent here by mistake. Escrowed funds are never recoverable this way.
    function rescue(IERC20 asset, address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (address(asset) == address(token) && token.balanceOf(address(this)) - totalHeld < amount) {
            revert InsufficientFreeBalance();
        }
        asset.safeTransfer(to, amount);
        emit Rescued(address(asset), to, amount);
    }

    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    // ---------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------

    function _held(bytes32 id) private view returns (Escrow storage e) {
        e = _escrows[id];
        if (e.status != Status.Held) revert NotHeld(id);
    }

    function _refund(bytes32 id, Escrow storage e, bool byDeadline) private {
        uint256 amount = e.amount;
        e.status = Status.Refunded;
        totalHeld -= amount;
        token.safeTransfer(e.payer, amount);
        emit Refunded(id, amount, byDeadline);
    }
}
