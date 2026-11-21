import { z } from "zod";

export const PROVIDER_PROTOCOL_VERSION = "1.0" as const;

export const ItemArchetypeSchema = z.enum([
  "code_change",
  "incident",
  "work_item",
  "document",
  "message",
]);
export type ItemArchetype = z.infer<typeof ItemArchetypeSchema>;

export const ARCHETYPE_AUTHORITY_RANK: Record<ItemArchetype, number> = {
  code_change: 90,
  incident: 80,
  work_item: 70,
  document: 60,
  message: 40,
};

export const ItemIntentSchema = z.enum([
  "review",
  "resolve_feedback",
  "fix_ci",
  "merge_ready",
  "implement",
  "investigate",
  "close_out",
  "reply",
]);
export type ItemIntent = z.infer<typeof ItemIntentSchema>;

export const ProviderLifecycleSchema = z.enum(["oneshot", "daemon"]);
export type ProviderLifecycle = z.infer<typeof ProviderLifecycleSchema>;

export const ProviderProtocolKindSchema = z.enum(["jsonrpc", "legacy"]);
export type ProviderProtocolKind = z.infer<typeof ProviderProtocolKindSchema>;

export const DeclarativeLinkMatcherSchema = z.object({
  id: z.string().optional(),
  urlRegex: z.string().min(1),
  flags: z.string().default("i"),
  kind: z.string().min(1),
  labelTemplate: z.string().min(1),
  subIdTemplate: z.string().optional(),
  entityKeyTemplate: z.string().optional(),
  canonicalUrlTemplate: z.string().optional(),
});
export type DeclarativeLinkMatcher = z.infer<typeof DeclarativeLinkMatcherSchema>;

export const EntityUrlTemplateSchema = z.object({
  entityPrefix: z.string().min(1),
  tokenRegex: z.string().optional(),
  branchTokenRegex: z.string().optional(),
  cardIdRegex: z.string().optional(),
  keyTemplate: z.string().default("$1"),
  urlTemplate: z.string().optional(),
  kind: z.string().default("link"),
  labelTemplate: z.string().default("$1"),
  subIdTemplate: z.string().optional(),
  deterministicLiveClaim: z.boolean().default(false),
});
export type EntityUrlTemplate = z.infer<typeof EntityUrlTemplateSchema>;

export const CustomDomainRulesSchema = z.object({
  resourceLabels: z.record(z.string(), z.string()).default({}),
  linkMatchers: z.array(DeclarativeLinkMatcherSchema).default([]),
  entityTemplates: z.array(EntityUrlTemplateSchema).default([]),
});
export type CustomDomainRules = z.infer<typeof CustomDomainRulesSchema>;

export const ProviderCapabilitiesSchema = z.object({
  health: z.boolean().default(false),
  wait: z.boolean().default(false),
  push: z.boolean().default(false),
});
export type ProviderCapabilities = z.infer<typeof ProviderCapabilitiesSchema>;

export const ProviderManifestSchema = z.object({
  protocolVersion: z.string().default(PROVIDER_PROTOCOL_VERSION),
  id: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().nullable().default(null),
  icon: z.string().nullable().optional(),
  capabilities: ProviderCapabilitiesSchema.default({
    health: false,
    wait: false,
    push: false,
  }),
  configSchema: z.record(z.string(), z.unknown()).nullable().optional(),
  linkMatchers: z.array(DeclarativeLinkMatcherSchema).default([]),
  entityTemplates: z.array(EntityUrlTemplateSchema).default([]),
  resourceLabels: z.record(z.string(), z.string()).default({}),
});
export type ProviderManifest = z.infer<typeof ProviderManifestSchema>;

export const WaitPredicateSchema = z.object({
  providerId: z.string().optional(),
  type: z.string().min(1),
  params: z.record(z.string(), z.unknown()).default({}),
});
export type WaitPredicate = z.infer<typeof WaitPredicateSchema>;

export const ClosureGateSchema = z.object({
  requireExternalTerminal: z.boolean().default(false),
  terminalBadgeRegex: z.string().optional(),
  terminalReplyRegex: z.string().optional(),
  waitPredicate: WaitPredicateSchema.optional(),
});
export type ClosureGate = z.infer<typeof ClosureGateSchema>;

export const PromoteToClosingRuleSchema = z.object({
  allEntitiesTerminal: z.array(z.string().min(1)).min(1),
  dropIfUnmet: z.boolean().default(false),
  closingSummarySuffix: z.string().optional(),
  closingHint: z.string().optional(),
});
export type PromoteToClosingRule = z.infer<typeof PromoteToClosingRuleSchema>;

export const ProviderWorkspaceHintSchema = z.object({
  repoPath: z.string().nullable().optional(),
  existingBranch: z.string().nullable().optional(),
  branchSlug: z.string().optional(),
  preferWorktree: z.boolean().optional(),
});
export type ProviderWorkspaceHint = z.infer<typeof ProviderWorkspaceHintSchema>;

export const ProviderRawLinkSchema = z.object({
  kind: z.string().default("link"),
  label: z.string().default("链接"),
  url: z.string().min(1),
});
export type ProviderRawLink = z.infer<typeof ProviderRawLinkSchema>;

export const ProviderItemSchema = z.object({
  id: z.string().min(1),
  source: z.string().optional(),
  archetype: ItemArchetypeSchema.default("work_item"),
  intent: ItemIntentSchema.default("implement"),
  group: z.enum(["urgent", "closing", "todo"]).default("todo"),
  badge: z.string().default("待办"),
  title: z.string().min(1),
  summary: z.string().default(""),
  url: z.string().default(""),
  secondaryUrl: z.string().nullable().optional(),
  links: z.array(ProviderRawLinkSchema).optional(),
  updatedAt: z.string().optional(),
  stateHash: z.string().min(1),
  entityKeys: z.array(z.string()).optional(),
  relatedKeys: z.array(z.string()).optional(),
  scanText: z.string().optional(),
  context: z.string().nullable().optional(),
  hint: z.string().nullable().optional(),
  promoteToClosingWhen: PromoteToClosingRuleSchema.optional(),
  workspaceHint: ProviderWorkspaceHintSchema.optional(),
  roleHint: z.enum(["backend", "design", "light"]).nullable().optional(),
  recommendedModel: z.string().nullable().optional(),
  closureGate: ClosureGateSchema.optional(),
  prepLabel: z.string().optional(),
  workLabel: z.string().optional(),
});
export type ProviderItem = z.infer<typeof ProviderItemSchema>;

export const EntitySignalSchema = z.object({
  entityKey: z.string().min(1),
  state: z.enum(["open", "terminal"]).optional(),
  links: z.array(ProviderRawLinkSchema).optional(),
});
export type EntitySignal = z.infer<typeof EntitySignalSchema>;

export const ProviderSyncParamsSchema = z.object({
  now: z.string(),
  timezone: z.string(),
  cursor: z.unknown().nullable().default(null),
  knownHashes: z.record(z.string(), z.string()).default({}),
  globalConfig: z
    .object({
      defaultRepoPath: z.string().optional(),
      issueTeamPrefixes: z.array(z.string()).optional(),
    })
    .default({}),
  rules: z.object({
    mutedKeywords: z.array(z.string()).default([]),
    mutedChannels: z.array(z.string()).default([]),
    mutedItemIds: z.array(z.string()).default([]),
  }),
});
export type ProviderSyncParams = z.infer<typeof ProviderSyncParamsSchema>;

export const ProviderSyncResultSchema = z.object({
  isFullSnapshot: z.boolean().default(true),
  nextCursor: z.unknown().nullable().optional(),
  items: z.array(ProviderItemSchema).default([]),
  removedIds: z.array(z.string()).default([]),
  entitySignals: z.array(EntitySignalSchema).default([]),
  warnings: z.array(z.string()).default([]),
});
export type ProviderSyncResult = z.infer<typeof ProviderSyncResultSchema>;

export const ProviderHealthResultSchema = z.object({
  ok: z.boolean(),
  identity: z.string().nullable().default(null),
  message: z.string().nullable().default(null),
  latencyMs: z.number().nullable().optional(),
});
export type ProviderHealthResult = z.infer<typeof ProviderHealthResultSchema>;

export const ProviderWaitCheckResultSchema = z.object({
  status: z.enum(["ready", "pending", "failed"]),
  note: z.string().default(""),
});
export type ProviderWaitCheckResult = z.infer<typeof ProviderWaitCheckResultSchema>;

export const ProviderChangedNotificationSchema = z.object({
  upserts: z.array(ProviderItemSchema).default([]),
  removedIds: z.array(z.string()).default([]),
  entitySignals: z.array(EntitySignalSchema).default([]),
});
export type ProviderChangedNotification = z.infer<typeof ProviderChangedNotificationSchema>;

export const ProviderInitializeParamsSchema = z.object({
  protocolVersion: z.literal(PROVIDER_PROTOCOL_VERSION).default(PROVIDER_PROTOCOL_VERSION),
  config: z.record(z.string(), z.unknown()).default({}),
  globalConfig: z.record(z.string(), z.unknown()).default({}),
}).passthrough();
export type ProviderInitializeParams = z.infer<typeof ProviderInitializeParamsSchema>;

const rpcRequest = z.object({ jsonrpc: z.literal("2.0"), id: z.union([z.number().int(), z.string()]) });
export const ProviderRequestSchema = z.discriminatedUnion("method", [
  rpcRequest.extend({ method: z.literal("provider/initialize"), params: ProviderInitializeParamsSchema }),
  rpcRequest.extend({ method: z.literal("provider/sync"), params: ProviderSyncParamsSchema }),
  rpcRequest.extend({ method: z.literal("provider/checkHealth"), params: z.object({}).passthrough().optional() }),
  rpcRequest.extend({ method: z.literal("provider/checkWait"), params: z.object({ predicate: WaitPredicateSchema }).passthrough() }),
]);
export const ProviderChangeMessageSchema = z.object({
  jsonrpc: z.literal("2.0"), method: z.literal("notifications/changed"), params: ProviderChangedNotificationSchema,
}).strict();
export const ProviderResponseSchema = z.union([
  rpcRequest.extend({ result: z.json() }).strict(),
  rpcRequest.extend({ id: rpcRequest.shape.id.nullable(), error: z.object({ code: z.number().int(), message: z.string(), data: z.json().optional() }) }).strict(),
]);

export const ProviderEntryConfigSchema = z.object({
  enabled: z.boolean().default(false),
  lifecycle: ProviderLifecycleSchema.default("oneshot"),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  config: z.record(z.string(), z.unknown()).default({}),
});
export type ProviderEntryConfig = z.infer<typeof ProviderEntryConfigSchema>;

export const ProvidersConfigFileSchema = z.object({
  defaultRepoPath: z.string().default(""),
  issueTeamPrefixes: z.array(z.string()).default([]),
  providers: z.record(z.string(), ProviderEntryConfigSchema).default({}),
});
export type ProvidersConfigFile = z.infer<typeof ProvidersConfigFileSchema>;
