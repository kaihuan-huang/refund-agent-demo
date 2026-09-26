# Refund Agent Demo

**Live:** https://kaihuan-huang.github.io/refund-agent-demo/

An LLM agent that can look up payments and propose refunds, but can't move money. Every proposal passes fixed checks, a person approves it, and only then does the refund land in a hash-chained ledger. All data is synthetic.

- **Tools:** `find_my_payments` and `get_bill` are read-only; `propose_refund` only queues. Identity comes from the signed-in session, so the model can't look up or refund another customer's payment.
- **Checks on every proposal:** the payment exists and belongs to the customer, the amount is in whole cents and within what is still refundable, and there is a reason. Over $50 needs a manager. Review flags point the approver at odd amounts, such as refunding the whole charge for one item.
- **No false claims:** a reply that says the refund is done before anyone approved it is replaced by a fixed template.
- **Recorded runs** from qwen2.5:7b on Ollama replay in the page, including one where the model over-refunds and the approver has to catch it. With Ollama running locally, the page can talk to your own model instead.
- **Tests:** 16, including a replay of every recording.

## Run locally

```sh
python3 -m http.server 8000   # then open http://localhost:8000
node -e 'globalThis.window = globalThis; require("./ledger.js"); require("./agent.js"); require("./recorded.js"); require("./tests.js"); RefundTests.run().then(r => console.log(r.filter(x => x.pass).length + "/" + r.length))'
```
