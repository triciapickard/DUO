import fs from "node:fs";
import { parse } from "yaml";
import { z } from "zod";

// The profile is the one thing Phase 0 takes as input. It is validated here so
// a typo in profile.yaml fails loudly before any money is spent on a model call.

const InterestSchema = z.object({
  kind: z.string(),
  sport: z.string().optional(),
  team: z.string().optional(),
  priority: z.enum(["low", "medium", "high"]).default("medium"),
  notes: z.string().optional(),
});

export const ProfileSchema = z.object({
  name: z.string(),
  location: z.object({
    city: z.string(),
    country: z.string(),
    timezone: z.string(),
  }),
  interests: z.array(InterestSchema).min(1),
  budgets: z.record(
    z.string(),
    z.object({
      max_per_ticket: z.number().positive(),
      currency: z.string().length(3),
    }),
  ),
  preferences: z.object({
    seating: z.array(z.string()).default([]),
    companions: z.number().int().min(0).default(0),
    travel_radius_km: z.number().positive().default(50),
  }),
  rules: z.array(z.string()).default([]),
});

export type Profile = z.infer<typeof ProfileSchema>;

export function loadProfile(path = "./profile.yaml"): Profile {
  const raw = parse(fs.readFileSync(path, "utf8"));
  const result = ProfileSchema.safeParse(raw);
  if (!result.success) {
    console.error(`profile.yaml is invalid:\n${z.prettifyError(result.error)}`);
    process.exit(1);
  }
  const profile = result.data;
  const placeholders = JSON.stringify(profile).match(/CHANGE ME/g);
  if (placeholders) {
    console.error(
      `profile.yaml still has ${placeholders.length} "CHANGE ME" placeholder(s). Fill them in first.`,
    );
    process.exit(1);
  }
  return profile;
}
