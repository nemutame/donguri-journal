/**
 * BuJo lens — read-only Bullet Journal projections over the view-neutral core
 * (DESIGN §6). No BuJo marker exists in the data; every glyph is derived from
 * the generic annotations (`nature` / `status` / `granularity`) and from
 * `continues` links. The four tools never write.
 *
 * Opt-in: registered through the feature toggle (see modules/features.ts), not
 * unconditionally. Depends only on the kernel context, so it can later be
 * extracted into an external plugin unchanged.
 */
import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Entry, JournalStore } from "../db/store.js";
import type { JournalContext } from "../kernel/context.js";
import { jsonResult } from "../kernel/result.js";

const DAY_MS = 86_400_000;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** UTC window (inclusive bounds for store.query) of one local calendar day. */
export function dayWindowUtc(
  date: string,
  tzOffsetMinutes: number,
): { since: string; until: string } {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const start = Date.UTC(y, m - 1, d) - tzOffsetMinutes * 60_000;
  return {
    since: new Date(start).toISOString(),
    until: new Date(start + DAY_MS - 1).toISOString(),
  };
}

/** UTC window (inclusive bounds) of one local calendar month ("YYYY-MM"). */
export function monthWindowUtc(
  ym: string,
  tzOffsetMinutes: number,
): { since: string; until: string } {
  const [y, m] = ym.split("-").map(Number) as [number, number];
  const start = Date.UTC(y, m - 1, 1) - tzOffsetMinutes * 60_000;
  const end = Date.UTC(y, m, 1) - tzOffsetMinutes * 60_000;
  return { since: new Date(start).toISOString(), until: new Date(end - 1).toISOString() };
}

/** The local calendar date ("YYYY-MM-DD") an instant falls on. */
export function localDate(iso: string, tzOffsetMinutes: number): string {
  return new Date(Date.parse(iso) + tzOffsetMinutes * 60_000).toISOString().slice(0, 10);
}

/** The local calendar month ("YYYY-MM") an instant falls on. */
export function localYm(iso: string, tzOffsetMinutes: number): string {
  return localDate(iso, tzOffsetMinutes).slice(0, 7);
}

function granularity(entry: Entry): "day" | "month" {
  return entry.meta.granularity === "month" ? "month" : "day";
}

export interface BujoItem {
  id: number;
  kind: "task" | "event" | "note";
  /** BuJo prefix: • x > < ○ – ("~" = dropped; render the body struck through). */
  glyph: string;
  body: string;
  occurred_at: string;
  status?: string;
  priority?: true;
  due?: string;
  delegated_to?: string;
  /** How many times this line has been carried over (length of the continues chain behind it). */
  carry_count?: number;
  /** Where an open action was carried to (set when glyph is '>' or '<'). */
  moved_to?: { id: number; occurred_at: string; granularity: "day" | "month" };
}

/** Derive the BuJo glyph + fields for one entry. Read-only; walks links. */
export function projectItem(store: JournalStore, entry: Entry, tzOffsetMinutes: number): BujoItem {
  const nature = entry.meta.nature;
  const kind: BujoItem["kind"] =
    nature === "action" ? "task" : nature === "event" ? "event" : "note";

  const item: BujoItem = {
    id: entry.id,
    kind,
    glyph: kind === "event" ? "○" : "–",
    body: entry.body,
    occurred_at: entry.occurred_at,
  };
  if (entry.meta.priority === true) item.priority = true;
  if (typeof entry.meta.due === "string") item.due = entry.meta.due;
  if (typeof entry.meta.delegated_to === "string") item.delegated_to = entry.meta.delegated_to;

  if (kind !== "task") return item;

  const status = typeof entry.meta.status === "string" ? entry.meta.status : "open";
  item.status = status;
  item.carry_count = carryCount(store, entry.id);

  if (status === "done") {
    item.glyph = "x";
    return item;
  }
  if (status === "dropped") {
    item.glyph = "~";
    return item;
  }
  // Open: carried over iff a live successor `continues` this entry. The glyph
  // is derived from where the successor lives — a future month (month
  // granularity) means "scheduled into the future log" (<), anything else is a
  // plain migration (>).
  const successor = liveSuccessor(store, entry.id);
  if (!successor) {
    item.glyph = "•";
    return item;
  }
  const successorGran = granularity(successor);
  const scheduled =
    successorGran === "month" &&
    localYm(successor.occurred_at, tzOffsetMinutes) > localYm(entry.occurred_at, tzOffsetMinutes);
  item.glyph = scheduled ? "<" : ">";
  item.moved_to = {
    id: successor.id,
    occurred_at: successor.occurred_at,
    granularity: successorGran,
  };
  return item;
}

function liveSuccessor(store: JournalStore, id: number): Entry | null {
  for (const link of store.getLinks(id).incoming) {
    if (link.rel !== "continues") continue;
    const successor = store.getEntry(link.from_id);
    if (successor) return successor;
  }
  return null;
}

/** Length of the `continues` chain behind an entry (0 = first appearance). */
export function carryCount(store: JournalStore, id: number): number {
  const visited = new Set<number>([id]);
  let count = 0;
  let current = id;
  while (count < 30) {
    const predecessor = store
      .getLinks(current)
      .outgoing.find((l) => l.rel === "continues" && !visited.has(l.to_id));
    if (!predecessor) break;
    visited.add(predecessor.to_id);
    current = predecessor.to_id;
    count++;
  }
  return count;
}

const NOTATION_LEGEND =
  "• open task | x done | > migrated (carried elsewhere) | < scheduled into a future month | " +
  "~ dropped (render struck through) | ○ event | – note. Prefix '*' when priority is set; " +
  "append '→ @name' when delegated_to is set; append '(carried Nx)' when carry_count > 0.";

/**
 * Agents raised on generic BuJo lore invent signifiers (！ ？ →) and scaffold
 * empty section templates when a log is sparse — observed with Codex in the
 * field. Every projection carries this to pin the rendering to the data.
 */
export const PROJECTION_FIDELITY_HINT =
  "Render ONLY the items provided, with their given glyphs. Do not invent sections, " +
  "signifiers, or placeholder lines — this notation has no others. When there are no " +
  "items, render a single 'nothing logged yet' line, not an empty template.";

/**
 * Chat scrolls away; a log is something the user keeps open. Every log-shaped
 * projection carries this so agents reach for a persistent surface (#33).
 */
export const DOCUMENT_MEDIUM_HINT =
  "This is a document-shaped view. Prefer rendering it into a persistent surface the " +
  "user can keep open — an artifact/canvas document if your client has one, else a " +
  "markdown file if you can write files (ask once where logs should live). Chat is for " +
  "quick in-ritual glances only. After changes, regenerate and re-render instead of " +
  "hand-editing the document.";

function byOccurredAt(a: BujoItem, b: BujoItem): number {
  return a.occurred_at < b.occurred_at ? -1 : a.occurred_at > b.occurred_at ? 1 : 0;
}

export function buildDayLog(
  store: JournalStore,
  args: { date: string; tz_offset_minutes?: number },
): { structured: Record<string, unknown>; presentation_hints: Record<string, unknown> } {
  const tz = args.tz_offset_minutes ?? 0;
  const { since, until } = dayWindowUtc(args.date, tz);
  const raw = store.query({ since, until, time_field: "occurred_at", limit: 500 });
  const truncated = store.countInWindow({ since, until, time_field: "occurred_at" }) > raw.length;
  const items = raw
    .filter((e) => granularity(e) === "day")
    .map((e) => projectItem(store, e, tz))
    .sort(byOccurredAt);
  return {
    structured: { date: args.date, count: items.length, truncated, items },
    presentation_hints: {
      headline: `Daily log ${args.date}`,
      ...(truncated ? { warning: "More entries exist than could be projected — say so." } : {}),
      notation: NOTATION_LEGEND,
      layout:
        "Render as a compact Bullet Journal daily log: one line per item in the given order, " +
        "glyph first. Do not group by kind; rapid logging is chronological.",
      fidelity: PROJECTION_FIDELITY_HINT,
      medium: DOCUMENT_MEDIUM_HINT,
      tone: "Terse, page-like. This is a projection — offer, don't editorialize.",
    },
  };
}

export function buildMonthLog(
  store: JournalStore,
  args: { month: string; tz_offset_minutes?: number },
): { structured: Record<string, unknown>; presentation_hints: Record<string, unknown> } {
  const tz = args.tz_offset_minutes ?? 0;
  const { since, until } = monthWindowUtc(args.month, tz);
  const inMonth = store.query({ since, until, time_field: "occurred_at", limit: 500 });
  const truncated =
    store.countInWindow({ since, until, time_field: "occurred_at" }) > inMonth.length;

  const calendar: Array<{ date: string; items: BujoItem[] }> = [];
  const byDate = new Map<string, BujoItem[]>();
  for (const entry of inMonth) {
    if (granularity(entry) !== "day" || entry.meta.nature !== "event") continue;
    const date = localDate(entry.occurred_at, tz);
    const bucket = byDate.get(date) ?? [];
    bucket.push(projectItem(store, entry, tz));
    byDate.set(date, bucket);
  }
  for (const date of [...byDate.keys()].sort()) {
    const items = byDate.get(date);
    if (items) calendar.push({ date, items: items.sort(byOccurredAt) });
  }

  const tasks = inMonth
    .filter((e) => granularity(e) === "month")
    .map((e) => projectItem(store, e, tz))
    .sort(byOccurredAt);

  return {
    structured: { month: args.month, truncated, calendar, tasks },
    presentation_hints: {
      headline: `Monthly log ${args.month}`,
      ...(truncated ? { warning: "More entries exist than could be projected — say so." } : {}),
      notation: NOTATION_LEGEND,
      layout:
        "Render as the BuJo monthly spread: a CALENDAR page (events by day, one line each) and " +
        "a TASK page (the month's tasks). Keep both compact.",
      fidelity: PROJECTION_FIDELITY_HINT,
      medium: DOCUMENT_MEDIUM_HINT,
      tone: "Terse, page-like.",
    },
  };
}

export function buildFutureLog(
  store: JournalStore,
  args: { from_month?: string; months?: number; tz_offset_minutes?: number },
): { structured: Record<string, unknown>; presentation_hints: Record<string, unknown> } {
  const tz = args.tz_offset_minutes ?? 0;
  const months = Math.min(Math.max(Math.trunc(args.months ?? 6), 1), 24);
  const fromYm = args.from_month ?? nextLocalMonth(tz);
  const [y, m] = fromYm.split("-").map(Number) as [number, number];
  const since = new Date(Date.UTC(y, m - 1, 1) - tz * 60_000).toISOString();
  const until = new Date(Date.UTC(y, m - 1 + months, 1) - tz * 60_000 - 1).toISOString();

  const inSpan = store.query({ since, until, time_field: "occurred_at", limit: 500 });
  const truncated =
    store.countInWindow({ since, until, time_field: "occurred_at" }) > inSpan.length;
  const byMonth = new Map<string, BujoItem[]>();
  for (const entry of inSpan) {
    if (granularity(entry) !== "month") continue;
    const ym = localYm(entry.occurred_at, tz);
    const bucket = byMonth.get(ym) ?? [];
    bucket.push(projectItem(store, entry, tz));
    byMonth.set(ym, bucket);
  }
  const groups = [...byMonth.keys()].sort().map((ym) => ({
    month: ym,
    items: (byMonth.get(ym) ?? []).sort(byOccurredAt),
  }));

  return {
    structured: { from_month: fromYm, months, truncated, groups },
    presentation_hints: {
      headline: `Future log from ${fromYm} (${months} months)`,
      ...(truncated ? { warning: "More entries exist than could be projected — say so." } : {}),
      notation: NOTATION_LEGEND,
      layout: "Render as the BuJo future log: one short section per month, items one line each.",
      fidelity: PROJECTION_FIDELITY_HINT,
      medium: DOCUMENT_MEDIUM_HINT,
      tone: "Terse, page-like.",
    },
  };
}

function nextLocalMonth(tzOffsetMinutes: number): string {
  const nowYm = localYm(new Date().toISOString(), tzOffsetMinutes);
  const [y, m] = nowYm.split("-").map(Number) as [number, number];
  return `${m === 12 ? y + 1 : y}-${String((m % 12) + 1).padStart(2, "0")}`;
}

export function buildReconcile(
  store: JournalStore,
  args: { before_date?: string; tz_offset_minutes?: number; limit?: number },
): { structured: Record<string, unknown>; presentation_hints: Record<string, unknown> } {
  const tz = args.tz_offset_minutes ?? 0;
  const beforeDate = args.before_date ?? localDate(new Date().toISOString(), tz);
  const before = dayWindowUtc(beforeDate, tz).since;

  // Fetch one extra row so truncation is honest, not silent (detectable while
  // the requested limit stays below the store's own cap).
  const limit = Math.min(Math.max(Math.trunc(args.limit ?? 100), 1), 499);
  const fetched = store.openActions({ before, limit: limit + 1 });
  const truncated = fetched.length > limit;

  const open = fetched.slice(0, limit).map((entry) => {
    const item = projectItem(store, entry, tz);
    const entryDate = localDate(entry.occurred_at, tz);
    return {
      ...item,
      local_date: entryDate,
      granularity: granularity(entry),
      // Local calendar-day difference: an action logged late yesterday is 1
      // day old at this morning's review, not 0.
      age_days: Math.max(0, Math.round((Date.parse(beforeDate) - Date.parse(entryDate)) / DAY_MS)),
    };
  });

  return {
    structured: { before_date: beforeDate, count: open.length, truncated, open_actions: open },
    presentation_hints: {
      headline: `Migration review — ${open.length} open action(s) before ${beforeDate}`,
      ...(truncated
        ? { warning: "More open actions exist than were returned — reconcile in batches." }
        : {}),
      ritual:
        "Walk the user through each open action ONE BY ONE and let THEM decide — never decide " +
        "for them: (a) already done → update_entry_status {status:'done'}; (b) not worth doing " +
        "anymore → update_entry_status {status:'dropped'}; (c) still worth doing → carry it " +
        "over: capture a NEW entry (rephrasing the text is encouraged — that friction is the " +
        "point) with occurred_at on the target day (or `granularity:'month'` + first-of-month " +
        "for a monthly/future slot) and links [{rel:'continues', to:<old id>}].",
      signals:
        "A high carry_count or age_days is worth gently naming: 'this has been carried 3 times — " +
        "still worth doing?'",
      tone: "A calm morning ritual, not a nag.",
    },
  };
}

const tzOffsetSchema = z
  .number()
  .int()
  .min(-840)
  .max(840)
  .optional()
  .describe(
    "The user's UTC offset in minutes (e.g. 540 for JST +09:00). Pass it so calendar days " +
      "match the user's local time. Defaults to 0 (UTC).",
  );

const monthSchema = z.string().regex(MONTH_RE, "must be YYYY-MM");

/** Register the four read-only BuJo tools. Returns handles so the feature can be disabled live. */
export function registerBujoTools(ctx: JournalContext): RegisteredTool[] {
  const { server, store } = ctx;
  const handles: RegisteredTool[] = [];

  handles.push(
    server.registerTool(
      "bujo_day",
      {
        title: "BuJo daily log (read-only view)",
        description:
          "Render one calendar day of the journal as a Bullet Journal daily log. Call this when " +
          "the user wants to see their day BuJo-style ('show today's log', the morning review, " +
          "'what did yesterday look like?'). Returns structured items with derived glyphs " +
          "(• x > < ~ ○ –) plus presentation hints — render them as a compact bulleted page. " +
          "Read-only: to change anything, use update_entry_status / capture.",
        inputSchema: {
          date: z.string().date().describe("The local calendar day to render (YYYY-MM-DD)."),
          tz_offset_minutes: tzOffsetSchema,
        },
      },
      async (args) => jsonResult(buildDayLog(store, args)),
    ),
  );

  handles.push(
    server.registerTool(
      "bujo_month",
      {
        title: "BuJo monthly log (read-only view)",
        description:
          "Render one month as the BuJo monthly spread: a calendar page (that month's events by " +
          "day) and a task page (entries captured with granularity 'month' — things to do " +
          "sometime that month). Use for monthly planning and month-end review. Read-only.",
        inputSchema: {
          month: monthSchema.describe("The local calendar month to render (YYYY-MM)."),
          tz_offset_minutes: tzOffsetSchema,
        },
      },
      async (args) => jsonResult(buildMonthLog(store, args)),
    ),
  );

  handles.push(
    server.registerTool(
      "bujo_future",
      {
        title: "BuJo future log (read-only view)",
        description:
          "Render the future log: month-granularity entries in upcoming months, grouped per " +
          "month. Use when planning ahead or when the user asks what's parked for later. At the " +
          "start of a month, combine with bujo_reconcile to pull its items into the monthly log. " +
          "Read-only.",
        inputSchema: {
          from_month: monthSchema
            .optional()
            .describe("First month to include (YYYY-MM). Defaults to next month."),
          months: z
            .number()
            .int()
            .optional()
            .describe("How many months to span (1-24, default 6)."),
          tz_offset_minutes: tzOffsetSchema,
        },
      },
      async (args) => jsonResult(buildFutureLog(store, args)),
    ),
  );

  handles.push(
    server.registerTool(
      "bujo_reconcile",
      {
        title: "BuJo migration review (the morning ritual)",
        description:
          "Start the BuJo migration ritual: list every OPEN action from before a given day that " +
          "nothing has carried over yet — the inventory to settle while assembling today's log. " +
          "Call this each morning (or at month end) and walk the user through the items one by " +
          "one: done, dropped, or carried over (a NEW capture with a 'continues' link). This " +
          "tool only lists; all decisions go through update_entry_status / capture.",
        inputSchema: {
          before_date: z
            .string()
            .date()
            .optional()
            .describe("Review open actions from before this local day. Defaults to today."),
          tz_offset_minutes: tzOffsetSchema,
          limit: z
            .number()
            .int()
            .optional()
            .describe("Max actions to return (1-499, default 100)."),
        },
      },
      async (args) => jsonResult(buildReconcile(store, args)),
    ),
  );

  return handles;
}
