import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { defineAgentTool, type AgentToolDefinition } from "@getpaseo/plugin/server";
import { z } from "zod";

import {
  CardStatusSchema,
  NeedsMeTagSchema,
  RADAR_LABELS,
  RadarLinkKindSchema,
  SnoozePresetSchema,
  WaitModeSchema,
  WaitPredicateSchema,
  type RadarItem,
} from "../shared/radar";
import { resolveWorkerTargetCard } from "./card-dedup";
import { listCollectorScripts, testCollectorScript } from "./collectors";
import type { RadarEngine } from "./engine";
import { recordInsightEvent } from "./insights";
import { hasUnexecutedDocOrProposalActivity, hasUnmergedMrActivity } from "./needs-me-tag";
import {
  extractCanonicalEntityKeys,
  extractRelatedTokens,
  isSameNormalizedTitle,
  mergeRadarLinks,
  normalizeCardId,
  resolveItemLinks,
  setsIntersect,
} from "./entity-keys";
import {
  readRadarState,
  updateRadarRules,
  updateRadarState,
  type GitDirtyBaseline,
  type RawScannedItem,
} from "./store";

const execFileAsync = promisify(execFile);
const MAX_GIT_BASELINE_ENTRIES = 300;

const READONLY_CLOSURE_EVIDENCE_RE =
  /(?:纯咨询|只读排查|纯排查|纯答疑|未涉及[^，。；\n]{0,8}(?:修改|改动)|无需[^，。；\n]{0,6}(?:修改|改动)|未修改代码|未改动文件)/i;

const EXPLICIT_SKIP_COMMIT_RE =
  /(?:用户|需求)(?:明确)?(?:要求|指定|指示)(?:暂不|不要|不用|无需|先不)\s*(?:提交|commit)/i;

export async function captureGitDirtySnapshot(cwd: string): Promise<GitDirtyBaseline | null> {
  if (!cwd) return null;
  let repoRoot: string;
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      timeout: 2500,
    });
    repoRoot = stdout.trim();
    if (!repoRoot) return null;
  } catch {
    return null;
  }

  let rawStatus: string;
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repoRoot, "status", "--porcelain=v1", "-z", "--ignore-submodules=untracked"],
      { timeout: 3000, maxBuffer: 2 * 1024 * 1024 },
    );
    rawStatus = stdout;
  } catch {
    return null;
  }

  const entries: Record<string, string> = {};
  const parts = rawStatus.split("\0");
  let count = 0;
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i]!;
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    const relPath = entry.slice(3);
    if (xy[0] === "R" || xy[0] === "C" || xy[1] === "R" || xy[1] === "C") {
      i += 1;
    }
    if (count >= MAX_GIT_BASELINE_ENTRIES) break;
    count += 1;
    try {
      const st = await lstat(join(repoRoot, relPath));
      const kindOrSize = st.isDirectory() ? "dir" : String(st.size);
      entries[relPath] = `${xy}|${kindOrSize}|${Math.trunc(st.mtimeMs)}`;
    } catch {
      entries[relPath] = `${xy}|missing`;
    }
  }
  return { repoRoot, entries };
}

export function mergeGitBaseline(
  existing: GitDirtyBaseline | undefined,
  current: GitDirtyBaseline,
): GitDirtyBaseline {
  if (!existing || existing.repoRoot !== current.repoRoot) {
    return current;
  }
  const entries: Record<string, string> = {};
  for (const [relPath, fp] of Object.entries(existing.entries)) {
    if (current.entries[relPath] === fp) {
      entries[relPath] = fp;
    }
  }
  return { repoRoot: current.repoRoot, entries };
}

export async function findUncommittedSessionChanges(
  cwd: string,
  baseline: GitDirtyBaseline | undefined,
  closureEvidence?: string,
): Promise<{ repoRoot: string; branch: string; dirtyFiles: string[] } | null> {
  if (closureEvidence && EXPLICIT_SKIP_COMMIT_RE.test(closureEvidence)) {
    return null;
  }
  const current = await captureGitDirtySnapshot(cwd);
  if (!current) return null;

  const hasMatchingBaseline = Boolean(baseline && baseline.repoRoot === current.repoRoot);
  if (!hasMatchingBaseline && closureEvidence && READONLY_CLOSURE_EVIDENCE_RE.test(closureEvidence)) {
    return null;
  }

  const dirtyFiles: string[] = [];
  for (const [relPath, fp] of Object.entries(current.entries)) {
    if (hasMatchingBaseline && baseline!.entries[relPath] === fp) {
      continue;
    }
    dirtyFiles.push(relPath);
  }
  if (dirtyFiles.length === 0) return null;

  let branch = "HEAD";
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", current.repoRoot, "symbolic-ref", "--quiet", "--short", "HEAD"],
      { timeout: 1500 },
    );
    if (stdout.trim()) branch = stdout.trim();
  } catch {
    // detached HEAD
  }
  return { repoRoot: current.repoRoot, branch, dirtyFiles };
}

const VAGUE_CLOSURE_EVIDENCE_RE =
  /^(?:已验证|已完成|已闭环|已处理|已解决|无异常|一切正常|正常|通过|ok|done)[。.!！]?$/i;

const UNVERIFIED_ADMISSION_RE =
  /(?:尚未|暂未|还未|还没|未曾|未经|未用|未通过|未做|没做|并未)(?:[^，。；\n]{0,16}?)(?:验证|实测|复测|端到端测试|冒烟测试|请求测试)|(?<!(?:无需|不用|不必))(?:未验证|未实测|未复测)/i;

const PENDING_OBSERVATION_RE =
  /(?<!(?:无需|不用|不必|不再)(?:再|继续)?等?)(?:等待观察|待观察|待线上观察|待后续观察|有待观察|尚待观察|仍需观察|还需观察|需继续观察|留待观察|等待真实请求|等真实流量|待真实请求|待真实流量|待后续请求|待后续流量|待触发验证)/i;

const DEPLOY_ACTION_RE =
  /(?<!(?:无需|不用|不必|不涉及|未涉及|没有|未|非|无)\s*)(?:已部署|部署完成|部署成功|重新部署|部署了|已发布|发布完成|发布成功|已上线|刚上线|代码已上线|逻辑已上线|已发版|已重启|重启了|已更新远端|已同步远端|容器已更新|\bdeploy(?:ed)?\b|\brollout\b)/i;

const POST_DEPLOY_VERIFIED_CLAUSE_RE =
  /(?:实测|复测|冒烟测试|联调通过|端到端验证|\be2e\b|重放|回放|重跑[^，。；\n]{0,12}(?:通过|成功|正常|验证)|构造[^，。；\n]{0,12}(?:请求|消息|用例|数据|触发)|模拟[^，。；\n]{0,12}(?:请求|消息|流量)|调用[^，。；\n]{0,16}(?:返回|验证|成功|正常|预期)|触发[^，。；\n]{0,12}(?:验证|通过|成功|正常|命中)|请求验证|接口验证|功能验证|业务验证|(?:已|经)?(?:观测到|观察到|捕获到|查到[^，。；\n]{0,10}命中|确认[^，。；\n]{0,10}命中)|(?:已|成功)(?:触发|命中)|(?:请求|流量|消息|任务|排查|订单|事件|回调)[^，。；\n]{0,14}(?:命中|正常处理|成功处理|正常消费|成功消费|正常执行|成功执行|正常回复|正常返回|返回预期|符合预期)|(?:结果|返回|输出|响应|回包|状态码)[^，。；\n]{0,6}(?:符合预期|正确|正常)|(?:已|成功)(?:落库|入库)|修数完成|数据已(?:修复|订正|更新)|页面(?:渲染|交互|展示)正常|已关单|已取消单据|\bCompleted\b|\bDone\b|\bCanceled\b|\bCancelled\b|(?:用户|需求)?(?:仅|只)(?:要求|需)(?:完成)?(?:部署|发布|上线|重启))/gi;

const CLAUSE_NEGATION_PREFIX_RE =
  /(?:尚未|暂未|还未|还没|未曾|未经|未用|未做|没做|并未|没有|暂无|尚无|未|没|待|等待|需观察|还需|仍需)/;

function hasAffirmativePostDeployVerification(text: string): boolean {
  const clauses = text.split(/[,，;；。！!\n（()）]|(?:但是|但|不过|然而|只是)/);
  for (const rawClause of clauses) {
    const clause = rawClause.trim();
    if (!clause) continue;
    POST_DEPLOY_VERIFIED_CLAUSE_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = POST_DEPLOY_VERIFIED_CLAUSE_RE.exec(clause)) !== null) {
      const rawPrefix = clause.slice(Math.max(0, match.index - 12), match.index);
      const cleanedPrefix = rawPrefix.replace(
        /无(?:异常|报错|错误|问题|需|用|必)|零报错|不用|不必/g,
        "",
      );
      if (!CLAUSE_NEGATION_PREFIX_RE.test(cleanedPrefix)) {
        return true;
      }
    }
  }
  return false;
}

export function validateReadyToArchiveEvidence(
  closureEvidence: string | undefined,
): string | null {
  const text = (closureEvidence ?? "").trim();
  if (!text || text.length < 4 || VAGUE_CLOSURE_EVIDENCE_RE.test(text)) {
    return (
      "拒绝标记 ready_to_archive：必须传入具体的 closureEvidence 说明业务层闭环证据（如真实/重放请求命中新逻辑的结果、线上流量观测结论、本地单测结果、单据已关单，或「纯咨询已答复」）。" +
      "若刚完成部署/重启且尚未验证新逻辑实际生效：能无副作用自测请先实测；需等线上真实流量触发观测请改调 radar_mark_waiting_external；需用户授权重跑外部请求请改标 decision；否则改标 review。"
    );
  }
  if (UNVERIFIED_ADMISSION_RE.test(text) || PENDING_OBSERVATION_RE.test(text)) {
    return (
      `拒绝标记 ready_to_archive：closureEvidence 显示当前尚未完成业务层验证或仍待观察（${text}）。` +
      "「仅部署/重启完成」不等于事项闭环：若需观察线上真实请求/日志，请改调 radar_mark_waiting_external 进入托管观测；若需重跑外部请求但涉及副作用，请改标 decision 交用户确认；若暂不执行后续动作，请改标 review。"
    );
  }
  if (DEPLOY_ACTION_RE.test(text) && !hasAffirmativePostDeployVerification(text)) {
    return (
      `拒绝标记 ready_to_archive：检测到本次涉及部署/上线/重启（${text}），但仅提供了版本/进程存活/连接重连/启动无报错等部署信号，缺少新逻辑在业务层实际生效的验证或观测证据。` +
      "请先用构造/重放请求验证新逻辑输出，或调用 radar_mark_waiting_external 观测线上真实请求正常工作后再闭环；若需用户确认是否重跑生产请求请改标 decision，仅同步部署进展请改标 review。"
    );
  }
  if (hasUnmergedMrActivity(text)) {
    return (
      `拒绝标记 ready_to_archive：检测到当前仅完成 MR/PR 提交或更新（${text}），MR/PR 尚未合并/合入不算最终闭环。` +
      "若需等待 CI/Review/自动合并，请改调 radar_mark_waiting_external 进入托管监听；若需用户确认后操作请改标 decision；否则请改标 review。"
    );
  }
  if (hasUnexecutedDocOrProposalActivity(text)) {
    return (
      `拒绝标记 ready_to_archive：检测到当前仅产出或同步了方案文档（${text}），方案尚未评审或落地执行，不算最终闭环。` +
      "请改标 review 交用户审阅方案并决定下一步。"
    );
  }
  return null;
}

export function buildWaitCheckTools(engine: RadarEngine): AgentToolDefinition[] {
  return [
    defineAgentTool({
      name: "radar_report_wait_check",
      title: "汇报「等外部」wait-evaluator 评估结果",
      description:
        "由「等外部」独立评估模型（wait-evaluator）调用：ready=false 时记录本次检查说明并继续等待；ready=true 时退出「等外部」、清理定时任务，并重新触发原工作会话 AI 继续处理。",
      input: z.object({
        cardId: z.string().min(1),
        ready: z.boolean().describe("外部完结条件是否已满足"),
        note: z.string().min(1).describe("一句话事实检查结论"),
      }),
      async execute({ cardId, ready, note }, { paseo }) {
        return engine.reportAiWaitCheck(paseo, { cardId, ready, note });
      },
    }),
  ];
}

async function loadWorkerTargetCard(
  engine: RadarEngine,
  paseo: Parameters<RadarEngine["loadSnapshot"]>[0],
  agent: { id: string; workspaceId: string | null },
  requestedCardId?: string,
): Promise<RadarItem | undefined> {
  const [snap, state] = await Promise.all([engine.loadSnapshot(paseo), readRadarState()]);
  return resolveWorkerTargetCard({
    items: snap.items,
    meta: state.meta,
    agentId: agent.id,
    workspaceId: agent.workspaceId,
    requestedCardId,
    normalizeCardId,
  });
}

export function buildWorkerTools(engine: RadarEngine): AgentToolDefinition[] {
  return [
    defineAgentTool({
      name: "radar_attach_links",
      title: "登记当前卡片关联的产物或目标链接",
      description:
        "仅登记本卡实际产物或明确处理目标的完整 URL。拿到 URL 后立即挂载；排除搜索结果、事项清单、示例与参考资料。",
      input: z.object({
        cardId: z
          .string()
          .optional()
          .describe("Radar 卡片 ID（可省略，默认自动匹配当前工作区会话关联的卡片）"),
        links: z
          .array(
            z.object({
              url: z.string().min(1).describe("完整外部链接（http/https）"),
              label: z
                .string()
                .optional()
                .describe(
                  "简短可读名称（如「方案文档」），不填机器 ID；省略时从 URL 提炼。",
                ),
              kind: RadarLinkKindSchema
                .optional()
                .describe("链接类型（可选，省略时按 URL 自动识别）"),
            }),
          )
          .min(1)
          .describe("要挂载到当前卡片的产物或目标对象链接列表"),
      }),
      async execute({ cardId, links }, { agent, paseo }) {
        const targetCard = await loadWorkerTargetCard(engine, paseo, agent, cardId);
        if (!targetCard) {
          return { text: "未找到关联的 Radar 卡片", isError: true };
        }
        try {
          const res = await engine.manageCardLinks(paseo, {
            cardId: targetCard.id,
            add: links,
            callerAgentId: agent.id,
            callerWorkspaceId: agent.workspaceId,
          });
          const summary = res.added.map((l) => `${l.label} (${l.url})`).join("、");
          return {
            text: `已将链接挂载到卡片 ${targetCard.id} 右上角：${summary}`,
          };
        } catch (err) {
          return {
            text: err instanceof Error ? err.message : String(err),
            isError: true,
          };
        }
      },
    }),
    defineAgentTool({
      name: "radar_mark_waiting_external",
      title: "登记卡片的等待条件",
      description:
        "等待明确、可只读检查的条件时调用。provider 用 Provider 谓词，script 用脚本（exit 0 达标，10 继续），ai 用独立评估模型；均须传 condition、cron 与 maxTimeout。board 用 watch.targets 监听卡片状态，可省略 cron 与 maxTimeout。不要自行创建定时任务或后台轮询。",
      input: z.object({
        cardId: z
          .string()
          .optional()
          .describe("Radar 卡片 ID（可省略，默认自动匹配当前工作区会话关联的卡片）"),
        mode: WaitModeSchema.describe("监听模式：provider | script | ai | board"),
        predicate: WaitPredicateSchema.optional().describe("provider 模式使用的等待条件；providerId 默认取当前卡片来源，省略谓词则使用卡片预设。"),
        condition: z.string().optional().describe("一句话简明描述等待的目标与完结条件（非 board 模式必填）"),
        cron: z
          .string()
          .optional()
          .describe(
            "非 board 模式必填：5 段标准 cron 表达式（如 */5 * * * *）",
          ),
        maxTimeout: z
          .string()
          .optional()
          .describe("非 board 模式必填：最大等待时长（如 \"30m\"、\"2h\"、\"24h\"、\"3d\"）"),
        script: z
          .string()
          .optional()
          .describe(
            "mode=\"script\" 时必填：只读 bash 检查脚本（默认 set -euo pipefail）；达标 exit 0，继续等必须显式 exit 10",
          ),
        checkPrompt: z
          .string()
          .optional()
          .describe(
            "mode=\"ai\" 时必填：给独立 wait-evaluator 模型执行的只读检查指令与判定标准",
          ),
        watch: z
          .object({
            targets: z
              .array(
                z.object({
                  cardId: z.string().min(1).describe("被监听的卡片 ID（协调模式下填子卡 ID，如 S1；外层填卡片 ID）"),
                  status: CardStatusSchema.default("archived").describe("目标状态，默认 archived"),
                  needsMeTag: NeedsMeTagSchema.nullable().optional().describe("当 status=needs_me 时可选精确匹配标签"),
                }),
              )
              .min(1),
            match: z.enum(["all", "any"]).default("all").describe("all=全部满足；any=任一满足"),
            wakeOnException: z.boolean().default(true).describe("协调模式下任一子卡异常或需决策时是否提前唤醒"),
          })
          .optional()
          .describe("mode=\"board\" 时必填：监听的看板目标与匹配规则"),
      }),
      async execute({ cardId, mode, predicate, condition, cron, maxTimeout, script, checkPrompt, watch }, { agent, paseo }) {
        const target = await loadWorkerTargetCard(engine, paseo, agent, cardId);
        if (!target) {
          return { text: "未找到关联的 Radar 卡片", isError: true };
        }
        return engine.enterWaitingExternal({
          cardId: target.id,
          cardTitle: target.title,
          callerAgentId: agent.id,
          callerWorkspaceId: agent.workspaceId,
          mode,
          predicate,
          condition,
          cron,
          maxTimeout,
          script,
          checkPrompt,
          watch,
        });
      },
    }),
    defineAgentTool({
      name: "radar_set_needs_me_tag",
      title: "标记卡片在「待我处理」下的细分标签（支持提交待确认草稿）",
      description:
        "当本轮处理结束、卡片停在「待我处理」时，调用此工具标记下一步性质：\n- tag=\"ready_to_archive\"（可完结）：整张卡片承载的主事项本身已实质闭环完成（如改动已提交并经真实/重放请求验证生效、单据已关单/取消、独立咨询已查清答复），卡片默认主按钮将变为「归档」，必须同步传入 closureEvidence 写明业务层闭环证据。三项硬门禁（工具将直接校验拒绝）：1）严禁「只部署未验证」：刚完成部署/发布/重启时，仅确认编译通过、SHA/版本一致、进程运行正常、连接重连或启动日志无异常不构成闭环；尚未拿到业务层生效证据时，可无副作用自测的先实测，需等线上真实流量触发的改调 radar_mark_waiting_external 托管观测，需重跑外部请求或待授权的标 decision，仅同步阶段进展的标 review；2）严禁「改完不提交」：凡本会话修改或新增了 Git 仓库文件，必须先按提交规范完成 git commit，存在未提交改动时禁止标 ready_to_archive；3）严禁「刚提/更新未合并 MR/PR 即闭环」：创建或更新了待合并的 MR/PR 时不算闭环（除非用户明确只要求提 MR），应调 radar_mark_waiting_external 监听合入/CI，或改标 review / decision。\n- tag=\"decision\"（待确认）：方案/草稿/操作已备好，待用户确认授权执行。若涉及外发沟通或共享内容修改（Slack、MR/PR、Linear/GitLab/GitHub 评论或建单、共享文档）及生产数据变更，请一并传入 title、target、impact 与完整可编辑 draft（替代桌面确认弹窗）。\n- tag=\"input\"（待补充）：需用户提供材料、证据或贴回命令输出。\n- tag=\"review\"（待查阅）：阶段排查结论、部署进展或子步骤核对已出，主事项尚未最终观测闭环，待用户查阅指示。",
      input: z.object({
        cardId: z
          .string()
          .optional()
          .describe("Radar 卡片 ID（可省略，默认自动匹配当前工作区关联卡片）"),
        tag: NeedsMeTagSchema.describe("细分标签：ready_to_archive | decision | input | review"),
        closureEvidence: z
          .string()
          .optional()
          .describe(
            "tag=\"ready_to_archive\" 时必填：一句话写明业务层闭环证据（如「重放请求已命中新逻辑并返回预期结果」「SLS 已观测到真实流量正常处理」「纯本地改动已通过类型检查与单测并已提交 commit」「纯咨询已答复」）。仅写已部署/SHA一致/进程存活/连接重连、含「尚未验证/待观察」或存在未提交 Git 改动将被拒绝。",
          ),
        title: z
          .string()
          .optional()
          .describe("tag=\"decision\" 时可选：待确认动作简短标题（如「回复 Slack 线程」「提交 PR/MR 评论」「创建 Issue」）"),
        target: z
          .string()
          .optional()
          .describe(
            "tag=\"decision\" 时可填：授权操作的目标名称，不填机器 ID。",
          ),
        impact: z
          .string()
          .optional()
          .describe(
            "tag=\"decision\" 时可选：简短影响面说明（如「仅追加 MR 回复，不改代码或生产数据」；不要重复目标对象名，也禁止带入 hash/note ID 等内部 ID）",
          ),
        draft: z
          .string()
          .optional()
          .describe("tag=\"decision\" 时外发或共享内容修改必填：供用户在 Radar 卡片直接审阅和修改的完整预填草稿原文（保留换行和缩进）"),
      }),
      async execute({ cardId, tag, closureEvidence, title, target, impact, draft }, { agent, paseo }) {
        const targetCard = await loadWorkerTargetCard(engine, paseo, agent, cardId);
        if (!targetCard) {
          return { text: "未找到关联的 Radar 卡片", isError: true };
        }
        if (tag === "ready_to_archive") {
          const unfinishedSubs = await engine.coordination.getUnfinishedSubcardsForGate(targetCard.id);
          if (unfinishedSubs.length > 0) {
            const listStr = unfinishedSubs
              .slice(0, 6)
              .map((s) => `${s.id}[${s.status}]`)
              .join(", ");
            const more = unfinishedSubs.length > 6 ? ` 等 ${unfinishedSubs.length} 项` : "";
            return {
              text:
                `拒绝标记 ready_to_archive：当前卡片在协调模式下仍有未完结子卡（${listStr}${more}）。` +
                "请等待所有非取消子卡达到 archived 并完成最终集成验证后，再将父卡标为 ready_to_archive。",
              isError: true,
            };
          }
          const invalidReason = validateReadyToArchiveEvidence(closureEvidence);
          if (invalidReason) {
            void recordInsightEvent({
              type: "gate_rejected",
              at: new Date().toISOString(),
              reason: "invalid_evidence",
              cardId: targetCard.id,
            });
            await engine.setNeedsMeTag({
              cardId: targetCard.id,
              tag: "review",
              callerAgentId: agent.id,
              callerWorkspaceId: agent.workspaceId,
            });
            return { text: invalidReason, isError: true };
          }

          if (agent.cwd) {
            const state = await readRadarState();
            const baseline =
              (agent.workspaceId ? state.gitBaselines?.[agent.workspaceId] : undefined) ??
              state.gitBaselines?.[agent.id];
            const dirty = await findUncommittedSessionChanges(agent.cwd, baseline, closureEvidence);
            if (dirty) {
              void recordInsightEvent({
                type: "gate_rejected",
                at: new Date().toISOString(),
                reason: "uncommitted_git",
                cardId: targetCard.id,
              });
              await engine.setNeedsMeTag({
                cardId: targetCard.id,
                tag: "review",
                callerAgentId: agent.id,
                callerWorkspaceId: agent.workspaceId,
              });
              const preview = dirty.dirtyFiles.slice(0, 6).join(", ");
              const more = dirty.dirtyFiles.length > 6 ? ` 等 ${dirty.dirtyFiles.length} 个文件` : "";
              return {
                text:
                  `拒绝标记 ready_to_archive：当前 Git 工作区（分支 ${dirty.branch}）仍有未提交改动（${preview}${more}）。` +
                  "涉及仓库文件修改的任务完成验证后必须先执行 git commit（严禁添加工具署名或 Co-Authored-By），再重新调用 radar_set_needs_me_tag 标记 ready_to_archive；" +
                  "若当前位于团队共享仓库主分支不便直接提交，请先切个人分支提交，或改标 decision / review 交用户确认。",
                isError: true,
              };
            }
          }
        }
        void recordInsightEvent({
          type: "needs_me_tagged",
          at: new Date().toISOString(),
          tag,
          cardId: targetCard.id,
        });
        await engine.setNeedsMeTag({
          cardId: targetCard.id,
          tag,
          callerAgentId: agent.id,
          callerWorkspaceId: agent.workspaceId,
          title,
          target,
          impact,
          draft,
        });
        const hasDraft = tag === "decision" && Boolean(draft && draft.trim() !== "");
        return {
          text: hasDraft
            ? `已将卡片 ${targetCard.id} 标记为 decision，并附上可编辑待审草稿。请结束本轮等待用户在卡片确认。`
            : `已将卡片 ${targetCard.id} 标记为 ${tag}`,
        };
      },
    }),
  ];
}

export function buildCopilotTools(engine: RadarEngine): AgentToolDefinition[] {
  return [
    defineAgentTool({
      name: "radar_list_items",
      title: "查看 Radar 全部卡片与项目",
      description: "列出当前 Radar 收件箱中的所有卡片（待办池、等我处理、AI 处理中、等外部）、状态及可选项目列表。",
      input: z.object({ includeHidden: z.boolean().default(false) }),
      async execute({ includeHidden }, { paseo }) {
        const snap = await engine.loadSnapshot(paseo);
        const filtered = includeHidden
          ? snap.items
          : snap.items.filter((i) => i.visibility === "active" && i.status !== "archived");
        return {
          text: JSON.stringify(
            {
              lastScanAt: snap.lastScanAt,
              counts: snap.counts,
              projects: snap.projects,
              assignableModels: snap.resolvedModels?.assignableModels ?? [],
              items: filtered.map((i) => ({
                id: i.id,
                group: i.group,
                badge: i.badge,
                title: i.title,
                links: i.links,
                status: i.status,
                needsMeTag: i.needsMeTag,
                hasDecisionDraft: Boolean(i.decisionProposal?.draft),
                waitMode: i.waitMode,
                waitCondition: i.waitCondition,
                waitTimeoutAt: i.waitTimeoutAt,
                goal: i.goal,
                projectName: i.projectName,
                selectedModel: i.selectedModel,
                workspaceId: i.workspace?.workspaceId ?? null,
                prepSummary: i.workspace?.prepSummary ?? null,
              })),
            },
            null,
            2,
          ),
        };
      },
    }),
    defineAgentTool({
      name: "radar_create_card",
      title: "新建待办卡片并派发跟进",
      description:
        "当用户提出看板上尚不存在的新任务、新功能改造或先行外部调研需求时，创建新卡片并可选立即在目标项目下启动后台跟进。",
      input: z.object({
        title: z.string().min(1),
        summary: z.string().min(1),
        prompt: z.string().min(1),
        group: z.enum(["urgent", "closing", "todo"]).default("todo"),
        projectId: z.string().optional(),
        selectedModel: z.string().optional().describe("留空则自动使用用户配置的可分配默认模型；可从 radar_list_items 返回的 assignableModels 中按描述匹配选择"),
        isScout: z.boolean().default(false),
        needsWorktree: z.boolean().default(false),
        startInBackground: z.boolean().default(true),
      }),
      async execute(
        { title, summary, prompt, group, projectId, selectedModel, isScout, needsWorktree, startInBackground },
        { paseo },
      ) {
        const cleanTitle = title.trim();
        const cleanSummary = summary.trim();
        const cleanPrompt = prompt.trim();
        const incomingKeys = extractCanonicalEntityKeys({
          title: cleanTitle,
          summary: cleanSummary,
          prompt: cleanPrompt,
        });

        const incomingLinks = resolveItemLinks({
          title: cleanTitle,
          summary: cleanSummary,
          prompt: cleanPrompt,
        });

        const [snap, curState] = await Promise.all([engine.loadSnapshot(paseo), readRadarState()]);
        const rawById = new Map([...curState.customItems, ...curState.rawItems].map((r) => [r.id, r]));
        const duplicate = snap.items.find((card) => {
          if (card.visibility !== "active" || card.status === "archived") return false;
          if (isSameNormalizedTitle(card.title, cleanTitle)) return true;
          if (incomingKeys.size === 0) return false;
          const raw = rawById.get(card.id);
          const cardKeys = extractCanonicalEntityKeys({
            title: card.title,
            summary: card.summary,
            url: card.url,
            secondaryUrl: card.secondaryUrl,
            links: card.links,
            prompt: raw?.prepPrompt,
            relatedKeys: raw?.relatedKeys,
          });
          return setsIntersect(incomingKeys, cardKeys);
        });

        if (duplicate) {
          if (incomingLinks.length > 0) {
            await updateRadarState((s) => {
              const prev = s.meta[duplicate.id] ?? {};
              s.meta[duplicate.id] = {
                ...prev,
                extraLinks: mergeRadarLinks(prev.extraLinks, incomingLinks),
              };
            });
          }
          if (startInBackground && duplicate.workspace === null) {
            const started = await engine.followItem(paseo, { itemId: duplicate.id, mode: "background", note: "" });
            return {
              text: JSON.stringify(
                { reusedExistingCard: true, cardId: duplicate.id, title: duplicate.title, startedInBackground: true, ...started },
                null,
                2,
              ),
            };
          }
          return {
            text: JSON.stringify(
              {
                reusedExistingCard: true,
                cardId: duplicate.id,
                title: duplicate.title,
                status: duplicate.status,
                workspaceId: duplicate.workspace?.workspaceId ?? null,
              },
              null,
              2,
            ),
          };
        }

        const models = await engine.getModels(paseo);
        const chosenModel =
          selectedModel?.trim() ||
          models.resolved.assignableModels[0]?.model ||
          models.resolved.defaultWorkerModel;
        const id = `custom-${Date.now().toString(36)}`;
        const nowIso = new Date().toISOString();
        const relatedKeys = extractRelatedTokens(cleanTitle, cleanSummary, cleanPrompt);
        const newItem: RawScannedItem = {
          id,
          source: "custom",
          group,
          badge: isScout ? "先行调研" : "手动新建",
          title: cleanTitle,
          summary: cleanSummary,
          url: incomingLinks[0]?.url ?? "",
          secondaryUrl: null,
          links: incomingLinks,
          updatedAt: nowIso,
          stateHash: `custom:${id}`,
          relatedKeys,
          repoPath: null,
          existingBranch: null,
          branchSlug: id,
          recommendedModel: chosenModel,
          prepLabel: "后台跟进",
          workLabel: needsWorktree ? "新建分支开发 ↗" : "开会话处理",
          prepPrompt: cleanPrompt,
          workPrompt: cleanPrompt,
        };
        await updateRadarState((s) => {
          s.customItems.unshift(newItem);
          s.meta[id] = {
            selectedProjectId: projectId ?? null,
            selectedModel: chosenModel,
            notifyCopilotOnFinish: isScout,
          };
        });
        if (startInBackground) {
          const started = await engine.followItem(paseo, { itemId: id, mode: "background", note: "" });
          return { text: JSON.stringify({ cardId: id, startedInBackground: true, ...started }, null, 2) };
        }
        return { text: JSON.stringify({ cardId: id, startedInBackground: false }, null, 2) };
      },
    }),
    defineAgentTool({
      name: "radar_follow_background",
      title: "批量后台跟进",
      description: "为一个或多个待办池卡片在后台启动跟进会话。",
      input: z.object({
        itemIds: z.array(z.string().min(1)).min(1),
        note: z.string().default(""),
      }),
      async execute({ itemIds, note }, { paseo }) {
        const res = await engine.followBatchBackground(paseo, itemIds);
        if (note.trim() !== "") {
          for (const id of itemIds) {
            await engine.followItem(paseo, { itemId: id, mode: "background", note });
          }
        }
        return { text: JSON.stringify(res, null, 2) };
      },
    }),
    defineAgentTool({
      name: "radar_request_wait_external",
      title: "将会话转「等外部」意图发给卡片 AI 核查",
      description:
        "附上等待说明发给该卡片的 AI 会话：若已具备明确、可检查的完结动作，会话 AI 将转入「等外部」并由独立便宜评估模型定时检查；若条件不成熟，会话 AI 会留在「等我处理」向用户追问补充信息。",
      input: z.object({
        itemId: z.string().min(1),
        note: z.string().min(1),
      }),
      async execute({ itemId, note }, { paseo }) {
        const res = await engine.requestWaitExternal(paseo, { itemId, note });
        return {
          text: `已发给卡片会话 ${res.agentId} 核查完结条件；条件明确可检时将转入「等外部」，否则将停在「等我处理」请用户补充信息`,
        };
      },
    }),
    defineAgentTool({
      name: "radar_update_cards",
      title: "修改卡片状态、模型或归属项目",
      description:
        "批量更新卡片模型、归属项目，或将卡片切回 needs_me（注：转入等外部需调 radar_request_wait_external 或由工作会话调 radar_mark_waiting_external）。",
      input: z.object({
        itemIds: z.array(z.string().min(1)).min(1),
        status: z.enum(["needs_me"]).optional(),
        needsMeTag: NeedsMeTagSchema.nullable().optional(),
        selectedModel: z.string().optional(),
        projectId: z.string().optional(),
      }),
      async execute({ itemIds, status, needsMeTag, selectedModel, projectId }, { paseo }) {
        for (const itemId of itemIds) {
          await engine.updateCard(paseo, { itemId, status, needsMeTag, selectedModel, projectId });
        }
        return { text: `已更新 ${itemIds.length} 张卡片` };
      },
    }),
    defineAgentTool({
      name: "radar_archive_cards",
      title: "批量归档卡片及关联工作区",
      description: "归档一个或多个卡片，并同步归档其关联的 Paseo 工作区与对话。",
      input: z.object({ itemIds: z.array(z.string().min(1)).min(1) }),
      async execute({ itemIds }, { paseo }) {
        for (const id of itemIds) {
          await engine.archiveCardAndSession(paseo, id);
        }
        return { text: `已归档 ${itemIds.length} 张卡片及其关联工作区` };
      },
    }),
    defineAgentTool({
      name: "radar_snooze_items",
      title: "批量缓期待办池条目",
      description: "将未开会话的外部条目缓期（4h / tomorrow / next_monday）。",
      input: z.object({
        itemIds: z.array(z.string().min(1)).min(1),
        preset: SnoozePresetSchema,
      }),
      async execute({ itemIds, preset }) {
        let until = "";
        for (const id of itemIds) until = await engine.snoozeItem(id, preset);
        return { text: `已将 ${itemIds.length} 项缓期至 ${until}` };
      },
    }),
    defineAgentTool({
      name: "radar_dismiss_items",
      title: "批量忽略待办池条目",
      description: "隐藏未开会话的外部条目。",
      input: z.object({ itemIds: z.array(z.string().min(1)).min(1) }),
      async execute({ itemIds }) {
        for (const id of itemIds) await engine.dismissItem(id);
        return { text: `已忽略 ${itemIds.length} 项` };
      },
    }),
    defineAgentTool({
      name: "radar_update_rules",
      title: "更新过滤与偏好规则",
      description: "增删屏蔽关键词（mutedKeywords）或记录备忘（notes），更新后自动重扫。",
      input: z.object({
        addMutedKeywords: z.array(z.string()).default([]),
        removeMutedKeywords: z.array(z.string()).default([]),
        addNote: z.string().default(""),
      }),
      async execute({ addMutedKeywords, removeMutedKeywords, addNote }) {
        const updated = await updateRadarRules((rules) => {
          const kw = new Set(rules.mutedKeywords);
          for (const k of addMutedKeywords) if (k.trim()) kw.add(k.trim());
          for (const k of removeMutedKeywords) kw.delete(k.trim());
          rules.mutedKeywords = [...kw];
          if (addNote.trim()) rules.notes.push(addNote.trim());
        });
        await engine.scan();
        return { text: JSON.stringify(updated, null, 2) };
      },
    }),
    defineAgentTool({
      name: "radar_list_collectors",
      title: "查看外挂采集脚本列表与运行状态",
      description:
        "列出 ~/.paseo/plugin-data/paseo-radar/collectors/ 下的 uv Python 采集脚本、SPEC.md 与 config.json 路径，以及最近一次扫描的耗时、条目数与报错信息。",
      input: z.object({}),
      async execute() {
        const info = await listCollectorScripts();
        return { text: JSON.stringify(info, null, 2) };
      },
    }),
    defineAgentTool({
      name: "radar_test_collector",
      title: "干跑测试单个外挂采集脚本",
      description:
        "使用 uv run 干跑指定的采集脚本（传入文件名如 github.py 或绝对路径），校验 stdout JSON 是否符合 SPEC.md 协议并返回采样条目，不会污染正式看板状态。",
      input: z.object({
        script: z.string().min(1).describe("collectors 目录下的脚本文件名（如 github.py）或脚本绝对路径"),
      }),
      async execute({ script }, { paseo }) {
        const cfg = await engine.getModels(paseo);
        const res = await testCollectorScript(script, cfg.timezone);
        return {
          text: JSON.stringify(res, null, 2),
          isError: !res.ok,
        };
      },
    }),
    defineAgentTool({
      name: "radar_rescan",
      title: "立即重新扫描外部待办",
      description: "立即运行外部采集脚本刷新待办列表。",
      input: z.object({}),
      async execute(_input, { paseo }) {
        await engine.scan();
        const snap = await engine.loadSnapshot(paseo);
        return { text: JSON.stringify({ lastScanAt: snap.lastScanAt, counts: snap.counts, scanErrors: snap.scanErrors }, null, 2) };
      },
    }),
  ];
}

const BoardWatchSubcardInputSchema = z.object({
  targets: z
    .array(
      z.object({
        cardId: z.string().min(1),
        status: CardStatusSchema.default("archived"),
        needsMeTag: NeedsMeTagSchema.nullable().optional(),
      }),
    )
    .min(1),
  match: z.enum(["all", "any"]).default("all"),
});

export function buildCoordinatorTools(engine: RadarEngine): AgentToolDefinition[] {
  return [
    defineAgentTool({
      name: "radar_coord_plan",
      title: "编排协调子卡",
      description:
        "启用协调模式并创建/更新/取消内部子卡（DAG）。调研用 readonly，改代码用 worktree；可先调 radar_coord_manage(action=\"models\") 匹配 selectedModel；用 refCards/waitBoard 串联上下游。",
      input: z.object({
        cardId: z.string().optional(),
        create: z
          .array(
            z.object({
              id: z.string().min(1),
              wave: z.number().int().min(1).optional(),
              title: z.string().min(1),
              objective: z.string().min(1),
              isolation: z.enum(["readonly", "worktree"]).default("readonly").describe("readonly|worktree"),
              selectedModel: z
                .string()
                .nullable()
                .optional()
                .describe("provider/model 或模型名/ID"),
              refCards: z.array(z.string()).optional().describe("上游子卡 ID（按需读取指针）"),
              requireReview: z.boolean().default(false).describe("true=需协调者验收后归档"),
              verifyCommand: z.string().nullable().optional().describe("自归档前验收命令"),
              waitBoard: BoardWatchSubcardInputSchema.nullable().optional().describe("满足后自动拉起"),
              startNow: z.boolean().default(true),
            }),
          )
          .optional(),
        update: z
          .array(
            z.object({
              id: z.string().min(1),
              title: z.string().optional(),
              objective: z.string().optional(),
              wave: z.number().int().min(1).optional(),
              refCards: z.array(z.string()).optional(),
              requireReview: z.boolean().optional(),
              verifyCommand: z.string().nullable().optional(),
              waitBoard: BoardWatchSubcardInputSchema.nullable().optional(),
              startNow: z.boolean().optional(),
            }),
          )
          .optional(),
        cancelIds: z.array(z.string().min(1)).optional(),
      }),
      async execute({ cardId, create, update, cancelIds }, { agent, paseo }) {
        const targetCard = await loadWorkerTargetCard(engine, paseo, agent, cardId);
        if (!targetCard) {
          return { text: "未找到关联的 Radar 父卡", isError: true };
        }
        return engine.coordination.planSubcards({
          parentCardId: targetCard.id,
          callerAgentId: agent.id,
          create,
          update,
          cancelIds,
        });
      },
    }),
    defineAgentTool({
      name: "radar_coord_manage",
      title: "管理协调子卡",
      description:
        "查询或干预内部子卡：models（可选模型）/list/get_card/start/reply/archive/events。",
      input: z.object({
        cardId: z.string().optional(),
        action: z.enum(["models", "list", "get_card", "start", "reply", "archive", "events"]),
        subcardId: z.string().optional().describe("目标子卡 ID"),
        text: z.string().optional().describe("回复或附加说明"),
        limit: z.number().int().min(1).max(200).optional(),
      }),
      async execute({ cardId, action, subcardId, text, limit }, { agent, paseo }) {
        const targetCard = await loadWorkerTargetCard(engine, paseo, agent, cardId);
        if (!targetCard) {
          return { text: "未找到关联的 Radar 父卡", isError: true };
        }
        return engine.coordination.coordinatorManage({
          parentCardId: targetCard.id,
          action,
          subcardId,
          text,
          limit,
        });
      },
    }),
  ];
}

async function resolveSubcardCaller(
  paseo: Parameters<RadarEngine["loadSnapshot"]>[0],
  agentId: string,
): Promise<{ parentCardId: string; subcardId: string } | null> {
  const res = await paseo.agents.ref(agentId).refresh().catch(() => null);
  const labels = res?.agent?.labels;
  const parentCardId = labels?.[RADAR_LABELS.parentCard]?.trim();
  const subcardId = labels?.[RADAR_LABELS.subcard]?.trim();
  if (!parentCardId || !subcardId) return null;
  return { parentCardId, subcardId };
}

export function buildSubcardTools(engine: RadarEngine): AgentToolDefinition[] {
  return [
    defineAgentTool({
      name: "radar_complete_subcard",
      title: "通过门禁并自主完结归档当前子卡",
      description:
        "当本子卡任务已完成且验收通过时调用。系统会自动执行三道门禁校验（1. closureEvidence 具体有效；2. worktree 子卡已 git commit 无未提交改动；3. 配置了 verifyCommand 时执行通过）。" +
        "通过后自动扫描你的专属产出目录清单并归档子卡（保留 Git 分支供合流），同步触发等待本子卡的下游子卡，无需主协调者介入。",
      input: z.object({
        closureEvidence: z
          .string()
          .min(1)
          .describe("一句话写明客观完结证据（如单测/命令结果、根因结论或产物文件路径）"),
        artifactNotes: z
          .record(z.string(), z.string())
          .optional()
          .describe("可选：为产出目录中的文件名/相对路径附上简短说明，便于下游按需挑选读取"),
      }),
      async execute({ closureEvidence, artifactNotes }, { agent, paseo }) {
        const caller = await resolveSubcardCaller(paseo, agent.id);
        if (!caller) {
          return { text: "未识别到子卡上下文标签", isError: true };
        }
        return engine.coordination.completeSubcard({
          parentCardId: caller.parentCardId,
          subcardId: caller.subcardId,
          callerAgent: {
            id: agent.id,
            workspaceId: agent.workspaceId,
            cwd: agent.cwd ?? null,
          },
          closureEvidence,
          artifactNotes,
        });
      },
    }),
    defineAgentTool({
      name: "radar_mark_waiting_external",
      title: "将当前子卡转入等待状态（支持外部脚本/AI 巡检与同看板事件监听）",
      description:
        "支持三种等待模式：\n- mode=\"script\"（0 token 定时只读脚本：exit 0 达标，exit 10 继续等）\n- mode=\"ai\"（独立 wait-evaluator 模型定期只读检查）\n- mode=\"board\"（事件驱动监听同看板前置子卡达到目标状态）\n达标或超时后直接唤醒本子卡继续执行。",
      input: z.object({
        mode: z.enum(["script", "ai", "board"]),
        condition: z.string().optional(),
        cron: z.string().optional(),
        maxTimeout: z.string().optional(),
        script: z.string().optional(),
        checkPrompt: z.string().optional(),
        watch: z
          .object({
            targets: z
              .array(
                z.object({
                  cardId: z.string().min(1),
                  status: CardStatusSchema.default("archived"),
                  needsMeTag: NeedsMeTagSchema.nullable().optional(),
                }),
              )
              .min(1),
            match: z.enum(["all", "any"]).default("all"),
          })
          .optional(),
      }),
      async execute({ mode, condition, cron, maxTimeout, script, checkPrompt, watch }, { agent, paseo }) {
        const caller = await resolveSubcardCaller(paseo, agent.id);
        if (!caller) {
          return { text: "未识别到子卡上下文标签", isError: true };
        }
        return engine.coordination.enterSubcardWaiting({
          parentCardId: caller.parentCardId,
          subcardId: caller.subcardId,
          callerAgentId: agent.id,
          mode,
          condition,
          cron,
          maxTimeout,
          script,
          checkPrompt,
          watch,
        });
      },
    }),
    defineAgentTool({
      name: "radar_set_needs_me_tag",
      title: "将当前子卡标记为待协调者处理（decision / input / review）",
      description:
        "当子卡遇到方案分歧需要拍板（decision）、缺少关键信息（input）或需要阶段同步（review）时调用，系统会立即通知主协调者介入。注意：子卡正常结单归档请调用 radar_complete_subcard。",
      input: z.object({
        tag: NeedsMeTagSchema,
        title: z.string().optional(),
        target: z.string().optional(),
        impact: z.string().optional(),
        draft: z.string().optional(),
      }),
      async execute({ tag, title, target, impact, draft }, { agent, paseo }) {
        const caller = await resolveSubcardCaller(paseo, agent.id);
        if (!caller) {
          return { text: "未识别到子卡上下文标签", isError: true };
        }
        return engine.coordination.setSubcardNeedsMeTag({
          parentCardId: caller.parentCardId,
          subcardId: caller.subcardId,
          callerAgentId: agent.id,
          tag,
          title,
          target,
          impact,
          draft,
        });
      },
    }),
    defineAgentTool({
      name: "radar_attach_links",
      title: "为当前子卡登记关联链接",
      description: "将本子卡产出的完整外部 URL（MR/PR、文档、构建链接等）挂载到子卡元数据中。",
      input: z.object({
        links: z
          .array(
            z.object({
              url: z.string().min(1),
              label: z.string().optional(),
              kind: RadarLinkKindSchema.optional(),
            }),
          )
          .min(1),
      }),
      async execute({ links }, { agent, paseo }) {
        const caller = await resolveSubcardCaller(paseo, agent.id);
        if (!caller) {
          return { text: "未识别到子卡上下文标签", isError: true };
        }
        return engine.coordination.attachSubcardLinks({
          parentCardId: caller.parentCardId,
          subcardId: caller.subcardId,
          links,
        });
      },
    }),
    defineAgentTool({
      name: "subradar_inspect",
      title: "按需查看同看板兄弟子卡状态与产物路径清单",
      description:
        "只读查看同父卡下的内部子看板概览（board）或指定子卡的详细结论、Git 分支与产物文件绝对路径清单（get_card），拿到路径后用原生文件工具按需读取所需文件。",
      input: z.object({
        action: z.enum(["board", "get_card"]),
        subcardId: z.string().optional().describe("action=\"get_card\" 时必填"),
      }),
      async execute({ action, subcardId }, { agent, paseo }) {
        const caller = await resolveSubcardCaller(paseo, agent.id);
        if (!caller) {
          return { text: "未识别到子卡上下文标签", isError: true };
        }
        return engine.coordination.inspectSubcardBoard({
          parentCardId: caller.parentCardId,
          action,
          targetSubcardId: subcardId,
        });
      },
    }),
    defineAgentTool({
      name: "subradar_message_peer",
      title: "向同看板兄弟子卡发送受控 P2P 消息",
      description:
        "并行协作期间向另一个未归档的兄弟子卡直接问询或通知，无需经过主协调者。对方运行中时实时投递，未启动/等待中时存入其 Inbox。每对子卡最多交互 4 轮，超出上限或出现方案分歧时请调 radar_set_needs_me_tag(tag=\"decision\") 升级给协调者。",
      input: z.object({
        toSubcardId: z.string().min(1),
        kind: z.enum(["question", "notify"]).default("question"),
        message: z.string().min(1),
      }),
      async execute({ toSubcardId, kind, message }, { agent, paseo }) {
        const caller = await resolveSubcardCaller(paseo, agent.id);
        if (!caller) {
          return { text: "未识别到子卡上下文标签", isError: true };
        }
        return engine.coordination.messagePeer({
          parentCardId: caller.parentCardId,
          fromSubcardId: caller.subcardId,
          toSubcardId,
          kind,
          message,
        });
      },
    }),
  ];
}
