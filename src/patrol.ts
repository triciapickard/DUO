// Phase 0: one patrol, run by hand.
//
//   npm run patrol
//
// Reads profile.yaml, gives Claude web search + web fetch + one output tool
// (file_proposal), and prints whatever proposals come out. Nothing is stored
// in a database and nothing is executed. The point is to run this ten times
// against real fixtures and tune the prompt until proposals are specific,
// evidenced, and affordable. See PLAN.md section 4.

import "dotenv/config";
import fs from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { BetaMessage } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { loadProfile, type Profile } from "./profile.js";
import { ProposalSchema, type Proposal } from "./proposal.js";

const MODEL = "claude-opus-5-5";
const MAX_ITERATIONS = 20;

// Approximate first-party rates for claude-opus-5-5, USD per million tokens.
// Used only for the cost line at the end of a run.
const RATES = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 };

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

function buildSystemPrompt(profile: Profile): string {
  return `You are Duo, a proactive personal agent. You are running an unattended "patrol": nobody asked you a question. Your job is to look at the world on behalf of the person described below, notice anything they would genuinely want to know about or act on, do the legwork, and file a proposal they can approve or decline later.

You are not chatting with anyone. Your only outputs are calls to the file_proposal tool. If nothing is worth proposing, file nothing and finish with one sentence saying what you checked and why nothing qualified.

## The person

${JSON.stringify(profile, null, 2)}

## How to patrol

1. Work out what in the world could matter to this person in the next six weeks, starting from their interests. For a sports team that means upcoming fixtures, especially ones near their location.
2. Use web_search to find candidate events, then web_fetch the official or primary pages (the team, the venue, the ticket seller) to confirm dates, venues, and prices. Search results alone are not evidence; fetch the page.
3. For anything that looks promising, check tickets: are they on sale, what sections are available, what do they cost, do any match the seating preferences, and does the total fit the budget for the number of people (the person plus their companions)?
4. File one proposal per distinct opportunity. Be specific: section names, prices, dates, venue, the exact page to buy from.

## Hard rules

- Every evidence URL must be a page you fetched or that appeared in your search results during this run. The harness checks this and will reject the proposal otherwise. Do not invent or guess URLs.
- Never propose a purchase whose max_total exceeds the budget for that many tickets. If the only tickets are over budget, file an information_only proposal explaining that.
- Respect the person's rules list above. If a rule disqualifies an event, do not propose it.
- Set confidence honestly. If you could not confirm current availability on the actual ticket page, confidence should be below 0.6.
- Set expires_at to when the facts will likely change: for tickets that is usually a few days, never past the event itself.
- Do not pad. If you found one good thing, file one proposal.`;
}

// ---------------------------------------------------------------------------
// Grounding: which URLs did this run actually touch?
// ---------------------------------------------------------------------------

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, "")}${u.search}`;
  } catch {
    return url.trim();
  }
}

function collectUrls(message: BetaMessage, into: Set<string>): void {
  for (const block of message.content) {
    if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
      for (const r of block.content) into.add(normalizeUrl(r.url));
    } else if (block.type === "web_fetch_tool_result" && block.content.type === "web_fetch_result") {
      into.add(normalizeUrl(block.content.url));
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const profile = loadProfile();
  const client = new Anthropic();

  const urlsSeen = new Set<string>();
  const proposals: Proposal[] = [];
  const rejected: Array<{ proposal: unknown; reason: string }> = [];

  // The one output tool. Validation happens twice: the SDK validates the input
  // against the Zod schema, then we check that the evidence is grounded in
  // URLs this run actually saw. An ungrounded proposal is bounced back to the
  // model with the list of bad URLs so it can fix or drop it.
  const fileProposal = betaZodTool({
    name: "file_proposal",
    description:
      "File a proposal for the user to review later. Call once per distinct opportunity. Evidence URLs must be pages you fetched or saw in search results during this run.",
    inputSchema: ProposalSchema,
    strict: true,
    run: (proposal) => {
      const ungrounded = proposal.evidence
        .map((e) => e.url)
        .filter((u) => !urlsSeen.has(normalizeUrl(u)));
      if (ungrounded.length > 0) {
        const reason = `Rejected: these evidence URLs were not fetched or returned by search in this run: ${ungrounded.join(", ")}. Fetch them, cite a URL you did fetch, or drop the proposal.`;
        rejected.push({ proposal, reason });
        return reason;
      }
      proposals.push(proposal);
      return `Filed proposal #${proposals.length}: ${proposal.title}`;
    },
  });

  const now = new Date();
  const localNow = now.toLocaleString("en-GB", { timeZone: profile.location.timezone, dateStyle: "full", timeStyle: "short" });

  const runner = client.beta.messages.toolRunner({
    model: MODEL,
    max_tokens: 16000,
    max_iterations: MAX_ITERATIONS,
    output_config: { effort: "high" },
    // Server-side fallback: if a safety classifier declines, the API re-runs on
    // a fallback model inside the same call instead of returning nothing.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    // The system prompt is the stable prefix; cache it. Anything that changes
    // per run (the date) goes in the user message after it.
    system: [{ type: "text", text: buildSystemPrompt(profile), cache_control: { type: "ephemeral" } }],
    tools: [
      { type: "web_search_20260209", name: "web_search", max_uses: 10 },
      { type: "web_fetch_20260209", name: "web_fetch", max_uses: 10, max_content_tokens: 20000 },
      fileProposal,
    ],
    messages: [
      {
        role: "user",
        content: `It is ${localNow} (${profile.location.timezone}). Run a patrol.`,
      },
    ],
  });

  console.log(`Duo patrol for ${profile.name} at ${localNow}`);
  console.log(`Model ${MODEL}, up to ${MAX_ITERATIONS} iterations\n`);

  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let iteration = 0;
  let finalMessage: BetaMessage | undefined;

  for await (const message of runner) {
    iteration += 1;
    finalMessage = message;

    // Record URLs before the runner executes this turn's tool calls (it does
    // that at the end of the loop body), so file_proposal sees them.
    collectUrls(message, urlsSeen);

    usage.input += message.usage.input_tokens;
    usage.output += message.usage.output_tokens;
    usage.cacheRead += message.usage.cache_read_input_tokens ?? 0;
    usage.cacheWrite += message.usage.cache_creation_input_tokens ?? 0;

    for (const block of message.content) {
      if (block.type === "text" && block.text.trim()) {
        console.log(`[${iteration}] ${block.text.trim()}`);
      } else if (block.type === "server_tool_use") {
        const input = block.input as Record<string, unknown>;
        console.log(`[${iteration}] ${block.name}: ${input.query ?? input.url ?? ""}`);
      } else if (block.type === "tool_use") {
        console.log(`[${iteration}] ${block.name}`);
      } else if (block.type === "fallback") {
        console.log(`[${iteration}] ${block.from.model} declined; ${block.to.model} continued`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Report
  // -------------------------------------------------------------------------

  const cost =
    (usage.input * RATES.input +
      usage.output * RATES.output +
      usage.cacheRead * RATES.cacheRead +
      usage.cacheWrite * RATES.cacheWrite) /
    1_000_000;

  const stopReason = finalMessage?.stop_reason ?? "none";
  if (stopReason === "refusal") {
    console.warn(`\nRun ended with a refusal: ${finalMessage?.stop_details?.explanation ?? "(no explanation)"}`);
  } else if (stopReason === "max_tokens") {
    console.warn("\nRun hit max_tokens before finishing; the last message was cut off.");
  } else if (stopReason === "tool_use" || stopReason === "pause_turn") {
    console.warn(`\nRun stopped at the iteration cap (${MAX_ITERATIONS}) with work still pending.`);
  }

  fs.mkdirSync("out", { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const outPath = `out/patrol-${stamp}.json`;
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        ran_at: now.toISOString(),
        model: MODEL,
        iterations: iteration,
        stop_reason: stopReason,
        usage,
        estimated_cost_usd: Number(cost.toFixed(4)),
        urls_seen: [...urlsSeen].sort(),
        proposals,
        rejected,
      },
      null,
      2,
    ),
  );

  console.log(`\n${"=".repeat(72)}`);
  console.log(`${proposals.length} proposal(s), ${rejected.length} rejected for ungrounded evidence`);
  for (const [i, p] of proposals.entries()) {
    console.log(`\n#${i + 1} ${p.title}  (confidence ${p.confidence}, expires ${p.expires_at})`);
    console.log(p.summary);
    if (p.action.kind === "purchase_tickets") {
      const a = p.action;
      console.log(
        `  Action: buy ${a.quantity} x ${a.price_per_ticket} ${a.currency} in ${a.section}, cap ${a.max_total} ${a.currency}`,
      );
      console.log(`  At: ${a.url}`);
    } else {
      console.log(`  Information only: ${p.action.reason}`);
    }
    for (const e of p.evidence) console.log(`  Evidence: ${e.url}`);
  }
  console.log(`\nTokens: in ${usage.input}, out ${usage.output}, cache read ${usage.cacheRead}, cache write ${usage.cacheWrite}`);
  console.log(`Estimated cost: $${cost.toFixed(3)}  |  Saved to ${outPath}`);
}

main().catch((err: unknown) => {
  const noCredentials =
    err instanceof Error && err.message.includes("Could not resolve authentication method");
  if (noCredentials || err instanceof Anthropic.AuthenticationError) {
    console.error("No valid API credentials. Put ANTHROPIC_API_KEY in .env (see .env.example).");
  } else if (err instanceof Anthropic.RateLimitError) {
    console.error("Rate limited. Wait a minute and run again.");
  } else if (err instanceof Anthropic.APIError) {
    console.error(`API error ${err.status}: ${err.message}`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
