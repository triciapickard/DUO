import { z } from "zod";

// A proposal is the only thing an investigation run is allowed to produce.
// It is a typed record, not free text. Later phases store it in a database
// and show it in the inbox; Phase 0 writes it to out/ as JSON.
//
// The `action` is a command for a future executor to run AFTER the user
// approves. In Phase 0 nothing executes it. Note that the model never sees
// payment details and cannot propose a total above the profile budget.

export const EvidenceSchema = z.object({
  url: z.string().url().describe("A URL that was actually fetched or returned by search during this run"),
  quote: z
    .string()
    .max(300)
    .describe("The exact phrase from that page that supports the claim, under 300 characters"),
});

export const ActionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("purchase_tickets"),
    url: z.string().url().describe("The page where the tickets can be bought"),
    event_date: z.string().describe("ISO 8601 date or datetime of the event"),
    venue: z.string(),
    section: z.string().describe("Section, block, or stand name as the ticket site labels it"),
    quantity: z.number().int().min(1).max(8),
    price_per_ticket: z.number().positive(),
    max_total: z.number().positive().describe("Hard cap for the whole purchase, including fees if known"),
    currency: z.string().length(3),
  }),
  z.object({
    kind: z.literal("information_only"),
    reason: z.string().describe("Why this is worth knowing but not worth acting on yet"),
  }),
]);

export const ProposalSchema = z.object({
  title: z.string().max(120).describe("One line, e.g. 'Tickets: Australia v India, Sat 15 Nov at the SCG'"),
  summary: z
    .string()
    .max(1200)
    .describe("Three to six sentences the user reads to decide. Lead with what, when, where, how much."),
  why_this_matters: z.string().max(400).describe("Which part of the profile this serves"),
  evidence: z.array(EvidenceSchema).min(1).max(6),
  action: ActionSchema,
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe("How sure you are that the facts (date, price, availability) are correct right now"),
  expires_at: z.string().describe("ISO 8601 datetime after which this proposal is stale"),
});

export type Proposal = z.infer<typeof ProposalSchema>;
