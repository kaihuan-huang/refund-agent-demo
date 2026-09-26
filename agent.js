(function (root) {
  "use strict";
  const L = root.LedgerDemo;

  const MANAGER_OVER_CENTS = 5000;
  const money = L.money;

  // Synthetic customers. Identity comes from the signed-in session, never from what the model or the customer types.
  const CUSTOMERS = {
    jordan: { id: "jordan", name: "Jordan Lee", phone: "••0132", bills: ["B-1"] },
    chen: { id: "chen", name: "陈晨", phone: "••0199", bills: ["B-3"] },
  };

  async function seedLedger(clock) {
    const l = new L.Ledger(clock);
    await l.openBill("B-1", "T3", "cashier:amy");
    await l.addRound("B-1", [{ sku: "beef", qty: 2 }, { sku: "tea", qty: 2 }], "cashier:amy");
    await l.addRound("B-1", [{ sku: "noodles", qty: 1 }], "cashier:amy");
    await l.settle("B-1", { method: "card", tipCents: 1200, key: "till-7-0001" }, "cashier:amy");
    await l.refund("P-1", { amountCents: 900, reason: "noodles were cold", approvedBy: "manager:raj" }, "cashier:amy");
    await l.openBill("B-3", "T1", "cashier:amy");
    await l.addRound("B-3", [{ sku: "beef", qty: 1 }, { sku: "noodles", qty: 1 }], "cashier:amy");
    await l.settle("B-3", { method: "cash", tipCents: 500, key: "till-7-0002" }, "cashier:amy");
    return l;
  }

  const TOOLS = [
    { type: "function", function: { name: "find_my_payments", description: "List the signed-in customer's payments with what is still refundable.", parameters: { type: "object", properties: {} } } },
    { type: "function", function: { name: "get_bill", description: "Show the items on one of the signed-in customer's bills.", parameters: { type: "object", properties: { bill_id: { type: "string", description: "e.g. B-1" } }, required: ["bill_id"] } } },
    { type: "function", function: { name: "propose_refund", description: "Propose a refund for staff to approve. This does not move money.", parameters: { type: "object", properties: { payment_id: { type: "string" }, amount_dollars: { type: "number" }, reason: { type: "string" } }, required: ["payment_id", "amount_dollars", "reason"] } } },
  ];

  function systemPrompt(customer) {
    return [
      `You are a support agent for a restaurant. The signed-in customer is ${customer.name}.`,
      "Always call find_my_payments first; never ask the customer for payment details you can look up.",
      "For a complaint about specific items, call get_bill and propose only the price of those items. If a refund is justified, call propose_refund.",
      "You cannot move money. A proposal waits for a staff member to approve it; never say a refund is done.",
      "If there is nothing to refund, say so plainly. Reply in the customer's language.",
    ].join("\n");
  }

  function ownPayments(state, customer) {
    return Object.values(state.payments).filter((p) => customer.bills.includes(p.bill));
  }

  // ---- read-only tools ----
  function runTool(name, args, ctx) {
    const s = ctx.ledger.state();
    if (name === "find_my_payments") {
      return ownPayments(s, ctx.customer).map((p) => ({
        payment_id: p.id, bill_id: p.bill, method: p.method,
        charged: money(p.amountCents + p.tipCents), refunded: money(p.refundedCents), refundable: money(p.amountCents + p.tipCents - p.refundedCents),
      }));
    }
    if (name === "get_bill") {
      const b = s.bills[args.bill_id];
      if (!b || !ctx.customer.bills.includes(b.id)) return { error: "no such bill for this customer" };
      return { bill_id: b.id, items: b.rounds.flat().map((i) => ({ item: i.name, qty: i.qty, each: money(i.unitCents) })), total: money(b.totalCents) };
    }
    if (name === "propose_refund") {
      const proposal = { id: `R${ctx.proposals.length + 1}`, paymentId: String(args.payment_id || ""), amountDollars: args.amount_dollars, reason: String(args.reason || "") };
      const g = guard(proposal, ctx);
      proposal.checks = g.checks; proposal.flags = g.flags; proposal.allowed = g.allowed; proposal.amountCents = g.amountCents; proposal.needsManager = g.needsManager;
      proposal.status = g.allowed ? "waiting for approval" : "blocked";
      ctx.proposals.push(proposal);
      return g.allowed
        ? { status: "queued", proposal_id: proposal.id, note: `Waiting for ${g.needsManager ? "a manager" : "staff"} to approve. No money has moved.` }
        : { status: "blocked", reasons: g.checks.filter((c) => !c.ok).map((c) => c.name) };
    }
    return { error: `unknown tool ${name}` };
  }

  // ---- deterministic checks on every proposal ----
  function guard(p, ctx) {
    const s = ctx.ledger.state();
    const pay = s.payments[p.paymentId];
    const cents = Number.isFinite(p.amountDollars) ? Math.round(p.amountDollars * 100) : NaN;
    const remaining = pay ? pay.amountCents + pay.tipCents - pay.refundedCents : 0;
    const checks = [
      { name: "payment exists", ok: Boolean(pay) },
      { name: "payment belongs to the signed-in customer", ok: Boolean(pay) && ctx.customer.bills.includes(pay.bill) },
      { name: "amount is a positive number of cents", ok: Number.isFinite(cents) && cents > 0 && Math.abs(p.amountDollars * 100 - cents) < 1e-6 },
      { name: `amount is within what is still refundable${pay ? ` (${money(remaining)})` : ""}`, ok: Number.isFinite(cents) && cents <= remaining },
      { name: "a reason is given", ok: p.reason.trim().length >= 3 },
    ];
    const allowed = checks.every((c) => c.ok);
    // Review flags don't block; they tell the human approver where to look.
    const flags = [];
    if (pay && allowed) {
      const units = s.bills[pay.bill].rounds.flat().map((i) => i.unitCents);
      const top = Math.max(...units);
      if (cents === pay.amountCents + pay.tipCents || cents === remaining) flags.push(`amount is the whole ${cents === remaining && pay.refundedCents ? "remaining " : ""}charge`);
      else if (cents > top) flags.push(`amount is more than the priciest item on the bill (${money(top)})`);
      if (cents > MANAGER_OVER_CENTS) flags.push(`over ${money(MANAGER_OVER_CENTS)}: needs a manager`);
    }
    return { allowed, checks, flags, amountCents: cents, needsManager: allowed && cents > MANAGER_OVER_CENTS };
  }

  // A reply may not claim money moved when nothing has been approved yet.
  // Past refunds ("$9.00 has already been refunded") are facts; only claims that this request is done count.
  const OVERCLAIM = /\b(i|we)('ve| have)? (just )?(refunded|processed|issued|credited)\b|\byour refund (has been|is|was) (processed|issued|completed|approved|sent)\b|已(为您|给您)(退款|退回|退还)|退款(已|已经)(完成|到账|成功)/i;
  function finalReply(draft, ctx, lang) {
    const queued = ctx.proposals.filter((p) => p.allowed);
    if (!OVERCLAIM.test(draft || "")) return { text: draft, replaced: false };
    const text = lang === "zh"
      ? (queued.length ? `已提交退款申请（${queued.map((p) => money(p.amountCents)).join("、")}），等待工作人员审批，目前还没有退款。` : "目前没有可以处理的退款。")
      : (queued.length ? `I've sent a refund request for ${queued.map((p) => money(p.amountCents)).join(" and ")} to staff. Nothing has been refunded until they approve it.` : "There's nothing I can refund here.");
    return { text, replaced: true };
  }

  // ---- the agent loop; `chat` is any function that returns an Ollama-style assistant message ----
  // One customer turn. `conv.messages` carries the conversation across turns.
  async function runTurn(conv, message, ctx, chat, maxSteps = 5) {
    const lang = /[一-鿿]/.test(message) ? "zh" : "en";
    if (!conv.messages.length) conv.messages.push({ role: "system", content: systemPrompt(ctx.customer) });
    const messages = conv.messages;
    messages.push({ role: "user", content: message });
    const trace = [];
    for (let i = 0; i < maxSteps; i++) {
      const reply = await chat(messages, TOOLS);
      const calls = reply.tool_calls || [];
      messages.push({ role: "assistant", content: reply.content || "", tool_calls: calls.length ? calls : undefined });
      if (!calls.length) {
        const out = finalReply(reply.content, ctx, lang);
        trace.push({ kind: "reply", draft: reply.content, sent: out.text, replaced: out.replaced });
        return { trace, reply: out.text, proposals: ctx.proposals };
      }
      for (const c of calls) {
        const name = c.function.name;
        let args = c.function.arguments || {};
        if (typeof args === "string") { try { args = JSON.parse(args); } catch { args = {}; } }
        const result = runTool(name, args, ctx);
        trace.push({ kind: "tool", name, args, result });
        messages.push({ role: "tool", tool_name: name, content: JSON.stringify(result) });
      }
    }
    trace.push({ kind: "reply", draft: "", sent: lang === "zh" ? "抱歉，我需要请工作人员来处理。" : "Sorry, I'll pass this to a staff member.", replaced: true });
    return { trace, reply: trace[trace.length - 1].sent, proposals: ctx.proposals };
  }

  // ---- human approval is the only path to a ledger write ----
  async function approve(proposal, ctx, approver) {
    if (!proposal.allowed) return { ok: false, reason: "Blocked proposals can't be approved" };
    if (proposal.status === "refunded") return { ok: false, reason: "Already approved" };
    if (proposal.needsManager && !approver.startsWith("manager:")) return { ok: false, reason: `Refunds over ${money(MANAGER_OVER_CENTS)} need a manager` };
    const r = await ctx.ledger.refund(proposal.paymentId, { amountCents: proposal.amountCents, reason: proposal.reason, approvedBy: approver }, `agent-proposal:${proposal.id}`);
    if (!r.ok) return r;
    proposal.status = "refunded"; proposal.eventSeq = r.event.seq;
    return r;
  }

  function reject(proposal, approver) {
    if (proposal.status !== "waiting for approval") return { ok: false, reason: "Nothing to reject" };
    proposal.status = `rejected by ${approver}`;
    return { ok: true };
  }

  function ollamaChat(endpoint, model) {
    return async (messages, tools) => {
      const res = await fetch(`${endpoint.replace(/\/+$/, "")}/api/chat`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages, tools, stream: false, options: { temperature: 0 } }),
      });
      if (!res.ok) throw new Error(`Ollama answered ${res.status}`);
      return (await res.json()).message;
    };
  }

  // Replays a recorded run: returns the recorded model messages in order.
  function replayChat(recorded) {
    let i = 0;
    return async () => recorded[i++] || { content: "" };
  }

  async function runAgent(message, ctx, chat) { return runTurn({ messages: [] }, message, ctx, chat); }

  function newContext(ledger, customerId) { return { ledger, customer: CUSTOMERS[customerId], proposals: [] }; }

  root.RefundAgent = { CUSTOMERS, TOOLS, MANAGER_OVER_CENTS, seedLedger, runTool, guard, finalReply, runAgent, runTurn, approve, reject, ollamaChat, replayChat, newContext, systemPrompt };
})(typeof window !== "undefined" ? window : globalThis);
