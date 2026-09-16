(() => {
  const reportPicker = document.getElementById("report-picker");
  const reportContainer = document.getElementById("report-container");
  const reportEmptyState = document.getElementById("report-empty-state");
  const chatToggle = document.getElementById("chat-toggle");
  const chatClose = document.getElementById("chat-close");
  const chatPanel = document.getElementById("chat-panel");
  const chatResizeHandle = document.getElementById("chat-resize-handle");
  const chatLog = document.getElementById("chat-log");
  const chatEmptyState = document.getElementById("chat-empty-state");
  const chatForm = document.getElementById("chat-form");
  const chatInput = document.getElementById("chat-input");
  const chatSend = document.getElementById("chat-send");

  const powerbiService = window["powerbi-client"]
    ? new window["powerbi-client"].service.Service(
        window["powerbi-client"].factories.hpmFactory,
        window["powerbi-client"].factories.wpmpFactory,
        window["powerbi-client"].factories.routerFactory
      )
    : null;

  let reports = [];
  let currentReportId = null;
  let embeddedReport = null; // powerbi-client Report, for reading live state

  // ---------- tiny helpers ----------

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }


  // ---------- visual context: reading the live report state ----------
  //
  // Power BI renders in a cross-origin iframe, so its pixels can't be
  // screenshotted from here. The embed SDK does expose the structured state
  // though — active page, filters/slicers, and each visual's own data — which
  // is both cheaper than a vision model and exact rather than OCR'd.

  const models = () => window["powerbi-client"].models;

  // Routing between the two paths. An explicit reference to what's on screen
  // ("this page", "the dashboard") is treated as decisive, because the user is
  // telling us they mean the current view even if they also use a data word
  // like "trend". Otherwise an open-ended ask goes visual, a measurable one
  // goes to the query pipeline. Genuinely ambiguous short asks prefer the
  // visual path: describing the wrong thing is cheaper to recover from than
  // quoting a confidently wrong number.
  const SCREEN_REFERENCE = /\b(this|these|current|currently|on screen|on-screen|this page|the page|the dashboard|the report|the view|here)\b/i;
  const OPEN_ENDED = /\b(summar|overview|walk me through|what am i looking at|explain|interpret|insight|stand out|standing out|notable|going on|tell me about)/i;
  const SPECIFIC_QUESTION = /\b(how many|how much|total|count|sum|average|top \d+|bottom \d+|compare|by (year|month|quarter|region|category|channel|publisher|genre))\b/i;

  function isVisualQuestion(q) {
    if (SCREEN_REFERENCE.test(q)) return true;
    // Naming a chart that's on the page is a stronger signal than any keyword:
    // the user is pointing at something in front of them, so answer from it
    // rather than re-querying the model and ignoring their slicers.
    if (matchVisual(q)) return true;
    if (OPEN_ENDED.test(q)) return !SPECIFIC_QUESTION.test(q);
    if (SPECIFIC_QUESTION.test(q)) return false;
    return q.trim().split(/\s+/).length <= 6;
  }

  const DECORATIVE = ["shape", "image", "textbox", "actionButton", "basicShape"];

  // Titles of the visuals on the page the user is currently looking at. Kept
  // warm so routing can consider them: getVisuals() measures at ~18ms, and the
  // router has to decide a path before capture would otherwise have run.
  let currentVisualTitles = [];

  async function refreshVisualTitles() {
    try {
      const pages = await embeddedReport.getPages();
      const page = pages.find((p) => p.isActive) || pages[0];
      const visuals = await page.getVisuals();
      currentVisualTitles = visuals
        .filter((v) => !DECORATIVE.includes(v.type))
        .map((v) => ({ name: v.name, title: v.title || v.name, type: v.type }));
    } catch {
      currentVisualTitles = []; // routing falls back to keywords alone
    }
  }

  // Words that carry no identifying weight when matching a question against a
  // visual's title.
  const TITLE_STOPWORDS = new Set(["by", "of", "the", "and", "per", "a", "an", "in", "for", "vs"]);

  function titleWords(title) {
    return String(title)
      .toLowerCase()
      .split(/[^a-z0-9%]+/)
      .filter((w) => w && !TITLE_STOPWORDS.has(w));
  }

  // Which on-screen visual, if any, the question is about. Used twice: to route
  // the question to the visual path at all, and to decide which visual to read
  // in depth. Requires most of the title's distinctive words to be present, so
  // "total sales by game" matches "Total Sales by Game" while "sales trend
  // since 2019" does not.
  function matchVisual(question) {
    const q = question.toLowerCase();
    let best = null;

    for (const v of currentVisualTitles) {
      const words = titleWords(v.title);
      if (words.length === 0) continue;
      const hits = words.filter((w) => q.includes(w)).length;
      const score = hits / words.length;
      // A single-word title is too weak a signal on its own ("Region" would
      // match almost any question mentioning regions).
      if (words.length < 2) continue;
      if (score >= 0.7 && (!best || score > best.score || words.length > best.words)) {
        best = { name: v.name, title: v.title, score, words: words.length };
      }
    }
    return best;
  }

  async function captureReportState(focusName) {
    if (!embeddedReport) throw new Error("The report isn't loaded yet.");

    const pages = await embeddedReport.getPages();
    const page = pages.find((p) => p.isActive) || pages[0];
    if (!page) throw new Error("No active report page.");

    const state = { pageName: page.displayName, reportFilters: [], pageFilters: [], visuals: [] };

    // Everything below is read concurrently. Each of these is a round trip
    // into the embed iframe, so doing them in series made a busy page feel
    // sluggish before the model was even called.
    const noFail = (p) => Promise.resolve(p).catch(() => null);

    const [reportFilters, pageFilters, visuals] = await Promise.all([
      noFail(embeddedReport.getFilters()),
      noFail(page.getFilters()),
      page.getVisuals(),
    ]);
    state.reportFilters = reportFilters || [];
    state.pageFilters = pageFilters || [];

    const interesting = visuals.filter((v) => !DECORATIVE.includes(v.type));

    state.visuals = await Promise.all(
      interesting.map(async (v) => {
        const isFocus = Boolean(focusName) && v.name === focusName;
        const entry = { title: v.title || v.name, type: v.type };
        if (isFocus) entry.focus = true;

        // A visual can carry its own filter on top of page/report ones, which
        // changes what its numbers actually mean.
        const filtersPromise = Promise.resolve(v.getFilters?.()).catch(() => null);

        try {
          if (v.type === "slicer") {
            const slicer = await v.getSlicerState();
            const values = (slicer.filters || []).flatMap((f) => f.values || []).join(", ");
            entry.slicerState = values || "(no selection — showing all)";
          } else {
            // The visual the question is about is the answer, so read it
            // properly; everything else only needs enough for context.
            const rows = isFocus ? 50 : 10;
            const result = await v.exportData(models().ExportDataType.Summarized, rows);
            entry.data = result && result.data ? result.data : null;
          }
        } catch (err) {
          entry.error = err && err.message ? err.message : "not readable";
        }

        const vf = await filtersPromise;
        if (Array.isArray(vf) && vf.length) entry.visualFilters = vf;
        return entry;
      })
    );

    return state;
  }

  // ---------- enlarge modal ----------

  const chartModal = document.getElementById("chart-modal");
  const chartModalBody = document.getElementById("chart-modal-body");
  const chartModalTitle = document.getElementById("chart-modal-title");
  let lastFocused = null;

  function openChartModal(spec) {
    lastFocused = document.activeElement;
    chartModalTitle.textContent = spec.label || "Chart";
    chartModal.hidden = false;

    // Re-render at the larger size rather than scaling the small SVG, so
    // text and strokes stay crisp.
    const width = Math.min(1100, Math.round(window.innerWidth * 0.86));
    const height = Math.min(
      Math.round(window.innerHeight * 0.68),
      spec.type === "card" ? 260 : Math.round(width * 0.5)
    );
    window.PortalCharts.renderChart(chartModalBody, spec, { width, height });
    document.getElementById("chart-modal-close").focus();
  }

  function closeChartModal() {
    chartModal.hidden = true;
    chartModalBody.innerHTML = "";
    if (lastFocused) lastFocused.focus();
  }

  document.getElementById("chart-modal-close").addEventListener("click", closeChartModal);
  document.getElementById("chart-modal-backdrop").addEventListener("click", closeChartModal);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !chartModal.hidden) closeChartModal();
  });

  async function fetchJson(url, options) {
    const res = await fetch(url, options);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `Request to ${url} failed (${res.status})`);
    }
    return data;
  }

  function setReportState(html) {
    reportEmptyState.innerHTML = html;
    reportEmptyState.hidden = false;
  }

  function clearReportState() {
    reportEmptyState.hidden = true;
  }

  // Minimal markdown: **bold**, `code`, bullet/numbered lists, paragraphs.
  function renderMarkdown(text) {
    const escaped = escapeHtml(text);
    const lines = escaped.split("\n");
    const blocks = [];
    let listItems = null;
    let listTag = null;

    const flushList = () => {
      if (listItems) {
        blocks.push(`<${listTag}>${listItems.join("")}</${listTag}>`);
        listItems = null;
        listTag = null;
      }
    };

    for (const rawLine of lines) {
      const line = rawLine.trim();
      const bulletMatch = line.match(/^[-*]\s+(.*)/);
      const numberedMatch = line.match(/^\d+[.)]\s+(.*)/);

      if (bulletMatch || numberedMatch) {
        const tag = bulletMatch ? "ul" : "ol";
        if (listTag && listTag !== tag) flushList();
        listTag = tag;
        listItems = listItems || [];
        listItems.push(`<li>${inline(bulletMatch ? bulletMatch[1] : numberedMatch[1])}</li>`);
      } else {
        flushList();
        if (line) blocks.push(`<p>${inline(line)}</p>`);
      }
    }
    flushList();
    return blocks.join("");
  }

  function inline(str) {
    return str
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  }

  // ---------- reports ----------

  async function loadReports() {
    reports = await fetchJson("/api/reports");
    reportPicker.innerHTML = "";
    for (const r of reports) {
      const opt = document.createElement("option");
      opt.value = r.id;
      opt.textContent = r.hasChat ? `${r.name}  ✦` : r.name;
      reportPicker.appendChild(opt);
    }
    if (reports.length > 0) {
      // Reopen whatever the user was last looking at rather than resetting
      // them to the first report on every refresh.
      const remembered = localStorage.getItem("selectedReportId");
      const initial = reports.some((r) => r.id === remembered) ? remembered : reports[0].id;
      await selectReport(initial);
    } else {
      setReportState(`<p>No reports configured yet — add one in config/reports.js.</p>`);
    }
  }

  async function selectReport(id) {
    currentReportId = id;
    reportPicker.value = id;
    try { localStorage.setItem("selectedReportId", id); } catch { /* storage unavailable */ }

    const report = reports.find((r) => r.id === id);
    const hasChat = Boolean(report?.hasChat);
    chatToggle.hidden = !hasChat;
    closeChat();
    resetChatLog();
    loadHistory(id);
    if (history.length) {
      hideEmptyState();
      replayHistory();
    }

    if (!powerbiService) {
      setReportState(`<p>powerbi-client failed to load.</p>`);
      return;
    }

    setReportState(`
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="3" y="12" width="4" height="9" rx="1" fill="currentColor" opacity="0.4"/>
        <rect x="10" y="7" width="4" height="14" rx="1" fill="currentColor" opacity="0.65"/>
        <rect x="17" y="3" width="4" height="18" rx="1" fill="currentColor" opacity="0.9"/>
      </svg>
      <p>Loading report…</p>
    `);

    try {
      const token = await fetchJson(`/api/embed-token/${encodeURIComponent(id)}`);

      powerbiService.reset(reportContainer);
      clearReportState();

      const embedded = powerbiService.embed(reportContainer, {
        type: "report",
        tokenType: window["powerbi-client"].models.TokenType.Embed,
        accessToken: token.accessToken,
        embedUrl: token.embedUrl,
        id: token.reportId,
        settings: {
          panes: { filters: { visible: false } },
        },
      });

      embeddedReport = embedded;
      currentVisualTitles = [];
      embedded.off("rendered");
      embedded.on("rendered", refreshVisualTitles);
      embedded.off("pageChanged");
      embedded.on("pageChanged", refreshVisualTitles);
      embedded.off("error");
      embedded.on("error", () => {
        setReportState(`<p>This report's embed token has expired. Reload the page to keep viewing it — this MVP doesn't auto-refresh tokens.</p>`);
      });
    } catch (err) {
      setReportState(`<p>Failed to load report: ${escapeHtml(err.message)}. Try reloading the page — embed tokens are short-lived and this MVP doesn't auto-refresh them.</p>`);
    }
  }

  reportPicker.addEventListener("change", (e) => selectReport(e.target.value));

  // ---------- chat panel open/close + resize ----------

  function openChat() {
    chatPanel.hidden = false;
    chatResizeHandle.hidden = false;
    chatInput.focus();
  }

  function closeChat() {
    chatPanel.hidden = true;
    chatResizeHandle.hidden = true;
  }

  chatToggle.addEventListener("click", () => {
    if (chatPanel.hidden) openChat();
    else closeChat();
  });
  chatClose.addEventListener("click", closeChat);
  document.getElementById("chat-clear").addEventListener("click", clearHistory);

  const savedWidth = localStorage.getItem("chatPanelWidth");
  if (savedWidth) chatPanel.style.width = `${savedWidth}px`;

  let resizing = false;
  chatResizeHandle.addEventListener("mousedown", (e) => {
    resizing = true;
    chatResizeHandle.classList.add("dragging");
    e.preventDefault();
  });
  window.addEventListener("mousemove", (e) => {
    if (!resizing) return;
    const width = Math.min(640, Math.max(280, window.innerWidth - e.clientX));
    chatPanel.style.width = `${width}px`;
  });
  window.addEventListener("mouseup", () => {
    if (!resizing) return;
    resizing = false;
    chatResizeHandle.classList.remove("dragging");
    localStorage.setItem("chatPanelWidth", parseInt(chatPanel.style.width, 10));
  });

  // ---------- chat history ----------
  //
  // Kept in localStorage rather than the database: the portal has no viewer
  // identity, so a server-side transcript would be shared by every visitor.
  // Per-browser storage keeps one person's conversation to themselves.

  const HISTORY_LIMIT = 15; // exchanges kept per report
  const HISTORY_SENT_TO_MODEL = 4; // recent exchanges given to the LLM

  let history = []; // [{ q, result }]

  function historyKey(reportId) {
    return `chatHistory:${reportId}`;
  }

  function loadHistory(reportId) {
    try {
      const raw = localStorage.getItem(historyKey(reportId));
      history = raw ? JSON.parse(raw) : [];
    } catch {
      history = [];
    }
  }

  function saveHistory() {
    if (!currentReportId) return;
    try {
      localStorage.setItem(historyKey(currentReportId), JSON.stringify(history.slice(-HISTORY_LIMIT)));
    } catch {
      // Quota exceeded or storage disabled — the transcript stays in memory
      // for this session rather than breaking the chat.
    }
  }

  function clearHistory() {
    history = [];
    if (currentReportId) {
      try { localStorage.removeItem(historyKey(currentReportId)); } catch { /* ignore */ }
    }
    resetChatLog();
  }

  // What the model sees: just the question and the prose answer, so follow-ups
  // like "and what about 2022?" resolve. Charts and DAX are left out — they'd
  // cost tokens without helping the model interpret the next question.
  function historyForModel() {
    return history.slice(-HISTORY_SENT_TO_MODEL).flatMap((h) => [
      { role: "user", content: h.q },
      { role: "assistant", content: (h.result && h.result.answer) || "" },
    ]);
  }

  function replayHistory() {
    for (const item of history) {
      appendUserRow(item.q);
      const row = appendThinkingRow();
      renderAnswerRow(row, item.result);
    }
  }

  // ---------- chat log rendering ----------

  function resetChatLog() {
    chatLog.innerHTML = "";
    chatLog.appendChild(chatEmptyState);
    chatEmptyState.hidden = false;
  }

  function hideEmptyState() {
    chatEmptyState.hidden = true;
  }

  function appendUserRow(question) {
    hideEmptyState();
    const row = document.createElement("div");
    row.className = "chat-row user";
    row.innerHTML = `<div class="chat-bubble">${escapeHtml(question)}</div>`;
    chatLog.appendChild(row);
    chatLog.scrollTop = chatLog.scrollHeight;
    return row;
  }

  function appendThinkingRow() {
    hideEmptyState();
    const row = document.createElement("div");
    row.className = "chat-row assistant";
    chatLog.appendChild(row);
    return row;
  }

  let daxCounter = 0;

  function renderAnswerRow(row, result) {
    const { answer, chart, dax } = result;
    daxCounter += 1;
    const daxId = `dax-${daxCounter}`;
    const bubble = row.querySelector(".chat-bubble");
    bubble.classList.remove("error");
    bubble.classList.toggle("clarify", Boolean(result.clarify));
    bubble.innerHTML = renderMarkdown(answer || "(no answer)");

    // A clarifying question is a prompt to the user, not a finding — mark it
    // as such and put the cursor back in the input so they can just reply.
    if (result.clarify) {
      chatInput.focus();
    }

    // For visual-context answers, show what was actually read so the user can
    // see the answer refers to the view they're looking at.
    if (result.visualContext) {
      const vc = result.visualContext;
      const parts = [];
      if (vc.pageName) parts.push(vc.pageName);
      // Name the chart that was actually analysed, so a focused answer is
      // visibly tied to the visual the user asked about.
      if (vc.focusTitle) parts.push(`focused on "${vc.focusTitle}"`);
      parts.push(`${vc.visualCount} visual${vc.visualCount === 1 ? "" : "s"}`);
      if (vc.filters && vc.filters !== "none") parts.push(`filters: ${vc.filters}`);
      const ctx = document.createElement("div");
      ctx.className = "visual-context";
      ctx.textContent = `Read from the current view — ${parts.join(" · ")}`;
      bubble.appendChild(ctx);
    }

    if (dax) {
      const disclosure = document.createElement("div");
      disclosure.className = "dax-disclosure";
      disclosure.innerHTML = `
        <button type="button" class="dax-toggle" data-target="${daxId}">
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M2 1l6 4-6 4V1z" fill="currentColor"/>
          </svg>
          <span>View generated DAX</span>
        </button>
        <div class="dax-body" id="${daxId}">
          <pre>${escapeHtml(dax)}</pre>
          <button type="button" class="dax-copy" title="Copy DAX">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <rect x="9" y="9" width="12" height="12" rx="2" stroke="currentColor" stroke-width="1.6"/>
              <path d="M5 15V5a2 2 0 0 1 2-2h10" stroke="currentColor" stroke-width="1.6"/>
            </svg>
          </button>
        </div>
      `;
      bubble.appendChild(disclosure);

      const toggleBtn = disclosure.querySelector(".dax-toggle");
      const body = disclosure.querySelector(".dax-body");
      toggleBtn.addEventListener("click", () => {
        const open = body.classList.toggle("open");
        toggleBtn.classList.toggle("open", open);
      });

      disclosure.querySelector(".dax-copy").addEventListener("click", async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(dax);
          const btn = disclosure.querySelector(".dax-copy");
          const original = btn.innerHTML;
          btn.innerHTML = "✓";
          setTimeout(() => { btn.innerHTML = original; }, 1200);
        } catch {
          /* clipboard unavailable — ignore */
        }
      });
    }

    if (chart) {
      // Assistant bubbles shrink to fit their text, so let the row span the
      // panel when it holds a chart — otherwise the chart inherits the width
      // of the sentence above it.
      row.classList.add("has-chart");

      const figure = document.createElement("figure");
      figure.className = "chat-chart";

      const enlarge = document.createElement("button");
      enlarge.type = "button";
      enlarge.className = "chart-enlarge";
      enlarge.title = "Enlarge chart";
      enlarge.setAttribute("aria-label", "Enlarge chart");
      enlarge.innerHTML = `
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M4 9V4h5M20 15v5h-5M20 9V4h-5M4 15v5h5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>`;
      enlarge.addEventListener("click", () => openChartModal(chart));

      const canvasHost = document.createElement("div");
      canvasHost.className = "chart-host";

      figure.appendChild(enlarge);
      figure.appendChild(canvasHost);
      bubble.appendChild(figure);

      // Size from the chat log rather than the bubble, which is content-sized.
      const available = (chatLog.clientWidth || 360) - 56;
      const width = Math.max(240, available);
      window.PortalCharts.renderChart(canvasHost, chart, {
        width,
        height: chart.type === "card" ? 120 : Math.round(Math.min(width * 0.72, 260)),
      });
    }

    chatLog.scrollTop = chatLog.scrollHeight;
  }

  function renderErrorRow(row, message, onRetry) {
    const bubble = row.querySelector(".chat-bubble");
    bubble.classList.add("error");
    bubble.innerHTML = `<div class="error-text">${escapeHtml(message)}</div>
      <button type="button" class="retry-btn">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M4 4v6h6M20 20v-6h-6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M5.5 15a8 8 0 0 0 14-3M18.5 9a8 8 0 0 0-14 3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
        </svg>
        Retry
      </button>`;
    bubble.querySelector(".retry-btn").addEventListener("click", onRetry);
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  function setThinking(row, label) {
    row.innerHTML =
      `<div class="chat-bubble">` +
      (label ? `<div class="thinking-label">${escapeHtml(label)}</div>` : "") +
      `<span class="typing-dots"><span></span><span></span><span></span></span></div>`;
  }

  // Reads the SSE stream from /api/chat/visual, painting text into the bubble
  // as it arrives. Falls back to a plain JSON response if the server chose not
  // to stream (a provider without streaming support).
  async function streamVisualAnswer(row, payload) {
    const res = await fetch("/api/chat/visual", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.headers.get("content-type")?.includes("text/event-stream")) {
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      return data;
    }

    const bubble = row.querySelector(".chat-bubble");
    bubble.innerHTML = "";
    const streamEl = document.createElement("div");
    bubble.appendChild(streamEl);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    let final = null;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const frames = buffer.split("\n\n");
      buffer = frames.pop() || "";

      for (const frame of frames) {
        const line = frame.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line.slice(5).trim()); } catch { continue; }

        if (msg.error) throw new Error(msg.error);
        if (msg.delta) {
          text += msg.delta;
          streamEl.innerHTML = renderMarkdown(text);
          chatLog.scrollTop = chatLog.scrollHeight;
        }
        if (msg.done) final = msg;
      }
    }

    if (!final) throw new Error("The response ended unexpectedly.");
    return { answer: final.answer || text, chart: null, visualContext: final.visualContext };
  }

  async function runAnswer(row, question) {
    const visual = isVisualQuestion(question);
    setThinking(row, visual ? "Reading the current view…" : null);

    try {
      let result;
      if (visual) {
        const focus = matchVisual(question);
        let state;
        try {
          state = await captureReportState(focus && focus.name);
        } catch (err) {
          // Couldn't read the visuals — fall back to whatever page/filter
          // metadata we do have rather than failing the question outright.
          state = { captureError: err.message, visuals: [] };
        }
        result = await streamVisualAnswer(row, { reportId: currentReportId, question, state, history: historyForModel() });
      } else {
        result = await fetchJson("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reportId: currentReportId, question, history: historyForModel() }),
        });
      }
      renderAnswerRow(row, result);
      history.push({ q: question, result });
      saveHistory();
    } catch (err) {
      renderErrorRow(row, err.message, () => runAnswer(row, question));
    }
  }

  function askQuestion(question) {
    appendUserRow(question);
    const row = appendThinkingRow();
    runAnswer(row, question);
  }

  chatForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const question = chatInput.value.trim();
    if (!question || !currentReportId) return;
    chatInput.value = "";
    askQuestion(question);
  });

  // Suggested prompts — one click to a useful first question, and they double
  // as a hint that the panel understands "what's on screen" as well as data.
  document.querySelectorAll("#chat-suggestions .suggestion").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!currentReportId) return;
      askQuestion(btn.dataset.q);
    });
  });

  // ---------- branding ----------

  async function loadBranding() {
    try {
      const branding = await fetchJson("/api/branding");
      if (branding.portalName) {
        document.getElementById("brand-name").textContent = branding.portalName;
        document.title = branding.portalName;
      }
      if (branding.accentColor) {
        document.documentElement.style.setProperty("--accent", branding.accentColor);
      }
      if (branding.logoDataUri) {
        document.getElementById("brand-icon").innerHTML = `<img src="${branding.logoDataUri}" alt="" />`;
      }
    } catch {
      // Branding is cosmetic — fall back to defaults silently.
    }
  }

  // ---------- boot ----------

  loadBranding();
  loadReports().catch((err) => {
    setReportState(`<p>Failed to load reports: ${escapeHtml(err.message)}</p>`);
  });
})();
