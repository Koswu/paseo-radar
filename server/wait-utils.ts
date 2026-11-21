import type { SnoozePreset } from "../shared/radar";

const MIN_TIMEOUT_MS = 60 * 1000; // 1m
const MAX_TIMEOUT_MS = 30 * 24 * 3600 * 1000; // 30d

const WEEKDAY_MAP: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export function isValidTimeZone(tz: string): boolean {
  const trimmed = tz.trim();
  if (!trimmed) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: trimmed });
    return true;
  } catch {
    return false;
  }
}

export function resolveEffectiveTimeZone(preferred?: string | null): string {
  if (preferred && isValidTimeZone(preferred)) {
    return preferred.trim();
  }
  try {
    const sys = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (sys && isValidTimeZone(sys)) return sys;
  } catch {
    // Fallback below
  }
  return "UTC";
}

export function parseMaxTimeoutMs(raw: string): number | null {
  const input = raw.trim().toLowerCase();
  if (!input) return null;

  if (/^\d+$/.test(input)) {
    const mins = Number(input);
    const ms = mins * 60 * 1000;
    return ms >= MIN_TIMEOUT_MS && ms <= MAX_TIMEOUT_MS ? ms : null;
  }

  const tokenRe =
    /(\d+(?:\.\d+)?)\s*(d|day|days|天|h|hr|hrs|hour|hours|小时|m|min|mins|minute|minutes|分|分钟|s|sec|secs|秒)/g;
  let totalMs = 0;
  let matchedLen = 0;
  let m: RegExpExecArray | null;

  while ((m = tokenRe.exec(input)) !== null) {
    const val = Number(m[1]);
    const unit = m[2];
    if (!Number.isFinite(val) || val <= 0) return null;
    matchedLen += m[0].length;
    if (unit === "d" || unit === "day" || unit === "days" || unit === "天") {
      totalMs += val * 86400 * 1000;
    } else if (
      unit === "h" ||
      unit === "hr" ||
      unit === "hrs" ||
      unit === "hour" ||
      unit === "hours" ||
      unit === "小时"
    ) {
      totalMs += val * 3600 * 1000;
    } else if (
      unit === "m" ||
      unit === "min" ||
      unit === "mins" ||
      unit === "minute" ||
      unit === "minutes" ||
      unit === "分" ||
      unit === "分钟"
    ) {
      totalMs += val * 60 * 1000;
    } else {
      totalMs += val * 1000;
    }
  }

  const stripped = input.replace(/\s+/g, "");
  if (
    matchedLen === 0 ||
    (stripped.length !== matchedLen.valueOf() && input.replace(tokenRe, "").trim() !== "")
  ) {
    return null;
  }

  const rounded = Math.round(totalMs);
  if (rounded < MIN_TIMEOUT_MS || rounded > MAX_TIMEOUT_MS) return null;
  return rounded;
}

function parseCronField(
  field: string,
  min: number,
  max: number,
  normalizeSevenToZero = false,
): Set<number> | null {
  const out = new Set<number>();
  const parts = field.split(",");
  for (const rawPart of parts) {
    const part = rawPart.trim();
    if (!part) return null;

    const slashParts = part.split("/");
    if (slashParts.length > 2) return null;
    const rangeStr = slashParts[0]!;
    const step = slashParts[1] !== undefined ? Number(slashParts[1]) : 1;
    if (!Number.isInteger(step) || step <= 0) return null;

    let start = min;
    let end = max;
    if (rangeStr !== "*") {
      if (rangeStr.includes("-")) {
        const [aStr, bStr, extra] = rangeStr.split("-");
        if (extra !== undefined || !aStr || !bStr) return null;
        start = Number(aStr);
        end = Number(bStr);
      } else {
        start = Number(rangeStr);
        end = slashParts[1] !== undefined ? max : start;
      }
    }

    if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
    if (start < min || end > max || start > end) return null;

    for (let v = start; v <= end; v += step) {
      out.add(normalizeSevenToZero && v === 7 ? 0 : v);
    }
  }
  return out.size > 0 ? out : null;
}

export interface ParsedCron5 {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  domWildcard: boolean;
  dowWildcard: boolean;
}

export function parseCron5(expr: string): ParsedCron5 | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const minutes = parseCronField(fields[0]!, 0, 59);
  const hours = parseCronField(fields[1]!, 0, 23);
  const daysOfMonth = parseCronField(fields[2]!, 1, 31);
  const months = parseCronField(fields[3]!, 1, 12);
  const daysOfWeek = parseCronField(fields[4]!, 0, 7, true);
  if (!minutes || !hours || !daysOfMonth || !months || !daysOfWeek) return null;
  return {
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    domWildcard: fields[2] === "*",
    dowWildcard: fields[4] === "*",
  };
}

export function minuteSlotInTimeZone(
  timeZone?: string | null,
  nowMs = Date.now(),
): {
  slotKey: string;
  year: number;
  month: number;
  dayOfMonth: number;
  hour: number;
  minute: number;
  dayOfWeek: number;
} {
  const tz = resolveEffectiveTimeZone(timeZone);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  });
  const parts = fmt.formatToParts(new Date(nowMs));
  const byType: Record<string, string> = {};
  for (const p of parts) {
    if (p.type !== "literal") byType[p.type] = p.value;
  }
  const year = Number(byType.year ?? 1970);
  const month = Number(byType.month ?? 1);
  const dayOfMonth = Number(byType.day ?? 1);
  const rawHour = Number(byType.hour ?? 0);
  const hour = rawHour === 24 ? 0 : rawHour;
  const minute = Number(byType.minute ?? 0);
  const dayOfWeek = WEEKDAY_MAP[byType.weekday ?? "Sun"] ?? 0;
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    slotKey: `${year}-${pad(month)}-${pad(dayOfMonth)}T${pad(hour)}:${pad(minute)}`,
    year,
    month,
    dayOfMonth,
    hour,
    minute,
    dayOfWeek,
  };
}

export function matchesCron5InTimeZone(
  expr: string,
  timeZone?: string | null,
  nowMs = Date.now(),
): boolean {
  const parsed = parseCron5(expr);
  if (!parsed) return false;
  const t = minuteSlotInTimeZone(timeZone, nowMs);
  if (
    !parsed.minutes.has(t.minute) ||
    !parsed.hours.has(t.hour) ||
    !parsed.months.has(t.month)
  ) {
    return false;
  }
  const domMatch = parsed.daysOfMonth.has(t.dayOfMonth);
  const dowMatch = parsed.daysOfWeek.has(t.dayOfWeek);
  if (!parsed.domWildcard && !parsed.dowWildcard) {
    return domMatch || dowMatch;
  }
  return domMatch && dowMatch;
}

/** Convert a wall-clock time (year, month 1..12, day, hour, minute) in `timeZone` to UTC ms */
function wallTimeToUtcMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  const naiveUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  let guess = naiveUtc;
  for (let i = 0; i < 2; i++) {
    const actual = minuteSlotInTimeZone(timeZone, guess);
    const actualAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.dayOfMonth,
      actual.hour,
      actual.minute,
      0,
    );
    guess += naiveUtc - actualAsUtc;
  }
  return guess;
}

export function computeSnoozeUntilInTimeZone(
  preset: SnoozePreset,
  timeZone?: string | null,
  now = new Date(),
): string {
  if (preset === "4h") {
    return new Date(now.getTime() + 4 * 3600 * 1000).toISOString();
  }
  const tz = resolveEffectiveTimeZone(timeZone);
  const cur = minuteSlotInTimeZone(tz, now.getTime());
  let addDays = 1;
  if (preset === "next_monday") {
    addDays = cur.dayOfWeek === 0 ? 1 : 8 - cur.dayOfWeek;
  }
  const targetMs = wallTimeToUtcMs(cur.year, cur.month, cur.dayOfMonth + addDays, 9, 30, tz);
  return new Date(targetMs).toISOString();
}

export const WAIT_SCRIPT_PENDING_EXIT_CODE = 10;
export const WAIT_SCRIPT_MAX_CONSECUTIVE_ERRORS = 3;
export const WAIT_SCRIPT_RETRY_BACKOFF_MS = 30 * 1000;
export const WAIT_SCRIPT_FAST_FAIL_CODES = new Set([2, 126, 127]);

/** Checks whether a wait script explicitly uses the dedicated pending exit code (exit 10). */
export function hasWaitPendingExitCode(scriptBody: string): boolean {
  return /(?:^|[\s;|&(])(?:exit|return)\s+10(?:\b|$)/m.test(scriptBody);
}

export interface WaitScriptFailureClassification {
  kind: "pending" | "fast_fail" | "transient";
  exitCode: number | null;
  threshold: number;
  statusTag: string;
}

/** Classifies a non-zero wait script exit into normal pending (10), deterministic fast-fail (2/126/127), or transient error. */
export function classifyWaitScriptFailure(err: {
  code?: unknown;
  killed?: boolean;
}): WaitScriptFailureClassification {
  if (!err.killed && err.code === WAIT_SCRIPT_PENDING_EXIT_CODE) {
    return {
      kind: "pending",
      exitCode: WAIT_SCRIPT_PENDING_EXIT_CODE,
      threshold: 0,
      statusTag: `exit ${WAIT_SCRIPT_PENDING_EXIT_CODE}`,
    };
  }
  if (!err.killed && typeof err.code === "number" && WAIT_SCRIPT_FAST_FAIL_CODES.has(err.code)) {
    return {
      kind: "fast_fail",
      exitCode: err.code,
      threshold: 1,
      statusTag: `exit ${err.code}`,
    };
  }
  const exitCode = typeof err.code === "number" ? err.code : null;
  return {
    kind: "transient",
    exitCode,
    threshold: WAIT_SCRIPT_MAX_CONSECUTIVE_ERRORS,
    statusTag: err.killed ? "脚本超时" : exitCode !== null ? `exit ${exitCode}` : "执行异常",
  };
}
