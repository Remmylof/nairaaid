// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title NairaAidCampaigns
/// @author Lawal Ridwan
/// @notice Transparent, rules-based aid and community payouts in a naira stablecoin (cNGN).
///
///  - An organiser (NGO, church/mosque, student union, cooperative) creates a campaign whose rules are
///    fixed at creation: stipend per period, number of periods, milestone amounts, recipient cap.
///  - Donors fund it; every donation is recorded per donor.
///  - Trusted local verifiers register recipients. A recipient only becomes active after TWO distinct
///    verifiers attest the same anonymous ID and the same payout wallet. On-chain a recipient is only
///    `anonId = keccak256(phone, salt)`; names, phone numbers and documents stay off-chain.
///  - Money only ever leaves the contract to (a) an active recipient's wallet, by the campaign rules, or
///    (b) donors, pro-rata, after the campaign is closed. There is no organiser withdraw function.
///  - The optional platform fee is paid by donors on top of their donation, never taken from recipients.
///
/// @dev Unaudited hackathon prototype. Testnets only.
contract NairaAidCampaigns is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ----------------------------------------------------------------------------------------------
    // Constants
    // ----------------------------------------------------------------------------------------------

    uint16 public constant MAX_FEE_BPS = 300; // 3% cap on the optional platform fee
    uint16 public constant BPS = 10_000;
    uint8 public constant REQUIRED_ATTESTATIONS = 2;
    uint32 public constant MAX_PERIODS = 120;
    uint256 public constant MAX_MILESTONES = 20;

    // ----------------------------------------------------------------------------------------------
    // Types
    // ----------------------------------------------------------------------------------------------

    enum Status {
        None,
        Active,
        Paused,
        Closed
    }

    enum PayoutKind {
        Stipend,
        Milestone
    }

    struct CampaignParams {
        IERC20 token;
        string name;
        string metadataURI; // IPFS/HTTPS doc with eligibility criteria, budget, organiser KYC summary
        uint64 startTime; // 0 = now
        uint64 periodDuration; // e.g. 30 days
        uint32 numPeriods; // e.g. 3 monthly stipends
        uint256 stipendPerPeriod; // per recipient, in token units (0 = milestone-only campaign)
        uint32 maxRecipients;
        uint16 feeBps; // optional platform fee charged to donors on top of the donation
        address feeRecipient;
        uint256[] milestoneAmounts; // per recipient
        string[] milestoneLabels;
    }

    struct Campaign {
        address organiser;
        IERC20 token;
        Status status;
        uint64 startTime;
        uint64 periodDuration;
        uint32 numPeriods;
        uint32 maxRecipients;
        uint32 recipientCount;
        uint32 verifierCount;
        uint32 donorCount;
        uint16 feeBps;
        address feeRecipient;
        uint64 closedAt;
        uint256 stipendPerPeriod;
        uint256 totalRaised; // net donations credited to the pool (fees excluded)
        uint256 totalFees;
        uint256 totalPaid; // paid to recipients
        uint256 totalRefunded; // paid back to donors
        uint256 refundPool; // unspent funds snapshotted at close
        string name;
        string metadataURI;
    }

    struct Milestone {
        string label;
        uint256 amount;
    }

    struct Recipient {
        address wallet;
        uint8 attestations;
        bool active;
        uint32 nextPeriod; // first stipend period index not yet claimed
        uint256 totalReceived;
    }

    struct MilestoneState {
        uint8 confirmations;
        bool paid;
    }

    struct Dashboard {
        Status status;
        uint256 totalRaised;
        uint256 totalPaid;
        uint256 totalRefunded;
        uint256 totalFees;
        uint256 balance; // tokens currently held for this campaign
        uint256 remaining; // raised minus paid to recipients (what would go back to donors)
        uint32 recipientCount;
        uint32 donorCount;
        uint32 verifierCount;
        uint32 periodsElapsed;
        uint64 endTime;
    }

    // ----------------------------------------------------------------------------------------------
    // Storage
    // ----------------------------------------------------------------------------------------------

    uint256 public campaignCount;

    mapping(uint256 => Campaign) private _campaigns;
    mapping(uint256 => Milestone[]) private _milestones;
    mapping(uint256 => mapping(address => bool)) public isVerifier;
    mapping(uint256 => mapping(address => uint256)) public donations;
    mapping(uint256 => mapping(address => bool)) public refunded;

    mapping(uint256 => mapping(bytes32 => Recipient)) private _recipients;
    mapping(uint256 => mapping(address => bool)) public walletUsed;
    mapping(uint256 => mapping(bytes32 => mapping(address => bool))) public hasAttested;

    mapping(uint256 => mapping(bytes32 => mapping(uint256 => MilestoneState))) private _milestoneState;
    mapping(uint256 => mapping(bytes32 => mapping(uint256 => mapping(address => bool)))) public hasConfirmed;

    // ----------------------------------------------------------------------------------------------
    // Events (the public payout trail)
    // ----------------------------------------------------------------------------------------------

    event CampaignCreated(
        uint256 indexed campaignId,
        address indexed organiser,
        address token,
        string name,
        uint256 stipendPerPeriod,
        uint32 numPeriods,
        uint64 startTime,
        uint64 periodDuration,
        uint32 maxRecipients,
        uint16 feeBps
    );
    event MilestoneDefined(uint256 indexed campaignId, uint256 indexed index, string label, uint256 amount);
    event VerifierAdded(uint256 indexed campaignId, address indexed verifier);
    event VerifierRemoved(uint256 indexed campaignId, address indexed verifier);
    event Donated(uint256 indexed campaignId, address indexed donor, uint256 amount, uint256 fee);
    event RecipientAttested(
        uint256 indexed campaignId, bytes32 indexed anonId, address indexed verifier, address wallet, uint8 attestations
    );
    event RecipientRegistered(uint256 indexed campaignId, bytes32 indexed anonId, address wallet);
    event StipendClaimed(
        uint256 indexed campaignId, bytes32 indexed anonId, uint32 fromPeriod, uint32 periods, uint256 amount
    );
    event MilestoneConfirmed(
        uint256 indexed campaignId, bytes32 indexed anonId, uint256 indexed index, address verifier, uint8 confirmations
    );
    event Payout(
        uint256 indexed campaignId, bytes32 indexed anonId, address indexed wallet, PayoutKind kind, uint256 ref, uint256 amount
    );
    event CampaignPaused(uint256 indexed campaignId);
    event CampaignUnpaused(uint256 indexed campaignId);
    event CampaignClosed(uint256 indexed campaignId, address indexed closedBy, uint256 refundPool);
    event Refunded(uint256 indexed campaignId, address indexed donor, uint256 amount);

    // ----------------------------------------------------------------------------------------------
    // Errors
    // ----------------------------------------------------------------------------------------------

    error CampaignNotFound(uint256 campaignId);
    error NotOrganiser();
    error NotVerifier();
    error InvalidParams();
    error FeeTooHigh();
    error ZeroAddress();
    error ZeroAmount();
    error NotActive();
    error NotPaused();
    error NotClosed();
    error AlreadyClosed();
    error CampaignNotEnded();
    error AlreadyVerifier();
    error ConflictOfInterest();
    error InvalidAnonId();
    error AlreadyAttested();
    error AlreadyRegistered();
    error WalletMismatch();
    error WalletAlreadyUsed();
    error RecipientCapReached();
    error RecipientNotActive();
    error NoStipend();
    error NothingToClaim();
    error InvalidMilestone();
    error MilestoneAlreadyPaid();
    error AlreadyConfirmed();
    error InsufficientFunds(uint256 available, uint256 needed);
    error NothingToRefund();
    error AlreadyRefunded();

    // ----------------------------------------------------------------------------------------------
    // Modifiers
    // ----------------------------------------------------------------------------------------------

    modifier exists(uint256 id) {
        if (_campaigns[id].status == Status.None) revert CampaignNotFound(id);
        _;
    }

    modifier onlyOrganiser(uint256 id) {
        if (_campaigns[id].status == Status.None) revert CampaignNotFound(id);
        if (msg.sender != _campaigns[id].organiser) revert NotOrganiser();
        _;
    }

    modifier onlyVerifier(uint256 id) {
        if (_campaigns[id].status == Status.None) revert CampaignNotFound(id);
        if (!isVerifier[id][msg.sender]) revert NotVerifier();
        _;
    }

    modifier whenActive(uint256 id) {
        if (_campaigns[id].status != Status.Active) revert NotActive();
        _;
    }

    // ----------------------------------------------------------------------------------------------
    // Organiser: campaign setup
    // ----------------------------------------------------------------------------------------------

    /// @notice Create a campaign. Its money rules cannot be changed afterwards.
    function createCampaign(CampaignParams calldata p) external returns (uint256 id) {
        if (address(p.token) == address(0)) revert ZeroAddress();
        if (p.periodDuration == 0 || p.numPeriods == 0 || p.numPeriods > MAX_PERIODS) revert InvalidParams();
        if (p.maxRecipients == 0) revert InvalidParams();
        if (p.milestoneAmounts.length != p.milestoneLabels.length) revert InvalidParams();
        if (p.milestoneAmounts.length > MAX_MILESTONES) revert InvalidParams();
        if (p.stipendPerPeriod == 0 && p.milestoneAmounts.length == 0) revert InvalidParams();
        if (p.feeBps > MAX_FEE_BPS) revert FeeTooHigh();
        if (p.feeBps > 0 && p.feeRecipient == address(0)) revert ZeroAddress();

        uint64 start = p.startTime == 0 ? uint64(block.timestamp) : p.startTime;
        if (start < block.timestamp) revert InvalidParams();

        id = ++campaignCount;
        Campaign storage c = _campaigns[id];
        c.organiser = msg.sender;
        c.token = p.token;
        c.status = Status.Active;
        c.startTime = start;
        c.periodDuration = p.periodDuration;
        c.numPeriods = p.numPeriods;
        c.maxRecipients = p.maxRecipients;
        c.feeBps = p.feeBps;
        c.feeRecipient = p.feeRecipient;
        c.stipendPerPeriod = p.stipendPerPeriod;
        c.name = p.name;
        c.metadataURI = p.metadataURI;

        emit CampaignCreated(
            id,
            msg.sender,
            address(p.token),
            p.name,
            p.stipendPerPeriod,
            p.numPeriods,
            start,
            p.periodDuration,
            p.maxRecipients,
            p.feeBps
        );

        for (uint256 i = 0; i < p.milestoneAmounts.length; i++) {
            if (p.milestoneAmounts[i] == 0) revert InvalidParams();
            _milestones[id].push(Milestone({label: p.milestoneLabels[i], amount: p.milestoneAmounts[i]}));
            emit MilestoneDefined(id, i, p.milestoneLabels[i], p.milestoneAmounts[i]);
        }
    }

    /// @notice Add a trusted local verifier (e.g. a lecturer, imam, pastor, union officer, NGO field agent).
    /// @dev The organiser can never be a verifier, so they always need at least two other people to agree.
    function addVerifier(uint256 id, address verifier) external onlyOrganiser(id) {
        Campaign storage c = _campaigns[id];
        if (c.status == Status.Closed) revert AlreadyClosed();
        if (verifier == address(0)) revert ZeroAddress();
        if (verifier == c.organiser || verifier == c.feeRecipient || walletUsed[id][verifier]) {
            revert ConflictOfInterest();
        }
        if (isVerifier[id][verifier]) revert AlreadyVerifier();
        isVerifier[id][verifier] = true;
        c.verifierCount++;
        emit VerifierAdded(id, verifier);
    }

    /// @notice Remove a verifier (lost key, misconduct). Past attestations stay on the public record.
    function removeVerifier(uint256 id, address verifier) external onlyOrganiser(id) {
        if (!isVerifier[id][verifier]) revert NotVerifier();
        isVerifier[id][verifier] = false;
        _campaigns[id].verifierCount--;
        emit VerifierRemoved(id, verifier);
    }

    function pause(uint256 id) external onlyOrganiser(id) whenActive(id) {
        _campaigns[id].status = Status.Paused;
        emit CampaignPaused(id);
    }

    function unpause(uint256 id) external onlyOrganiser(id) {
        if (_campaigns[id].status != Status.Paused) revert NotPaused();
        _campaigns[id].status = Status.Active;
        emit CampaignUnpaused(id);
    }

    /// @notice Close the campaign and lock unspent funds for pro-rata donor refunds.
    /// @dev The organiser can close at any time (funds go back to donors, never to the organiser).
    ///      Anyone can close once the schedule has ended, so funds can't be held hostage.
    function closeCampaign(uint256 id) external exists(id) {
        Campaign storage c = _campaigns[id];
        if (c.status == Status.Closed) revert AlreadyClosed();
        if (msg.sender != c.organiser && block.timestamp < endTime(id)) revert CampaignNotEnded();
        c.status = Status.Closed;
        c.closedAt = uint64(block.timestamp);
        c.refundPool = c.totalRaised - c.totalPaid;
        emit CampaignClosed(id, msg.sender, c.refundPool);
    }

    // ----------------------------------------------------------------------------------------------
    // Donors
    // ----------------------------------------------------------------------------------------------

    /// @notice Donate `amount` to the campaign pool. If the campaign has a platform fee, the donor pays it
    ///         on top (`amount * feeBps / 10000`), so recipients always get the full rule amount.
    function fund(uint256 id, uint256 amount) external nonReentrant exists(id) whenActive(id) {
        if (amount == 0) revert ZeroAmount();
        Campaign storage c = _campaigns[id];
        uint256 fee = (amount * c.feeBps) / BPS;

        if (donations[id][msg.sender] == 0) c.donorCount++;
        donations[id][msg.sender] += amount;
        c.totalRaised += amount;
        c.totalFees += fee;

        c.token.safeTransferFrom(msg.sender, address(this), amount);
        if (fee > 0) c.token.safeTransferFrom(msg.sender, c.feeRecipient, fee);
        emit Donated(id, msg.sender, amount, fee);
    }

    /// @notice After close, each donor can reclaim `donation * refundPool / totalRaised`.
    function claimRefund(uint256 id) external nonReentrant exists(id) {
        Campaign storage c = _campaigns[id];
        if (c.status != Status.Closed) revert NotClosed();
        if (refunded[id][msg.sender]) revert AlreadyRefunded();
        uint256 amount = refundableAmount(id, msg.sender);
        if (amount == 0) revert NothingToRefund();
        refunded[id][msg.sender] = true;
        c.totalRefunded += amount;
        c.token.safeTransfer(msg.sender, amount);
        emit Refunded(id, msg.sender, amount);
    }

    // ----------------------------------------------------------------------------------------------
    // Verifiers
    // ----------------------------------------------------------------------------------------------

    /// @notice Attest a recipient. The first attestation proposes `(anonId, wallet)`; a second, different
    ///         verifier must attest the exact same pair before the recipient becomes active.
    /// @param anonId keccak256(phone || salt), computed off-chain by the verifier app. No personal data on-chain.
    /// @param wallet Payout wallet (self-custody, or a custodial/USSD wallet held by an off-ramp partner).
    function registerRecipient(uint256 id, bytes32 anonId, address wallet)
        external
        onlyVerifier(id)
        whenActive(id)
    {
        if (anonId == bytes32(0)) revert InvalidAnonId();
        if (wallet == address(0)) revert ZeroAddress();
        Campaign storage c = _campaigns[id];
        if (wallet == c.organiser || wallet == c.feeRecipient || isVerifier[id][wallet]) revert ConflictOfInterest();

        Recipient storage r = _recipients[id][anonId];
        if (r.active) revert AlreadyRegistered();
        if (hasAttested[id][anonId][msg.sender]) revert AlreadyAttested();

        if (r.attestations == 0) {
            if (walletUsed[id][wallet]) revert WalletAlreadyUsed();
            if (c.recipientCount >= c.maxRecipients) revert RecipientCapReached();
            r.wallet = wallet;
            walletUsed[id][wallet] = true;
        } else if (r.wallet != wallet) {
            revert WalletMismatch();
        }

        hasAttested[id][anonId][msg.sender] = true;
        r.attestations++;
        emit RecipientAttested(id, anonId, msg.sender, wallet, r.attestations);

        if (r.attestations >= REQUIRED_ATTESTATIONS) {
            if (c.recipientCount >= c.maxRecipients) revert RecipientCapReached();
            r.active = true;
            r.nextPeriod = _currentPeriodIndex(c);
            c.recipientCount++;
            emit RecipientRegistered(id, anonId, wallet);
        }
    }

    /// @notice Confirm that an active recipient reached milestone `index` (e.g. school fees invoice checked).
    ///         Pays out automatically on the second confirmation by a distinct verifier.
    function confirmMilestone(uint256 id, bytes32 anonId, uint256 index)
        external
        nonReentrant
        onlyVerifier(id)
        whenActive(id)
    {
        if (index >= _milestones[id].length) revert InvalidMilestone();
        Recipient storage r = _recipients[id][anonId];
        if (!r.active) revert RecipientNotActive();
        if (r.wallet == msg.sender) revert ConflictOfInterest();
        MilestoneState storage m = _milestoneState[id][anonId][index];
        if (m.paid) revert MilestoneAlreadyPaid();
        if (hasConfirmed[id][anonId][index][msg.sender]) revert AlreadyConfirmed();

        hasConfirmed[id][anonId][index][msg.sender] = true;
        m.confirmations++;
        emit MilestoneConfirmed(id, anonId, index, msg.sender, m.confirmations);

        if (m.confirmations >= REQUIRED_ATTESTATIONS) {
            m.paid = true;
            _pay(id, anonId, r, PayoutKind.Milestone, index, _milestones[id][index].amount);
        }
    }

    // ----------------------------------------------------------------------------------------------
    // Recipients
    // ----------------------------------------------------------------------------------------------

    /// @notice Claim every stipend period that has started and not yet been claimed.
    /// @dev Anyone may call (e.g. a USSD/WhatsApp relayer paying gas), but the money only ever goes to the
    ///      recipient's registered wallet. Each period can be claimed exactly once.
    function claimStipend(uint256 id, bytes32 anonId) external nonReentrant exists(id) whenActive(id) {
        Campaign storage c = _campaigns[id];
        if (c.stipendPerPeriod == 0) revert NoStipend();
        Recipient storage r = _recipients[id][anonId];
        if (!r.active) revert RecipientNotActive();

        uint32 available = _periodsElapsed(c);
        if (available <= r.nextPeriod) revert NothingToClaim();
        uint32 from = r.nextPeriod;
        uint32 n = available - from;
        r.nextPeriod = available;

        uint256 amount = uint256(n) * c.stipendPerPeriod;
        emit StipendClaimed(id, anonId, from, n, amount);
        _pay(id, anonId, r, PayoutKind.Stipend, from, amount);
    }

    // ----------------------------------------------------------------------------------------------
    // Views (dashboard)
    // ----------------------------------------------------------------------------------------------

    function getCampaign(uint256 id) external view exists(id) returns (Campaign memory) {
        return _campaigns[id];
    }

    function getDashboard(uint256 id) external view exists(id) returns (Dashboard memory d) {
        Campaign storage c = _campaigns[id];
        d.status = c.status;
        d.totalRaised = c.totalRaised;
        d.totalPaid = c.totalPaid;
        d.totalRefunded = c.totalRefunded;
        d.totalFees = c.totalFees;
        d.balance = balanceOf(id);
        d.remaining = remaining(id);
        d.recipientCount = c.recipientCount;
        d.donorCount = c.donorCount;
        d.verifierCount = c.verifierCount;
        d.periodsElapsed = _periodsElapsed(c);
        d.endTime = endTime(id);
    }

    /// @notice Tokens currently held by the contract for this campaign.
    function balanceOf(uint256 id) public view exists(id) returns (uint256) {
        Campaign storage c = _campaigns[id];
        return c.totalRaised - c.totalPaid - c.totalRefunded;
    }

    function totalPaid(uint256 id) external view exists(id) returns (uint256) {
        return _campaigns[id].totalPaid;
    }

    /// @notice Raised minus paid to recipients: the unspent amount (what donors get back if closed now).
    function remaining(uint256 id) public view exists(id) returns (uint256) {
        Campaign storage c = _campaigns[id];
        return c.totalRaised - c.totalPaid;
    }

    function recipientCount(uint256 id) external view exists(id) returns (uint32) {
        return _campaigns[id].recipientCount;
    }

    function endTime(uint256 id) public view exists(id) returns (uint64) {
        Campaign storage c = _campaigns[id];
        return c.startTime + c.periodDuration * c.numPeriods;
    }

    function periodsElapsed(uint256 id) external view exists(id) returns (uint32) {
        return _periodsElapsed(_campaigns[id]);
    }

    function getMilestones(uint256 id) external view exists(id) returns (Milestone[] memory) {
        return _milestones[id];
    }

    function getRecipient(uint256 id, bytes32 anonId) external view exists(id) returns (Recipient memory) {
        return _recipients[id][anonId];
    }

    function milestoneStatus(uint256 id, bytes32 anonId, uint256 index)
        external
        view
        exists(id)
        returns (uint8 confirmations, bool paid)
    {
        MilestoneState storage m = _milestoneState[id][anonId][index];
        return (m.confirmations, m.paid);
    }

    function claimableStipend(uint256 id, bytes32 anonId) external view exists(id) returns (uint256) {
        Campaign storage c = _campaigns[id];
        Recipient storage r = _recipients[id][anonId];
        if (!r.active || c.status != Status.Active) return 0;
        uint32 available = _periodsElapsed(c);
        if (available <= r.nextPeriod) return 0;
        return uint256(available - r.nextPeriod) * c.stipendPerPeriod;
    }

    /// @notice What `donor` can reclaim after close (0 before close or after refund).
    function refundableAmount(uint256 id, address donor) public view exists(id) returns (uint256) {
        Campaign storage c = _campaigns[id];
        if (c.status != Status.Closed || refunded[id][donor] || c.totalRaised == 0) return 0;
        return (donations[id][donor] * c.refundPool) / c.totalRaised;
    }

    /// @notice Hashing helper so verifier apps and tests produce identical IDs. Call it off-chain only
    ///         (eth_call): sending the phone number in a transaction would put it on the public chain.
    function computeAnonId(string calldata phone, bytes32 salt) external pure returns (bytes32) {
        return keccak256(abi.encodePacked(phone, salt));
    }

    // ----------------------------------------------------------------------------------------------
    // Internal
    // ----------------------------------------------------------------------------------------------

    /// @dev Number of stipend periods that have started (period k opens at start + k * duration).
    function _periodsElapsed(Campaign storage c) internal view returns (uint32) {
        if (block.timestamp < c.startTime) return 0;
        uint256 n = (block.timestamp - c.startTime) / c.periodDuration + 1;
        return n > c.numPeriods ? c.numPeriods : uint32(n);
    }

    /// @dev Index of the current period for a newly activated recipient (they can claim from here on).
    function _currentPeriodIndex(Campaign storage c) internal view returns (uint32) {
        uint32 elapsed = _periodsElapsed(c);
        return elapsed == 0 ? 0 : elapsed - 1;
    }

    function _pay(uint256 id, bytes32 anonId, Recipient storage r, PayoutKind kind, uint256 ref, uint256 amount)
        internal
    {
        Campaign storage c = _campaigns[id];
        uint256 available = c.totalRaised - c.totalPaid - c.totalRefunded;
        if (amount > available) revert InsufficientFunds(available, amount);
        c.totalPaid += amount;
        r.totalReceived += amount;
        c.token.safeTransfer(r.wallet, amount);
        emit Payout(id, anonId, r.wallet, kind, ref, amount);
    }
}
