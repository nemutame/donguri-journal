/**
 * The BuJo playbook — the agent workflow guide that rides along in the
 * enable_feature result (#32/#33). The bujo_* tools are read-only primitives;
 * this is the choreography: the morning ritual, and the rule that a log is a
 * DOCUMENT the user keeps open, not a chat message that scrolls away.
 *
 * Canonical copy: agents are told (via playbook_hint) to install it into
 * their client's own skill mechanism and re-run enable_feature for updates.
 */
export const BUJO_PLAYBOOK = `# Bullet Journal playbook (donguri-journal)

You drive the user's Bullet Journal over donguri-journal. The four \`bujo_*\` tools are
read-only projections; every change goes through the generic tools (\`capture\`,
\`update_entry_status\`, \`link_entries\`). A lens is only a view — nothing is locked in.

## Rendering: a log is a DOCUMENT, not a chat message

Chat scrolls away; a daily log is something the user keeps open. Whenever you produce a
day/month/future log, render it into the most persistent surface YOUR client offers:

1. A document surface (artifact, canvas, or equivalent) — preferred.
2. A markdown file, if you can write files: put it where the user wants their logs
   (ask once, remember the answer — a notes folder or vault is typical).
3. Chat only as a fallback, or for quick in-ritual glances.

Regenerate, don't hand-edit: after any status change or new capture, rebuild the view
from the tools and re-render the whole document. The journal is the source of truth —
an edited rendering silently diverges, and a change written only into the document is
lost. Journal first, document second.

Fidelity: render only what the projection returns — the provided items with their
provided glyphs. Never invent sections, signifiers, or placeholder lines from generic
BuJo lore (no ！/？/→, no scaffolded "tasks/notes" headings). An empty day is a single
"nothing logged yet" line, not a template.

## The morning ritual (daily)

1. \`bujo_reconcile\` for today (pass the user's \`tz_offset_minutes\`) → lists every
   open action from before today that has not been carried over yet.
2. Walk them ONE BY ONE; the user decides, never you:
   - already done → \`update_entry_status {status:'done'}\`
   - not worth doing anymore → \`update_entry_status {status:'dropped'}\`
   - still worth doing → carry it over: \`capture\` a NEW entry (rephrasing is
     encouraged — that friction is the point) with \`occurred_at\` on the target day
     and \`links:[{rel:'continues', to:<old id>}]\`. For "sometime this/next month",
     use \`granularity:'month'\` with a first-of-month \`occurred_at\`.
3. Let the user add today's items: \`capture\` with \`meta.nature\`
   ('action' / 'event' / 'note') and optional \`priority\` / \`due\`.
4. \`bujo_day\` for today → render the document (see above).

When \`carry_count\` or \`age_days\` is high, name it gently ("carried 3 times — still
worth keeping?") — the verdict is always the user's.

## Monthly and future logs

- Month start: \`bujo_reconcile\` plus \`bujo_future\` for the new month to pull parked
  items in, then \`bujo_month\` → render as its own document.
- Planning ahead: \`bujo_future\` shows what's parked; park new items with
  \`granularity:'month'\`.

## Conventions

- Ask the user's timezone once and pass \`tz_offset_minutes\` consistently.
- Meta vocabulary: \`nature\` (action/event/note), \`status\` (open → done/dropped),
  \`priority\`, \`due\` (a real date), \`granularity\` (day/month).
- Glyphs (• x > < ~ ○ –) are derived server-side; the legend arrives in
  \`presentation_hints\` — include it in rendered documents.`;
