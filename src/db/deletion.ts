/**
 * Hard delete, orchestrated original-first — shared by the MCP delete_entry
 * tool and the management UI's POST endpoint so the erase guarantee has one
 * implementation.
 *
 * Order matters: erase the orphaned original BEFORE purging the row, so a
 * failure can't leave secret bytes behind. Every failure leaves the operation
 * retryable (re-running re-purges; deleting an already-missing original is a
 * no-op).
 *
 * The erase is guarded against a concurrent re-attach: the ref is CLAIMED on
 * the store (blocking new attachments in this process — MCP tools and the
 * management UI share it), orphanhood is re-checked under the claim, and only
 * then is the original erased. Without the claim, a capture landing between
 * the orphan check and the erase could reference bytes we are about to
 * destroy.
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
  if (peek.original_ref) store.claimOriginalErase(peek.original_ref);
  try {
    let originalErased: boolean | null = null;
    // Re-check under the claim: no await separates this from the claim, so the
    // answer stays true until we release.
    const guarded = store.peekHardDelete(id);
    if (guarded.orphan && guarded.original_ref) {
      try {
        originalErased = await originals.delete(guarded.original_ref);
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
  } finally {
    if (peek.original_ref) store.releaseOriginalErase(peek.original_ref);
  }
}
