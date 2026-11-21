import { randomUUID } from "node:crypto";
import { resolveEffectiveTimeZone } from "./wait-utils";

interface Frame {
  type?: unknown;
  isBinary?: unknown;
  data?: unknown;
}

interface SessionResponse {
  type?: unknown;
  message?: {
    type?: unknown;
    payload?: {
      requestId?: unknown;
      accepted?: unknown;
      error?: unknown;
      code?: unknown;
      schedule?: { id?: unknown } | null;
      scheduleId?: unknown;
    };
  };
}

function sendSessionRequest<TPayload extends NonNullable<NonNullable<SessionResponse["message"]>["payload"]>>(
  responseType: string,
  requestId: string,
  message: Record<string, unknown>,
  timeoutMs: number,
  timeoutHint: string,
): Promise<TPayload> {
  const send = process.send?.bind(process);
  if (!send) {
    return Promise.reject(new Error("当前插件进程无法连接 Paseo IPC 通道"));
  }

  return new Promise((resolve, reject) => {
    function finish(): void {
      clearTimeout(timer);
      process.off("message", listen);
    }
    function listen(raw: unknown): void {
      const frame = raw as Frame | null;
      if (!frame || typeof frame !== "object") return;
      if (frame.type !== "paseo_frame" || frame.isBinary !== false || typeof frame.data !== "string") return;
      try {
        const parsed = JSON.parse(frame.data) as SessionResponse;
        if (parsed.type !== "session" || !parsed.message) return;
        const payload = parsed.message.payload;
        if (parsed.message.type === "rpc_error" && payload?.requestId === requestId) {
          finish();
          const errText =
            typeof payload.error === "string" && payload.error ? payload.error : "Daemon RPC error";
          reject(new Error(errText));
          return;
        }
        if (parsed.message.type !== responseType) return;
        if (payload?.requestId !== requestId) return;
        finish();
        resolve(payload as TPayload);
      } catch {
        // Ignore unrelated frames
      }
    }
    const timer = setTimeout(() => {
      finish();
      reject(new Error(timeoutHint));
    }, timeoutMs);

    process.on("message", listen);
    try {
      send({
        type: "paseo_frame",
        isBinary: false,
        data: JSON.stringify({
          type: "session",
          message: {
            ...message,
            requestId,
          },
        }),
      });
    } catch (err) {
      finish();
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

function splitProviderAndModel(fullModel: string): { provider: string; model?: string } {
  const trimmed = fullModel.trim();
  const slashIdx = trimmed.indexOf("/");
  if (slashIdx === -1) return { provider: trimmed || "pi" };
  const provider = trimmed.slice(0, slashIdx);
  const model = trimmed.slice(slashIdx + 1);
  return model ? { provider, model } : { provider };
}

export async function setLiveAgentModel(
  agentId: string,
  agentProvider: string,
  fullModel: string,
  timeoutMs = 8000,
): Promise<void> {
  const slashIdx = fullModel.indexOf("/");
  const targetProvider = slashIdx !== -1 ? fullModel.slice(0, slashIdx) : agentProvider;
  const modelId = slashIdx !== -1 ? fullModel.slice(slashIdx + 1) : fullModel;

  if (targetProvider && agentProvider && targetProvider !== agentProvider) {
    throw new Error(`已有对话的 Provider 为 "${agentProvider}"，无法直接跨 Provider 切换为 "${targetProvider}" 模型`);
  }

  const payload = await sendSessionRequest(
    "set_agent_model_response",
    `radar-model-${randomUUID()}`,
    {
      type: "set_agent_model_request",
      agentId,
      modelId,
    },
    timeoutMs,
    "切换对话模型超时，请先点进会话唤醒后再试",
  );

  if (payload.accepted === false) {
    const reason = typeof payload.error === "string" && payload.error ? payload.error : "当前会话状态不支持切换该模型";
    throw new Error(reason);
  }
}

export async function createDaemonSchedule(input: {
  name: string;
  prompt: string;
  cron: string;
  fullModel: string;
  cwd: string;
  expiresAt?: string;
  timezone?: string;
  timeoutMs?: number;
}): Promise<{ scheduleId: string }> {
  const { provider, model } = splitProviderAndModel(input.fullModel);
  const payload = await sendSessionRequest(
    "schedule/create/response",
    `radar-sched-create-${randomUUID()}`,
    {
      type: "schedule/create",
      name: input.name,
      prompt: input.prompt,
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      cadence: {
        type: "cron",
        expression: input.cron.trim(),
        timezone: resolveEffectiveTimeZone(input.timezone),
      },
      target: {
        type: "new-agent",
        config: {
          provider,
          ...(model ? { model } : {}),
          cwd: input.cwd,
          thinkingOptionId: "low",
          archiveOnFinish: true,
        },
      },
    },
    input.timeoutMs ?? 8000,
    "创建定时巡检任务超时",
  );

  if (typeof payload.error === "string" && payload.error) {
    throw new Error(payload.error);
  }
  const scheduleId = payload.schedule?.id;
  if (typeof scheduleId !== "string" || !scheduleId) {
    throw new Error("创建定时巡检任务失败：未返回 scheduleId");
  }
  return { scheduleId };
}

export async function deleteDaemonSchedule(scheduleId: string, timeoutMs = 8000): Promise<void> {
  if (!scheduleId) return;
  const payload = await sendSessionRequest(
    "schedule/delete/response",
    `radar-sched-del-${randomUUID()}`,
    {
      type: "schedule/delete",
      scheduleId,
    },
    timeoutMs,
    "删除定时巡检任务超时",
  );
  if (typeof payload.error === "string" && payload.error && !payload.error.toLowerCase().includes("not found")) {
    throw new Error(payload.error);
  }
}

export async function sendDaemonAgentMessage(
  agentId: string,
  text: string,
  activeTurnBehavior: "steer" | "interrupt" = "steer",
  timeoutMs = 10_000,
): Promise<void> {
  const payload = await sendSessionRequest(
    "send_agent_message_response",
    `radar-send-${randomUUID()}`,
    {
      type: "send_agent_message_request",
      agentId,
      text,
      messageId: randomUUID(),
      activeTurnBehavior,
    },
    timeoutMs,
    "唤醒原会话超时",
  );
  if (payload.accepted === false) {
    const reason = typeof payload.error === "string" && payload.error ? payload.error : "原会话拒绝接收唤醒消息";
    throw new Error(reason);
  }
}
