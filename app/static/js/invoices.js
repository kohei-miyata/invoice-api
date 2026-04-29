/* Invoice CRUD + AI processing */

let invoiceList   = [];
let filteredList  = [];
let currentPage   = 1;
let editingInvoice = null;
let currentInvoiceId = null;
const PAGE_SIZE = 20;

/* ── Load / filter ───────────────────────────────────────────── */

async function loadInvoices(status = "") {
  try {
    invoiceList = await api.listInvoices(status, 200);
    applyFilter();
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

  tbody.innerHTML = pageItems.map(inv => `
    <tr>
      <td><input type="checkbox" class="row-check" value="${inv.id}"></td>
      <td class="truncate" title="${esc(inv.original_filename || "")}">
        ${esc(inv.original_filename || inv.id.slice(0,8) + "...")}
      </td>
      <td>${esc(inv.extracted_data?.document_type || "—")}</td>
      <td>${statusBadge(inv.status)}</td>
      <td>${esc(inv.extracted_data?.vendor_name || "—")}</td>
      <td>${esc(inv.extracted_data?.invoice_number || "—")}</td>
      <td>${formatAmount(inv.extracted_data?.total_amount)}</td>
      <td>${formatDate(inv.created_at)}</td>
      <td><button class="btn btn-outline btn-sm" onclick="openStorageUrl('${inv.id}')" title="ストレージで開く">${icons.link}</button></td>
      <td>
        <div class="flex gap-2">
          <button class="btn btn-outline btn-sm" onclick="openInvoiceDetail('${inv.id}')">詳細</button>
          <button class="btn btn-outline btn-sm btn-icon" onclick="openEditInvoice('${inv.id}')" title="編集">${icons.pencil}</button>
          <button class="btn btn-danger btn-sm" onclick="deleteInvoice('${inv.id}')">削除</button>
        </div>
      </td>
    </tr>
  `).join("");

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

  const headers = ["ファイル名","文書種別","ステータス","発行者","請求書番号","発行日","支払期限","小計","消費税","合計金額","登録日"];
  const csv = [
    headers.join(","),
    ...rows.map(inv => {
      const d = inv.extracted_data || {};
      return [
        inv.original_filename || "",
        d.document_type || "",
        inv.status,
        d.vendor_name || "",
        d.invoice_number || "",
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

  zone.addEventListener("click", () => input.click());
  zone.addEventListener("dragover",  e => { e.preventDefault(); zone.classList.add("drag-over"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("drag-over"));
  zone.addEventListener("drop", e => {
    e.preventDefault();
    zone.classList.remove("drag-over");
    handleFiles(e.dataTransfer.files);
  });
  input.addEventListener("change", () => handleFiles(input.files));
}

async function handleFiles(files) {
  for (const file of files) await uploadInvoice(file);
}

async function uploadInvoice(file) {
  const fd   = new FormData();
  fd.append("file", file);
  const zone = document.getElementById("upload-zone");
  const orig = zone.innerHTML;
  zone.innerHTML = `<span class="spinner"></span> アップロード・AI解析中...`;
  zone.style.pointerEvents = "none";
  try {
    const result = await api.uploadInvoice(fd);
    toast(`「${file.name}」の解析が完了しました`, "success");
    loadInvoices();
    renderInvoiceDetail(result);
    currentInvoiceId = result.id;
    openModal("invoice-detail-modal");
  } catch (e) {
    toast(`アップロード失敗: ${e.message}`, "error");
  } finally {
    zone.innerHTML = orig;
    zone.style.pointerEvents = "";
  }
}

/* ── Detail modal ────────────────────────────────────────────── */

async function openInvoiceDetail(id) {
  currentInvoiceId = id;
  try {
    const inv = await api.getInvoice(id);
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
    <div class="detail-grid">
      <div class="detail-item"><div class="key">文書種別</div><div class="val">${esc(d.document_type || "—")}</div></div>
      <div class="detail-item"><div class="key">ステータス</div><div class="val">${statusBadge(inv.status)}</div></div>
      <div class="detail-item"><div class="key">請求書番号</div><div class="val">${esc(d.invoice_number || "—")}</div></div>
      <div class="detail-item"><div class="key">発行日</div><div class="val">${esc(d.invoice_date || "—")}</div></div>
      <div class="detail-item"><div class="key">支払期限</div><div class="val">${esc(d.due_date || "—")}</div></div>
      <div class="detail-item"><div class="key">発行者</div><div class="val">${esc(d.vendor_name || "—")}</div></div>
      <div class="detail-item"><div class="key">登録番号</div><div class="val">${esc(d.vendor_registration_number || "—")}</div></div>
      <div class="detail-item"><div class="key">宛先</div><div class="val">${esc(d.buyer_name || "—")}</div></div>
      <div class="detail-item"><div class="key">小計</div><div class="val">${formatAmount(d.subtotal)}</div></div>
      <div class="detail-item"><div class="key">消費税</div><div class="val">${formatAmount(d.tax_amount)}</div></div>
      <div class="detail-item"><div class="key">合計金額</div><div class="val" style="font-size:18px;font-weight:700;">${formatAmount(d.total_amount)}</div></div>
      ${inv.matching_score != null ? `<div class="detail-item"><div class="key">照合スコア</div><div class="val">${(inv.matching_score * 100).toFixed(0)}%</div></div>` : ""}
    </div>
    ${(d.line_items || []).length ? `
      <div style="margin-top:16px;">
        <div class="key" style="margin-bottom:6px;">明細</div>
        <table class="line-items-table">
          <thead><tr><th>品目</th><th>数量</th><th>単価</th><th>金額</th></tr></thead>
          <tbody>
            ${d.line_items.map(li => `
              <tr>
                <td>${esc(li.description || "")}</td>
                <td class="text-right">${li.quantity ?? ""}</td>
                <td class="text-right">${formatAmount(li.unit_price)}</td>
                <td class="text-right">${formatAmount(li.amount)}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    ` : ""}
    ${d.notes ? `<div style="margin-top:12px;"><div class="key">備考</div><div class="val" style="margin-top:4px;">${esc(d.notes)}</div></div>` : ""}
  `;

  const processBtn = document.getElementById("process-btn");
  processBtn.style.display = "inline-flex";
  processBtn.innerHTML = `${icons.refresh} 再解析`;
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

/* ── Edit modal ──────────────────────────────────────────────── */

async function openEditInvoice(id) {
  try {
    const [inv, companies] = await Promise.all([api.getInvoice(id), api.listCompanies()]);
    editingInvoice = inv;

    document.getElementById("edit-invoice-id").value = id;
    document.getElementById("ei-doc-type").value = inv.extracted_data?.document_type || "";
    document.getElementById("ei-status").value   = inv.status;

    const sel = document.getElementById("ei-company");
    sel.innerHTML = `<option value="">（未設定）</option>` +
      companies.map(c => `<option value="${c.id}" ${inv.company_id === c.id ? "selected" : ""}>${esc(c.name)}</option>`).join("");

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
    company_id: document.getElementById("ei-company").value || null,
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
    window.open(data.url, "_blank");
  } catch (e) {
    toast("ストレージURLの取得に失敗しました: " + e.message, "error");
  }
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
