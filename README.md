# Duo

A proactive personal agent built on the Claude API. Duo stays on, watches for
things you care about, does the research, and brings you a proposal to approve
before it acts.

See [PLAN.md](PLAN.md) for the architecture, stack, and phased build order.

## Phase 0: run one patrol by hand

What exists today is the Phase 0 script: one investigation run, driven by
your profile, that searches the web and files structured proposals. Nothing is
stored in a database and nothing is purchased.

```bash
npm install
cp .env.example .env        # then put your ANTHROPIC_API_KEY in .env
```

Edit `profile.yaml` and replace every `CHANGE ME` with your own details. Keep
anything sensitive (addresses, card numbers) out of it; the model reads it.

```bash
npm run patrol
```

The run prints what Duo searched and fetched, then any proposals it filed.
Each run is also saved to `out/patrol-<timestamp>.json` with token usage, an
estimated cost, every URL the run touched, and any proposals that were
rejected for citing URLs the run never saw.

Run it a handful of times against real upcoming fixtures and tune the prompt
in `src/patrol.ts` (the `buildSystemPrompt` function) until the proposals are
specific, evidenced, and affordable. That is the whole goal of this phase.

## Layout

```
profile.yaml       who Duo works for (edit this)
src/profile.ts     loads and validates the profile
src/proposal.ts    the schema a proposal must match
src/patrol.ts      the Phase 0 run: prompt, tools, grounding check, report
out/               one JSON file per run (gitignored)
```
