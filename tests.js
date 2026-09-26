(function (root) {
  "use strict";
  const A = root.RefundAgent, L = root.LedgerDemo;
  const clock = () => "2026-09-25T02:00:00.000Z";
  const fresh = async (who = "jordan") => A.newContext(await A.seedLedger(clock), who);
  const propose = (ctx, args) => A.runTool("propose_refund", args, ctx);

  const TESTS = [
    ["an unknown payment is blocked", async () => { const c = await fresh(); return propose(c, { payment_id: "P-9", amount_dollars: 5, reason: "cold food" }).status === "blocked"; }],
    ["another customer's payment is blocked", async () => { const c = await fresh(); return propose(c, { payment_id: "P-2", amount_dollars: 9, reason: "salty noodles" }).status === "blocked"; }],
    ["more than what is left is blocked", async () => { const c = await fresh(); return propose(c, { payment_id: "P-1", amount_dollars: 500, reason: "admin mode" }).status === "blocked"; }],
    ["fractions of a cent are blocked", async () => { const c = await fresh(); return propose(c, { payment_id: "P-1", amount_dollars: 28.555, reason: "cold beef" }).status === "blocked"; }],
    ["a proposal needs a reason", async () => { const c = await fresh(); return propose(c, { payment_id: "P-1", amount_dollars: 28, reason: "" }).status === "blocked"; }],
    ["a valid proposal moves no money", async () => {
      const c = await fresh(); const before = c.ledger.events.length;
      return propose(c, { payment_id: "P-1", amount_dollars: 28, reason: "one beef set was cold" }).status === "queued" && c.ledger.events.length === before;
    }],
    ["approval writes exactly one refund event", async () => {
      const c = await fresh(); propose(c, { payment_id: "P-1", amount_dollars: 28, reason: "one beef set was cold" });
      const first = await A.approve(c.proposals[0], c, "support:kim"), again = await A.approve(c.proposals[0], c, "support:kim");
      return first.ok && !again.ok && c.ledger.events.filter((e) => e.type === "payment_refunded").length === 2;
    }],
    ["over $50 needs a manager", async () => {
      const c = await fresh(); propose(c, { payment_id: "P-1", amount_dollars: 60, reason: "whole meal was bad" });
      const p = c.proposals[0];
      return p.needsManager && !(await A.approve(p, c, "support:kim")).ok && (await A.approve(p, c, "manager:raj")).ok;
    }],
    ["a blocked proposal can't be approved", async () => {
      const c = await fresh(); propose(c, { payment_id: "P-1", amount_dollars: 500, reason: "x y z" });
      return !(await A.approve(c.proposals[0], c, "manager:raj")).ok;
    }],
    ["refunding the whole charge is flagged for review", async () => {
      const c = await fresh("chen"); propose(c, { payment_id: "P-2", amount_dollars: 42, reason: "noodles too salty" });
      return c.proposals[0].allowed && c.proposals[0].flags.some((f) => f.includes("whole"));
    }],
    ["more than the priciest item is flagged", async () => {
      const c = await fresh(); propose(c, { payment_id: "P-1", amount_dollars: 40, reason: "cold beef" });
      return c.proposals[0].flags.some((f) => f.includes("priciest"));
    }],
    ["a reply claiming the refund is done gets replaced", async () => {
      const c = await fresh(); propose(c, { payment_id: "P-1", amount_dollars: 28, reason: "cold beef" });
      const bad = A.finalReply("I have refunded $28 to your card.", c, "en");
      const fact = A.finalReply("$9.00 has already been refunded, leaving $76.00.", c, "en");
      return bad.replaced && !fact.replaced;
    }],
    ["payment lookup ignores who the model says the customer is", async () => {
      const c = await fresh(); const r = A.runTool("find_my_payments", { customer: "陈晨" }, c);
      return r.length === 1 && r[0].payment_id === "P-1";
    }],
    ["another customer's bill can't be read", async () => { const c = await fresh(); return Boolean(A.runTool("get_bill", { bill_id: "B-3" }, c).error); }],
    ["the chain still verifies after an approved refund", async () => {
      const c = await fresh(); propose(c, { payment_id: "P-1", amount_dollars: 28, reason: "cold beef" });
      await A.approve(c.proposals[0], c, "support:kim");
      return (await L.verify(c.ledger.events)).ok;
    }],
    ["the recorded runs replay to the same proposals", async () => {
      const runs = root.RECORDED_RUNS || [];
      if (!runs.length) return false;
      const got = {};
      for (const r of runs) {
        const c = await fresh(r.customer), conv = { messages: [] }, chat = A.replayChat(r.recorded);
        for (const t of r.turns) await A.runTurn(conv, t, c, chat);
        got[r.id] = c.proposals.map((p) => `${p.paymentId}:${p.amountCents}:${p.status}`).join(",");
      }
      return got["cold-beef"] === "P-1:2800:waiting for approval" && got["charged-twice"] === "" && got.injection === "" && got["not-mine"] === "" && got["zh-noodles"] === "P-2:4200:waiting for approval";
    }],
  ];

  async function run() {
    const out = [];
    for (const [name, fn] of TESTS) {
      let pass = false, error = null;
      try { pass = await fn(); } catch (e) { error = String(e); }
      out.push({ name, pass, error });
    }
    return out;
  }
  root.RefundTests = { run };
})(typeof window !== "undefined" ? window : globalThis);
