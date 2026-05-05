/* Invoice CRUD + AI processing */

let invoiceList      = [];
let filteredList     = [];
let currentPage      = 1;
let editingInvoice   = null;
let currentInvoiceId = null;
let currentInvoice   = null;
let companiesList    = [];
let pendingUploadFile    = null;
let pendingOverwriteId   = null;
let detailSaved          = false;
const PAGE_SIZE = 20;
const BATCH_MAX  = 50;

/* ── Batch upload queue ──────────────────────────────────────── */

let batchTotal   = 0;
let batchDone    = 0;
let batchFailed  = 0;

/* single-file sequential review queue (used when multiple files are dropped/selected at once) */
let singleQueue = [];
/* pre-fetched next result: { file, promise: Promise<{result,companies}|{error}> } */
let prefetch = null;

/* Strip folder path from a filename string (handles both / and \) */
const bname = s => (s || "").split("/").pop().split("\\").pop();

function showProgressPanel() {
  const panel = document.getElementById("upload-progress-panel");
  panel.classList.add("visible");
  document.getElementById("progress-spinner").style.display = "inline-block";
  document.getElementById("progress-close-btn").style.display = "none";
  document.getElementById("progress-title").textContent = "アップロード中...";
  document.getElementById("progress-bar-fill").style.width = "0%";
  document.getElementById("progress-bar-fill").style.background = "";
  document.getElementById("progress-log").innerHTML = "";
  document.getElementById("ps-done").textContent  = "0";
  document.getElementById("ps-total").textContent = "0";
  document.getElementById("ps-ok").textContent    = "0";
  document.getElementById("ps-err").textContent   = "0";
  setProgressCurrent("");
}

function closeProgressPanel() {
  document.getElementById("upload-progress-panel").classList.remove("visible");
}

function updateProgressBar() {
  const processed = batchDone + batchFailed;
  const pct = batchTotal ? Math.round(processed / batchTotal * 100) : 0;
  document.getElementById("progress-bar-fill").style.width = pct + "%";
  document.getElementById("ps-done").textContent  = processed;
  document.getElementById("ps-total").textContent = batchTotal;
  document.getElementById("ps-ok").textContent    = batchDone;
  document.getElementById("ps-err").textContent   = batchFailed;
}

function setProgressCurrent(name) {
  document.getElementById("progress-current").textContent = name || "";
}

function addProgressLog(name, type, detail = "") {
  const iconMap = { success: "✓", error: "✗", skip: "–" };
  const el = document.createElement("div");
  el.className = `progress-log-item log-${type}`;
  el.innerHTML = `
    <span class="log-icon">${iconMap[type] || "·"}</span>
    <span class="log-name" title="${esc(name)}">${esc(name)}</span>
    ${detail ? `<span class="log-detail">${esc(detail)}</span>` : ""}
  `;
  const log = document.getElementById("progress-log");
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
}

function finalizeProgressPanel(hadErrors) {
  document.getElementById("progress-title").textContent = hadErrors ? "完了（一部エラーあり）" : "アップロード完了";
  document.getElementById("progress-spinner").style.display = "none";
  document.getElementById("progress-close-btn").style.display = "flex";
  setProgressCurrent("");
  document.getElementById("progress-bar-fill").style.width = "100%";
  document.getElementById("progress-bar-fill").style.background = hadErrors
    ? "var(--warning)"
    : "var(--success)";
  if (!hadErrors) setTimeout(closeProgressPanel, 5000);
}


function handleFolderInput(files) {
  const allowed = new Set(["pdf","jpg","jpeg","png","gif","webp"]);
  const valid = [...files].filter(f => allowed.has(f.name.split(".").pop().toLowerCase()));

  if (!valid.length) { toast("対応ファイルがありませんでした", "info"); return; }

  const limited = valid.slice(0, BATCH_MAX);
  if (valid.length > BATCH_MAX) {
    toast(`${valid.length}件中 ${BATCH_MAX}件のみ処理します`, "info");
  }

  handleFiles(limited);
  setTimeout(() => { document.getElementById("folder-input").value = ""; }, 200);
}

/* ── Usage stats ─────────────────────────────────────────────── */

async function loadUsageStats() {
  try {
    const s = await api.getUsageStats();
    document.getElementById("usage-ai-count").textContent = s.ai_processed.toLocaleString("ja-JP") + " 件";
    const total = s.input_tokens + s.output_tokens;
    document.getElementById("usage-tokens").textContent =
      total >= 1_000_000
        ? (total / 1_000_000).toFixed(2) + "M"
        : total >= 1_000
        ? (total / 1_000).toFixed(1) + "K"
        : total;
    document.getElementById("usage-cost").textContent =
      `¥${Math.round(s.cost_jpy).toLocaleString("ja-JP")}`;
  } catch (_) {/* ignore if table not yet migrated */}
}

/* ── Company incremental search ─────────────────────────────── */

function initCompanySearch(inputId, hiddenId, dropdownId) {
  const input    = document.getElementById(inputId);
  const dropdown = document.getElementById(dropdownId);
  if (!input || !dropdown) return;

  function showDropdown(q) {
    const matches = companiesList
      .filter(c => !q || c.name.toLowerCase().includes(q.toLowerCase()))
      .slice(0, 10);
    if (!matches.length) { dropdown.style.display = "none"; return; }
    dropdown.innerHTML = matches.map(c =>
      `<li data-id="${c.id}" data-name="${esc(c.name)}">${esc(c.name)}</li>`
    ).join("");
    dropdown.style.display = "block";
  }

  input.addEventListener("input",  () => showDropdown(input.value));
  input.addEventListener("focus",  () => showDropdown(input.value));
  dropdown.addEventListener("mousedown", e => {
    const li = e.target.closest("li");
    if (!li) return;
    document.getElementById(hiddenId).value = li.dataset.id;
    input.value = li.dataset.name;
    dropdown.style.display = "none";
    e.preventDefault();
  });
  document.addEventListener("click", e => {
    if (!input.contains(e.target) && !dropdown.contains(e.target)) {
      dropdown.style.display = "none";
    }
  });
}

function setCompanySearch(inputId, hiddenId, companyId) {
  const c = companiesList.find(co => co.id === companyId);
  document.getElementById(hiddenId).value = companyId || "";
  document.getElementById(inputId).value  = c ? c.name : "";
}

/* ── Load / filter ───────────────────────────────────────────── */

async function loadInvoices(status = "") {
  try {
    const [list, companies] = await Promise.all([
      api.listInvoices(status, 200),
      api.listCompanies(),
    ]);
    invoiceList   = list;
    companiesList = companies;
    applyFilter();
    loadUsageStats();
  } catch (e) {
    toast("請求書一覧の取得に失敗しました: " + e.message, "error");
  }
}

function applyFilter() {
  const q = (document.getElementById("invoice-search")?.value || "").toLowerCase();
  filteredList = invoiceList.filter(inv =>
    (inv.original_filename || "").toLowerCase().includes(q) ||
    (inv.extracted_data?.vendor_name || "").toLowerCase().includes(q) ||
    (inv.extracted_data?.document_type || "").toLowerCase().includes(q)
  );
  currentPage = 1;
  renderInvoices();
}

function filterInvoices() { applyFilter(); }

/* ── Render list ─────────────────────────────────────────────── */

function renderInvoices() {
  const tbody = document.getElementById("invoices-tbody");
  document.getElementById("invoices-count").textContent = filteredList.length;

  // reset select-all
  const allCheck = document.getElementById("select-all-check");
  if (allCheck) allCheck.checked = false;

  if (!filteredList.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="10">請求書がありません</td></tr>`;
    renderPagination();
    return;
  }

  const start = (currentPage - 1) * PAGE_SIZE;
  const pageItems = filteredList.slice(start, start + PAGE_SIZE);

  tbody.innerHTML = pageItems.map(inv => {
    const co = companiesList.find(c => String(c.id) === String(inv.company_id));
    const coCell = co
      ? `<span class="company-tag">${esc(co.name)}</span>`
      : `<span class="company-tag company-tag-none">未紐付け</span>`;
    return `
    <tr>
      <td class="col-hide-mobile"><input type="checkbox" class="row-check" value="${inv.id}"></td>
      <td class="truncate" title="${esc(inv.original_filename || "")}">
        ${esc(inv.original_filename || inv.id.slice(0,8) + "...")}
      </td>
      <td class="col-hide-mobile">${esc(inv.extracted_data?.document_type || "—")}</td>
      <td>${statusBadge(inv.status)}</td>
      <td class="col-hide-mobile">${coCell}</td>
      <td class="col-hide-mobile">${esc(inv.extracted_data?.vendor_name || "—")}</td>
      <td>${formatAmount(inv.extracted_data?.total_amount)}</td>
      <td class="col-hide-mobile">${formatDate(inv.created_at)}</td>
      <td class="col-hide-mobile"><button class="btn btn-outline btn-sm" onclick="openStorageUrl('${inv.id}')" title="ストレージで開く">${icons.link}</button></td>
      <td>
        <div class="flex gap-2">
          <button class="btn btn-outline btn-sm btn-icon" onclick="openInvoiceDetail('${inv.id}')" title="詳細">${icons.eye}</button>
          <button class="btn btn-danger btn-sm" onclick="deleteInvoice('${inv.id}')">削除</button>
        </div>
      </td>
    </tr>`;
  }).join("");

  renderPagination();
}

function toggleSelectAll(cb) {
  document.querySelectorAll(".row-check").forEach(c => { c.checked = cb.checked; });
}

/* ── Pagination ──────────────────────────────────────────────── */

function renderPagination() {
  const el = document.getElementById("invoice-pagination");
  if (!el) return;

  const totalPages = Math.ceil(filteredList.length / PAGE_SIZE);
  if (totalPages <= 1) { el.innerHTML = ""; return; }

  const start = (currentPage - 1) * PAGE_SIZE + 1;
  const end   = Math.min(currentPage * PAGE_SIZE, filteredList.length);

  el.innerHTML = `
    <span>${start}–${end} / ${filteredList.length} 件</span>
    <div class="pagination-controls">
      <button class="btn btn-outline btn-sm" onclick="changePage(${currentPage - 1})" ${currentPage === 1 ? "disabled" : ""}>
        ${icons.chevronLeft} 前へ
      </button>
      <span class="page-indicator">${currentPage} / ${totalPages}</span>
      <button class="btn btn-outline btn-sm" onclick="changePage(${currentPage + 1})" ${currentPage === totalPages ? "disabled" : ""}>
        次へ ${icons.chevronRight}
      </button>
    </div>
  `;
}

function changePage(page) {
  const totalPages = Math.ceil(filteredList.length / PAGE_SIZE);
  if (page < 1 || page > totalPages) return;
  currentPage = page;
  renderInvoices();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

/* ── CSV download ────────────────────────────────────────────── */

function downloadCSV() {
  const checked = document.querySelectorAll(".row-check:checked");
  if (!checked.length) { toast("ダウンロードするレコードを選択してください", "info"); return; }

  const ids = new Set([...checked].map(cb => cb.value));
  const rows = filteredList.filter(inv => ids.has(inv.id));

  const headers = ["ファイル名","文書種別","ステータス","発行者","発行日","支払期限","小計","消費税","合計金額","登録日"];
  const csv = [
    headers.join(","),
    ...rows.map(inv => {
      const d = inv.extracted_data || {};
      return [
        inv.original_filename || "",
        d.document_type || "",
        inv.status,
        d.vendor_name || "",
        d.invoice_date || "",
        d.due_date || "",
        d.subtotal ?? "",
        d.tax_amount ?? "",
        d.total_amount ?? "",
        inv.created_at,
      ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(",");
    }),
  ].join("\n");

  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = `invoices_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/* ── Upload ──────────────────────────────────────────────────── */

function initUploadZone() {
  const zone  = document.getElementById("upload-zone");
  const input = document.getElementById("file-input");

  zone.addEventListener("dragover",  e => { e.preventDefault(); zone.classList.add("drag-over"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("drag-over"));
  zone.addEventListener("drop", e => {
    e.preventDefault();
    zone.classList.remove("drag-over");
    handleFiles(e.dataTransfer.files);
  });
  input.addEventListener("change", () => {
    if (!input.files.length) return;
    handleFiles(input.files);
    setTimeout(() => { input.value = ""; }, 200);
  });
}

async function handleFiles(files) {
  const fileArr = [...files];
  if (!fileArr.length) return;
  singleQueue = fileArr.slice(1);

  batchTotal  = fileArr.length;
  batchDone   = 0;
  batchFailed = 0;
  showProgressPanel();
  updateProgressBar();

  startPrefetch(); // start file[1] analysis in parallel while file[0] uploads
  await uploadInvoice(fileArr[0]);
}

async function uploadInvoice(file) {
  const existing = invoiceList.find(inv => bname(inv.original_filename) === bname(file.name));
  if (existing) {
    pendingUploadFile  = file;
    pendingOverwriteId = existing.id;
    document.getElementById("overwrite-filename").textContent = bname(file.name);
    openModal("overwrite-confirm-modal");
    return;
  }
  await doUpload(file);
}

async function confirmOverwrite() {
  closeModal("overwrite-confirm-modal");
  const file = pendingUploadFile;
  const id   = pendingOverwriteId;
  pendingUploadFile = null;
  pendingOverwriteId = null;
  if (!file || !id) return;

  const btn = document.getElementById("overwrite-confirm-btn");
  btn.disabled = true;
  try {
    await api.deleteInvoice(id);
  } catch (e) {
    toast(`既存ファイルの削除に失敗しました: ${e.message}`, "error");
    btn.disabled = false;
    return;
  }
  btn.disabled = false;
  await doUpload(file);
}

function cancelOverwrite() {
  const file = pendingUploadFile;
  closeModal("overwrite-confirm-modal");
  pendingUploadFile  = null;
  pendingOverwriteId = null;
  if (file) {
    batchFailed++;
    addProgressLog(bname(file.name), "skip", "上書きキャンセル");
    updateProgressBar();
    if (!singleQueue.length) finalizeProgressPanel(batchFailed > 0);
  }
  processNextSingleFile();
}

function startPrefetch() {
  if (!singleQueue.length || prefetch) return;
  const file = singleQueue[0];
  if (invoiceList.some(inv => bname(inv.original_filename) === bname(file.name))) return; // duplicate — needs confirmation first
  const fd = new FormData();
  fd.append("file", new File([file], bname(file.name), { type: file.type }));
  let pending = true;
  const promise = Promise.all([api.uploadInvoice(fd), api.listCompanies()])
    .then(([result, companies]) => ({ result, companies }))
    .catch(err => ({ error: err?.message || String(err) || "エラーが発生しました" }))
    .finally(() => { pending = false; });
  prefetch = { file, promise, get pending() { return pending; } };
}

async function doUpload(file) {
  const cleanName = bname(file.name);
  const cleanFile = new File([file], cleanName, { type: file.type });
  const fd = new FormData();
  fd.append("file", cleanFile);
  setProgressCurrent(cleanName);
  try {
    const [result, companies] = await Promise.all([api.uploadInvoice(fd), api.listCompanies()]);
    companiesList = companies;
    batchDone++;
    addProgressLog(cleanName, "success");
    updateProgressBar();
    if (!singleQueue.length) finalizeProgressPanel(batchFailed > 0);
    toast(`「${cleanName}」の解析が完了しました`, "success");
    loadInvoices();
    loadUsageStats();
    renderInvoiceDetail(result);
    currentInvoiceId = result.id;
    openModal("invoice-detail-modal");
    startPrefetch();
  } catch (e) {
    batchFailed++;
    addProgressLog(cleanName, "error", e.message);
    updateProgressBar();
    if (!singleQueue.length) finalizeProgressPanel(true);
    toast(`アップロード失敗: ${e.message}`, "error");
    processNextSingleFile();
  }
}

async function processNextSingleFile() {
  if (!singleQueue.length) return;
  const file = singleQueue.shift();

  if (prefetch && prefetch.file === file) {
    const p = prefetch.promise;
    const wasPending = prefetch.pending;
    prefetch = null;
    const cleanName = bname(file.name);
    if (wasPending) toast(`「${cleanName}」を解析中です — 完了後にモーダルを表示します`, "info");
    // Await silently — open result modal automatically when ready
    const data = await p;
    const errMsg = data?.error || (!data?.result ? "アップロードに失敗しました" : null);
    if (errMsg) {
      batchFailed++;
      addProgressLog(cleanName, "error", errMsg);
      updateProgressBar();
      if (!singleQueue.length) finalizeProgressPanel(true);
      toast(`アップロード失敗: ${errMsg}`, "error");
      processNextSingleFile();
      return;
    }
    const { result, companies } = data;
    companiesList = companies;
    batchDone++;
    addProgressLog(cleanName, "success");
    updateProgressBar();
    if (!singleQueue.length) finalizeProgressPanel(batchFailed > 0);
    toast(`「${cleanName}」の解析が完了しました`, "success");
    loadInvoices();
    loadUsageStats();
    renderInvoiceDetail(result);
    currentInvoiceId = result.id;
    openModal("invoice-detail-modal");
    startPrefetch();
    return;
  }

  prefetch = null;
  uploadInvoice(file);
}

/* ── Detail modal ────────────────────────────────────────────── */

async function openInvoiceDetail(id) {
  currentInvoiceId = id;
  try {
    const [inv, companies] = await Promise.all([api.getInvoice(id), api.listCompanies()]);
    companiesList = companies;
    renderInvoiceDetail(inv);
    openModal("invoice-detail-modal");
  } catch (e) {
    toast("詳細の取得に失敗しました: " + e.message, "error");
  }
}

function renderInvoiceDetail(inv) {
  document.getElementById("detail-title").textContent = inv.original_filename || "請求書詳細";

  const d = inv.extracted_data || {};
  document.getElementById("detail-body").innerHTML = `
    <div class="detail-meta-row">
      <span class="detail-meta-label">UUID</span>
      <span class="detail-meta-val">${esc(inv.id)}</span>
      ${inv.matching_score != null ? `<span class="detail-meta-label" style="margin-left:8px;">照合スコア</span><span class="detail-meta-val">${(inv.matching_score * 100).toFixed(0)}%</span>` : ""}
    </div>
    <div class="detail-edit-grid">
      <div class="form-group">
        <label>発行日</label>
        <input type="date" id="di-invoice-date" value="${esc(d.invoice_date || '')}">
      </div>
      <div class="form-group">
        <label>支払期限</label>
        <input type="date" id="di-due-date" value="${esc(d.due_date || '')}">
      </div>
      <div class="form-group">
        <label>発行者</label>
        <input type="text" id="di-vendor-name" value="${esc(d.vendor_name || '')}">
      </div>
      <div class="form-group">
        <label>登録番号</label>
        <input type="text" id="di-vendor-reg-num" value="${esc(d.vendor_registration_number || '')}">
      </div>
      <div class="form-group">
        <label>小計</label>
        <input type="text" inputmode="numeric" id="di-subtotal" value="${d.subtotal != null ? Number(d.subtotal).toLocaleString('ja-JP') : ''}">
      </div>
      <div class="form-group">
        <label>消費税</label>
        <input type="text" inputmode="numeric" id="di-tax-amount" value="${d.tax_amount != null ? Number(d.tax_amount).toLocaleString('ja-JP') : ''}">
      </div>
      <div class="form-group" style="grid-column:1/-1;">
        <label>合計金額</label>
        <input type="text" inputmode="numeric" id="di-total-amount" value="${d.total_amount != null ? Number(d.total_amount).toLocaleString('ja-JP') : ''}">
      </div>
    </div>
    <div style="margin-bottom:12px;">
      <div class="detail-meta-label" style="display:block;margin-bottom:6px;">明細</div>
      <table class="line-items-table" id="di-line-items-table">
        <thead><tr><th>品目</th><th style="width:60px">数量</th><th style="width:90px">単価</th><th style="width:90px">金額</th><th style="width:28px"></th></tr></thead>
        <tbody>
          ${(d.line_items || []).map(li => `
            <tr>
              <td><input type="text" class="li-desc" value="${esc(li.description || '')}"></td>
              <td><input type="number" class="li-qty" value="${li.quantity ?? ''}"></td>
              <td><input type="number" class="li-unit-price" value="${li.unit_price ?? ''}"></td>
              <td><input type="number" class="li-amount" value="${li.amount ?? ''}"></td>
              <td><button type="button" class="li-del-btn" onclick="removeLineItem(this)" title="削除">×</button></td>
            </tr>
          `).join("")}
        </tbody>
      </table>
      <button type="button" class="btn btn-outline btn-sm" style="margin-top:6px;" onclick="addLineItem()">＋ 行を追加</button>
    </div>
    <div class="form-group" style="margin-bottom:0;">
      <label>備考</label>
      <textarea id="di-notes" style="min-height:56px;">${esc(d.notes || '')}</textarea>
    </div>
  `;

  currentInvoice = inv;
  detailSaved    = false;
  document.getElementById("detail-doc-type").value = inv.extracted_data?.document_type || "";
  document.getElementById("detail-status").value   = inv.status || "processed";
  setCompanySearch("detail-company-search", "detail-company-id", inv.company_id || "");

  const processBtn = document.getElementById("process-btn");
  processBtn.style.display = "inline-flex";
  processBtn.innerHTML = `${icons.refresh} 再解析`;

  ["di-invoice-date", "di-due-date"].forEach(id => {
    flatpickr(document.getElementById(id), {
      dateFormat: "Y-m-d",
      locale: "ja",
      allowInput: true,
    });
  });

  ["di-subtotal", "di-tax-amount", "di-total-amount"].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("focus", () => { el.value = el.value.replace(/,/g, ""); });
    el.addEventListener("blur",  () => {
      const n = Number(el.value);
      if (el.value !== "" && !isNaN(n)) el.value = n.toLocaleString("ja-JP");
    });
    el.addEventListener("input", () => {
      el.value = el.value.replace(/[^\d]/g, "");
      if (id === "di-subtotal" || id === "di-tax-amount") recalcTotal();
    });
  });

  // Auto-fill total on open if missing
  const totalEl = document.getElementById("di-total-amount");
  if (totalEl && !totalEl.value) recalcTotal();
}

function recalcTotal() {
  const sub = Number((document.getElementById("di-subtotal")?.value || "").replace(/,/g, "")) || 0;
  const tax = Number((document.getElementById("di-tax-amount")?.value || "").replace(/,/g, "")) || 0;
  const totalEl = document.getElementById("di-total-amount");
  if (totalEl) totalEl.value = (sub + tax) > 0 ? (sub + tax).toLocaleString("ja-JP") : "";
}

async function processCurrentInvoice() {
  if (!currentInvoiceId) return;
  const btn = document.getElementById("process-btn");
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span> AI解析中...`;
  try {
    const result = await api.processInvoice(currentInvoiceId);
    toast("AI解析が完了しました", "success");
    renderInvoiceDetail(result);
    loadInvoices();
  } catch (e) {
    toast("AI解析に失敗しました: " + e.message, "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = `${icons.refresh} 再解析`;
  }
}

async function saveDetailEdit() {
  const id = currentInvoiceId;
  if (!id || !currentInvoice) return;

  const docType   = document.getElementById("detail-doc-type").value;
  const companyId = document.getElementById("detail-company-id").value;

  const toStr = elId => document.getElementById(elId)?.value.trim() || null;
  const toNum = elId => { const v = (document.getElementById(elId)?.value || "").replace(/,/g, ""); return v !== "" ? Number(v) : null; };
  const toN   = v => v !== "" && v != null ? Number(String(v).replace(/,/g, "")) : null;

  const line_items = [...document.querySelectorAll("#di-line-items-table tbody tr")].map(tr => ({
    description: tr.querySelector(".li-desc")?.value.trim() || null,
    quantity:    toN(tr.querySelector(".li-qty")?.value),
    unit_price:  toN(tr.querySelector(".li-unit-price")?.value),
    amount:      toN(tr.querySelector(".li-amount")?.value),
  })).filter(li => li.description || li.amount != null);

  const body = {
    status: "approved",
    extracted_data: {
      ...(currentInvoice.extracted_data || {}),
      document_type:               docType || null,
      invoice_date:                toStr("di-invoice-date"),
      due_date:                    toStr("di-due-date"),
      vendor_name:                 toStr("di-vendor-name"),
      vendor_registration_number:  toStr("di-vendor-reg-num"),
      subtotal:                    toNum("di-subtotal"),
      tax_amount:                  toNum("di-tax-amount"),
      total_amount:                toNum("di-total-amount"),
      notes:                       toStr("di-notes"),
      line_items,
    },
  };
  if (companyId) body.company_id = companyId;

  const btn = document.getElementById("detail-save-btn");
  btn.disabled = true;
  try {
    await api.updateInvoice(id, body);
    detailSaved = true;
    toast("承認済みとして保存しました", "success");
    loadInvoices();
    closeModal("invoice-detail-modal");
  } catch (e) {
    toast("更新に失敗しました: " + e.message, "error");
  } finally {
    btn.disabled = false;
  }
}

function addLineItem() {
  const tbody = document.querySelector("#di-line-items-table tbody");
  if (!tbody) return;
  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td><input type="text" class="li-desc" value=""></td>
    <td><input type="number" class="li-qty" value=""></td>
    <td><input type="number" class="li-unit-price" value=""></td>
    <td><input type="number" class="li-amount" value=""></td>
    <td><button type="button" class="li-del-btn" onclick="removeLineItem(this)" title="削除">×</button></td>
  `;
  tbody.appendChild(tr);
  tr.querySelector(".li-desc").focus();
}

function removeLineItem(btn) {
  btn.closest("tr").remove();
}

/* ── Edit modal ──────────────────────────────────────────────── */

async function openEditInvoice(id) {
  try {
    const [inv, companies] = await Promise.all([api.getInvoice(id), api.listCompanies()]);
    editingInvoice = inv;
    companiesList  = companies;

    document.getElementById("edit-invoice-id").value = id;
    document.getElementById("ei-doc-type").value     = inv.extracted_data?.document_type || "";
    document.getElementById("ei-status").value       = inv.status;
    setCompanySearch("ei-company-search", "ei-company-id", inv.company_id || "");

    openModal("edit-invoice-modal");
  } catch (e) {
    toast("編集フォームの取得に失敗しました: " + e.message, "error");
  }
}

async function saveInvoiceEdit() {
  const id      = document.getElementById("edit-invoice-id").value;
  const docType = document.getElementById("ei-doc-type").value;
  const body    = {
    status:     document.getElementById("ei-status").value || null,
    company_id: document.getElementById("ei-company-id").value || null,
  };

  if (docType !== undefined && editingInvoice) {
    body.extracted_data = { ...(editingInvoice.extracted_data || {}), document_type: docType || null };
  }

  Object.keys(body).forEach(k => { if (body[k] == null && k !== "extracted_data") delete body[k]; });

  const btn = document.getElementById("edit-invoice-save-btn");
  btn.disabled = true;
  try {
    await api.updateInvoice(id, body);
    toast("更新しました", "success");
    closeModal("edit-invoice-modal");
    loadInvoices();
  } catch (e) {
    toast("更新に失敗しました: " + e.message, "error");
  } finally {
    btn.disabled = false;
  }
}

/* ── Storage / Delete ────────────────────────────────────────── */

async function openStorageUrl(id) {
  try {
    const data = await api.getDownloadUrl(id);
    const inv  = invoiceList.find(i => i.id === id);
    const filename = inv?.original_filename || "ファイル";

    document.getElementById("preview-title").textContent = filename;

    const ext = filename.split(".").pop().toLowerCase();
    const body = document.getElementById("preview-body");
    if (ext === "pdf") {
      body.innerHTML = `<iframe src="${data.url}" style="width:100%;height:70vh;border:none;"></iframe>`;
    } else {
      body.innerHTML = `<img src="${data.url}" style="max-width:100%;max-height:70vh;object-fit:contain;">`;
    }

    openModal("file-preview-modal");
  } catch (e) {
    toast("ストレージURLの取得に失敗しました: " + e.message, "error");
  }
}

function closeFilePreview() {
  document.getElementById("preview-body").innerHTML = "";
  closeModal("file-preview-modal");
}

async function deleteInvoice(id) {
  if (!confirm("この請求書を削除してもよいですか？")) return;
  try {
    await api.deleteInvoice(id);
    toast("削除しました", "success");
    loadInvoices();
  } catch (e) {
    toast("削除に失敗しました: " + e.message, "error");
  }
}

/* ── Helpers ─────────────────────────────────────────────────── */

function statusBadge(status) {
  const map = {
    processed: ["badge-processed", "解析済"],
    approved:  ["badge-approved",  "承認済"],
  };
  const [cls, label] = map[status] || ["badge-default", status];
  return `<span class="badge ${cls}">${label}</span>`;
}

function formatAmount(val) {
  if (val == null || val === "") return "—";
  return "¥" + Number(val).toLocaleString("ja-JP");
}

function formatDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("ja-JP");
}

/* ── Init ────────────────────────────────────────────────────── */
initCompanySearch("detail-company-search", "detail-company-id", "detail-company-dropdown");
initCompanySearch("ei-company-search",     "ei-company-id",     "ei-company-dropdown");

document.getElementById("invoice-detail-modal")?.addEventListener("modal:closed", () => {
  const id          = currentInvoiceId;
  const wasNew      = !detailSaved && currentInvoice?.status === "processed";
  processNextSingleFile();
  if (wasNew && id) {
    api.updateInvoice(id, { status: "processed" }).catch(() => {});
  }
});
