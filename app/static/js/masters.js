/* Company Master CRUD */

let mastersList = [];
let editingMasterId = null;

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
