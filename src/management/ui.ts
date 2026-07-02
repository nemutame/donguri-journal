/**
 * The management console SPA, as a single self-contained HTML document
 * (inline CSS + vanilla JS, no framework, no build step — consistent with the
 * dependency-free approach used elsewhere, e.g. the SVG charts).
 *
 * It reads the session token from its own URL (`?token=`) and sends it as the
 * `x-donguri-token` header on every /api/* fetch. It holds no secrets beyond
 * that token. Mutations are limited to entry deletion (soft, and hard behind a
 * double confirm); export and original download are direct navigations so the
 * bytes stream browser-side, never through the LLM.
 */

// Kept static and data-free so the served bytes never embed anything sensitive.
export function renderApp(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="referrer" content="no-referrer" />
<title>donguri-journal</title>
<style>
  :root { color-scheme: light dark; --gap: 12px; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  header { display: flex; align-items: baseline; gap: 10px; padding: 14px 18px; border-bottom: 1px solid #8883; }
  header h1 { font-size: 16px; margin: 0; }
  header .sub { opacity: 0.6; font-size: 12px; }
  main { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 18px; padding: 18px; align-items: start; }
  @media (max-width: 820px) { main { grid-template-columns: 1fr; } }
  .controls { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: var(--gap); }
  .controls input, .controls select, .controls button {
    font: inherit; padding: 6px 9px; border: 1px solid #8886; border-radius: 6px; background: transparent; color: inherit;
  }
  .controls button { cursor: pointer; }
  .controls input[type="search"] { flex: 1 1 220px; }
  .entry { border: 1px solid #8883; border-radius: 8px; padding: 10px 12px; margin-bottom: 10px; }
  .entry.deleted { opacity: 0.55; }
  .entry .body { white-space: pre-wrap; word-break: break-word; }
  .entry .meta { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 6px; font-size: 12px; opacity: 0.7; }
  .tag { font-size: 11px; padding: 1px 7px; border: 1px solid #8886; border-radius: 999px; }
  .badge { font-size: 11px; padding: 1px 7px; border-radius: 999px; background: #8882; }
  aside { border: 1px solid #8883; border-radius: 8px; padding: 12px 14px; position: sticky; top: 18px; }
  aside h2 { font-size: 13px; margin: 0 0 8px; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.7; }
  aside dl { display: grid; grid-template-columns: 1fr auto; gap: 2px 10px; margin: 0; }
  aside dt { opacity: 0.7; } aside dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; }
  .muted { opacity: 0.6; }
  .status { padding: 10px 0; }
  .actions { display: flex; gap: 6px; margin-top: 8px; }
  .actions button, .actions a {
    font-size: 11px; padding: 2px 9px; border: 1px solid #8886; border-radius: 6px;
    background: transparent; color: inherit; cursor: pointer; text-decoration: none;
  }
  .actions .danger { color: #c0392b; border-color: #c0392b66; }
</style>
</head>
<body>
<header>
  <h1>🐿️ donguri-journal</h1>
  <span class="sub">management console</span>
</header>
<main>
  <section>
    <form class="controls" id="controls">
      <input type="search" id="q" placeholder="Semantic recall (leave blank to browse)…" />
      <input type="text" id="tag" placeholder="tag" size="8" />
      <input type="text" id="source_kind" placeholder="source kind" size="10" />
      <select id="time_field" title="timestamp field">
        <option value="created_at">created_at</option>
        <option value="occurred_at">occurred_at</option>
      </select>
      <label class="badge"><input type="checkbox" id="include_deleted" /> show deleted</label>
      <button type="submit">Search</button>
      <button type="button" id="export" title="Download the whole journal as NDJSON (respects 'show deleted')">Export</button>
    </form>
    <div class="status muted" id="status">Loading…</div>
    <div id="list"></div>
  </section>
  <aside>
    <h2>Storage</h2>
    <dl id="stats"><dd class="muted">…</dd></dl>
  </aside>
</main>
<script>
(() => {
  const TOKEN = new URLSearchParams(location.search).get("token") || "";
  const $ = (id) => document.getElementById(id);

  async function api(path, params) {
    const url = new URL(path, location.origin);
    if (params) for (const [k, v] of Object.entries(params)) {
      if (v !== "" && v != null && v !== false) url.searchParams.set(k, v);
    }
    const res = await fetch(url, { headers: { "x-donguri-token": TOKEN } });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  }

  const fmt = (iso) => { try { return new Date(iso).toLocaleString(); } catch { return iso; } };
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

  function renderEntries(data) {
    const list = $("list");
    if (!data.entries || data.entries.length === 0) {
      list.innerHTML = '<p class="muted">No entries.</p>';
      return;
    }
    list.innerHTML = data.entries.map((e) => {
      const tags = (e.tags || []).map((t) => '<span class="tag">' + esc(String(t)) + "</span>").join(" ");
      const deleted = e.deleted_at ? " deleted" : "";
      const delBadge = e.deleted_at ? '<span class="badge">deleted</span>' : "";
      const dist = typeof e.distance === "number" ? '<span class="badge">d=' + e.distance.toFixed(3) + "</span>" : "";
      const originalLink = e.original_ref
        ? '<a href="/api/original?ref=' + encodeURIComponent(String(e.original_ref)) +
          "&token=" + encodeURIComponent(TOKEN) + '" download>original</a>'
        : "";
      const softBtn = e.deleted_at ? "" :
        '<button type="button" data-id="' + Number(e.id) + '" data-mode="soft">delete</button>';
      const hardBtn =
        '<button type="button" class="danger" data-id="' + Number(e.id) + '" data-mode="hard">purge</button>';
      return '<div class="entry' + deleted + '">' +
        '<div class="body">' + esc(String(e.body || "")) + "</div>" +
        '<div class="meta"><span>#' + esc(String(e.id)) + "</span>" +
        "<span>" + esc(String(e.source_kind || "")) + "</span>" +
        "<span>" + esc(fmt(e.occurred_at)) + "</span>" +
        delBadge + dist + " " + tags + "</div>" +
        '<div class="actions">' + originalLink + softBtn + hardBtn + "</div></div>";
    }).join("");
  }

  function renderStats(s) {
    const rows = [];
    rows.push(["Active", s.entries.active]);
    rows.push(["Soft-deleted", s.entries.soft_deleted]);
    rows.push(["Vectors", s.entries.vectors]);
    rows.push(["Originals", s.originals.count]);
    if (s.db_bytes != null) rows.push(["DB size", (s.db_bytes / 1024 / 1024).toFixed(2) + " MB"]);
    if (s.originals.bytes != null) rows.push(["Originals size", (s.originals.bytes / 1024 / 1024).toFixed(2) + " MB"]);
    $("stats").innerHTML = rows
      .map(([k, v]) => "<dt>" + esc(String(k)) + "</dt><dd>" + esc(String(v)) + "</dd>")
      .join("");
  }

  async function search() {
    const status = $("status");
    status.textContent = "Loading…";
    try {
      const q = $("q").value.trim();
      let data;
      if (q) {
        data = await api("/api/recall", { q, k: 50 });
        data = { entries: data.hits, count: data.count };
      } else {
        data = await api("/api/entries", {
          tag: $("tag").value.trim(),
          source_kind: $("source_kind").value.trim(),
          time_field: $("time_field").value,
          include_deleted: $("include_deleted").checked,
          limit: 200,
        });
      }
      renderEntries(data);
      status.textContent = data.count + " " + (q ? "match(es) by meaning" : "ent"+"ries");
    } catch (err) {
      status.textContent = "Error: " + err.message;
    }
  }

  $("controls").addEventListener("submit", (ev) => { ev.preventDefault(); search(); });

  $("export").addEventListener("click", () => {
    const u = new URL("/api/export", location.origin);
    u.searchParams.set("token", TOKEN);
    u.searchParams.set("include_deleted", $("include_deleted").checked ? "true" : "false");
    location.href = u.toString();
  });

  const refreshStats = () => api("/api/stats").then(renderStats).catch(() => {});

  $("list").addEventListener("click", async (ev) => {
    const btn = ev.target instanceof Element ? ev.target.closest("button[data-id]") : null;
    if (!btn) return;
    const id = btn.getAttribute("data-id");
    const mode = btn.getAttribute("data-mode");
    if (mode === "soft") {
      if (!confirm("Soft-delete entry #" + id + "? (recoverable; hidden from views)")) return;
    } else {
      if (!confirm("PERMANENTLY erase entry #" + id + " — including its original if nothing else references it. This cannot be undone. Continue?")) return;
      if (!confirm("Really purge entry #" + id + " forever?")) return;
    }
    try {
      const res = await fetch("/api/entries/" + id + "/delete?mode=" + mode, {
        method: "POST",
        headers: { "x-donguri-token": TOKEN },
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      await search();
      refreshStats();
    } catch (err) {
      $("status").textContent = "Delete failed: " + err.message;
    }
  });

  refreshStats();
  search();
})();
</script>
</body>
</html>`;
}
