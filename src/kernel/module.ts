/**
 * Module contract. The core ships as a module, and opt-in features (management
 * UI, album, Eagle connector, …) will plug in through the same interface — later
 * loaded dynamically from installed plugins.
 */
import type { JournalContext } from "./context.js";

export interface JournalModule {
  /** Stable id, e.g. "core", "management-ui", "eagle". */
  readonly id: string;
  /** Register the module's tools / capabilities against the kernel context. */
  register(ctx: JournalContext): void | Promise<void>;
}

export async function registerModules(
  ctx: JournalContext,
  modules: JournalModule[],
): Promise<void> {
  for (const module of modules) {
    await module.register(ctx);
    ctx.log(`module registered: ${module.id}`);
  }
}
