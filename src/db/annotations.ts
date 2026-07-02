/**
 * View-neutral annotation vocabulary (DESIGN §6).
 *
 * The core never stores a presentation format; lenses (BuJo, GTD, …) are
 * read-only projections over these universal semantics. Reserved `meta` keys
 * are validated at the tool boundary when present; every other `meta` key
 * stays free-form.
 */
import { z } from "zod";

/** Typed relation vocabulary for entry_links. Links always point new → old. */
export const LINK_RELS = ["continues", "references"] as const;
export const linkRelSchema = z.enum(LINK_RELS);
export type LinkRel = (typeof LINK_RELS)[number];

/** Reserved, view-neutral `meta` keys. All optional; unknown keys pass through. */
export const reservedAnnotationsSchema = z.object({
  nature: z
    .enum(["action", "event", "note"])
    .optional()
    .describe(
      "What the content IS: 'action' = something to do, 'event' = something that " +
        "happened/happens at a time, 'note' = an observation. (source_kind is the medium.)",
    ),
  status: z
    .enum(["open", "done", "dropped"])
    .optional()
    .describe("An action's lifecycle. 'done' / 'dropped' are terminal; 'open' is the default."),
  priority: z
    .literal(true)
    .optional()
    .describe("Importance marker. Pass true or omit the key entirely (never false)."),
  due: z
    .string()
    .date("due must be a valid ISO date (YYYY-MM-DD)")
    .optional()
    .describe("Deadline as an ISO date (YYYY-MM-DD)."),
  delegated_to: z.string().min(1).optional().describe("Who the action was handed off to."),
  granularity: z
    .enum(["day", "month"])
    .optional()
    .describe(
      "How precisely occurred_at places the entry in time. 'month' = belongs to a month, " +
        "not a specific day (monthly/future-log style); set occurred_at to the first of " +
        "that month in the user's timezone. Defaults to 'day'.",
    ),
});

/**
 * `meta` as accepted at the capture boundary: reserved keys validated,
 * everything else free-form.
 */
export const annotatedMetaSchema = reservedAnnotationsSchema.passthrough();
