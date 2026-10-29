# Duo: project plan

Duo is a proactive personal agent. Instead of waiting for a prompt, it stays on,
watches the world on your behalf, notices things you would care about, does the
legwork, and brings you a ready-to-approve proposal. It only takes real-world
actions (spending money, sending messages) after you explicitly say yes.

The cricket example, end to end:

1. Duo knows you follow a team and roughly what you can spend on a night out.
2. A scheduled "patrol" notices an international fixture next week.
3. Duo checks the ticket sites, finds affordable seats in a shaded spot, and
   captures the evidence (URLs, prices, seat sections, a screenshot).
4. You get a notification with a proposal card: the seats, the price, why Duo
   picked them, and an Approve / Decline button.
5. You approve. Duo buys the tickets, confirms, and remembers the outcome.

This document breaks that into an architecture, a tech stack, and a phased
build order so you can start on something small today.

---

## 1. The core idea: a loop, not a chatbot

Most agents are request/response. Duo is a loop with six stages:

```
 Signals ──► Triggers ──► Investigation ──► Proposal ──► Permission ──► Action
   ▲                                                                       │
   └──────────────────── Memory (what happened, what you said) ◄───────────┘
```

| Stage | What it means | Who does it |
|---|---|---|
| Signals | Raw facts arriving from the outside world: a fixture list, a calendar, a price feed, an email. | Plain code. Cheap. Runs often. |
| Triggers | "Is any of this relevant to this person, given their profile?" | A cheap, fast model call (Claude Haiku 5.5). |
| Investigation | Dig in: search, fetch pages, compare options, gather evidence. | The capable model (Claude Opus 5.5) running an agent loop with tools. |
| Proposal | A structured recommendation with evidence and a concrete action. | Model output, validated against a schema, stored in the DB. |
| Permission | You see the proposal in the interface and approve, decline, or edit. | Human. Always. |
| Action | Execute the approved action and report back. | Dedicated, gated tools. |

Keeping these stages separate is the single most important design decision.
It makes the system cheap (most cycles stop at Triggers), safe (Action is
behind a hard permission gate, not a prompt instruction), and debuggable (you
can inspect each stage's output).

---

## 2. The pieces

### 2.1 User profile ("what Duo knows about you")

A small, editable document. Start as a YAML or JSON file, move to the DB later.

```yaml
name: Tricia
location: { city: "...", timezone: "..." }
interests:
  - kind: sports_team
    sport: cricket
    team: "..."
    priority: high
budgets:
  event_ticket: { max_per_ticket: 120, currency: USD }
preferences:
  seating: ["shade", "aisle"]
  companions: 1          # how many tickets to buy by default
rules:
  - "Never spend money without asking."
  - "Don't bother me about weekday afternoon events."
```

This is injected into every model call as the stable system prompt prefix so
prompt caching makes it nearly free.

### 2.2 Signal collectors

Each collector is a small function: fetch something, normalize it into a
`Signal` row, dedupe, store. No AI here. Examples, in rough build order:

- Sports fixtures for your teams (any public cricket fixtures API or a scrape).
- Your calendar (free/busy, so Duo does not propose things you cannot attend).
- A generic web-search collector that Duo itself can schedule ("search for X
  every Tuesday").
- Email (later; most interesting signals live here but it is the hardest to
  do safely).

Signals are stored with a `fingerprint` so the same fixture seen on ten patrols
only creates one trigger.

### 2.3 The patrol (scheduler)

A cron job, say every two hours, that:

1. Runs all collectors.
2. Hands new signals plus the profile to the Trigger step.
3. For each trigger that fires, starts an Investigation run.

Two ways to host this. Recommendation for v1 is the first.

| Option | Pros | Cons |
|---|---|---|
| Self-hosted loop (Node process + cron + Anthropic SDK tool runner) | Full control over the UI, the permission gate, and where secrets live. Cheapest to start. | You run the process. |
| Anthropic Managed Agents scheduled deployments | No scheduler or loop code. Anthropic hosts the sandbox and the cron. Built-in `always_ask` tool approval. | Your UI still has to answer approvals through webhooks. Beta. Less control over the purchase flow. |

Start self-hosted. The code is small, and you can move the Investigation step
onto Managed Agents later without changing the rest.

### 2.4 Investigation runs (the agent part)

This is the only part that is a "real" agent. One run per trigger. Built on the
Anthropic SDK tool runner (`client.beta.messages.toolRunner` in TypeScript),
which drives the request → tool → response loop for you.

Tools available to an investigation:

- `web_search` and `web_fetch` (Anthropic server-side tools, no code to write).
- `get_profile`, `get_calendar_availability` (read-only, yours).
- `remember(note)` and `recall(query)` (memory, yours).
- `file_proposal(proposal)` (the only "output" tool; validated with a strict
  JSON schema).

What an investigation deliberately cannot do: buy anything, send anything,
or touch a browser. Those tools do not exist in this run. That is the
permission boundary, enforced by the tool list rather than by asking nicely.

Model settings: `claude-opus-5-5`, adaptive thinking (default), effort
`high`, streaming, a `task_budget` so a run paces itself and never runs away.

### 2.5 Proposals

A proposal is a row in the DB, not a chat message:

```ts
{
  id, triggerId, createdAt,
  title: "Tickets: <team> vs <opponent>, Sat 7 Nov",
  summary: "2 seats, Section 214 (shaded, aisle), $84 each...",
  evidence: [{ url, quote, screenshotPath? }],
  action: {
    kind: "purchase_tickets",
    params: { url, section, quantity: 2, maxTotal: 170 }
  },
  confidence: 0.8,
  expiresAt,                // tickets sell out; proposals go stale
  status: "pending" | "approved" | "declined" | "executed" | "failed" | "expired"
}
```

The `action` is a typed command, not free text. The Action stage only knows
how to run a fixed set of action kinds. If Claude proposes something there is
no executor for, the proposal is shown as information only.

### 2.6 Interface and notifications

v1 is a small local web app (one page):

- Inbox of proposals, newest first, with Approve / Decline / "Tell me more".
- A chat box, so you can also talk to Duo on demand (this reuses the same
  investigation machinery with a prompt instead of a trigger).
- A profile editor.
- A log view: every patrol, trigger decision, run, and action, with cost.

Notifications: start with desktop notifications from the local app, or a
push to your phone via a hosted push service, or a Telegram bot message
(simplest cross-device option, and the Approve button can be an inline
keyboard). Add email as a fallback.

### 2.7 Action executors

One small module per action kind. Each executor:

1. Re-checks that the proposal is `approved` and not expired.
2. Re-verifies the world (is the price still $84? still available?). If
   anything differs from the approved proposal beyond a tolerance you set,
   it stops and asks again rather than proceeding.
3. Performs the action.
4. Records the result and notifies you.

For ticket purchasing specifically, see the risk section. Build the
executors in this order:

1. `open_checkout`: open the browser on the right page with the right seats
   selected, and you finish the purchase. Trivial to build, nearly all the
   value.
2. `purchase_tickets` with a browser automation (Playwright) against a site
   you have tested, with a hard spending cap, only after step 1 works.

### 2.8 Memory

Three kinds, all simple:

- Signal fingerprints (so the same fact does not re-trigger).
- Proposal history with your decisions (so a declined idea is not re-proposed,
  and so Duo can learn "they always decline weekday games").
- Free-form notes Claude writes via the `remember` tool, retrieved via
  `recall` and included in the investigation prompt. Start with a notes table
  and plain text search; add embeddings only if you outgrow it.

---

## 3. Recommended stack

| Concern | Choice | Why |
|---|---|---|
| Language | TypeScript on Node 22 | One language for the agent, the API, and the web UI. The Anthropic SDK's tool runner and Zod tool helpers are first-class here. |
| Package layout | Single repo, `packages/core`, `packages/web`, `packages/collectors` | Keeps the agent logic testable without the UI. Can flatten to one package if it feels heavy. |
| Model access | `@anthropic-ai/sdk`, `claude-opus-5-5` for investigation, `claude-haiku-5-5` for triage | See cost section. |
| Database | SQLite via `better-sqlite3` or Drizzle ORM | Zero ops, one file, easy to inspect. |
| Scheduler | `node-cron` or `croner` inside the main process | Good enough until you want it to survive restarts; then systemd or a tiny Docker container. |
| Web UI | A small React or Svelte app, or even server-rendered HTML with htmx | It is an inbox with three buttons. Do not over-build it. |
| Browser automation | Playwright | Only for the `open_checkout` and later purchase executors. |
| Secrets | `.env` locally; never in the DB, never in prompts | Payment details in particular stay in the executor, never in model context. |
| Observability | Log every model call with tokens and cost to a `runs` table | You will want to know what each patrol costs by week two. |

Repo layout to aim for:

```
duo/
  packages/
    core/        # profile, signals, triggers, investigation, proposals, memory, executors
    collectors/  # one file per signal source
    web/         # the inbox UI + a thin API over core
  data/          # duo.sqlite (gitignored)
  profile.yaml
  .env           # ANTHROPIC_API_KEY etc. (gitignored)
```

---

## 4. Build order

Each phase ends with something you can actually run. Resist starting phase N+1
before phase N is boring.

### Phase 0: one patrol, by hand (weekend one)

Goal: prove the Investigation step works for the cricket case.

- `profile.yaml` with your team and budget.
- A single script `patrol.ts` that calls Claude with the profile, the
  `web_search` and `web_fetch` tools, and a `file_proposal` tool, and prints
  the proposal as JSON.
- No DB, no scheduler, no UI. Run it manually, read the output, tune the
  prompt until the proposals are good and grounded in real URLs.

You will learn more from ten manual runs than from any amount of architecture.

### Phase 1: the loop (weekend two to three)

- SQLite with `signals`, `triggers`, `runs`, `proposals`, `memory` tables.
- One real collector (fixtures) and the generic web-search collector.
- The Trigger step on Haiku: given new signals and the profile, return a
  structured list of `{signalId, shouldInvestigate, reason}`.
- Cron every N hours. Dedupe via fingerprints so you stop getting the same
  proposal repeatedly.
- Notifications via Telegram or desktop. Approve / Decline by replying.

At the end of this phase Duo is genuinely proactive, just without a UI.

### Phase 2: the interface

- Web inbox with proposals, evidence, and the three buttons.
- Chat box that runs an on-demand investigation.
- Profile editor and run log with cost per run.

### Phase 3: actions, safely

- `open_checkout` executor first.
- The re-verify-then-act pattern.
- Only then a real purchase executor, scoped to one ticket site you have
  tested, with a hard cap read from the profile and a kill switch in the UI.

### Phase 4: more of the world

- Calendar integration (do not propose things you cannot attend).
- Email signals (flights, deliveries, bills) with a strict read-only tool.
- More action kinds: "add to calendar", "draft a reply", "set a price alert".
- Learning from decisions: a weekly job that summarizes your approve/decline
  history into the profile's `rules`.

---

## 5. Hard problems and how to handle them

**Buying tickets automatically is the hardest part, not the AI part.**
Ticketmaster, StubHub, and similar sites actively block automation, use
queues and CAPTCHAs, and their terms of service often prohibit bots. Plan on
`open_checkout` being the real product for a long time. If you do automate
the purchase, do it for one venue or site you have tested, keep a human
confirmation on the final click, and expect it to break when the site changes.

**Payment details must never enter model context.** The model proposes
`{quantity, maxTotal}`. The executor holds the card, fills the form, and never
echoes it back. Treat this as a hard rule in code review.

**Grounding.** Require every proposal to cite URLs the model actually fetched
in that run. Reject proposals whose evidence URLs do not appear in the run's
tool results. This single check removes most hallucinated availability.

**Cost control.** A patrol every two hours is twelve runs a day. Keep the
Trigger step on Haiku and only escalate to Opus when a trigger fires. Set a
`task_budget` per investigation and a daily dollar cap that pauses patrols.
Log cost per run from day one. Prompt caching on the profile and tool
definitions makes the per-call overhead small.

**Notification fatigue.** If Duo pings you about everything, you will turn it
off. The Trigger step should be strict, proposals should have a minimum
confidence, and the profile's `rules` list is where you tune it. A "quiet
hours" setting is worth adding early.

**Staleness.** Tickets sell out and prices move. Proposals carry `expiresAt`,
and executors always re-verify before acting.

**Prompt injection via the web.** Fetched pages are untrusted. Keep the
investigation run's tool set read-only so a malicious page cannot cause an
action, and keep the profile's sensitive fields out of the prompt (the model
needs "budget $120", not your card number or home address).

---

## 6. What to do first

1. Create the TypeScript project and install `@anthropic-ai/sdk`.
2. Write `profile.yaml` for yourself.
3. Build the Phase 0 `patrol.ts` script with web search, web fetch, and a
   `file_proposal` tool using a strict schema.
4. Run it ten times against real upcoming fixtures and iterate on the prompt
   until the proposals are specific, evidenced, and affordable.
5. Only then add the database and the cron loop.

Phase 0 is a single file of roughly 150 lines. That is the whole "how do I
start" answer: get one good proposal out of one manual run.
