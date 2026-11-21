import { z } from "zod";

export const CardStatusSchema = z.enum([
  "pool",
  "running",
  "needs_me",
  "waiting_external",
  "archived",
]);
export type CardStatus = z.infer<typeof CardStatusSchema>;

export const WaitModeSchema = z.enum(["script", "ai", "board", "provider"]);
export type WaitMode = z.infer<typeof WaitModeSchema>;

export const NeedsMeTagSchema = z.enum([
  "ready_to_archive",
  "decision",
  "input",
  "review",
]);
export type NeedsMeTag = z.infer<typeof NeedsMeTagSchema>;

export const RadarLinkKindSchema = z.string().min(1);
export type RadarLinkKind = z.infer<typeof RadarLinkKindSchema>;

export const RadarLinkSchema = z.object({
  kind: RadarLinkKindSchema.default("link"),
  label: z.string(),
  url: z.string(),
});
export type RadarLink = z.infer<typeof RadarLinkSchema>;

export const RadarLinkInputSchema = z.object({
  url: z.string().min(1),
  label: z.string().optional(),
  kind: RadarLinkKindSchema.optional(),
});
export type RadarLinkInput = z.infer<typeof RadarLinkInputSchema>;

export const DecisionProposalSchema = z.object({
  title: z.string().nullable().default(null),
  target: z.string().nullable().default(null),
  impact: z.string().nullable().default(null),
  draft: z.string().nullable().default(null),
  agentId: z.string().nullable().default(null),
  updatedAt: z.string().nullable().default(null),
});
export type DecisionProposal = z.infer<typeof DecisionProposalSchema>;
