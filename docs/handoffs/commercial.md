# Handoff: commercial design and billing

**Status: no pricing decision, commercial validation, billing integration, or
paid customer evidence exists.** Product segments and amounts must remain
hypotheses until measured with real design partners. This work is parallel
design, not permission to publish prices or charge customers.

## Research sequence

1. After the user authorizes outreach, interview a small set of voluntary
   studios/teams about their current Web3D/WebAR release QA workflow, failure
   cost, frequency, target coverage, evidence/report needs, security review,
   and willingness to pay. Record consent, date, role, question, actual
   response, and sample size. Do not invent quotes or say Flam/customers use
   Atlas.
2. Compare configurable pricing hypotheses: per-certification run,
   monthly project/team plan, and real-device-minute add-on. Do not present
   illustrative example dollars as approved or market-validated prices.
3. Build a worksheet from measured full cost: worker compute, database,
   object storage and egress, device-farm minutes, optional Jev calls, support,
   payment/tax costs, failed/inconclusive reruns, retention, and margin
   sensitivity. Track cost per successful and failed run, not just average CPU
   time.
4. Define policy options for trial quota, fair use, overages, failed or
   inconclusive credits, cancellation, refunds, seats, storage/retention, and
   upgrades/downgrades. Obtain qualified tax/legal review for markets in scope.
5. Present the actual offer for explicit user approval: plan names, currency,
   prices, taxes, trial/quotas, overage, cancellation, refund, retention and
   checkout language. Do not publish or charge before approval.

## Sandbox billing implementation (only after requirements review)

Select a provider after comparing requirements; do not create an account yet.
When authorized, implement isolated sandbox/live credentials and product IDs,
hosted checkout, signed idempotent webhook handling, subscriptions/trials,
receipts, payment failures, proration/downgrade, cancellation, refunds and
server-side entitlement reconciliation. Never store card data. Audit every
entitlement transition. Test duplicate, delayed, replayed, and out-of-order
events, retry behavior, failure, refund and expiry. Live mode must default off.

## Current repository state

- No billing package, provider, merchant account, product/price IDs, checkout,
  entitlement table, payment webhook, subscription, or paid customer is
  implemented.
- `apps/control-plane` has no billing entitlements despite the initial schema
  having organizations/projects/runs. Do not infer billing from run quotas.
- There is no measured run cost or demand data. Phase 2 workers/storage are not
  implemented, so a cost worksheet now can only be a template with explicitly
  empty or hypothetical inputs.

## Acceptance and user decisions

Before sandbox implementation: requirements and provider selection. Before live
mode: the user explicitly approves the final offer, currency/prices, tax and
refund terms, merchant account, and checkout flow. No live charges without all
of those decisions. Commercial success claims require actual interview/trial
observations with sample sizes; brainstorming is not evidence.
