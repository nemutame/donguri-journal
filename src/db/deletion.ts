/**
 * Hard delete, orchestrated original-first — shared by the MCP delete_entry
 * tool and the management UI's POST endpoint so the erase guarantee has one
 * implementation.
 *
 * Order matters: erase the orphaned original BEFORE purging the row, so a
 * failure can't leave secret bytes behind. Every failure leaves the operation
 * retryable (re-running re-purges; deleting an already-missing original is a
 * no-op).
 */
import type { OriginalStore } from "../originals/store.js";
import type { JournalStore } from "./store.js";

export type HardDeleteOutcome =
  | { ok: true; deleted: boolean; original_erased: boolean | null }
  | { ok: false; message: string };

export async function hardDeleteEntry(
  store: JournalStore,
  originals: OriginalStore,
  log: (...args: unknown[]) => void,
  id: number,
): Promise<HardDeleteOutcome> {
  const peek = store.peekHardDelete(id);
  if (!peek.exists) {
    return { ok: true, deleted: false, original_erased: null };
  }
  let originalErased: boolean | null = null;
  if (peek.orphan && peek.original_ref) {
    try {
      originalErased = await originals.delete(peek.original_ref);
    } catch (err) {
      // Log details to stderr; keep the outward message generic (no raw exception).
      log("failed to erase original during hard delete:", err);
      return {
        ok: false,
        message: "Failed to erase the original; the entry was left intact so you can retry.",
      };
    }
  }
  try {
    return { ok: true, deleted: store.purgeEntry(id), original_erased: originalErased };
  } catch (err) {
    log("failed to purge entry after erasing original:", err);
    return {
      ok: false,
      message: "Erased the original but failed to purge the entry; run delete again to finish.",
    };
  }
}
