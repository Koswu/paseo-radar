import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const HumanInteractionSourceSchema = z.enum(["rpc", "hook", "settings", "ui"]);
export type HumanInteractionSource = z.infer<typeof HumanInteractionSourceSchema>;

export const HumanInteractionEventSchema = z.object({
  id: z.string(),
  at: z.string(),
  kind: z.string().min(1),
  source: HumanInteractionSourceSchema,
  cardId: z.string().nullable().optional(),
  cardTitle: z.string().nullable().optional(),
  cardStatus: z.string().nullable().optional(),
  cardGroup: z.string().nullable().optional(),
  cardSource: z.string().nullable().optional(),
  agentId: z.string().nullable().optional(),
  workspaceId: z.string().nullable().optional(),
  projectId: z.string().nullable().optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
});
export type HumanInteractionEvent = z.infer<typeof HumanInteractionEventSchema>;

export const logRadarInteractionRpc = defineRpc({
  name: "radar.interaction.log",
  input: z.object({
    kind: z.string().min(1),
    cardId: z.string().optional(),
    agentId: z.string().optional(),
    workspaceId: z.string().optional(),
    detail: z.record(z.string(), z.unknown()).optional(),
  }),
  output: z.object({
    ok: z.boolean(),
  }),
});

export const loadRadarInteractionsRpc = defineRpc({
  name: "radar.interactions.load",
  input: z.object({
    limit: z.number().int().min(1).max(500).default(100),
    kind: z.string().optional(),
    cardId: z.string().optional(),
  }),
  output: z.object({
    logPath: z.string(),
    totalCount: z.number().int(),
    byKind: z.record(z.string(), z.number().int()),
    events: z.array(HumanInteractionEventSchema),
  }),
});
