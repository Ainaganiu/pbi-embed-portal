(() => {
  const $ = (id) => document.getElementById(id);

  async function api(url, options) {
    const res = await fetch(url, {
      headers: { "Content-Type": "application/json" },
      ...options,
    });
    if (res.status === 401) {
      window.location.href = "/login.html";
      throw new Error("Not authenticated");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    return data;
  }

  // ---------- auth guard + logout ----------

  $("logout-btn").addEventListener("click", async () => {
    await api("/api/auth/logout", { method: "POST" });
    window.location.href = "/login.html";
  });

  // ---------- branding ----------

  let logoDataUri = null;

  function renderLogoPreview() {
    const preview = $("logo-preview");
    if (logoDataUri) {
      preview.innerHTML = `<img src="${logoDataUri}" alt="Logo preview" />`;
    } else {
      preview.innerHTML = `<span style="color:var(--text-faint);font-size:0.7rem;">No logo</span>`;
    }
  }

  $("logo-input").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const dataUri = await resizeImageToDataUri(file, 128, 128, 0.85);
    if (dataUri.length > 280_000) {
      alert("That image is still too large after resizing. Try a simpler/smaller image.");
      return;
    }
    logoDataUri = dataUri;
    renderLogoPreview();
  });

  function resizeImageToDataUri(file, maxW, maxH, quality) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const reader = new FileReader();
      reader.onload = () => {
        img.onload = () => {
          const scale = Math.min(1, maxW / img.width, maxH / img.height);
          const canvas = document.createElement("canvas");
          canvas.width = Math.round(img.width * scale);
          canvas.height = Math.round(img.height * scale);
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL("image/png", quality));
        };
        img.onerror = reject;
        img.src = reader.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  $("save-branding").addEventListener("click", async () => {
    const status = $("branding-status");
    status.textContent = "Saving…";
    try {
      await api("/api/admin/settings", {
        method: "PUT",
        body: JSON.stringify({
          portalName: $("portal-name").value.trim() || "Reports Portal",
          accentColor: $("accent-color").value,
          ...(logoDataUri ? { logoDataUri } : {}),
        }),
      });
      status.textContent = "Saved.";
    } catch (err) {
      status.textContent = `Error: ${err.message}`;
    }
  });

  // ---------- Power BI ----------

  $("save-powerbi").addEventListener("click", async () => {
    try {
      const secret = $("pbi-client-secret").value;
      await api("/api/admin/settings", {
        method: "PUT",
        body: JSON.stringify({
          pbiTenantId: $("pbi-tenant-id").value.trim(),
          pbiClientId: $("pbi-client-id").value.trim(),
          ...(secret ? { pbiClientSecret: secret } : {}),
        }),
      });
      $("pbi-client-secret").value = "";
      await loadSettings();
      $("test-powerbi-result").textContent = "Saved.";
      $("test-powerbi-result").className = "";
    } catch (err) {
      $("test-powerbi-result").textContent = `Error: ${err.message}`;
      $("test-powerbi-result").className = "fail";
    }
  });

  $("test-powerbi").addEventListener("click", async () => {
    const resultEl = $("test-powerbi-result");
    resultEl.textContent = "Testing…";
    resultEl.className = "";
    try {
      const secret = $("pbi-client-secret").value;
      const result = await api("/api/admin/test-powerbi", {
        method: "POST",
        body: JSON.stringify({
          tenantId: $("pbi-tenant-id").value.trim() || undefined,
          clientId: $("pbi-client-id").value.trim() || undefined,
          clientSecret: secret || undefined,
        }),
      });
      if (result.ok) {
        resultEl.textContent = "Connected successfully.";
        resultEl.className = "ok";
      } else {
        resultEl.textContent = result.error;
        resultEl.className = "fail";
      }
    } catch (err) {
      resultEl.textContent = err.message;
      resultEl.className = "fail";
    }
  });

  // ---------- AI Chat ----------

  $("save-llm").addEventListener("click", async () => {
    const status = $("llm-status");
    status.textContent = "Saving…";
    try {
      const key = $("llm-api-key").value;
      await api("/api/admin/settings", {
        method: "PUT",
        body: JSON.stringify({
          llmProvider: $("llm-provider").value,
          llmModel: $("llm-model").value.trim() || null,
          llmApiBase: $("llm-api-base").value.trim() || null,
          ...(key ? { llmApiKey: key } : {}),
        }),
      });
      $("llm-api-key").value = "";
      status.textContent = "Saved.";
      await loadSettings();
    } catch (err) {
      status.textContent = `Error: ${err.message}`;
    }
  });

  // ---------- settings load ----------

  async function loadSettings() {
    const s = await api("/api/admin/settings");
    $("portal-name").value = s.portalName || "";
    $("accent-color").value = s.accentColor || "#3b5bfd";
    logoDataUri = s.logoDataUri || null;
    renderLogoPreview();

    $("pbi-tenant-id").value = s.pbiTenantId || "";
    $("pbi-client-id").value = s.pbiClientId || "";
    const pbiStatus = $("pbi-secret-status");
    pbiStatus.textContent = s.pbiClientSecretSet ? "Client secret is set" : "No client secret set";
    pbiStatus.className = `secret-status ${s.pbiClientSecretSet ? "set" : "unset"}`;

    $("llm-provider").value = s.llmProvider || "anthropic";
    $("llm-model").value = s.llmModel || "";
    $("llm-api-base").value = s.llmApiBase || "";
    const llmStatus = $("llm-secret-status");
    llmStatus.textContent = s.llmApiKeySet ? "API key is set (chat enabled if reports have a schema)" : "No API key set (chat disabled)";
    llmStatus.className = `secret-status ${s.llmApiKeySet ? "set" : "unset"}`;
  }

  // ---------- reports ----------

  let reportsCache = [];

  async function loadReports() {
    reportsCache = await api("/api/admin/reports");
    const tbody = $("reports-tbody");
    tbody.innerHTML = "";
    for (const r of reportsCache) {
      const hasChat = Boolean(r.datasetId && r.schemaDescription);
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>
          <div class="report-row-name">${escapeHtml(r.name)}</div>
          <div class="report-row-id">${escapeHtml(r.id)}</div>
        </td>
        <td class="report-row-id">${escapeHtml(r.workspaceId)} / ${escapeHtml(r.reportId)}</td>
        <td>${hasChat ? "Enabled" : "—"}</td>
        <td>
          <button class="btn-secondary edit-btn" type="button">Edit</button>
          <button class="btn-danger delete-btn" type="button">Delete</button>
        </td>
      `;
      tr.querySelector(".edit-btn").addEventListener("click", () => openEditor(r));
      tr.querySelector(".delete-btn").addEventListener("click", () => deleteReport(r.id));
      tbody.appendChild(tr);
    }
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str ?? "";
    return div.innerHTML;
  }

  function openEditor(report) {
    $("report-editor").hidden = false;
    $("report-editor-error").hidden = true;
    const editing = Boolean(report);
    $("report-editor-title").textContent = editing ? "Edit report" : "Add report";
    $("report-editing-id").value = editing ? report.id : "";
    $("report-id").value = editing ? report.id : "";
    $("report-id").disabled = editing;
    $("report-name").value = editing ? report.name : "";
    $("report-workspace-id").value = editing ? report.workspaceId : "";
    $("report-report-id").value = editing ? report.reportId : "";
    $("report-dataset-id").value = editing ? report.datasetId || "" : "";
    $("report-schema").value = editing ? report.schemaDescription || "" : "";
    $("report-problem").value = editing ? report.problemStatement || "" : "";
    $("report-measures").value = editing ? report.measuresDescription || "" : "";
    $("report-columns").value = editing ? report.columnsDescription || "" : "";
    $("model-synced-at").textContent = editing && report.modelMetadataSyncedAt
      ? `Last synced ${new Date(report.modelMetadataSyncedAt).toLocaleString()}`
      : "Never synced";
    $("model-report").hidden = true;
    $("sync-model").disabled = !editing;
    $("report-id").focus();
    resetBrowsePicker();
    loadWorkspaces();
  }

  function closeEditor() {
    $("report-editor").hidden = true;
  }

  $("add-report-btn").addEventListener("click", () => openEditor(null));
  $("cancel-report-edit").addEventListener("click", closeEditor);

  // ---------- browse Power BI picker ----------

  let workspacesLoaded = false;

  function resetBrowsePicker() {
    $("browse-workspace").innerHTML = `<option value="">Select a workspace…</option>`;
    $("browse-report").innerHTML = `<option value="">Select a report…</option>`;
    $("browse-report").disabled = true;
    $("browse-status").textContent = "Uses the saved Power BI credentials to list workspaces/reports and fill in the IDs below.";
    workspacesLoaded = false;
  }

  async function loadWorkspaces() {
    if (workspacesLoaded) return;
    const status = $("browse-status");
    try {
      const workspaces = await api("/api/admin/powerbi/workspaces");
      const select = $("browse-workspace");
      for (const w of workspaces) {
        const opt = document.createElement("option");
        opt.value = w.id;
        opt.textContent = w.name;
        select.appendChild(opt);
      }
      workspacesLoaded = true;
      status.textContent = workspaces.length
        ? "Pick a workspace to browse its reports."
        : "No workspaces found — is the service principal added as a member of any workspace?";
    } catch (err) {
      status.textContent = `Couldn't list workspaces: ${err.message}`;
    }
  }

  $("browse-workspace").addEventListener("change", async (e) => {
    const workspaceId = e.target.value;
    const reportSelect = $("browse-report");
    reportSelect.innerHTML = `<option value="">Select a report…</option>`;
    reportSelect.disabled = true;
    if (!workspaceId) return;

    const status = $("browse-status");
    status.textContent = "Loading reports…";
    try {
      const reports = await api(`/api/admin/powerbi/workspaces/${encodeURIComponent(workspaceId)}/reports`);
      for (const r of reports) {
        const opt = document.createElement("option");
        opt.value = r.id;
        opt.textContent = r.name;
        opt.dataset.datasetId = r.datasetId || "";
        opt.dataset.name = r.name;
        reportSelect.appendChild(opt);
      }
      reportSelect.disabled = false;
      status.textContent = reports.length
        ? "Pick a report to fill in the fields below."
        : "No reports found in this workspace.";
    } catch (err) {
      status.textContent = `Couldn't list reports: ${err.message}`;
    }
  });

  $("browse-report").addEventListener("change", (e) => {
    const opt = e.target.selectedOptions[0];
    if (!opt || !opt.value) return;

    $("report-workspace-id").value = $("browse-workspace").value;
    $("report-report-id").value = opt.value;
    $("report-dataset-id").value = opt.dataset.datasetId || "";
    if (!$("report-name").value.trim()) {
      $("report-name").value = opt.dataset.name || "";
    }
    if (!$("report-editing-id").value && !$("report-id").value.trim()) {
      $("report-id").value = slugify(opt.dataset.name || "");
    }
  });

  function slugify(str) {
    return str
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60);
  }

  $("save-report").addEventListener("click", async () => {
    const errorEl = $("report-editor-error");
    errorEl.hidden = true;

    const editingId = $("report-editing-id").value;
    const id = $("report-id").value.trim();
    const payload = {
      id,
      name: $("report-name").value.trim(),
      workspaceId: $("report-workspace-id").value.trim(),
      reportId: $("report-report-id").value.trim(),
      datasetId: $("report-dataset-id").value.trim() || null,
      schemaDescription: $("report-schema").value.trim() || null,
      problemStatement: $("report-problem").value.trim() || null,
      measuresDescription: $("report-measures").value.trim() || null,
      columnsDescription: $("report-columns").value.trim() || null,
    };

    try {
      if (editingId) {
        await api(`/api/admin/reports/${encodeURIComponent(editingId)}`, {
          method: "PUT",
          body: JSON.stringify(payload),
        });
      } else {
        await api("/api/admin/reports", {
          method: "POST",
          body: JSON.stringify(payload),
        });
      }
      closeEditor();
      await loadReports();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
  });

  $("sync-model").addEventListener("click", async () => {
    const id = $("report-editing-id").value;
    if (!id) return;

    const btn = $("sync-model");
    const panel = $("model-report");
    btn.disabled = true;
    btn.textContent = "Syncing…";
    try {
      const r = await api(`/api/admin/reports/${encodeURIComponent(id)}/sync-model`, { method: "POST" });
      $("model-synced-at").textContent = `Last synced ${new Date(r.syncedAt).toLocaleString()}`;

      const measuresWithExpression = r.counts.measuresWithExpression ?? 0;
      const calculatedColumnsWithExpression = r.counts.calculatedColumnsWithExpression ?? 0;
      const rows = [
        `<div><strong>${r.counts.tables}</strong> tables, <strong>${r.counts.measures}</strong> measures, ` +
          `<strong>${r.counts.columns}</strong> columns, <strong>${r.counts.relationships}</strong> relationships.</div>`,
      ];
      if (measuresWithExpression || calculatedColumnsWithExpression) {
        rows.push(
          `<div>${measuresWithExpression} of ${r.counts.measures} measures have real DAX read from the model.</div>`,
          `<div>${calculatedColumnsWithExpression} calculated column DAX definitions read from the model.</div>`
        );
      }
      rows.push(`<div>${r.reconciliation.describedCount} described by your notes.</div>`);
      // The two lists worth acting on: what the AI will be told nothing
      // about, and what your notes claim exists but the model has never
      // heard of.
      if (r.reconciliation.undescribed.length) {
        rows.push(
          `<details><summary>${r.reconciliation.undescribed.length} without a description</summary><pre>` +
            escapeHtml(r.reconciliation.undescribed.join("\n")) +
            `</pre></details>`
        );
      }
      if (r.reconciliation.unknownReferences.length) {
        rows.push(
          `<div class="model-report-warn">Your notes mention ` +
            escapeHtml(r.reconciliation.unknownReferences.join(", ")) +
            `, which this model does not contain. That text is left out of what the AI is given.</div>`
        );
      }
      panel.innerHTML = rows.join("");
      panel.hidden = false;
    } catch (err) {
      panel.innerHTML = `<div class="model-report-warn">${escapeHtml(err.message)}</div>`;
      panel.hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = "Sync from model";
    }
  });

  async function deleteReport(id) {
    if (!confirm(`Delete report "${id}"? This can't be undone.`)) return;
    await api(`/api/admin/reports/${encodeURIComponent(id)}`, { method: "DELETE" });
    await loadReports();
  }

  // ---------- boot ----------

  (async () => {
    const status = await fetch("/api/auth/status").then((r) => r.json());
    if (!status.loggedIn) {
      window.location.href = "/login.html";
      return;
    }
    await loadSettings();
    await loadReports();
  })();
})();
