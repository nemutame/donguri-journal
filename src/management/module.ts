/**
 * Management module — registers the `open_management_ui` tool.
 *
 * The UI host is opt-in: nothing listens until the owner asks to open it. The
 * server is a singleton per process, so repeated calls return the same URL
 * rather than leaking listeners.
 */
import type { JournalContext } from "../kernel/context.js";
import type { JournalModule } from "../kernel/module.js";
import { jsonResult } from "../kernel/result.js";
import { type ManagementUi, startManagementUi } from "./server.js";

export const managementModule: JournalModule = {
  id: "management",
  register(ctx: JournalContext): void {
    let running: ManagementUi | null = null;
    let starting: Promise<ManagementUi> | null = null;

    ctx.server.registerTool(
      "open_management_ui",
      {
        title: "Open the management console",
        description:
          "Start (or return the URL of) the local, browser-based management console for the owner " +
          "to inspect their journal directly — outside this LLM conversation. It offers browsing, " +
          "filtering, semantic recall, and storage stats over a localhost-only web page. Use this " +
          "when the user wants to look through their journal themselves, manage it, or see storage " +
          "usage in a UI. The URL contains a session token and binds to localhost only; share it " +
          "with the user so they can open it in their browser. It is NOT for you to fetch data " +
          "from — use query_entries / recall_related / storage_stats for that.",
        inputSchema: {},
      },
      async () => {
        if (running) {
          return jsonResult({ url: running.url, port: running.port, already_running: true });
        }
        // Guard against concurrent calls racing two listeners onto the port.
        if (!starting) {
          starting = startManagementUi(ctx)
            .then((ui) => {
              running = ui;
              ctx.log(`management UI listening on ${ctx.config.uiHost}:${ui.port}`);
              return ui;
            })
            .finally(() => {
              starting = null;
            });
        }
        const ui = await starting;
        return jsonResult({ url: ui.url, port: ui.port, already_running: false });
      },
    );
  },
};
