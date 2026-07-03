/**
 * The single-page UI served by `oma ui`. Kept as a template string in its own
 * module so the server logic in ui.ts stays readable.
 */
export function appHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>OMA Sessions</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f7f5;
      --panel: #ffffff;
      --panel-muted: #f0f2f1;
      --line: #d9ddda;
      --text: #1d211f;
      --muted: #626b66;
      --accent: #2d6f67;
      --accent-ink: #ffffff;
      --danger: #a63d3d;
      --warn: #966b1f;
      --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--text);
    }

    button, input, textarea {
      font: inherit;
    }

    .shell {
      display: grid;
      grid-template-columns: minmax(260px, 340px) minmax(0, 1fr);
      min-height: 100vh;
    }

    .sidebar {
      border-right: 1px solid var(--line);
      background: #fbfbfa;
      display: flex;
      flex-direction: column;
      min-width: 0;
    }

    .brand {
      height: 56px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 16px;
      border-bottom: 1px solid var(--line);
      font-weight: 650;
    }

    .session-list {
      overflow: auto;
      padding: 8px;
    }

    .session-row {
      width: 100%;
      display: grid;
      gap: 4px;
      border: 1px solid transparent;
      background: transparent;
      color: inherit;
      text-align: left;
      padding: 10px;
      border-radius: 6px;
      cursor: pointer;
    }

    .session-row:hover, .session-row.active {
      background: var(--panel);
      border-color: var(--line);
    }

    .row-main {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      min-width: 0;
    }

    .id, .offset {
      font-family: var(--mono);
      font-size: 12px;
    }

    .id {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .muted {
      color: var(--muted);
      font-size: 12px;
    }

    .meta-line {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      color: var(--muted);
      font-size: 12px;
      flex-wrap: wrap;
    }

    .pill-row {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
      margin-top: 8px;
    }

    .status {
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 2px 7px;
      font-size: 11px;
      color: var(--muted);
      white-space: nowrap;
    }

    .link {
      color: var(--accent);
      text-decoration: none;
      font-weight: 600;
    }

    .link:hover {
      text-decoration: underline;
    }

    .main {
      min-width: 0;
      display: grid;
      grid-template-rows: auto auto minmax(0, 1fr) auto;
      height: 100vh;
    }

    .topbar {
      height: 56px;
      border-bottom: 1px solid var(--line);
      background: var(--panel);
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 18px;
      gap: 16px;
      min-width: 0;
    }

    .title {
      min-width: 0;
    }

    .title h1 {
      margin: 0;
      font-size: 15px;
      line-height: 1.25;
      font-weight: 650;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .toolbar {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }

    .tabs {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 8px 18px;
      border-bottom: 1px solid var(--line);
      background: #fbfbfa;
      overflow-x: auto;
    }

    .tab, .button {
      border: 1px solid var(--line);
      background: var(--panel);
      color: var(--text);
      border-radius: 6px;
      padding: 7px 10px;
      cursor: pointer;
      white-space: nowrap;
    }

    .tab.active, .button.primary {
      background: var(--accent);
      border-color: var(--accent);
      color: var(--accent-ink);
    }

    .button:disabled {
      opacity: .55;
      cursor: not-allowed;
    }

    .content {
      overflow: auto;
      padding: 16px 18px 24px;
      min-width: 0;
    }

    .grid {
      display: grid;
      gap: 10px;
    }

    .split {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }

    .item {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px;
      min-width: 0;
    }

    .item-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 8px;
    }

    .pre {
      margin: 0;
      font-family: var(--mono);
      font-size: 12px;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .timeline-row {
      display: grid;
      grid-template-columns: 54px minmax(120px, 220px) minmax(0, 1fr);
      gap: 10px;
      align-items: baseline;
      padding: 9px 0;
      border-bottom: 1px solid var(--line);
    }

    .timeline-row:last-child {
      border-bottom: 0;
    }

    .error { color: var(--danger); }
    .warning { color: var(--warn); }

    .composer {
      border-top: 1px solid var(--line);
      background: var(--panel);
      padding: 10px 18px;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto auto;
      gap: 8px;
      align-items: end;
    }

    textarea {
      min-height: 42px;
      max-height: 130px;
      resize: vertical;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 9px 10px;
      color: var(--text);
      background: #ffffff;
    }

    .empty {
      color: var(--muted);
      border: 1px dashed var(--line);
      border-radius: 8px;
      padding: 24px;
      text-align: center;
      background: rgba(255,255,255,.5);
    }

    @media (max-width: 760px) {
      .shell {
        grid-template-columns: 1fr;
      }

      .sidebar {
        max-height: 34vh;
        border-right: 0;
        border-bottom: 1px solid var(--line);
      }

      .main {
        height: auto;
        min-height: 66vh;
      }

      .composer {
        grid-template-columns: 1fr;
      }

      .timeline-row {
        grid-template-columns: 44px minmax(0, 1fr);
      }

      .timeline-row .type {
        grid-column: 2;
      }

      .split {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <div class="shell">
    <aside class="sidebar">
      <div class="brand">
        <span>OMA Sessions</span>
        <button class="button" id="refresh" type="button">Refresh</button>
      </div>
      <div class="session-list" id="sessions"></div>
    </aside>
    <main class="main">
      <header class="topbar">
        <div class="title">
          <h1 id="session-title">No session selected</h1>
          <div class="muted" id="session-meta">Select a session from the list.</div>
        </div>
        <div class="toolbar">
          <button class="button" id="wake" type="button">Wake</button>
          <button class="button" id="fork" type="button">Fork at latest</button>
        </div>
      </header>
      <nav class="tabs" id="tabs">
        <button class="tab active" data-tab="transcript" type="button">Transcript</button>
        <button class="tab" data-tab="timeline" type="button">Timeline</button>
        <button class="tab" data-tab="tools" type="button">Tools</button>
        <button class="tab" data-tab="runs" type="button">Runs</button>
        <button class="tab" data-tab="forks" type="button">Forks</button>
        <button class="tab" data-tab="pr-review" type="button">PR Review</button>
        <button class="tab" data-tab="events" type="button">Events</button>
      </nav>
      <section class="content" id="content"></section>
      <form class="composer" id="composer">
        <textarea id="message" placeholder="Send a message to this session"></textarea>
        <label class="muted"><input id="send-wake" type="checkbox" checked> wake</label>
        <button class="button primary" type="submit">Send</button>
      </form>
    </main>
  </div>
  <script>
    const state = {
      sessions: [],
      selectedId: sessionIdFromPath(),
      selected: null,
      tab: "transcript",
      stream: null,
      streamSessionId: null,
      refreshTimer: null
    };
    const el = {
      sessions: document.getElementById("sessions"),
      title: document.getElementById("session-title"),
      meta: document.getElementById("session-meta"),
      content: document.getElementById("content"),
      tabs: document.getElementById("tabs"),
      composer: document.getElementById("composer"),
      message: document.getElementById("message"),
      sendWake: document.getElementById("send-wake"),
      wake: document.getElementById("wake"),
      fork: document.getElementById("fork"),
      refresh: document.getElementById("refresh")
    };

    el.refresh.addEventListener("click", () => loadSessions());
    el.wake.addEventListener("click", () => selectedAction("wake"));
    el.fork.addEventListener("click", () => selectedAction("fork"));
    el.tabs.addEventListener("click", (event) => {
      const button = event.target.closest("[data-tab]");
      if (!button) return;
      state.tab = button.dataset.tab;
      renderTabs();
      renderSelected();
    });
    el.composer.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!state.selectedId || !el.message.value.trim()) return;
      await api("/api/sessions/" + encodeURIComponent(state.selectedId) + "/send", {
        method: "POST",
        body: JSON.stringify({ message: el.message.value.trim(), wake: el.sendWake.checked })
      });
      el.message.value = "";
      await loadSelected();
    });

    loadSessions();

    async function loadSessions() {
      state.sessions = await api("/api/sessions");
      if (!state.selectedId && state.sessions[0]) state.selectedId = state.sessions[0].id;
      renderSessions();
      await loadSelected();
    }

    async function loadSelected() {
      if (!state.selectedId) {
        closeStream();
        state.selected = null;
        renderSelected();
        return;
      }
      state.selected = await api("/api/sessions/" + encodeURIComponent(state.selectedId));
      history.replaceState(null, "", "/sessions/" + encodeURIComponent(state.selectedId));
      ensureStream();
      updateSelectedRow();
      renderSessions();
      renderSelected();
    }

    function ensureStream() {
      if (!state.selectedId || typeof EventSource === "undefined") return;
      if (state.stream && state.streamSessionId === state.selectedId) return;
      closeStream();
      const latest = state.selected?.session?.events?.at(-1)?.offset;
      const fromOffset = Number.isInteger(latest) ? latest + 1 : 0;
      state.stream = new EventSource("/api/sessions/" + encodeURIComponent(state.selectedId) + "/stream?fromOffset=" + fromOffset);
      state.streamSessionId = state.selectedId;
      state.stream.addEventListener("session-event", (message) => {
        applyStreamedEvent(JSON.parse(message.data));
      });
    }

    function closeStream() {
      if (state.stream) state.stream.close();
      state.stream = null;
      state.streamSessionId = null;
    }

    function applyStreamedEvent(event) {
      if (!state.selected || event.sessionId !== state.selectedId) return;
      const events = state.selected.session.events;
      if (events.some((existing) => existing.offset === event.offset)) return;
      events.push(event);
      updateSelectedRow();
      renderSessions();
      renderSelected();
      scheduleViewRefresh();
    }

    function scheduleViewRefresh() {
      if (state.refreshTimer) return;
      state.refreshTimer = setTimeout(async () => {
        state.refreshTimer = null;
        if (!state.selectedId) return;
        state.selected = await api("/api/sessions/" + encodeURIComponent(state.selectedId));
        updateSelectedRow();
        renderSessions();
        renderSelected();
      }, 250);
    }

    function updateSelectedRow() {
      const row = state.sessions.find((session) => session.id === state.selectedId);
      if (!row || !state.selected) return;
      row.status = state.selected.status;
      row.eventCount = state.selected.session.events.length;
    }

    async function selectedAction(action) {
      if (!state.selectedId) return;
      if (action === "wake") {
        await api("/api/sessions/" + encodeURIComponent(state.selectedId) + "/wake", { method: "POST", body: "{}" });
      } else {
        const latest = state.selected?.session?.events?.at(-1)?.offset;
        if (!Number.isInteger(latest)) return;
        const result = await api("/api/sessions/" + encodeURIComponent(state.selectedId) + "/fork", {
          method: "POST",
          body: JSON.stringify({ offset: latest })
        });
        state.selectedId = result.forkId;
      }
      await loadSessions();
    }

    function renderSessions() {
      el.sessions.innerHTML = state.sessions.map((session) => {
        const active = session.id === state.selectedId ? " active" : "";
        const trigger = session.trigger ? "trigger " + session.trigger.source + ":" + session.trigger.kind : "";
        const forkedFrom = session.forkedFrom ? "forked from " + session.forkedFrom.sessionId + "@" + session.forkedFrom.atOffset : "";
        const latest = session.latestEventAt ? shortTime(session.latestEventAt) : "";
        const cues = [session.eventCount + " events", latest, trigger, forkedFrom, session.preview || ""].filter(Boolean).join(" / ");
        return "<button class=\\"session-row" + active + "\\" data-id=\\"" + escapeHtml(session.id) + "\\" type=\\"button\\">" +
          "<div class=\\"row-main\\"><span class=\\"id\\">" + escapeHtml(session.id) + "</span><span class=\\"status\\">" + escapeHtml(session.status) + "</span></div>" +
          "<div class=\\"muted\\">" + escapeHtml(session.profilePath || session.profileName || "-") + "</div>" +
          "<div class=\\"meta-line\\">" + escapeHtml(cues) + "</div>" +
        "</button>";
      }).join("") || "<div class=\\"empty\\">No sessions yet.</div>";

      el.sessions.querySelectorAll("[data-id]").forEach((button) => {
        button.addEventListener("click", async () => {
          state.selectedId = button.dataset.id;
          await loadSelected();
        });
      });
    }

    function renderTabs() {
      el.tabs.querySelectorAll("[data-tab]").forEach((button) => {
        button.classList.toggle("active", button.dataset.tab === state.tab);
      });
    }

    function renderSelected() {
      const payload = state.selected;
      const disabled = !payload;
      el.wake.disabled = disabled;
      el.fork.disabled = disabled;
      el.message.disabled = disabled;
      el.composer.querySelector("button[type=submit]").disabled = disabled;

      if (!payload) {
        el.title.textContent = "No session selected";
        el.meta.textContent = "Select a session from the list.";
        el.content.innerHTML = "<div class=\\"empty\\">No session selected.</div>";
        return;
      }

      el.title.textContent = payload.session.id;
      el.meta.textContent = payload.status + " / " + payload.session.events.length + " events";

      if (state.tab === "transcript") renderTranscript(payload.view.transcript);
      if (state.tab === "timeline") renderTimeline(payload.view.timeline);
      if (state.tab === "tools") renderTools(payload.view.tools);
      if (state.tab === "runs") renderRuns(payload.view.runs);
      if (state.tab === "forks") renderForks(payload.forks, payload.session.events);
      if (state.tab === "pr-review") renderPrReview(payload.view.prReview, payload.forks);
      if (state.tab === "events") renderEvents(payload.session.events);
    }

    function renderTranscript(items) {
      el.content.innerHTML = list(items, (item) =>
        "<article class=\\"item\\"><div class=\\"item-head\\"><strong>" + escapeHtml(item.role) + "</strong><span class=\\"offset\\">#" + item.offset + "</span></div>" +
        "<pre class=\\"pre\\">" + escapeHtml(item.content) + "</pre></article>"
      );
    }

    function renderTimeline(items) {
      el.content.innerHTML = "<div class=\\"item\\">" + items.map((item) =>
        "<div class=\\"timeline-row " + item.severity + "\\"><span class=\\"offset\\">#" + item.offset + "</span><span class=\\"type\\">" + escapeHtml(item.type) + "</span><span>" + escapeHtml(item.label) + "</span></div>"
      ).join("") + "</div>";
    }

    function renderTools(items) {
      el.content.innerHTML = list(items, (item) =>
        "<article class=\\"item\\"><div class=\\"item-head\\"><strong>" + escapeHtml(item.toolName) + "</strong><span class=\\"status\\">" + escapeHtml(item.status) + "</span></div>" +
        "<pre class=\\"pre\\">" + escapeHtml(JSON.stringify(item.result ?? item.error ?? item.args, null, 2)) + "</pre></article>"
      );
    }

    function renderRuns(items) {
      el.content.innerHTML = list(items, (item) =>
        "<article class=\\"item\\"><div class=\\"item-head\\"><strong>" + escapeHtml(item.runId) + "</strong><span class=\\"status\\">" + escapeHtml(item.status) + "</span></div>" +
        "<div class=\\"muted\\">" + escapeHtml(item.reason || ((item.steps ?? 0) + " steps")) + "</div></article>"
      );
    }

    function renderForks(forks, events) {
      const parents = events.filter((event) => event.type === "session.forked");
      const parentItems = parents.map((fork) =>
        "<article class=\\"item\\"><div class=\\"item-head\\"><strong>Fork origin</strong><span class=\\"offset\\">#" + fork.offset + "</span></div>" +
        "<div class=\\"meta-line\\">from " + sessionLink(fork.fromSessionId) + " at offset " + fork.atOffset + "</div></article>"
      ).join("");
      const childItems = forks.map((fork) =>
        "<article class=\\"item\\"><div class=\\"item-head\\"><strong>" + sessionLink(fork.sessionId) + "</strong><span class=\\"status\\">child</span></div>" +
        "<div class=\\"meta-line\\">from " + escapeHtml(fork.forkedFromSessionId) + " at offset " + fork.atOffset + " / " + escapeHtml(shortTime(fork.createdAt)) + "</div></article>"
      ).join("");
      el.content.innerHTML = parentItems + childItems || "<div class=\\"empty\\">No forks recorded.</div>";
    }

    function renderPrReview(summary, forks) {
      const header = "<article class=\\"item\\"><div class=\\"item-head\\"><strong>" + escapeHtml(summary.repo || "PR Review") + "</strong><span class=\\"status\\">" + escapeHtml(summary.status) + "</span></div>" +
        "<div class=\\"muted\\">PR #" + escapeHtml(String(summary.pr || "-")) + " / " + summary.triggers.length + " triggers / " + summary.comments.length + " comments / " + summary.reviews.length + " reviews</div>" +
        "<div class=\\"pill-row\\">" + forks.map((fork) => "<span class=\\"status\\">fork " + sessionLink(fork.sessionId) + "</span>").join("") + "</div></article>";
      const triggers = summary.triggers.map((trigger) =>
        "<article class=\\"item\\"><div class=\\"item-head\\"><strong>" + escapeHtml(trigger.source + ":" + trigger.kind) + "</strong><span class=\\"offset\\">#" + trigger.offset + "</span></div>" +
        "<div class=\\"meta-line\\">" + escapeHtml(shortTime(trigger.createdAt)) + (trigger.deliveryId ? " / delivery " + escapeHtml(trigger.deliveryId) : "") + "</div></article>"
      ).join("");
      const comments = summary.comments.map((comment) =>
        "<article class=\\"item\\"><div class=\\"item-head\\"><strong>" + escapeHtml(comment.path || "comment") + "</strong><span class=\\"offset\\">line " + escapeHtml(String(comment.line || "-")) + "</span></div>" +
        "<pre class=\\"pre\\">" + escapeHtml(comment.body || JSON.stringify(comment, null, 2)) + "</pre>" +
        "<div class=\\"meta-line\\">provider " + escapeHtml(comment.providerId || "-") + " / key " + escapeHtml(comment.key || "-") + "</div></article>"
      ).join("");
      const reviews = summary.reviews.map((review) =>
        "<article class=\\"item\\"><div class=\\"item-head\\"><strong>Submitted review</strong><span class=\\"offset\\">#" + review.offset + "</span></div>" +
        "<pre class=\\"pre\\">" + escapeHtml(review.body || JSON.stringify(review, null, 2)) + "</pre>" +
        "<div class=\\"meta-line\\">provider " + escapeHtml(review.providerId || "-") + " / key " + escapeHtml(review.key || "-") + "</div></article>"
      ).join("");
      const idempotency = summary.idempotency.map((item) =>
        "<article class=\\"item\\"><div class=\\"item-head\\"><strong>" + escapeHtml(item.toolName) + "</strong><span class=\\"status\\">" + escapeHtml(item.status) + "</span></div>" +
        "<div class=\\"meta-line\\">call " + escapeHtml(item.callId) + " / key " + escapeHtml(item.key || "-") + " / provider " + escapeHtml(item.providerId || item.providerCallId || "-") + "</div></article>"
      ).join("");
      el.content.innerHTML = header +
        "<div class=\\"split\\"><section>" + section("Triggers", triggers) + section("Comments", comments) + "</section><section>" + section("Reviews", reviews) + section("Idempotency", idempotency) + section("Forks", forks.map((fork) => "<article class=\\"item\\"><div class=\\"item-head\\"><strong>" + sessionLink(fork.sessionId) + "</strong><span class=\\"status\\">child</span></div><div class=\\"meta-line\\">offset " + fork.atOffset + "</div></article>").join("")) + "</section></div>";
    }

    function renderEvents(events) {
      el.content.innerHTML = list(events, (event) =>
        "<article class=\\"item\\"><div class=\\"item-head\\"><strong>" + escapeHtml(event.type) + "</strong><span class=\\"offset\\">#" + event.offset + "</span></div>" +
        "<pre class=\\"pre\\">" + escapeHtml(JSON.stringify(event, null, 2)) + "</pre></article>"
      );
    }

    function list(items, render) {
      return items.length ? "<div class=\\"grid\\">" + items.map(render).join("") + "</div>" : "<div class=\\"empty\\">Nothing to show.</div>";
    }

    function section(title, body) {
      return "<h2 class=\\"muted\\">" + escapeHtml(title) + "</h2>" + (body || "<div class=\\"empty\\">None.</div>");
    }

    function sessionLink(sessionId) {
      return "<a class=\\"link\\" href=\\"/sessions/" + encodeURIComponent(sessionId) + "\\">" + escapeHtml(sessionId) + "</a>";
    }

    function shortTime(value) {
      if (!value) return "";
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
    }

    async function api(path, init) {
      const response = await fetch(path, {
        headers: { "content-type": "application/json" },
        ...init
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || response.statusText);
      return value;
    }

    function sessionIdFromPath() {
      const match = location.pathname.match(/^\\/sessions\\/(.+)$/);
      return match ? decodeURIComponent(match[1]) : "";
    }

    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\\"": "&quot;", "'": "&#39;" }[char]));
    }
  </script>
</body>
</html>`;
}
