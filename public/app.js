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

  // A ceiling on an in-panel chart, not its height: the renderer sizes from
  // the content, and this only stops a long category list from filling the
  // whole log. Shared so the first draw and a resize redraw agree.
  const CHART_MAX_HEIGHT = 520;

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

  const DECORATIVE = ["shape", "image", "textbox", "actionButton", "basicShape"];

  async function captureReportState() {
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
        // The id travels so the router can name the visual a question is
        // about; the browser no longer decides that.
        const entry = { name: v.name, title: v.title || v.name, type: v.type };

        // A visual can carry its own filter on top of page/report ones, which
        // changes what its numbers actually mean.
        const filtersPromise = Promise.resolve(v.getFilters?.()).catch(() => null);

        try {
          if (v.type === "slicer") {
            const slicer = await v.getSlicerState();
            const values = (slicer.filters || []).flatMap((f) => f.values || []).join(", ");
            entry.slicerState = values || "(no selection — showing all)";
          } else {
            // Uniform: the router names the focused visual only after this has
            // run, so capture can't favour one. Mirrors
            // EXPORT_ROWS_PER_VISUAL in lib/budgets.js.
            const result = await v.exportData(models().ExportDataType.Summarized, 30);
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

  // ---------- chart downloads ----------

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  // The SVG is serialised and painted onto a canvas rather than screenshotted:
  // the chart is vector, so this is the only way to get a clean raster of it
  // without a dependency. At 2x so it stays sharp when pasted into a deck.
  function exportPng(host, label) {
    const svg = host.querySelector("svg");
    if (!svg) return;
    const scale = 2;
    const width = +svg.getAttribute("width");
    const height = +svg.getAttribute("height");
    const source = new XMLSerializer().serializeToString(svg);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = width * scale;
      canvas.height = height * scale;
      const ctx2d = canvas.getContext("2d");
      ctx2d.fillStyle = "#ffffff";
      ctx2d.fillRect(0, 0, canvas.width, canvas.height);
      ctx2d.drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => {
        if (blob) downloadBlob(blob, `${label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.png`);
      });
    };
    img.src = "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(source)));
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
    // A ceiling, not a height: a long category list is allowed to grow into
    // the modal's scrollable body rather than being squashed into one screen,
    // but it must not inherit the renderer's 2000px default either.
    const width = Math.min(1100, Math.round(window.innerWidth * 0.86));
    const maxHeight = Math.max(260, Math.round(window.innerHeight * 0.68));
    window.PortalCharts.renderChart(chartModalBody, spec, { width, maxHeight });
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
    loadStarters(id);
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

  // Mirrors HISTORY_EXCHANGES_STORED / HISTORY_EXCHANGES_TO_MODEL in
  // lib/budgets.js — the browser has no require, so keep them in step by hand.
  const HISTORY_LIMIT = 40;
  const HISTORY_SENT_TO_MODEL = 10;

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

  // Generated from the report's own schema, so the empty panel is useful on
  // first open rather than offering the same four prompts everywhere.
  async function loadStarters(reportId) {
    const host = document.getElementById("chat-suggestions");
    host.innerHTML = "";
    let starters = [];
    try {
      starters = (await fetchJson(`/api/chat/starters/${encodeURIComponent(reportId)}`)).starters || [];
    } catch {
      return; // the panel is still usable without them
    }
    starters.forEach((q) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "suggestion";
      btn.textContent = q;
      btn.addEventListener("click", () => { if (currentReportId) askQuestion(q); });
      host.appendChild(btn);
    });
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

  // A row may or may not already hold its bubble: live answers get one from
  // setThinking, replayed history rows start empty. Callers shouldn't have to
  // know which.
  function ensureBubble(row) {
    let bubble = row.querySelector(".chat-bubble");
    if (!bubble) {
      bubble = document.createElement("div");
      bubble.className = "chat-bubble";
      row.appendChild(bubble);
    }
    return bubble;
  }

  function appendThinkingRow() {
    hideEmptyState();
    const row = document.createElement("div");
    row.className = "chat-row assistant";
    chatLog.appendChild(row);
    return row;
  }

  let daxCounter = 0;
  let clarifyCounter = 0;

  // Three questions the answer leads to, offered as one-click chips. Every
  // answer ends with them: the hard part of using a report you didn't build is
  // knowing what to ask next, and the model has just read the data, so it is
  // better placed to suggest that than the user is.
  function renderFollowUps(bubble, followUps) {
    const list = (followUps || []).filter((q) => typeof q === "string" && q.trim());
    if (!list.length) return;

    const wrap = document.createElement("div");
    wrap.className = "followups";

    const label = document.createElement("div");
    label.className = "followups-label";
    label.textContent = "Ask next";
    wrap.appendChild(label);

    const chips = document.createElement("div");
    chips.className = "followup-chips";
    list.forEach((q) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "suggestion";
      chip.textContent = q;
      chip.addEventListener("click", () => {
        if (!currentReportId) return;
        askQuestion(q);
      });
      chips.appendChild(chip);
    });

    wrap.appendChild(chips);
    bubble.appendChild(wrap);
  }

  // An ambiguous question comes back as one or more questions with suggested
  // answers. Rendering them as chips means a comparison can be pinned down in
  // one interaction instead of several slow round trips.
  function renderClarifyOptions(bubble, result, row) {
    const questions = Array.isArray(result.questions) ? result.questions : [];
    // A single question with no options is just prose — the bubble already
    // shows it, so there's nothing to add.
    if (!questions.length || (questions.length === 1 && !questions[0].options.length)) return;

    // One set of answers per question. A "multi" question keeps several, so
    // "which measures?" can be answered with all three at once instead of
    // three round trips.
    const picked = questions.map(() => new Set());
    const groupName = `clarify-${++clarifyCounter}`;
    const wrap = document.createElement("div");
    wrap.className = "clarify-questions";

    questions.forEach((q, i) => {
      const block = document.createElement("div");
      block.className = "clarify-q";

      // With one question the bubble text already asks it; repeating it reads
      // like a stutter — unless that text is the model's reasoning for asking,
      // in which case the question itself still has to appear.
      if (questions.length > 1 || result.answer !== q.ask) {
        const label = document.createElement("div");
        label.className = "clarify-ask";
        label.textContent = q.ask;
        if (q.multi) {
          const hint = document.createElement("span");
          hint.className = "clarify-hint";
          hint.textContent = "tick all that apply";
          label.appendChild(hint);
        }
        block.appendChild(label);
      }

      const opts = document.createElement("div");
      opts.className = "clarify-options";

      q.options.forEach((opt, j) => {
        // A checkbox where several answers are allowed, a radio where only one
        // is: the control itself tells the user which, so nobody has to guess
        // whether a second tick will replace the first.
        const id = `${groupName}-${i}-${j}`;
        const label = document.createElement("label");
        label.className = "clarify-option";
        label.htmlFor = id;

        const input = document.createElement("input");
        input.type = q.multi ? "checkbox" : "radio";
        input.id = id;
        input.name = `${groupName}-${i}`;

        input.addEventListener("change", () => {
          if (!q.multi) picked[i].clear();
          if (input.checked) picked[i].add(opt);
          else picked[i].delete(opt);
          label.classList.toggle("chosen", input.checked);
          if (!q.multi) {
            opts.querySelectorAll(".clarify-option").forEach((l) => {
              if (l !== label) l.classList.remove("chosen");
            });
          }
          refreshSubmit();
        });

        const text = document.createElement("span");
        text.textContent = opt;

        label.appendChild(input);
        label.appendChild(text);
        opts.appendChild(label);
      });

      block.appendChild(opts);
      wrap.appendChild(block);
    });

    // Every question needs an answer before the round trip is worth making —
    // sending a half-answered set just earns another clarification.
    function refreshSubmit() {
      const answered = picked.filter((set) => set.size).length;
      submit.disabled = answered === 0;
      submit.textContent =
        answered < questions.length
          ? `Continue (${answered} of ${questions.length})`
          : "Continue";
    }

    const actions = document.createElement("div");
    actions.className = "clarify-actions";
    const submit = document.createElement("button");
    submit.type = "button";
    submit.className = "btn-primary";
    submit.style.width = "auto";
    submit.textContent = "Continue";
    submit.disabled = true;
    actions.appendChild(submit);

    // An ambiguous question is otherwise a hard stop until the user engages
    // with the chips. Sometimes they just want an answer.
    const decide = document.createElement("button");
    decide.type = "button";
    decide.className = "clarify-skip";
    decide.textContent = "Just choose for me";
    decide.addEventListener("click", () => {
      const original = pendingClarifyQuestion || "";
      wrap.remove();
      askQuestion(
        `${original} — take the most reasonable reading and answer it; ` +
        `state the assumption you made in your first line.`
      );
    });
    actions.appendChild(decide);

    const note = document.createElement("span");
    note.className = "clarify-note";
    note.textContent = "or type your own answer";
    actions.appendChild(note);
    wrap.appendChild(actions);

    submit.addEventListener("click", () => {
      // Only the chosen values, not the questions. Echoing "Compare against
      // what? Year over year" reads as another question and the model asks
      // again instead of answering.
      const answers = picked
        .map((set) => [...set].join(" and "))
        .filter(Boolean)
        .join("; ");

      // Resend the original question with the answers attached rather than
      // relying on history — this still resolves if the transcript was
      // truncated or cleared.
      const original = pendingClarifyQuestion || "";
      wrap.remove();
      askQuestion(original ? `${original} — ${answers}` : answers);
    });

    bubble.appendChild(wrap);
  }

  function renderAnswerRow(row, result) {
    const { answer, chart, dax } = result;
    daxCounter += 1;
    const daxId = `dax-${daxCounter}`;

    const bubble = ensureBubble(row);
    bubble.classList.remove("error");
    bubble.classList.toggle("clarify", Boolean(result.clarify));
    bubble.innerHTML = renderMarkdown(answer || "(no answer)");

    // A clarifying question is a prompt to the user, not a finding — mark it
    // as such and put the cursor back in the input so they can just reply.
    if (result.clarify) {
      renderClarifyOptions(bubble, result, row);
      chatInput.focus();
    }

    // For visual-context answers, show what was actually read so the user can
    // see the answer refers to the view they're looking at.
    // Authoring answers carry code the user will paste into Power BI, plus
    // the result of actually running it against their model.
    if (result.authoring && result.dax) {
      const block = document.createElement("div");
      block.className = "authored-dax";
      block.innerHTML = `
        <div class="authored-dax-head">
          <span>DAX</span>
          <button type="button" class="dax-copy" title="Copy">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <rect x="9" y="9" width="12" height="12" rx="2" stroke="currentColor" stroke-width="1.6"/>
              <path d="M5 15V5a2 2 0 0 1 2-2h10" stroke="currentColor" stroke-width="1.6"/>
            </svg>
          </button>
        </div>
        <pre>${escapeHtml(result.dax)}</pre>`;

      block.querySelector(".dax-copy").addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(result.dax);
          const b = block.querySelector(".dax-copy");
          const original = b.innerHTML;
          b.innerHTML = "✓";
          setTimeout(() => { b.innerHTML = original; }, 1200);
        } catch { /* clipboard unavailable */ }
      });

      if (result.validation) {
        const v = document.createElement("div");
        v.className = `dax-validation ${result.validation.ok ? "ok" : "fail"}`;
        v.textContent = result.validation.ok
          ? `Runs against your model${result.validation.sample ? ` — returns ${result.validation.sample}` : ""}`
          : `Didn't run: ${result.validation.error}`;
        block.appendChild(v);
      }
      bubble.appendChild(block);
    }

    if (result.visualContext) {
      const vc = result.visualContext;
      const parts = [];
      if (vc.pageName) parts.push(vc.pageName);
      // Name the chart that was actually analysed, so a focused answer is
      // visibly tied to the visual the user asked about.
      if (vc.focusTitle) parts.push(`focused on "${vc.focusTitle}"`);
      if (vc.queried) parts.push("model queried for missing data");
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

      const tools = document.createElement("div");
      tools.className = "chart-tools";

      const redraw = () => {
        const width = Math.max(240, (chatLog.clientWidth || 360) - 56);
        window.PortalCharts.renderChart(canvasHost, figure.__spec, { width, maxHeight: CHART_MAX_HEIGHT });
      };

      // Only the forms these rows can honestly take. A line over unordered
      // categories would imply an order that isn't there.
      const types = Array.isArray(chart.validTypes) ? chart.validTypes : [];
      if (types.length > 1) {
        const select = document.createElement("select");
        select.className = "chart-type";
        select.title = "Chart type";
        types.forEach((t) => {
          const option = document.createElement("option");
          option.value = t;
          option.textContent = t;
          option.selected = t === chart.type;
          select.appendChild(option);
        });
        select.addEventListener("change", () => {
          figure.__spec = { ...figure.__spec, type: select.value };
          redraw();
        });
        tools.appendChild(select);
      }

      const csv = document.createElement("button");
      csv.type = "button";
      csv.className = "chart-tool";
      csv.textContent = "CSV";
      csv.title = "Download the data";
      csv.addEventListener("click", () => {
        downloadBlob(
          new Blob([window.PortalCharts.toCsv(figure.__spec)], { type: "text/csv" }),
          `${(chart.label || "chart").replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.csv`
        );
      });
      tools.appendChild(csv);

      const png = document.createElement("button");
      png.type = "button";
      png.className = "chart-tool";
      png.textContent = "PNG";
      png.title = "Download the chart";
      png.addEventListener("click", () => exportPng(canvasHost, chart.label || "chart"));
      tools.appendChild(png);

      tools.appendChild(enlarge); // the existing enlarge button, unchanged
      figure.appendChild(tools);
      figure.appendChild(canvasHost);
      bubble.appendChild(figure);

      // Size from the chat log rather than the bubble, which is content-sized.
      const available = (chatLog.clientWidth || 360) - 56;
      const width = Math.max(240, available);
      // The spec rides on the element so a resize can redraw it without
      // re-asking the model.
      figure.__spec = chart;
      window.PortalCharts.renderChart(canvasHost, chart, { width, maxHeight: CHART_MAX_HEIGHT });
    }

    // Last, under everything else — a clarifying question is already asking
    // something, so suggesting three more on top of it would just compete.
    if (!result.clarify) renderFollowUps(bubble, result.followUps);

    chatLog.scrollTop = chatLog.scrollHeight;
  }

  // The server describes a failure as a sentence plus what to do about it, so
  // the headline stays readable and the raw text only shows if it is asked
  // for. A failure the server calls unrecoverable offers no retry — the button
  // would only spend the user's time confirming the same answer.
  function renderErrorRow(row, err, onRetry) {
    const bubble = ensureBubble(row);
    bubble.classList.add("error");
    const hint = err.hint ? `<div class="error-hint">${escapeHtml(err.hint)}</div>` : "";
    const details = err.details && err.details !== err.message
      ? `<details class="error-details"><summary>Details</summary><pre>${escapeHtml(err.details)}</pre></details>`
      : "";
    const dax = err.dax ? `<pre class="error-dax">${escapeHtml(err.dax)}</pre>` : "";
    bubble.innerHTML =
      `<div class="error-text">${escapeHtml(err.message)}</div>${hint}${dax}${details}` +
      (err.retryable === false
        ? ""
        : `<button type="button" class="retry-btn">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M4 4v6h6M20 20v-6h-6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M5.5 15a8 8 0 0 0 14-3M18.5 9a8 8 0 0 0-14 3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
        </svg>
        Retry
      </button>`);
    const retry = bubble.querySelector(".retry-btn");
    if (retry) retry.addEventListener("click", onRetry);
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  function setThinking(row, label) {
    row.innerHTML =
      `<div class="chat-bubble">` +
      (label ? `<div class="thinking-label">${escapeHtml(label)}</div>` : "") +
      `<span class="typing-dots"><span></span><span></span><span></span></span></div>`;
  }

  // Reads the SSE stream from /api/chat, painting text into the bubble as it
  // arrives. There is one endpoint now, and it always streams — a response
  // that isn't an event stream is the server refusing the request, so it is
  // read as an error rather than as an answer.
  async function streamAnswer(row, payload, signal) {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    });

    if (!res.headers.get("content-type")?.includes("text/event-stream")) {
      const data = await res.json().catch(() => ({}));
      throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { hint: null });
    }

    // Reassigned if the pipeline changes course mid-stream: setThinking
    // rebuilds the bubble to show the new stage, so these can't be const.
    let bubble = ensureBubble(row);
    bubble.innerHTML = "";
    let streamEl = document.createElement("div");
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

        if (msg.error) {
          throw Object.assign(new Error(msg.error.message), {
            hint: msg.error.hint,
            details: msg.error.details,
            retryable: msg.error.retryable,
            dax: msg.error.dax,
          });
        }
        if (msg.stage) {
          // A stage after text has begun means the pipeline changed course —
          // rebuild the bubble so the new stage shows rather than sitting
          // under a half-written answer.
          setThinking(row, STAGE_LABELS[msg.stage] || null);
          bubble = ensureBubble(row);
          streamEl = document.createElement("div");
          bubble.appendChild(streamEl);
          text = "";
          continue;
        }
        if (msg.delta) {
          text += msg.delta;
          streamEl.innerHTML = renderMarkdown(text);
          chatLog.scrollTop = chatLog.scrollHeight;
        }
        if (msg.done) final = msg;
      }
    }

    if (!final) throw new Error("The response ended unexpectedly.");
    // The final frame is authoritative: the streamed text is what was safe to
    // show as it arrived, and carries neither the clarifying questions nor the
    // follow-ups, both of which are stripped out of the stream.
    return {
      answer: final.answer || text,
      // The escalation path queries the model for figures the page doesn't
      // show, so there is no visual of them anywhere — this is the only place
      // the user sees their shape.
      chart: final.chart || null,
      questions: final.questions,
      clarify: final.clarify,
      followUps: final.followUps,
      visualContext: final.visualContext,
      dax: final.dax,
      authoring: final.route === "authoring",
      validation: final.validation,
    };
  }

  // The server's stage vocabulary, said in the user's terms. An unnamed stage
  // falls back to the bare typing dots rather than showing a raw token.
  const STAGE_LABELS = {
    routing: "Working out how to answer this…",
    reading: "Reading the current view…",
    writing_query: "Writing the query…",
    running_query: "Running it against the model…",
    retrying_query: "Adjusting the query…",
    escalating: "The page can't answer that — querying the model…",
    validating: "Checking it runs against your model…",
    composing: "Writing it up…",
  };

  // The request in flight, so the stop button can cancel it.
  let inFlight = null;

  async function runAnswer(row, question) {
    setThinking(row, STAGE_LABELS.routing);

    // Every question now carries the view: the server decides whether it
    // matters, so the browser no longer has to guess which questions are
    // about what is on screen.
    let state;
    try {
      state = await captureReportState();
    } catch (err) {
      // Couldn't read the visuals — send whatever page metadata we do have
      // rather than failing the question outright.
      state = { captureError: err.message, visuals: [] };
    }

    const controller = new AbortController();
    inFlight = controller;
    setSending(true);

    try {
      const result = await streamAnswer(row, {
        reportId: currentReportId,
        question,
        state,
        history: historyForModel(),
      }, controller.signal);
      renderAnswerRow(row, result);
      history.push({ q: question, result });
      saveHistory();
    } catch (err) {
      if (err.name === "AbortError") {
        // The user asked for this to stop, so a failed row would be reporting
        // their own decision back to them as a problem.
        row.remove();
        return;
      }
      renderErrorRow(row, err, () => startAnswer(row, question));
    } finally {
      inFlight = null;
      setSending(false);
    }
  }

  function setSending(sending) {
    chatSend.classList.toggle("sending", sending);
    chatSend.setAttribute("aria-label", sending ? "Stop" : "Send");
    chatSend.title = sending ? "Stop" : "Send";
  }

  chatSend.addEventListener("click", (e) => {
    // While a request is in flight this button stops it rather than
    // submitting. Aborting the fetch closes the connection, which is what
    // tells the server to stop spending on provider calls.
    if (!inFlight) return;
    e.preventDefault();
    inFlight.abort();
  });

  // The question a clarification is about, so answering the chips can resend
  // the original rather than depending on the transcript still being there.
  let pendingClarifyQuestion = null;

  // One question at a time. `inFlight` holds a single AbortController, so a
  // second question would overwrite it: the first request would keep streaming
  // — and keep spending on provider and Power BI calls — with nothing left
  // able to stop it, and whichever finished first would put the button back to
  // "Send" while the other was still running. This flag is set synchronously
  // rather than reading `inFlight`, because the slot isn't filled until the
  // view has been captured, and capture is the slowest part of the request.
  let asking = false;

  // The only way `runAnswer` is ever called. Retry reaches it too, so a retry
  // in flight blocks a new question exactly as a new question does — otherwise
  // retry would be the one path that could still be orphaned.
  function startAnswer(row, question) {
    if (asking) return false;
    asking = true;
    runAnswer(row, question).finally(() => { asking = false; });
    return true;
  }

  function askQuestion(question) {
    if (asking) return false;
    pendingClarifyQuestion = question;
    appendUserRow(question);
    const row = appendThinkingRow();
    return startAnswer(row, question);
  }

  chatForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const question = chatInput.value.trim();
    if (!question || !currentReportId) return;
    // Keep what they typed if the question was refused — clearing it would
    // lose the question to a race they can't see.
    if (askQuestion(question)) chatInput.value = "";
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

  // A chart used to keep the width it was born at, so dragging the panel
  // wider left it stranded at its old size.
  let resizeTimer = null;
  new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const width = Math.max(240, (chatLog.clientWidth || 360) - 56);
      chatLog.querySelectorAll(".chat-chart").forEach((figure) => {
        if (!figure.__spec) return;
        window.PortalCharts.renderChart(figure.querySelector(".chart-host"), figure.__spec, {
          width,
          maxHeight: CHART_MAX_HEIGHT,
        });
      });
    }, 120);
  }).observe(chatLog);

  // ---------- boot ----------

  loadBranding();
  loadReports().catch((err) => {
    setReportState(`<p>Failed to load reports: ${escapeHtml(err.message)}</p>`);
  });
})();
