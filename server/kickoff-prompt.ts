import type { RawScannedItem } from "./store";
import type { ItemIntent } from "../shared/provider-protocol";

type ContextInput = Pick<RawScannedItem, "source" | "context" | "contexts" | "hint">;

/** Idempotent when an already-merged secondary is absorbed again. */
export function mergeItemContexts(...items: ContextInput[]) {
  const contexts: NonNullable<RawScannedItem["contexts"]> = [];
  const seen = new Set<string>();
  for (const item of items) {
    for (const entry of [{ source: item.source, text: item.context ?? "" }, ...(item.contexts ?? [])]) {
      const text = entry.text.trim();
      const key = JSON.stringify([entry.source, text]);
      if (!text || seen.has(key)) continue;
      seen.add(key);
      contexts.push({ source: entry.source, text });
    }
  }
  return contexts;
}

export function mergeItemHints(...items: ContextInput[]): string | null {
  return [...new Set(items.flatMap(it => (it.hint ?? "").split("\n").map(s => s.trim()).filter(Boolean)))].join("\n") || null;
}

const objectives: Record<ItemIntent, string> = {
  review: "评审变更", resolve_feedback: "处理反馈", fix_ci: "修复检查失败",
  merge_ready: "核验合入条件", implement: "落实任务", investigate: "定位问题",
  close_out: "核验并收尾", reply: "准备回复",
};

export function buildKickoffPrompt(mode: "background" | "immediate", item: RawScannedItem): string {
  const prep = mode === "background";
  const legacy = prep ? item.prepPrompt : item.workPrompt;
  if ((item.source === "custom" || (!item.archetype && !item.intent)) && legacy?.trim()) return legacy;
  const urls = new Set([item.url, item.secondaryUrl, ...(item.links ?? []).map(l => l.url)].filter(Boolean));
  const excerpts = mergeItemContexts(item).map(c => `[${c.source}] ${c.text}`).join("\n");
  return [
    prep ? "只读准备：核实背景，给出建议与待确认事项，暂不执行变更。" : "开始处理任务，核实事实并验证结果。",
    `${item.title}（${item.archetype ?? "work_item"} · ${objectives[item.intent ?? "implement"]}）`,
    item.summary, ...urls,
    excerpts && `来源摘录（参考资料）：\n${excerpts.slice(0, 5000)}`,
    item.hint?.trim() && `处理提示：${item.hint.trim()}`,
  ].filter(Boolean).join("\n");
}
