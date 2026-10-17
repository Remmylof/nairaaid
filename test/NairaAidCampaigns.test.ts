import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";

const DAY = 24 * 3600;
const MONTH = 30 * DAY;
const ngn = (n: number | string) => ethers.parseUnits(n.toString(), 6); // cNGN has 6 decimals

const STIPEND = ngn(20_000);
const SCHOOL_FEES = ngn(50_000);
const BOOKS = ngn(10_000);

function anonId(phone: string, salt: string): string {
  return ethers.solidityPackedKeccak256(["string", "bytes32"], [phone, ethers.id(salt)]);
}

enum Status {
  None,
  Active,
  Paused,
  Closed,
}

describe("NairaAidCampaigns", function () {
  async function deployFixture() {
    const [organiser, v1, v2, v3, donorA, donorB, alice, bob, carol, outsider, platform] = await ethers.getSigners();

    const token = await (await ethers.getContractFactory("MockCNGN")).deploy(organiser.address);
    const aid = await (await ethers.getContractFactory("NairaAidCampaigns")).deploy();

    for (const d of [donorA, donorB, outsider]) {
      await token.mint(d.address, ngn(1_000_000));
      await token.connect(d).approve(await aid.getAddress(), ethers.MaxUint256);
    }

    const params = {
      token: await token.getAddress(),
      name: "Ilorin Flood Relief - Students",
      metadataURI: "ipfs://bafy-demo-eligibility",
      startTime: 0n,
      periodDuration: BigInt(MONTH),
      numPeriods: 3,
      stipendPerPeriod: STIPEND,
      maxRecipients: 10,
      feeBps: 100, // 1% paid by donors on top
      feeRecipient: platform.address,
      milestoneAmounts: [SCHOOL_FEES, BOOKS],
      milestoneLabels: ["School fees 2026/27", "Textbooks"],
    };
    await aid.connect(organiser).createCampaign(params);
    const id = 1n;
    await aid.connect(organiser).addVerifier(id, v1.address);
    await aid.connect(organiser).addVerifier(id, v2.address);
    await aid.connect(organiser).addVerifier(id, v3.address);

    const aliceId = anonId("+2348030000001", "salt-alice");
    const bobId = anonId("+2348030000002", "salt-bob");

    return { aid, token, organiser, v1, v2, v3, donorA, donorB, alice, bob, carol, outsider, platform, params, id, aliceId, bobId };
  }

  /** Funded with ₦300k (A: 200k, B: 100k) and Alice + Bob fully registered. */
  async function readyFixture() {
    const f = await deployFixture();
    const { aid, id, donorA, donorB, v1, v2, alice, bob, aliceId, bobId } = f;
    await aid.connect(donorA).fund(id, ngn(200_000));
    await aid.connect(donorB).fund(id, ngn(100_000));
    for (const [rid, w] of [
      [aliceId, alice.address],
      [bobId, bob.address],
    ] as const) {
      await aid.connect(v1).registerRecipient(id, rid, w);
      await aid.connect(v2).registerRecipient(id, rid, w);
    }
    return f;
  }

  // ------------------------------------------------------------------------------------------------
  describe("campaign creation & setup", function () {
    it("creates a campaign with fixed rules, milestones and events", async function () {
      const { aid, organiser, params, token } = await loadFixture(deployFixture);
      const c = await aid.getCampaign(1);
      expect(c.organiser).to.equal(organiser.address);
      expect(c.token).to.equal(await token.getAddress());
      expect(c.status).to.equal(Status.Active);
      expect(c.stipendPerPeriod).to.equal(STIPEND);
      expect(c.numPeriods).to.equal(3);
      expect(c.verifierCount).to.equal(3);
      const ms = await aid.getMilestones(1);
      expect(ms.length).to.equal(2);
      expect(ms[0].label).to.equal("School fees 2026/27");
      expect(ms[0].amount).to.equal(SCHOOL_FEES);

      await expect(aid.connect(organiser).createCampaign(params))
        .to.emit(aid, "CampaignCreated")
        .and.to.emit(aid, "MilestoneDefined");
      expect(await aid.campaignCount()).to.equal(2);
    });

    it("rejects invalid params and fees above the 3% cap", async function () {
      const { aid, params } = await loadFixture(deployFixture);
      await expect(aid.createCampaign({ ...params, feeBps: 301 })).to.be.revertedWithCustomError(aid, "FeeTooHigh");
      await expect(aid.createCampaign({ ...params, periodDuration: 0n })).to.be.revertedWithCustomError(aid, "InvalidParams");
      await expect(aid.createCampaign({ ...params, maxRecipients: 0 })).to.be.revertedWithCustomError(aid, "InvalidParams");
      await expect(aid.createCampaign({ ...params, milestoneLabels: ["only one"] })).to.be.revertedWithCustomError(
        aid,
        "InvalidParams"
      );
      await expect(
        aid.createCampaign({ ...params, stipendPerPeriod: 0n, milestoneAmounts: [], milestoneLabels: [] })
      ).to.be.revertedWithCustomError(aid, "InvalidParams");
      await expect(aid.createCampaign({ ...params, token: ethers.ZeroAddress })).to.be.revertedWithCustomError(
        aid,
        "ZeroAddress"
      );
    });

    it("only the organiser can add verifiers, and the organiser can never be a verifier", async function () {
      const { aid, id, organiser, outsider, v1, platform } = await loadFixture(deployFixture);
      await expect(aid.connect(outsider).addVerifier(id, outsider.address)).to.be.revertedWithCustomError(aid, "NotOrganiser");
      await expect(aid.connect(organiser).addVerifier(id, organiser.address)).to.be.revertedWithCustomError(
        aid,
        "ConflictOfInterest"
      );
      await expect(aid.connect(organiser).addVerifier(id, platform.address)).to.be.revertedWithCustomError(
        aid,
        "ConflictOfInterest"
      );
      await expect(aid.connect(organiser).addVerifier(id, v1.address)).to.be.revertedWithCustomError(aid, "AlreadyVerifier");
      await expect(aid.connect(organiser).removeVerifier(id, v1.address))
        .to.emit(aid, "VerifierRemoved")
        .withArgs(id, v1.address);
      expect(await aid.isVerifier(id, v1.address)).to.equal(false);
    });

    it("reverts on unknown campaign ids", async function () {
      const { aid } = await loadFixture(deployFixture);
      await expect(aid.getCampaign(99)).to.be.revertedWithCustomError(aid, "CampaignNotFound").withArgs(99);
      await expect(aid.fund(99, 1)).to.be.revertedWithCustomError(aid, "CampaignNotFound");
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe("donations", function () {
    it("tracks donations per donor, charges the platform fee on top, and updates the dashboard", async function () {
      const { aid, token, id, donorA, donorB, platform } = await loadFixture(deployFixture);
      await expect(aid.connect(donorA).fund(id, ngn(200_000)))
        .to.emit(aid, "Donated")
        .withArgs(id, donorA.address, ngn(200_000), ngn(2_000));
      await aid.connect(donorA).fund(id, ngn(50_000));
      await aid.connect(donorB).fund(id, ngn(100_000));

      expect(await aid.donations(id, donorA.address)).to.equal(ngn(250_000));
      expect(await aid.donations(id, donorB.address)).to.equal(ngn(100_000));
      expect(await token.balanceOf(platform.address)).to.equal(ngn(3_500)); // 1% of 350k
      expect(await token.balanceOf(await aid.getAddress())).to.equal(ngn(350_000)); // full amount in the pool

      const d = await aid.getDashboard(id);
      expect(d.totalRaised).to.equal(ngn(350_000));
      expect(d.balance).to.equal(ngn(350_000));
      expect(d.remaining).to.equal(ngn(350_000));
      expect(d.donorCount).to.equal(2);
      expect(d.totalFees).to.equal(ngn(3_500));
    });

    it("rejects zero donations", async function () {
      const { aid, id, donorA } = await loadFixture(deployFixture);
      await expect(aid.connect(donorA).fund(id, 0)).to.be.revertedWithCustomError(aid, "ZeroAmount");
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe("recipient registration (2-of-N verifiers)", function () {
    it("activates a recipient only after two distinct verifier attestations", async function () {
      const { aid, id, v1, v2, alice, aliceId } = await loadFixture(deployFixture);
      await expect(aid.connect(v1).registerRecipient(id, aliceId, alice.address))
        .to.emit(aid, "RecipientAttested")
        .withArgs(id, aliceId, v1.address, alice.address, 1);
      let r = await aid.getRecipient(id, aliceId);
      expect(r.active).to.equal(false);
      expect(await aid.recipientCount(id)).to.equal(0);

      await expect(aid.connect(v2).registerRecipient(id, aliceId, alice.address))
        .to.emit(aid, "RecipientRegistered")
        .withArgs(id, aliceId, alice.address);
      r = await aid.getRecipient(id, aliceId);
      expect(r.active).to.equal(true);
      expect(r.wallet).to.equal(alice.address);
      expect(await aid.recipientCount(id)).to.equal(1);
    });

    it("ATTACK: a single verifier cannot attest the same recipient twice (collusion blocked)", async function () {
      const { aid, id, v1, alice, aliceId } = await loadFixture(deployFixture);
      await aid.connect(v1).registerRecipient(id, aliceId, alice.address);
      await expect(aid.connect(v1).registerRecipient(id, aliceId, alice.address)).to.be.revertedWithCustomError(
        aid,
        "AlreadyAttested"
      );
      expect((await aid.getRecipient(id, aliceId)).active).to.equal(false);
    });

    it("ATTACK: non-verifiers cannot attest", async function () {
      const { aid, id, outsider, organiser, alice, aliceId } = await loadFixture(deployFixture);
      await expect(aid.connect(outsider).registerRecipient(id, aliceId, alice.address)).to.be.revertedWithCustomError(
        aid,
        "NotVerifier"
      );
      // the organiser is not a verifier either
      await expect(aid.connect(organiser).registerRecipient(id, aliceId, alice.address)).to.be.revertedWithCustomError(
        aid,
        "NotVerifier"
      );
    });

    it("ATTACK: second verifier cannot swap the payout wallet (WalletMismatch)", async function () {
      const { aid, id, v1, v2, alice, outsider, aliceId } = await loadFixture(deployFixture);
      await aid.connect(v1).registerRecipient(id, aliceId, alice.address);
      await expect(aid.connect(v2).registerRecipient(id, aliceId, outsider.address)).to.be.revertedWithCustomError(
        aid,
        "WalletMismatch"
      );
    });

    it("ATTACK: organiser, fee recipient or a verifier cannot be registered as a recipient wallet", async function () {
      const { aid, id, v1, v2, organiser, platform, aliceId } = await loadFixture(deployFixture);
      await expect(aid.connect(v1).registerRecipient(id, aliceId, organiser.address)).to.be.revertedWithCustomError(
        aid,
        "ConflictOfInterest"
      );
      await expect(aid.connect(v1).registerRecipient(id, aliceId, platform.address)).to.be.revertedWithCustomError(
        aid,
        "ConflictOfInterest"
      );
      await expect(aid.connect(v1).registerRecipient(id, aliceId, v2.address)).to.be.revertedWithCustomError(
        aid,
        "ConflictOfInterest"
      );
    });

    it("blocks one wallet claiming under two anonymous IDs, duplicate IDs, and enforces the recipient cap", async function () {
      const { aid, token, id, organiser, v1, v2, alice, bob, carol, aliceId, bobId, params } = await loadFixture(deployFixture);
      await aid.connect(v1).registerRecipient(id, aliceId, alice.address);
      await aid.connect(v2).registerRecipient(id, aliceId, alice.address);
      await expect(aid.connect(v1).registerRecipient(id, bobId, alice.address)).to.be.revertedWithCustomError(
        aid,
        "WalletAlreadyUsed"
      );
      await expect(aid.connect(v1).registerRecipient(id, aliceId, alice.address)).to.be.revertedWithCustomError(
        aid,
        "AlreadyRegistered"
      );
      await expect(aid.connect(v1).registerRecipient(id, ethers.ZeroHash, bob.address)).to.be.revertedWithCustomError(
        aid,
        "InvalidAnonId"
      );

      // cap of 1 recipient on a new campaign
      await aid.connect(organiser).createCampaign({ ...params, maxRecipients: 1, token: await token.getAddress() });
      await aid.connect(organiser).addVerifier(2, v1.address);
      await aid.connect(organiser).addVerifier(2, v2.address);
      await aid.connect(v1).registerRecipient(2, aliceId, alice.address);
      await aid.connect(v2).registerRecipient(2, aliceId, alice.address);
      await expect(aid.connect(v1).registerRecipient(2, bobId, carol.address)).to.be.revertedWithCustomError(
        aid,
        "RecipientCapReached"
      );
    });

    it("computeAnonId matches the off-chain hash (no personal data stored)", async function () {
      const { aid, aliceId } = await loadFixture(deployFixture);
      expect(await aid.computeAnonId("+2348030000001", ethers.id("salt-alice"))).to.equal(aliceId);
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe("stipends", function () {
    it("pays the current month's stipend to the registered wallet", async function () {
      const { aid, token, id, alice, aliceId } = await loadFixture(readyFixture);
      expect(await aid.claimableStipend(id, aliceId)).to.equal(STIPEND);
      await expect(aid.connect(alice).claimStipend(id, aliceId))
        .to.emit(aid, "StipendClaimed")
        .withArgs(id, aliceId, 0, 1, STIPEND)
        .and.to.emit(aid, "Payout")
        .withArgs(id, aliceId, alice.address, 0, 0, STIPEND);
      expect(await token.balanceOf(alice.address)).to.equal(STIPEND);
      expect(await aid.totalPaid(id)).to.equal(STIPEND);
      expect(await aid.claimableStipend(id, aliceId)).to.equal(0);
    });

    it("ATTACK: double claim in the same period is rejected", async function () {
      const { aid, id, alice, aliceId } = await loadFixture(readyFixture);
      await aid.connect(alice).claimStipend(id, aliceId);
      await expect(aid.connect(alice).claimStipend(id, aliceId)).to.be.revertedWithCustomError(aid, "NothingToClaim");
    });

    it("accrues missed periods, caps at numPeriods, and never pays a period twice", async function () {
      const { aid, token, id, alice, aliceId } = await loadFixture(readyFixture);
      await time.increase(MONTH + 1); // now in period 2
      await expect(aid.connect(alice).claimStipend(id, aliceId))
        .to.emit(aid, "StipendClaimed")
        .withArgs(id, aliceId, 0, 2, STIPEND * 2n);
      await time.increase(5 * MONTH); // well past the 3-month schedule
      await aid.connect(alice).claimStipend(id, aliceId);
      expect(await token.balanceOf(alice.address)).to.equal(STIPEND * 3n); // capped at 3 periods
      await expect(aid.connect(alice).claimStipend(id, aliceId)).to.be.revertedWithCustomError(aid, "NothingToClaim");
    });

    it("a relayer can trigger the claim but funds only go to the recipient's wallet", async function () {
      const { aid, token, id, outsider, alice, aliceId } = await loadFixture(readyFixture);
      const before = await token.balanceOf(outsider.address);
      await aid.connect(outsider).claimStipend(id, aliceId);
      expect(await token.balanceOf(alice.address)).to.equal(STIPEND);
      expect(await token.balanceOf(outsider.address)).to.equal(before);
    });

    it("recipients registered later cannot back-claim earlier periods; pending recipients cannot claim", async function () {
      const { aid, token, id, v1, v2, carol, outsider } = await loadFixture(readyFixture);
      const carolId = anonId("+2348030000003", "salt-carol");
      await aid.connect(v1).registerRecipient(id, carolId, carol.address);
      await expect(aid.connect(carol).claimStipend(id, carolId)).to.be.revertedWithCustomError(aid, "RecipientNotActive");
      await time.increase(MONTH + 1); // period 2
      await aid.connect(v2).registerRecipient(id, carolId, carol.address);
      await aid.connect(carol).claimStipend(id, carolId);
      expect(await token.balanceOf(carol.address)).to.equal(STIPEND); // only period 2, not period 1
      await expect(aid.connect(outsider).claimStipend(id, ethers.id("ghost"))).to.be.revertedWithCustomError(
        aid,
        "RecipientNotActive"
      );
    });

    it("reverts with InsufficientFunds when the pool is empty instead of over-paying", async function () {
      const { aid, id, organiser, v1, v2, alice, aliceId, donorA, params, token } = await loadFixture(deployFixture);
      await aid.connect(organiser).createCampaign({ ...params, token: await token.getAddress() });
      await aid.connect(organiser).addVerifier(2, v1.address);
      await aid.connect(organiser).addVerifier(2, v2.address);
      await aid.connect(donorA).fund(2, ngn(5_000));
      await aid.connect(v1).registerRecipient(2, aliceId, alice.address);
      await aid.connect(v2).registerRecipient(2, aliceId, alice.address);
      await expect(aid.connect(alice).claimStipend(2, aliceId))
        .to.be.revertedWithCustomError(aid, "InsufficientFunds")
        .withArgs(ngn(5_000), STIPEND);
      void id;
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe("milestones", function () {
    it("pays a milestone only after two distinct verifier confirmations", async function () {
      const { aid, token, id, v1, v2, alice, aliceId } = await loadFixture(readyFixture);
      await expect(aid.connect(v1).confirmMilestone(id, aliceId, 0))
        .to.emit(aid, "MilestoneConfirmed")
        .withArgs(id, aliceId, 0, v1.address, 1);
      expect(await token.balanceOf(alice.address)).to.equal(0);
      await expect(aid.connect(v2).confirmMilestone(id, aliceId, 0))
        .to.emit(aid, "Payout")
        .withArgs(id, aliceId, alice.address, 1, 0, SCHOOL_FEES);
      expect(await token.balanceOf(alice.address)).to.equal(SCHOOL_FEES);
      const [conf, paid] = await aid.milestoneStatus(id, aliceId, 0);
      expect(conf).to.equal(2);
      expect(paid).to.equal(true);
    });

    it("ATTACK: one verifier confirming twice cannot release a milestone", async function () {
      const { aid, token, id, v1, alice, aliceId } = await loadFixture(readyFixture);
      await aid.connect(v1).confirmMilestone(id, aliceId, 0);
      await expect(aid.connect(v1).confirmMilestone(id, aliceId, 0)).to.be.revertedWithCustomError(aid, "AlreadyConfirmed");
      expect(await token.balanceOf(alice.address)).to.equal(0);
    });

    it("ATTACK: milestone cannot be paid twice, nor confirmed by non-verifiers, nor for bad indexes", async function () {
      const { aid, id, v1, v2, v3, outsider, aliceId } = await loadFixture(readyFixture);
      await aid.connect(v1).confirmMilestone(id, aliceId, 0);
      await aid.connect(v2).confirmMilestone(id, aliceId, 0);
      await expect(aid.connect(v3).confirmMilestone(id, aliceId, 0)).to.be.revertedWithCustomError(aid, "MilestoneAlreadyPaid");
      await expect(aid.connect(outsider).confirmMilestone(id, aliceId, 1)).to.be.revertedWithCustomError(aid, "NotVerifier");
      await expect(aid.connect(v1).confirmMilestone(id, aliceId, 7)).to.be.revertedWithCustomError(aid, "InvalidMilestone");
      await expect(aid.connect(v1).confirmMilestone(id, ethers.id("ghost"), 0)).to.be.revertedWithCustomError(
        aid,
        "RecipientNotActive"
      );
    });

    it("a removed verifier can no longer confirm", async function () {
      const { aid, id, organiser, v1, aliceId } = await loadFixture(readyFixture);
      await aid.connect(organiser).removeVerifier(id, v1.address);
      await expect(aid.connect(v1).confirmMilestone(id, aliceId, 0)).to.be.revertedWithCustomError(aid, "NotVerifier");
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe("organiser powers are limited", function () {
    it("ATTACK: the organiser has no way to drain the pool", async function () {
      const { aid, token, id, organiser, aliceId } = await loadFixture(readyFixture);
      // no withdraw function exists in the ABI
      const fnNames = aid.interface.fragments.filter((f) => f.type === "function").map((f: any) => f.name as string);
      for (const bad of ["withdraw", "sweep", "emergencyWithdraw", "rescueTokens", "transferOut"]) {
        expect(fnNames).to.not.include(bad);
      }
      // organiser cannot attest, cannot confirm milestones, and cannot refund without donating
      await expect(aid.connect(organiser).confirmMilestone(id, aliceId, 0)).to.be.revertedWithCustomError(aid, "NotVerifier");
      await aid.connect(organiser).closeCampaign(id);
      await expect(aid.connect(organiser).claimRefund(id)).to.be.revertedWithCustomError(aid, "NothingToRefund");
      expect(await token.balanceOf(organiser.address)).to.equal(0);
      expect(await token.balanceOf(await aid.getAddress())).to.equal(ngn(300_000));
    });

    it("pause blocks funding, registration, claims and milestones; unpause restores them", async function () {
      const { aid, id, organiser, outsider, donorA, v1, v2, alice, carol, aliceId } = await loadFixture(readyFixture);
      await expect(aid.connect(outsider).pause(id)).to.be.revertedWithCustomError(aid, "NotOrganiser");
      await expect(aid.connect(organiser).pause(id)).to.emit(aid, "CampaignPaused").withArgs(id);
      expect((await aid.getCampaign(id)).status).to.equal(Status.Paused);

      await expect(aid.connect(donorA).fund(id, ngn(1))).to.be.revertedWithCustomError(aid, "NotActive");
      await expect(aid.connect(alice).claimStipend(id, aliceId)).to.be.revertedWithCustomError(aid, "NotActive");
      await expect(aid.connect(v1).confirmMilestone(id, aliceId, 0)).to.be.revertedWithCustomError(aid, "NotActive");
      await expect(aid.connect(v1).registerRecipient(id, ethers.id("c"), carol.address)).to.be.revertedWithCustomError(
        aid,
        "NotActive"
      );
      expect(await aid.claimableStipend(id, aliceId)).to.equal(0);

      await expect(aid.connect(organiser).unpause(id)).to.emit(aid, "CampaignUnpaused");
      await aid.connect(alice).claimStipend(id, aliceId);
      await aid.connect(v1).confirmMilestone(id, aliceId, 0);
      await aid.connect(v2).confirmMilestone(id, aliceId, 0);
      await expect(aid.connect(organiser).unpause(id)).to.be.revertedWithCustomError(aid, "NotPaused");
    });

    it("only the organiser can close early; anyone can close after the schedule ends", async function () {
      const { aid, id, outsider } = await loadFixture(readyFixture);
      await expect(aid.connect(outsider).closeCampaign(id)).to.be.revertedWithCustomError(aid, "CampaignNotEnded");
      await time.increaseTo((await aid.endTime(id)) + 1n);
      await expect(aid.connect(outsider).closeCampaign(id)).to.emit(aid, "CampaignClosed");
      await expect(aid.connect(outsider).closeCampaign(id)).to.be.revertedWithCustomError(aid, "AlreadyClosed");
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe("close & pro-rata refunds", function () {
    it("refunds unspent funds to donors pro-rata (exact math)", async function () {
      const { aid, token, id, organiser, donorA, donorB, v1, v2, alice, bob, aliceId, bobId } =
        await loadFixture(readyFixture);
      // spend ₦90k: 2 stipends (40k) + Alice's school fees (50k)
      await aid.connect(alice).claimStipend(id, aliceId);
      await aid.connect(bob).claimStipend(id, bobId);
      await aid.connect(v1).confirmMilestone(id, aliceId, 0);
      await aid.connect(v2).confirmMilestone(id, aliceId, 0);
      expect(await aid.remaining(id)).to.equal(ngn(210_000));

      await expect(aid.connect(organiser).closeCampaign(id))
        .to.emit(aid, "CampaignClosed")
        .withArgs(id, organiser.address, ngn(210_000));

      // A gave 200k of 300k (2/3) -> 140k ; B gave 100k (1/3) -> 70k
      expect(await aid.refundableAmount(id, donorA.address)).to.equal(ngn(140_000));
      expect(await aid.refundableAmount(id, donorB.address)).to.equal(ngn(70_000));

      const aBefore = await token.balanceOf(donorA.address);
      await expect(aid.connect(donorA).claimRefund(id)).to.emit(aid, "Refunded").withArgs(id, donorA.address, ngn(140_000));
      expect((await token.balanceOf(donorA.address)) - aBefore).to.equal(ngn(140_000));
      await aid.connect(donorB).claimRefund(id);

      const d = await aid.getDashboard(id);
      expect(d.status).to.equal(Status.Closed);
      expect(d.totalPaid).to.equal(ngn(90_000));
      expect(d.totalRefunded).to.equal(ngn(210_000));
      expect(d.balance).to.equal(0);
      expect(await token.balanceOf(await aid.getAddress())).to.equal(0);
    });

    it("ATTACK: no refund before close, no double refund, no refund for non-donors", async function () {
      const { aid, id, organiser, donorA, outsider } = await loadFixture(readyFixture);
      await expect(aid.connect(donorA).claimRefund(id)).to.be.revertedWithCustomError(aid, "NotClosed");
      await aid.connect(organiser).closeCampaign(id);
      await aid.connect(donorA).claimRefund(id);
      await expect(aid.connect(donorA).claimRefund(id)).to.be.revertedWithCustomError(aid, "AlreadyRefunded");
      await expect(aid.connect(outsider).claimRefund(id)).to.be.revertedWithCustomError(aid, "NothingToRefund");
    });

    it("after close nothing can be paid, funded or registered", async function () {
      const { aid, id, organiser, donorA, v1, alice, carol, aliceId } = await loadFixture(readyFixture);
      await aid.connect(organiser).closeCampaign(id);
      await expect(aid.connect(alice).claimStipend(id, aliceId)).to.be.revertedWithCustomError(aid, "NotActive");
      await expect(aid.connect(donorA).fund(id, ngn(1))).to.be.revertedWithCustomError(aid, "NotActive");
      await expect(aid.connect(v1).confirmMilestone(id, aliceId, 0)).to.be.revertedWithCustomError(aid, "NotActive");
      await expect(aid.connect(v1).registerRecipient(id, ethers.id("c"), carol.address)).to.be.revertedWithCustomError(
        aid,
        "NotActive"
      );
      await expect(aid.connect(organiser).addVerifier(id, carol.address)).to.be.revertedWithCustomError(aid, "AlreadyClosed");
    });

    it("campaigns are isolated: a campaign can't spend another campaign's funds", async function () {
      const { aid, token, organiser, donorA, donorB, v1, v2, alice, aliceId, params } = await loadFixture(deployFixture);
      const t = await token.getAddress();
      await aid.connect(organiser).createCampaign({ ...params, token: t }); // #2: tiny pool
      await aid.connect(organiser).addVerifier(2, v1.address);
      await aid.connect(organiser).addVerifier(2, v2.address);
      await aid.connect(donorA).fund(2, ngn(5_000));
      await aid.connect(donorB).fund(1, ngn(500_000)); // #1: big pool, same contract + token
      await aid.connect(v1).registerRecipient(2, aliceId, alice.address);
      await aid.connect(v2).registerRecipient(2, aliceId, alice.address);
      expect(await token.balanceOf(await aid.getAddress())).to.equal(ngn(505_000));
      await expect(aid.connect(alice).claimStipend(2, aliceId))
        .to.be.revertedWithCustomError(aid, "InsufficientFunds")
        .withArgs(ngn(5_000), STIPEND);
      await expect(aid.connect(alice).claimStipend(1, aliceId)).to.be.revertedWithCustomError(aid, "RecipientNotActive");
    });
  });

  describe("reentrancy", function () {
    it("ATTACK: a hostile token cannot re-enter claimStipend to double-pay", async function () {
      const [organiser, v1, v2, donor, alice] = await ethers.getSigners();
      const evil = await (await ethers.getContractFactory("ReentrantToken")).deploy();
      const aid = await (await ethers.getContractFactory("NairaAidCampaigns")).deploy();
      await aid.connect(organiser).createCampaign({
        token: await evil.getAddress(),
        name: "evil",
        metadataURI: "",
        startTime: 0n,
        periodDuration: BigInt(MONTH),
        numPeriods: 3,
        stipendPerPeriod: STIPEND,
        maxRecipients: 5,
        feeBps: 0,
        feeRecipient: ethers.ZeroAddress,
        milestoneAmounts: [],
        milestoneLabels: [],
      });
      await aid.connect(organiser).addVerifier(1, v1.address);
      await aid.connect(organiser).addVerifier(1, v2.address);
      await evil.mint(donor.address, ngn(100_000));
      await evil.connect(donor).approve(await aid.getAddress(), ethers.MaxUint256);
      await aid.connect(donor).fund(1, ngn(100_000));
      const rid = anonId("+2348030000009", "salt");
      await aid.connect(v1).registerRecipient(1, rid, alice.address);
      await aid.connect(v2).registerRecipient(1, rid, alice.address);

      await evil.arm(await aid.getAddress(), aid.interface.encodeFunctionData("claimStipend", [1, rid]));
      await aid.connect(alice).claimStipend(1, rid);
      expect(await evil.reentryAttempted()).to.equal(true);
      expect(await evil.reentrySucceeded()).to.equal(false);
      expect(await evil.balanceOf(alice.address)).to.equal(STIPEND);
      expect(await aid.totalPaid(1)).to.equal(STIPEND);
    });
  });

  describe("MockCNGN", function () {
    it("has 6 decimals and owner-only minting", async function () {
      const { token, outsider } = await loadFixture(deployFixture);
      expect(await token.decimals()).to.equal(6);
      expect(await token.symbol()).to.equal("cNGN");
      await expect(token.connect(outsider).mint(outsider.address, 1)).to.be.revertedWithCustomError(
        token,
        "OwnableUnauthorizedAccount"
      );
    });
  });
});
