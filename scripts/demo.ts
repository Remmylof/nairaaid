import { ethers, network } from "hardhat";
import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";

/**
 * End-to-end NairaAid demo on the local Hardhat network:
 * a flood-relief campaign for 5 university students in Ilorin, Kwara State.
 *
 *   npm run demo
 *
 * All names, phone numbers and wallets below are fictional.
 */

const DAY = 24 * 3600;
const MONTH = 30 * DAY;
const ngn = (n: number) => ethers.parseUnits(n.toString(), 6);
const fmt = (v: bigint) => `₦${Number(ethers.formatUnits(v, 6)).toLocaleString("en-NG", { maximumFractionDigits: 2 })}`;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const line = (t = "") => console.log(t);
const header = (t: string) => {
  line();
  line("═".repeat(78));
  line(`  ${t}`);
  line("═".repeat(78));
};

async function expectRevert(label: string, p: Promise<unknown>, iface: any) {
  try {
    await p;
    throw new Error(`UNEXPECTED SUCCESS: ${label}`);
  } catch (e: any) {
    if (String(e.message).startsWith("UNEXPECTED SUCCESS")) throw e;
    let name = e?.revert?.name;
    if (!name && e?.data) {
      try {
        name = iface.parseError(e.data)?.name;
      } catch {
        /* ignore */
      }
    }
    line(`   🛡️  BLOCKED  ${label}  →  reverted with ${name ?? e.shortMessage ?? e.message}`);
  }
}

async function main() {
  if (network.name !== "hardhat") {
    throw new Error("demo.ts fast-forwards time and mints test tokens; run it on the local hardhat network only.");
  }

  const [organiser, platform, diaspora, church, alumni, vLecturer, vUnion, vImam, ...rest] = await ethers.getSigners();
  const studentWallets = rest.slice(0, 5);
  const ghostWallet = rest[5];

  header("NairaAid demo · Ilorin Flood Relief for Students (cNGN on a local Celo-compatible chain)");

  // ── 1. Deploy ──────────────────────────────────────────────────────────────────────────────
  const token = await (await ethers.getContractFactory("MockCNGN")).deploy(organiser.address);
  const aid = await (await ethers.getContractFactory("NairaAidCampaigns")).deploy();
  const aidAddr = await aid.getAddress();
  line(`1. Deployed MockCNGN (6 decimals) at ${short(await token.getAddress())}, NairaAidCampaigns at ${short(aidAddr)}`);

  // ── 2. Campaign ────────────────────────────────────────────────────────────────────────────
  const tx = await aid.connect(organiser).createCampaign({
    token: await token.getAddress(),
    name: "Ilorin Flood Relief - Students",
    metadataURI: "ipfs://bafy-demo/ilorin-flood-relief-eligibility.json",
    startTime: 0n,
    periodDuration: BigInt(MONTH),
    numPeriods: 2,
    stipendPerPeriod: ngn(20_000),
    maxRecipients: 5,
    feeBps: 100, // 1% platform fee, paid by donors on top
    feeRecipient: platform.address,
    milestoneAmounts: [ngn(50_000)],
    milestoneLabels: ["School fees 2026/27 session"],
  });
  await tx.wait();
  const id = 1n;
  line("2. Organiser (student-union relief committee) created campaign #1:");
  line("     rules: ₦20,000/month stipend × 2 months · milestone 'School fees 2026/27' ₦50,000");
  line("     max 5 recipients · 1% platform fee paid by donors (never deducted from students)");

  // ── 3. Verifiers ───────────────────────────────────────────────────────────────────────────
  const verifiers = [
    ["Dr. Adeyemi (faculty lecturer)", vLecturer],
    ["SU welfare officer", vUnion],
    ["Imam / community NGO agent", vImam],
  ] as const;
  for (const [, v] of verifiers) await aid.connect(organiser).addVerifier(id, v.address);
  line(`3. Added ${verifiers.length} independent local verifiers: ${verifiers.map(([n]) => n).join(", ")}`);
  await expectRevert("organiser adds themselves as a verifier", aid.connect(organiser).addVerifier(id, organiser.address), aid.interface);

  // ── 4. Donations ───────────────────────────────────────────────────────────────────────────
  header("Donations");
  const donors = [
    ["Diaspora donor (London)", diaspora, 250_000],
    ["Church welfare fund (Ilorin)", church, 150_000],
    ["Alumni association", alumni, 100_000],
  ] as const;
  for (const [name, d, amt] of donors) {
    await token.mint(d.address, ngn(amt * 1.01));
    await token.connect(d).approve(aidAddr, ethers.MaxUint256);
    await aid.connect(d).fund(id, ngn(amt));
    line(`   💚 ${name.padEnd(30)} donated ${fmt(ngn(amt)).padStart(10)}  (+ ${fmt(ngn(amt / 100))} platform fee)`);
  }
  let dash = await aid.getDashboard(id);
  line(`   Pool: ${fmt(dash.totalRaised)} from ${dash.donorCount} donors · fees to platform: ${fmt(dash.totalFees)}`);

  // ── 5. Recipients ──────────────────────────────────────────────────────────────────────────
  header("Recipient registration (2 distinct verifiers each, anonymous IDs only)");
  const students = studentWallets.map((w, i) => {
    const phone = `+23480300000${(i + 1).toString().padStart(2, "0")}`; // fictional
    const salt = ethers.id(`demo-salt-${i + 1}`); // in production: 32 random bytes, kept off-chain by the verifier app
    const anonId = ethers.solidityPackedKeccak256(["string", "bytes32"], [phone, salt]);
    return { label: `Student ${i + 1}`, wallet: w, anonId };
  });

  // a lone verifier tries to slip in a ghost recipient
  const ghostId = ethers.solidityPackedKeccak256(["string", "bytes32"], ["+2348099999999", ethers.id("ghost-salt")]);
  await aid.connect(vLecturer).registerRecipient(id, ghostId, ghostWallet.address);
  line(`   ⚠️  Lecturer attested a 'ghost' recipient ${ghostId.slice(0, 12)}… alone (1/2 attestations)`);
  await expectRevert("same verifier attests the ghost a 2nd time", aid.connect(vLecturer).registerRecipient(id, ghostId, ghostWallet.address), aid.interface);
  await expectRevert("ghost tries to claim a stipend while pending", aid.connect(ghostWallet).claimStipend(id, ghostId), aid.interface);

  for (const [i, s] of students.entries()) {
    const a = verifiers[i % 3];
    const b = verifiers[(i + 1) % 3];
    await aid.connect(a[1]).registerRecipient(id, s.anonId, s.wallet.address);
    await aid.connect(b[1]).registerRecipient(id, s.anonId, s.wallet.address);
    line(`   ✅ ${s.label}  id=${s.anonId.slice(0, 14)}…  wallet=${short(s.wallet.address)}  attested by ${a[0].split(" (")[0]} + ${b[0].split(" (")[0]}`);
  }
  line(`   Active recipients: ${await aid.recipientCount(id)} (ghost still pending: ${(await aid.getRecipient(id, ghostId)).active ? "no" : "yes"})`);
  line("   On-chain: only keccak256(phone ‖ salt) + wallet. Names, phone numbers, IDs, flood-damage photos stay off-chain.");

  // ── 6. Month 1 stipend ─────────────────────────────────────────────────────────────────────
  header("Month 1 · stipend");
  for (const s of students) {
    await aid.connect(s.wallet).claimStipend(id, s.anonId);
  }
  line(`   💸 5 students each claimed ${fmt(ngn(20_000))} → ${fmt(ngn(100_000))} paid`);
  await expectRevert("Student 1 claims month 1 again (double claim)", aid.connect(students[0].wallet).claimStipend(id, students[0].anonId), aid.interface);

  // ── 7. Milestone ───────────────────────────────────────────────────────────────────────────
  header("Milestone · School fees 2026/27 (needs 2 verifier confirmations)");
  for (const s of students.slice(0, 4)) {
    await aid.connect(vLecturer).confirmMilestone(id, s.anonId, 0);
    await aid.connect(vUnion).confirmMilestone(id, s.anonId, 0);
    line(`   🎓 ${s.label}: fee invoice checked by Lecturer + SU officer → ${fmt(ngn(50_000))} paid`);
  }
  const s5 = students[4];
  await aid.connect(vImam).confirmMilestone(id, s5.anonId, 0);
  line(`   ⚠️  ${s5.label}: only the NGO agent has confirmed (1/2), invoice not yet seen by a second verifier`);
  await expectRevert(
    `COLLUSION: NGO agent confirms ${s5.label}'s school fees a 2nd time`,
    aid.connect(vImam).confirmMilestone(id, s5.anonId, 0),
    aid.interface
  );
  await expectRevert(`organiser tries to confirm ${s5.label}'s milestone`, aid.connect(organiser).confirmMilestone(id, s5.anonId, 0), aid.interface);
  const [c5, p5] = await aid.milestoneStatus(id, s5.anonId, 0);
  line(`   ${s5.label} milestone: ${c5}/2 confirmations, paid=${p5}`);

  // ── 8. Month 2 ─────────────────────────────────────────────────────────────────────────────
  header("Month 2 · stipend");
  await time.increase(MONTH);
  for (const s of students) await aid.connect(s.wallet).claimStipend(id, s.anonId);
  line(`   💸 5 students each claimed ${fmt(ngn(20_000))} → ${fmt(ngn(100_000))} paid`);

  // ── 9. Organiser drain attempts ────────────────────────────────────────────────────────────
  header("Organiser drain attempts");
  const hasWithdraw = aid.interface.fragments.some((f: any) => f.type === "function" && /withdraw|sweep|rescue/i.test(f.name));
  line(`   ABI has a withdraw/sweep/rescue function? ${hasWithdraw ? "YES (bug!)" : "no"}`);
  await expectRevert(
    "verifier registers the organiser's wallet as a recipient",
    aid.connect(vUnion).registerRecipient(id, ethers.id("organiser-sock-puppet"), organiser.address),
    aid.interface
  );

  // ── 10. Close + refunds ────────────────────────────────────────────────────────────────────
  header("Campaign end · close · pro-rata refunds");
  await time.increaseTo((await aid.endTime(id)) + 1n);
  await aid.connect(diaspora).closeCampaign(id); // anyone may close after the schedule ends
  const camp = await aid.getCampaign(id);
  line(`   🔒 Campaign closed by a donor after the schedule ended. Unspent pool: ${fmt(camp.refundPool)}`);
  await expectRevert("Student 2 tries to claim after close", aid.connect(students[1].wallet).claimStipend(id, students[1].anonId), aid.interface);
  await expectRevert("organiser claims a refund without having donated", aid.connect(organiser).claimRefund(id), aid.interface);

  for (const [name, d, amt] of donors) {
    const due = await aid.refundableAmount(id, d.address);
    await aid.connect(d).claimRefund(id);
    line(`   ↩️  ${name.padEnd(30)} gave ${fmt(ngn(amt)).padStart(10)} → refunded ${fmt(due).padStart(9)} (${((amt / 500_000) * 100).toFixed(0)}%)`);
  }

  // ── 11. Dashboard ──────────────────────────────────────────────────────────────────────────
  header("Public dashboard (all values read from chain)");
  dash = await aid.getDashboard(id);
  line(`   Status:           ${["None", "Active", "Paused", "Closed"][Number(dash.status)]}`);
  line(`   Raised:           ${fmt(dash.totalRaised)}`);
  line(`   Paid to students: ${fmt(dash.totalPaid)}`);
  line(`   Refunded donors:  ${fmt(dash.totalRefunded)}`);
  line(`   Platform fees:    ${fmt(dash.totalFees)} (paid by donors on top)`);
  line(`   Balance left:     ${fmt(dash.balance)}`);
  line(`   Recipients:       ${dash.recipientCount} · Donors: ${dash.donorCount} · Verifiers: ${dash.verifierCount}`);
  line(`   Organiser cNGN balance: ${fmt(await token.balanceOf(organiser.address))}`);
  line();
  line("   Per-student totals:");
  for (const s of students) {
    const r = await aid.getRecipient(id, s.anonId);
    line(`     ${s.label}  ${s.anonId.slice(0, 14)}…  received ${fmt(r.totalReceived).padStart(9)}  (wallet balance ${fmt(await token.balanceOf(s.wallet.address))})`);
  }

  // ── 12. Payout trail ───────────────────────────────────────────────────────────────────────
  header("Payout trail (Payout events, anyone can replay these)");
  const events = await aid.queryFilter(aid.filters.Payout(id));
  for (const ev of events) {
    const { anonId, wallet, kind, ref, amount } = ev.args;
    const what = Number(kind) === 0 ? `stipend from period ${Number(ref) + 1}` : `milestone #${ref} (school fees)`;
    line(`   block ${String(ev.blockNumber).padStart(3)}  ${anonId.slice(0, 12)}…  → ${short(wallet)}  ${fmt(amount).padStart(8)}  ${what}`);
  }
  line(`   ${events.length} payouts, total ${fmt(events.reduce((a, e) => a + e.args.amount, 0n))}`);

  const ok = dash.totalPaid === ngn(400_000) && dash.totalRefunded === ngn(100_000) && dash.balance === 0n;
  line();
  line(ok ? "✅ Demo complete: every naira is accounted for (₦400,000 paid + ₦100,000 refunded = ₦500,000)." : "❌ Accounting mismatch!");
  if (!ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
