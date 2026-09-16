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
  let currentChart = null;

  // ---------- tiny helpers ----------

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

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
      await selectReport(reports[0].id);
    } else {
      setReportState(`<p>No reports configured yet — add one in config/reports.js.</p>`);
    }
  }

  async function selectReport(id) {
    currentReportId = id;
    reportPicker.value = id;

    const report = reports.find((r) => r.id === id);
    const hasChat = Boolean(report?.hasChat);
    chatToggle.hidden = !hasChat;
    closeChat();
    resetChatLog();

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

  function renderAnswerRow(row, { answer, chart, dax }) {
    daxCounter += 1;
    const daxId = `dax-${daxCounter}`;
    const bubble = row.querySelector(".chat-bubble");
    bubble.classList.remove("error");
    bubble.innerHTML = renderMarkdown(answer || "(no answer)");

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

    if (chart && Array.isArray(chart.labels) && Array.isArray(chart.values)) {
      if (currentChart) {
        currentChart.destroy();
        currentChart = null;
      }
      const canvas = document.createElement("canvas");
      bubble.appendChild(canvas);
      currentChart = new Chart(canvas, {
        type: chart.type === "line" ? "line" : "bar",
        data: {
          labels: chart.labels,
          datasets: [
            {
              label: chart.label || "Value",
              data: chart.values,
              backgroundColor: "#3b5bfd",
              borderColor: "#3b5bfd",
              tension: 0.3,
            },
          ],
        },
        options: {
          responsive: true,
          plugins: { legend: { display: false } },
          scales: {
            x: { grid: { display: false } },
            y: { grid: { color: "#eef0f4" } },
          },
        },
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

  async function runAnswer(row, question) {
    row.innerHTML = `<div class="chat-bubble"><span class="typing-dots"><span></span><span></span><span></span></span></div>`;
    try {
      const result = await fetchJson("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reportId: currentReportId, question }),
      });
      renderAnswerRow(row, result);
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
