/*
 * NairaAid demo - client-side simulation of the NairaAidCampaigns contract.
 * Everything runs in memory in the browser. No storage, no network, no wallet.
 * Amounts are whole naira (cNGN is 1:1 with the naira).
 */
(function (root) {
  "use strict";

  // ---------------------------------------------------------------------------
  // Campaign rules (fixed at creation, like createCampaign on-chain)
  // ---------------------------------------------------------------------------
  var RULES = {
    title: "Ilorin student support",
    subtitle: "School fees + monthly stipend for 5 students",
    goal: 500000,
    stipend: 20000,
    periods: 3,
    milestoneName: "School fees",
    milestoneAmount: 50000,
    feeBps: 200, // optional organiser fee: 2%, paid on top by the donor (capped at 3%)
    maxFeeBps: 300
  };

  var VERIFIERS = {
    A: { key: "A", name: "Verifier A", role: "Faculty officer" },
    B: { key: "B", name: "Verifier B", role: "Student union" }
  };

  var RECIPIENT_IDS = ["NA-7F3C", "NA-2B91", "NA-C4E8", "NA-91AD", "NA-5E06"];

  var DONOR_POOL = {
    bank: [
      "Alumni association (bank transfer)",
      "Church welfare fund (bank transfer)",
      "Ilorin cooperative (bank transfer)",
      "Mosque zakat fund (bank transfer)",
      "Local business (bank transfer)"
    ],
    diaspora: [
      "Diaspora donor, London (stablecoin)",
      "Diaspora donor, Houston (stablecoin)",
      "Diaspora donor, Toronto (stablecoin)",
      "Diaspora donor, Berlin (stablecoin)",
      "Diaspora donor, Dubai (stablecoin)"
    ]
  };

  // ---------------------------------------------------------------------------
  // Engine
  // ---------------------------------------------------------------------------
  function randomHex(len) {
    var out = "";
    var chars = "0123456789abcdef";
    var cryptoObj = (typeof root !== "undefined" && root.crypto && root.crypto.getRandomValues) ? root.crypto : null;
    if (cryptoObj) {
      var buf = new Uint8Array(len);
      cryptoObj.getRandomValues(buf);
      for (var i = 0; i < len; i++) out += chars[buf[i] % 16];
    } else {
      for (var j = 0; j < len; j++) out += chars[Math.floor(Math.random() * 16)];
    }
    return out;
  }

  function createState() {
    return {
      month: 1,
      raised: 0,
      feesCollected: 0,
      paid: 0,
      refunded: 0,
      closed: false,
      unspentAtClose: 0,
      donors: [],
      donorCounter: { bank: 0, diaspora: 0 },
      recipients: RECIPIENT_IDS.map(function (id) {
        return {
          id: id,
          attestedBy: [],
          verified: false,
          paidPeriods: [],
          milestoneConfirmedBy: [],
          milestonePaid: false,
          received: 0,
          wallet: 0,
          inbox: []
        };
      }),
      ledger: [],
      seq: 0
    };
  }

  function balance(s) {
    return s.raised - s.paid - s.refunded;
  }

  function findRecipient(s, id) {
    for (var i = 0; i < s.recipients.length; i++) {
      if (s.recipients[i].id === id) return s.recipients[i];
    }
    return null;
  }

  function log(s, entry) {
    s.seq += 1;
    var row = {
      n: s.seq,
      event: entry.event,
      who: entry.who || "-",
      amount: entry.amount || 0,
      direction: entry.direction || "none", // in | out | none
      note: entry.note || "",
      ok: entry.ok !== false,
      month: s.month,
      time: new Date(),
      tx: "0x" + randomHex(64)
    };
    s.ledger.push(row);
    return row;
  }

  function fail(s, event, who, msg) {
    log(s, { event: event, who: who, note: msg, ok: false });
    return { ok: false, msg: msg };
  }

  function feeFor(amount, withFee) {
    if (!withFee) return 0;
    var bps = Math.min(RULES.feeBps, RULES.maxFeeBps);
    return Math.floor((amount * bps) / 10000);
  }

  function donate(s, kind, amount, withFee) {
    amount = amount || 100000;
    var label = kind === "diaspora" ? "Diaspora gift" : "Bank on-ramp";
    if (s.closed) return { ok: false, msg: "Campaign is closed. Donations are no longer accepted." };
    if (s.raised >= RULES.goal) return { ok: false, msg: "Goal reached: this campaign is fully funded." };
    var pool = DONOR_POOL[kind] || DONOR_POOL.bank;
    var name = pool[s.donorCounter[kind] % pool.length];
    s.donorCounter[kind] += 1;
    var fee = feeFor(amount, withFee);
    var donor = { name: name, kind: kind, amount: amount, fee: fee, refund: 0 };
    s.donors.push(donor);
    s.raised += amount;
    s.feesCollected += fee;
    log(s, {
      event: "Donated",
      who: name,
      amount: amount,
      direction: "in",
      note: label + (fee ? " · +₦" + fmt(fee) + " organiser fee paid on top" : " · no fee")
    });
    return { ok: true, msg: name + " gave ₦" + fmt(amount) + (fee ? " (+₦" + fmt(fee) + " fee on top)" : "") + "." };
  }

  function attest(s, id, verifierKey) {
    var r = findRecipient(s, id);
    var v = VERIFIERS[verifierKey];
    if (!r || !v) return { ok: false, msg: "Unknown recipient or verifier." };
    if (s.closed) return { ok: false, msg: "Campaign is closed." };
    if (r.verified) return { ok: false, msg: id + " is already verified." };
    if (r.attestedBy.indexOf(verifierKey) !== -1) {
      return fail(s, "Attest rejected", id, "Blocked: needs a second, independent verifier");
    }
    r.attestedBy.push(verifierKey);
    log(s, { event: "RecipientAttested", who: id, note: v.name + " (" + v.role + ") attested · " + r.attestedBy.length + " of 2" });
    if (r.attestedBy.length >= 2) {
      r.verified = true;
      log(s, { event: "RecipientRegistered", who: id, note: "2 distinct verifiers agreed on the same ID and wallet" });
      return { ok: true, msg: id + " is verified by 2 independent verifiers." };
    }
    return { ok: true, msg: v.name + " attested " + id + ". Waiting for a second, independent verifier." };
  }

  function credit(r, amount, label, month) {
    r.received += amount;
    r.wallet += amount;
    r.inbox.unshift({ text: "You received ₦" + fmt(amount), sub: label + " · Month " + month });
  }

  function payStipend(s, id) {
    var r = findRecipient(s, id);
    if (!r) return { ok: false, msg: "Unknown recipient." };
    if (s.closed) return { ok: false, msg: "Campaign is closed." };
    if (!r.verified) return fail(s, "Stipend rejected", id, "Rejected: " + id + " is not verified yet");
    if (r.paidPeriods.indexOf(s.month) !== -1) return fail(s, "Stipend rejected", id, "Already paid this month");
    if (balance(s) < RULES.stipend) return fail(s, "Stipend rejected", id, "Rejected: not enough funds in the campaign pool");
    r.paidPeriods.push(s.month);
    s.paid += RULES.stipend;
    credit(r, RULES.stipend, "Monthly stipend", s.month);
    log(s, { event: "StipendClaimed", who: id, amount: RULES.stipend, direction: "out", note: "Month " + s.month + " stipend" });
    return { ok: true, msg: "Paid ₦" + fmt(RULES.stipend) + " stipend to " + id + " for month " + s.month + "." };
  }

  function payAllStipends(s) {
    var results = [];
    s.recipients.forEach(function (r) {
      if (r.verified) results.push(payStipend(s, r.id));
    });
    if (!results.length) return { ok: false, msg: "No verified recipients yet. Verify someone in Step 2 first." };
    var paid = results.filter(function (x) { return x.ok; }).length;
    var firstFail = results.filter(function (x) { return !x.ok; })[0];
    if (!paid) return { ok: false, msg: firstFail ? firstFail.msg : "Nothing to pay." };
    return { ok: true, msg: "Paid month " + s.month + " stipend to " + paid + " verified recipient" + (paid > 1 ? "s" : "") + "." + (firstFail ? " Some skipped: " + firstFail.msg + "." : "") };
  }

  function advanceMonth(s) {
    if (s.closed) return { ok: false, msg: "Campaign is closed." };
    if (s.month >= RULES.periods) return { ok: false, msg: "Schedule ended after month " + RULES.periods + ". Close the campaign to refund what's left." };
    s.month += 1;
    log(s, { event: "PeriodStarted", who: "Schedule", note: "Month " + s.month + " of " + RULES.periods + " opened" });
    return { ok: true, msg: "Month " + s.month + " has started. Each verified student can be paid once this month." };
  }

  function confirmMilestone(s, id, verifierKey) {
    var r = findRecipient(s, id);
    var v = VERIFIERS[verifierKey];
    if (!r || !v) return { ok: false, msg: "Unknown recipient or verifier." };
    if (s.closed) return { ok: false, msg: "Campaign is closed." };
    if (!r.verified) return fail(s, "Milestone rejected", id, "Rejected: " + id + " is not verified yet");
    if (r.milestonePaid) return { ok: false, msg: RULES.milestoneName + " already paid for " + id + "." };
    if (r.milestoneConfirmedBy.indexOf(verifierKey) !== -1) {
      return fail(s, "Milestone rejected", id, "Blocked: needs a second, independent verifier");
    }
    if (r.milestoneConfirmedBy.length === 1 && balance(s) < RULES.milestoneAmount) {
      return fail(s, "Milestone rejected", id, "Rejected: not enough funds in the campaign pool");
    }
    r.milestoneConfirmedBy.push(verifierKey);
    log(s, { event: "MilestoneConfirmed", who: id, note: v.name + " (" + v.role + ") saw the fee invoice · " + r.milestoneConfirmedBy.length + " of 2" });
    if (r.milestoneConfirmedBy.length >= 2) {
      r.milestonePaid = true;
      s.paid += RULES.milestoneAmount;
      credit(r, RULES.milestoneAmount, RULES.milestoneName + " milestone", s.month);
      log(s, { event: "Payout", who: id, amount: RULES.milestoneAmount, direction: "out", note: RULES.milestoneName + " milestone, confirmed by both verifiers" });
      return { ok: true, msg: "Both verifiers confirmed. ₦" + fmt(RULES.milestoneAmount) + " school fees paid to " + id + "." };
    }
    return { ok: true, msg: v.name + " confirmed the invoice for " + id + ". Needs the other verifier to release ₦" + fmt(RULES.milestoneAmount) + "." };
  }

  function organiserWithdraw(s) {
    return fail(s, "Withdraw attempt", "Organiser", "Rejected: no withdraw function exists — funds move only by campaign rules");
  }

  function closeCampaign(s) {
    if (s.closed) return { ok: false, msg: "Campaign is already closed." };
    s.closed = true;
    var unspent = balance(s);
    s.unspentAtClose = unspent;
    log(s, { event: "CampaignClosed", who: "Campaign", note: "Unspent ₦" + fmt(unspent) + " snapshotted for pro-rata refunds" });
    if (unspent <= 0 || s.raised <= 0) {
      return { ok: true, msg: "Campaign closed. Nothing left to refund." };
    }
    var total = 0;
    s.donors.forEach(function (d) {
      var share = Math.floor((d.amount * unspent) / s.raised);
      d.refund = share;
      if (share > 0) {
        total += share;
        log(s, { event: "Refunded", who: d.name, amount: share, direction: "out", note: "₦" + fmt(d.amount) + " × " + fmt(unspent) + " ÷ " + fmt(s.raised) });
      }
    });
    s.refunded += total;
    return { ok: true, msg: "Campaign closed. ₦" + fmt(total) + " refunded pro-rata to " + s.donors.length + " donor" + (s.donors.length === 1 ? "" : "s") + "." };
  }

  function cashOut(s, id, method) {
    var r = findRecipient(s, id);
    if (!r) return { ok: false, msg: "Unknown recipient." };
    if (r.wallet <= 0) return { ok: false, msg: "Wallet is empty." };
    var amount = r.wallet;
    r.wallet = 0;
    var label = method === "momo" ? "Cashed out to mobile money" : method === "spend" ? "Paid at campus bookshop" : "Cashed out to bank account";
    r.inbox.unshift({ text: label, sub: "₦" + fmt(amount) + " · off-ramp" });
    return { ok: true, msg: label + ": ₦" + fmt(amount) + "." };
  }

  function stats(s) {
    var verified = s.recipients.filter(function (r) { return r.verified; }).length;
    return {
      raised: s.raised,
      paid: s.paid,
      refunded: s.refunded,
      balance: balance(s),
      remaining: Math.max(0, RULES.goal - s.raised),
      verified: verified,
      donors: s.donors.length,
      fees: s.feesCollected,
      month: s.month
    };
  }

  function fmt(n) {
    return Number(n).toLocaleString("en-NG");
  }

  var Engine = {
    RULES: RULES,
    VERIFIERS: VERIFIERS,
    RECIPIENT_IDS: RECIPIENT_IDS,
    createState: createState,
    donate: donate,
    attest: attest,
    payStipend: payStipend,
    payAllStipends: payAllStipends,
    advanceMonth: advanceMonth,
    confirmMilestone: confirmMilestone,
    organiserWithdraw: organiserWithdraw,
    closeCampaign: closeCampaign,
    cashOut: cashOut,
    stats: stats,
    balance: balance,
    fmt: fmt
  };

  if (typeof module !== "undefined" && module.exports) module.exports = Engine;
  if (typeof root !== "undefined") root.NairaAidEngine = Engine;

  // ---------------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------------
  if (typeof document === "undefined") return;

  var state = createState();
  var phoneId = RECIPIENT_IDS[0];

  function $(sel) { return document.querySelector(sel); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function toast(target, res) {
    var box = typeof target === "string" ? $(target) : target;
    if (!box) return;
    box.textContent = res.msg;
    box.className = "feedback " + (res.ok ? "is-ok" : "is-bad");
  }

  function shortHash(h) { return h.slice(0, 8) + "…" + h.slice(-4); }
  function timeStr(d) {
    var hh = String(d.getHours()).padStart(2, "0");
    var mm = String(d.getMinutes()).padStart(2, "0");
    var ss = String(d.getSeconds()).padStart(2, "0");
    return hh + ":" + mm + ":" + ss;
  }

  function renderFund() {
    var st = stats(state);
    var pct = Math.min(100, Math.round((st.raised / RULES.goal) * 100));
    $("#fund-bar").style.width = pct + "%";
    $("#fund-bar").parentNode.setAttribute("aria-valuenow", String(pct));
    $("#fund-raised").textContent = "₦" + fmt(st.raised);
    $("#fund-pct").textContent = pct + "%";
    var list = $("#donor-list");
    list.innerHTML = "";
    if (!state.donors.length) {
      list.appendChild(el("li", "empty", "No donations yet. Be the first."));
    }
    state.donors.slice().reverse().forEach(function (d) {
      var li = el("li");
      var left = el("div");
      left.appendChild(el("strong", null, d.name));
      left.appendChild(el("span", "muted small", d.fee ? "+₦" + fmt(d.fee) + " organiser fee paid on top" : "No organiser fee"));
      li.appendChild(left);
      var right = el("div", "donor-amt");
      right.appendChild(el("strong", null, "₦" + fmt(d.amount)));
      if (d.refund) right.appendChild(el("span", "tag tag-refund", "Refunded ₦" + fmt(d.refund)));
      li.appendChild(right);
      list.appendChild(li);
    });
    var full = st.raised >= RULES.goal || state.closed;
    $("#btn-donate-bank").disabled = full;
    $("#btn-donate-diaspora").disabled = full;
    $("#fees-total").textContent = "₦" + fmt(st.fees);
  }

  function badge(r) {
    if (r.verified) return el("span", "tag tag-ok", "Verified");
    if (r.attestedBy.length === 1) return el("span", "tag tag-wait", "1 of 2");
    return el("span", "tag", "Pending");
  }

  function renderVerify() {
    var wrap = $("#verify-list");
    wrap.innerHTML = "";
    state.recipients.forEach(function (r) {
      var row = el("div", "rrow");
      var id = el("div", "rid");
      id.appendChild(el("code", null, r.id));
      id.appendChild(badge(r));
      row.appendChild(id);
      var who = el("div", "rattest muted small", r.attestedBy.length ? "Attested by: " + r.attestedBy.map(function (k) { return VERIFIERS[k].role; }).join(" + ") : "No attestations yet");
      row.appendChild(who);
      var actions = el("div", "ractions");
      ["A", "B"].forEach(function (k) {
        var b = el("button", "btn btn-sm " + (k === "A" ? "btn-ghost" : "btn-ghost-alt"), VERIFIERS[k].name + " · " + VERIFIERS[k].role);
        b.setAttribute("data-attest", r.id + ":" + k);
        b.disabled = r.verified || state.closed;
        actions.appendChild(b);
      });
      row.appendChild(actions);
      wrap.appendChild(row);
    });
  }

  function renderPayouts() {
    $("#month-label").textContent = "Month " + state.month + " of " + RULES.periods;
    var wrap = $("#payout-list");
    wrap.innerHTML = "";
    state.recipients.forEach(function (r) {
      var row = el("div", "rrow" + (r.verified ? "" : " is-dim"));
      var id = el("div", "rid");
      id.appendChild(el("code", null, r.id));
      id.appendChild(badge(r));
      row.appendChild(id);

      var info = el("div", "rattest small");
      var paidThis = r.paidPeriods.indexOf(state.month) !== -1;
      info.appendChild(el("span", paidThis ? "tag tag-ok" : "tag", paidThis ? "Stipend paid · M" + state.month : "Stipend due · M" + state.month));
      var ms = r.milestonePaid ? "Fees paid" : "Fees " + r.milestoneConfirmedBy.length + "/2";
      info.appendChild(el("span", r.milestonePaid ? "tag tag-ok" : (r.milestoneConfirmedBy.length ? "tag tag-wait" : "tag"), ms));
      info.appendChild(el("span", "muted", "Received ₦" + fmt(r.received)));
      row.appendChild(info);

      var actions = el("div", "ractions");
      var b1 = el("button", "btn btn-sm btn-primary", "Pay stipend ₦" + fmt(RULES.stipend));
      b1.setAttribute("data-stipend", r.id);
      b1.disabled = state.closed;
      actions.appendChild(b1);
      ["A", "B"].forEach(function (k) {
        var b = el("button", "btn btn-sm " + (k === "A" ? "btn-ghost" : "btn-ghost-alt"), "Fees ✓ " + VERIFIERS[k].role);
        b.setAttribute("data-milestone", r.id + ":" + k);
        b.disabled = state.closed || r.milestonePaid;
        actions.appendChild(b);
      });
      row.appendChild(actions);
      wrap.appendChild(row);
    });
    $("#btn-pay-all").disabled = state.closed;
    $("#btn-advance").disabled = state.closed;
    $("#btn-withdraw").disabled = false;
  }

  function renderLedger() {
    var st = stats(state);
    $("#stat-balance").textContent = "₦" + fmt(st.balance);
    $("#stat-paid").textContent = "₦" + fmt(st.paid);
    $("#stat-remaining").textContent = "₦" + fmt(st.remaining);
    $("#stat-refunded").textContent = "₦" + fmt(st.refunded);
    var body = $("#ledger-body");
    body.innerHTML = "";
    if (!state.ledger.length) {
      var tr0 = el("tr");
      var td0 = el("td", "empty", "No events yet. Every donation, verification and payout will appear here.");
      td0.colSpan = 6;
      tr0.appendChild(td0);
      body.appendChild(tr0);
    }
    state.ledger.slice().reverse().forEach(function (row) {
      var tr = el("tr", row.ok ? "" : "is-rejected");
      var tx = el("td", "mono");
      tx.textContent = shortHash(row.tx);
      tx.title = row.tx;
      tr.appendChild(tx);
      var ev = el("td");
      ev.appendChild(el("span", "ev " + (row.ok ? "ev-" + row.direction : "ev-bad"), row.event));
      if (row.note) ev.appendChild(el("div", "muted small", row.note));
      tr.appendChild(ev);
      tr.appendChild(el("td", "mono", row.who));
      var amt = el("td", "num " + (row.direction === "in" ? "pos" : row.direction === "out" ? "neg" : ""));
      amt.textContent = row.amount ? (row.direction === "in" ? "+" : "−") + "₦" + fmt(row.amount) : "–";
      tr.appendChild(amt);
      tr.appendChild(el("td", "small", "M" + row.month));
      tr.appendChild(el("td", "mono small", timeStr(row.time)));
      body.appendChild(tr);
    });
    $("#btn-close").disabled = state.closed;
    $("#campaign-status").textContent = state.closed ? "Closed" : "Active";
    $("#campaign-status").className = "tag " + (state.closed ? "tag-refund" : "tag-ok");
  }

  function renderPhone() {
    var sel = $("#phone-select");
    var current = sel.value || phoneId;
    sel.innerHTML = "";
    state.recipients.forEach(function (r) {
      var o = el("option", null, r.id + (r.verified ? "" : " (not verified)"));
      o.value = r.id;
      sel.appendChild(o);
    });
    sel.value = current;
    phoneId = sel.value;
    var r = findRecipient(state, phoneId);
    $("#phone-id").textContent = r.id;
    $("#phone-balance").textContent = "₦" + fmt(r.wallet);
    var latest = r.inbox.filter(function (m) { return m.text.indexOf("You received") === 0; })[0];
    var hero = $("#phone-alert");
    if (latest) {
      hero.classList.remove("is-empty");
      $("#phone-alert-title").textContent = latest.text;
      $("#phone-alert-sub").textContent = latest.sub + " · cNGN on Celo";
    } else {
      hero.classList.add("is-empty");
      $("#phone-alert-title").textContent = "No payments yet";
      $("#phone-alert-sub").textContent = r.verified ? "Pay a stipend in Step 3." : "Verify this ID in Step 2 first.";
    }
    var feed = $("#phone-feed");
    feed.innerHTML = "";
    r.inbox.slice(0, 5).forEach(function (m) {
      var li = el("li");
      li.appendChild(el("strong", null, m.text));
      li.appendChild(el("span", null, m.sub));
      feed.appendChild(li);
    });
    var empty = r.wallet <= 0;
    ["#ph-bank", "#ph-momo", "#ph-spend"].forEach(function (s) { $(s).disabled = empty; });
  }

  function renderHeroLive() {
    var st = stats(state);
    $("#live-pill").textContent = "Demo: ₦" + fmt(st.raised) + " raised · " + st.verified + "/5 verified · Month " + st.month;
  }

  function render() {
    renderFund();
    renderVerify();
    renderPayouts();
    renderLedger();
    renderPhone();
    renderHeroLive();
  }

  function bind() {
    $("#btn-donate-bank").addEventListener("click", function () {
      toast("#fund-feedback", donate(state, "bank", 100000, $("#fee-toggle").checked));
      render();
    });
    $("#btn-donate-diaspora").addEventListener("click", function () {
      toast("#fund-feedback", donate(state, "diaspora", 100000, $("#fee-toggle").checked));
      render();
    });
    $("#verify-list").addEventListener("click", function (e) {
      var b = e.target.closest("[data-attest]");
      if (!b) return;
      var p = b.getAttribute("data-attest").split(":");
      toast("#verify-feedback", attest(state, p[0], p[1]));
      render();
    });
    $("#btn-double").addEventListener("click", function () {
      // Find a recipient that Verifier A already attested but isn't verified, else attest one first.
      var target = state.recipients.filter(function (r) { return !r.verified; })[0];
      if (!target) { toast("#verify-feedback", { ok: false, msg: "Everyone is verified already. Reset the demo to try this." }); return; }
      if (target.attestedBy.indexOf("A") === -1 && target.attestedBy.length === 0) attest(state, target.id, "A");
      var key = target.attestedBy[0];
      toast("#verify-feedback", attest(state, target.id, key));
      render();
    });
    $("#payout-list").addEventListener("click", function (e) {
      var s = e.target.closest("[data-stipend]");
      var m = e.target.closest("[data-milestone]");
      if (s) {
        toast("#payout-feedback", payStipend(state, s.getAttribute("data-stipend")));
        phoneId = s.getAttribute("data-stipend");
        $("#phone-select").value = phoneId;
      } else if (m) {
        var p = m.getAttribute("data-milestone").split(":");
        toast("#payout-feedback", confirmMilestone(state, p[0], p[1]));
        phoneId = p[0];
        $("#phone-select").value = phoneId;
      } else return;
      render();
    });
    $("#btn-pay-all").addEventListener("click", function () {
      toast("#payout-feedback", payAllStipends(state));
      render();
    });
    $("#btn-advance").addEventListener("click", function () {
      toast("#payout-feedback", advanceMonth(state));
      render();
    });
    $("#btn-withdraw").addEventListener("click", function () {
      toast("#payout-feedback", organiserWithdraw(state));
      render();
    });
    $("#btn-close").addEventListener("click", function () {
      toast("#ledger-feedback", closeCampaign(state));
      render();
    });
    $("#phone-select").addEventListener("change", function () {
      phoneId = this.value;
      renderPhone();
    });
    [["#ph-bank", "bank"], ["#ph-momo", "momo"], ["#ph-spend", "spend"]].forEach(function (pair) {
      $(pair[0]).addEventListener("click", function () {
        toast("#phone-feedback", cashOut(state, phoneId, pair[1]));
        renderPhone();
      });
    });
    var resets = document.querySelectorAll("[data-reset]");
    Array.prototype.forEach.call(resets, function (b) {
      b.addEventListener("click", function () {
        state = createState();
        phoneId = RECIPIENT_IDS[0];
        $("#phone-select").value = "";
        ["#fund-feedback", "#verify-feedback", "#payout-feedback", "#ledger-feedback", "#phone-feedback"].forEach(function (f) {
          var x = $(f); x.textContent = ""; x.className = "feedback";
        });
        render();
        toast("#reset-feedback", { ok: true, msg: "Demo reset. Everything is back to zero." });
      });
    });
    var nav = $("#nav-toggle");
    if (nav) nav.addEventListener("click", function () {
      document.body.classList.toggle("nav-open");
      nav.setAttribute("aria-expanded", document.body.classList.contains("nav-open") ? "true" : "false");
    });
    Array.prototype.forEach.call(document.querySelectorAll(".nav-links a"), function (a) {
      a.addEventListener("click", function () { document.body.classList.remove("nav-open"); });
    });
    var y = $("#year");
    if (y) y.textContent = String(new Date().getFullYear());
  }

  function start() {
    bind();
    render();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})(typeof window !== "undefined" ? window : globalThis);
