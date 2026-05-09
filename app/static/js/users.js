/* User management page — admin only */

let _users = [];
let _adminTenants = [];
let _usersPage = 1;
const USERS_PAGE_SIZE = 20;

async function loadUsers() {
  try {
    [_users, _adminTenants] = await Promise.all([api.listUsers(), api.listAdminTenants()]);
    _usersPage = 1;
    renderUsersTable();
  } catch (e) {
    toast(e.message, "error");
  }
}

function renderUsersTable() {
  const tbody = document.getElementById("users-tbody");
  if (!_users.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="6">ユーザーが登録されていません</td></tr>';
    renderUsersPagination();
    return;
  }
  const start = (_usersPage - 1) * USERS_PAGE_SIZE;
  const pageItems = _users.slice(start, start + USERS_PAGE_SIZE);
  tbody.innerHTML = pageItems.map(u => {
    const roleBadge = u.role === "admin"
      ? '<span class="badge" style="background:#e9d8fd;color:#553c9a;">管理者</span>'
      : '<span class="badge badge-processed">ユーザー</span>';
    const activeBadge = u.is_active
      ? '<span class="badge badge-processed">有効</span>'
      : '<span class="badge" style="background:#fed7d7;color:#822727;">無効</span>';
    const tenants = u.tenants.map(t => esc(t.name || t.slug)).join(", ") || "—";
    return `
      <tr>
        <td>${esc(u.name || "—")}</td>
        <td class="col-hide-mobile">${esc(u.email)}</td>
        <td>${roleBadge}</td>
        <td class="col-hide-mobile" style="font-size:12px;">${tenants}</td>
        <td class="col-hide-mobile">${activeBadge}</td>
        <td class="text-right">
          <button class="btn btn-ghost btn-sm" onclick="openEditUser('${u.id}')">編集</button>
          <button class="btn btn-ghost btn-sm" style="color:var(--danger,#e53e3e);" onclick="confirmDeleteUser('${u.id}', '${esc(u.name || u.email).replace(/'/g, "\\'")}')">削除</button>
        </td>
      </tr>`;
  }).join("");
  renderUsersPagination();
}

function renderUsersPagination() {
  const el = document.getElementById("users-pagination");
  if (!el) return;
  const totalPages = Math.ceil(_users.length / USERS_PAGE_SIZE);
  if (totalPages <= 1) { el.innerHTML = ""; return; }
  const start = (_usersPage - 1) * USERS_PAGE_SIZE + 1;
  const end   = Math.min(_usersPage * USERS_PAGE_SIZE, _users.length);
  el.innerHTML = `
    <span>${start}–${end} / ${_users.length} 件</span>
    <div class="pagination-controls">
      <button class="btn btn-outline btn-sm" onclick="changeUsersPage(${_usersPage - 1})" ${_usersPage === 1 ? "disabled" : ""}>
        ${icons.chevronLeft} 前へ
      </button>
      <span class="page-indicator">${_usersPage} / ${totalPages}</span>
      <button class="btn btn-outline btn-sm" onclick="changeUsersPage(${_usersPage + 1})" ${_usersPage === totalPages ? "disabled" : ""}>
        次へ ${icons.chevronRight}
      </button>
    </div>
  `;
}

function changeUsersPage(page) {
  const totalPages = Math.ceil(_users.length / USERS_PAGE_SIZE);
  if (page < 1 || page > totalPages) return;
  _usersPage = page;
  renderUsersTable();
}

function openCreateUser() {
  document.getElementById("user-modal-title").textContent = "ユーザー追加";
  document.getElementById("um-id").value = "";
  document.getElementById("um-name").value = "";
  document.getElementById("um-email").value = "";
  document.getElementById("um-password").value = "";
  document.getElementById("um-role").value = "user";
  document.getElementById("um-is-active").value = "true";
  document.getElementById("um-password-label").innerHTML = 'パスワード <span style="color:var(--danger,#e53e3e)">*</span>';
  document.getElementById("um-active-group").style.display = "none";
  renderTenantCheckboxes([]);
  onUserRoleChange();
  openModal("user-modal");
}

function openEditUser(userId) {
  const u = _users.find(x => x.id === userId);
  if (!u) return;
  document.getElementById("user-modal-title").textContent = "ユーザー編集";
  document.getElementById("um-id").value = u.id;
  document.getElementById("um-name").value = u.name || "";
  document.getElementById("um-email").value = u.email;
  document.getElementById("um-password").value = "";
  document.getElementById("um-role").value = u.role;
  document.getElementById("um-is-active").value = String(u.is_active);
  document.getElementById("um-password-label").textContent = "パスワード（変更する場合のみ入力）";
  document.getElementById("um-active-group").style.display = "";
  renderTenantCheckboxes(u.tenants.map(t => t.slug));
  onUserRoleChange();
  openModal("user-modal");
}

function renderTenantCheckboxes(selectedSlugs) {
  const container = document.getElementById("um-tenants-list");
  if (!_adminTenants.length) {
    container.innerHTML = '<span style="font-size:12px;color:var(--text-muted);">テナントがありません</span>';
    return;
  }
  container.innerHTML = _adminTenants.map(t => `
    <label style="display:flex;align-items:center;gap:4px;font-size:13px;cursor:pointer;">
      <input type="checkbox" value="${esc(t.slug)}" ${selectedSlugs.includes(t.slug) ? "checked" : ""} />
      ${esc(t.name || t.slug)}
    </label>`).join("");
}

function onUserRoleChange() {
  const isAdmin = document.getElementById("um-role").value === "admin";
  document.getElementById("um-tenants-group").style.display = isAdmin ? "none" : "";
}

async function saveUser() {
  const id       = document.getElementById("um-id").value;
  const name     = document.getElementById("um-name").value.trim();
  const email    = document.getElementById("um-email").value.trim();
  const password = document.getElementById("um-password").value;
  const role     = document.getElementById("um-role").value;
  const isActive = document.getElementById("um-is-active").value === "true";
  const tenantSlugs = [...document.querySelectorAll("#um-tenants-list input:checked")].map(cb => cb.value);

  if (!email) { toast("メールアドレスを入力してください", "error"); return; }
  if (!id && !password) { toast("パスワードを入力してください", "error"); return; }

  try {
    if (id) {
      const body = { name, email, role, is_active: isActive, tenant_slugs: role === "admin" ? [] : tenantSlugs };
      if (password) body.password = password;
      await api.updateUser(id, body);
      toast("ユーザーを更新しました", "success");
    } else {
      await api.createUser({ name, email, password, role, tenant_slugs: role === "admin" ? [] : tenantSlugs });
      toast("ユーザーを登録しました", "success");
    }
    closeModal("user-modal");
    await loadUsers();
  } catch (e) {
    toast(e.message, "error");
  }
}

async function confirmDeleteUser(userId, label) {
  if (!confirm(`「${label}」を削除しますか？`)) return;
  try {
    await api.deleteUser(userId);
    toast("ユーザーを削除しました", "success");
    await loadUsers();
  } catch (e) {
    toast(e.message, "error");
  }
}
