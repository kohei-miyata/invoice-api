/* Company Master CRUD */

let mastersList = [];
let editingMasterId = null;

/* ── CSV sample download ─────────────────────────────────────── */

function downloadSampleCSV() {
  const rows = [
    "会社名,適格請求書登録番号,住所,電話番号,メールアドレス,備考",
    "株式会社サンプル,T1234567890123,東京都千代田区1-1-1,03-1234-5678,info@sample.co.jp,",
    "テスト商事株式会社,T9876543210987,大阪府大阪市北区2-2-2,06-9876-5432,contact@test.co.jp,取引先A",
  ];
  const blob = new Blob(["﻿" + rows.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement("a"), { href: url, download: "companies_sample.csv" });
  a.click();
  URL.revokeObjectURL(url);
}

/* ── CSV import ──────────────────────────────────────────────── */

function handleMasterCSVInput(input) {
  const file = input.files[0];
  if (!file) return;
  input.value = "";
  importMastersCSV(file);
}

async function importMastersCSV(file) {
  const text  = await file.text();
  const clean = text.replace(/^﻿/, "");
  const rows  = parseCsv(clean);
  if (!rows.length) { toast("データが見つかりませんでした", "error"); return; }

  const FIELD_MAP = {
    "会社名":               "name",
    "適格請求書登録番号":   "registration_number",
    "住所":                 "address",
    "電話番号":             "phone",
    "メールアドレス":       "email",
    "備考":                 "notes",
  };

  let success = 0, skipped = 0;
  for (const row of rows) {
    const body = {};
    for (const [jp, en] of Object.entries(FIELD_MAP)) {
      const v = row[jp];
      if (v) body[en] = v;
    }
    if (!body.name) { skipped++; continue; }
    try {
      await api.createCompany(body);
      success++;
    } catch (e) {
      skipped++;
    }
  }

  toast(`${success}件登録しました${skipped ? `（${skipped}件スキップ）` : ""}`, skipped && !success ? "error" : "success");
  loadMasters();
}

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];

  const parseRow = line => {
    const cols = [];
    let cur = "", inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = !inQ;
      } else if (c === ',' && !inQ) { cols.push(cur); cur = ""; }
      else cur += c;
    }
    cols.push(cur);
    return cols;
  };

  const headers = parseRow(lines[0]).map(h => h.trim());
  return lines.slice(1).filter(l => l.trim()).map(line => {
    const vals = parseRow(line);
    const row = {};
    headers.forEach((h, i) => { row[h] = (vals[i] || "").trim(); });
    return row;
  });
}

async function loadMasters() {
  try {
    mastersList = await api.listCompanies();
    renderMasters(mastersList);
  } catch (e) {
    toast("会社マスタの取得に失敗しました: " + e.message, "error");
  }
}

function renderMasters(list) {
  const tbody = document.getElementById("masters-tbody");
  document.getElementById("masters-count").textContent = list.length;

  if (!list.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="6">会社マスタが登録されていません</td></tr>`;
    return;
  }

  tbody.innerHTML = list.map(c => `
    <tr>
      <td class="truncate" title="${esc(c.name)}">${esc(c.name)}</td>
      <td>${esc(c.registration_number || "—")}</td>
      <td class="truncate" title="${esc(c.address || "")}">${esc(c.address || "—")}</td>
      <td>${esc(c.phone || "—")}</td>
      <td>${esc(c.email || "—")}</td>
      <td>
        <div class="flex gap-2">
          <button class="btn btn-outline btn-sm" onclick="openEditMaster('${c.id}')">編集</button>
          <button class="btn btn-danger btn-sm" onclick="deleteMaster('${c.id}', '${esc(c.name)}')">削除</button>
        </div>
      </td>
    </tr>
  `).join("");
}

function filterMasters() {
  const q = document.getElementById("master-search").value.toLowerCase();
  renderMasters(mastersList.filter(c =>
    c.name.toLowerCase().includes(q) ||
    (c.registration_number || "").toLowerCase().includes(q)
  ));
}

function openCreateMaster() {
  editingMasterId = null;
  document.getElementById("master-modal-title").textContent = "会社マスタ 新規登録";
  document.getElementById("master-form").reset();
  openModal("master-modal");
}

function openEditMaster(id) {
  const c = mastersList.find(x => x.id === id);
  if (!c) return;
  editingMasterId = id;
  document.getElementById("master-modal-title").textContent = "会社マスタ 編集";
  document.getElementById("m-name").value            = c.name || "";
  document.getElementById("m-reg-num").value         = c.registration_number || "";
  document.getElementById("m-address").value         = c.address || "";
  document.getElementById("m-phone").value           = c.phone || "";
  document.getElementById("m-email").value           = c.email || "";
  document.getElementById("m-notes").value           = c.notes || "";
  openModal("master-modal");
}

async function saveMaster() {
  const body = {
    name:                document.getElementById("m-name").value.trim(),
    registration_number: document.getElementById("m-reg-num").value.trim() || null,
    address:             document.getElementById("m-address").value.trim() || null,
    phone:               document.getElementById("m-phone").value.trim() || null,
    email:               document.getElementById("m-email").value.trim() || null,
    notes:               document.getElementById("m-notes").value.trim() || null,
  };

  if (!body.name) { toast("会社名は必須です", "error"); return; }

  const btn = document.getElementById("master-save-btn");
  btn.disabled = true;
  try {
    if (editingMasterId) {
      await api.updateCompany(editingMasterId, body);
      toast("会社マスタを更新しました", "success");
    } else {
      await api.createCompany(body);
      toast("会社マスタを登録しました", "success");
    }
    closeModal("master-modal");
    loadMasters();
  } catch (e) {
    toast("保存に失敗しました: " + e.message, "error");
  } finally {
    btn.disabled = false;
  }
}

async function deleteMaster(id, name) {
  if (!confirm(`「${name}」を削除してもよいですか？`)) return;
  try {
    await api.deleteCompany(id);
    toast("削除しました", "success");
    loadMasters();
  } catch (e) {
    toast("削除に失敗しました: " + e.message, "error");
  }
}
