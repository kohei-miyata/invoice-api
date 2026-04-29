/* Approval management CRUD */

let approvalsList = [];

async function loadApprovals(invoiceId = "") {
  try {
    approvalsList = await api.listApprovals(invoiceId || null);
    renderApprovals(approvalsList);
  } catch (e) {
    toast("承認一覧の取得に失敗しました: " + e.message, "error");
  }
}

function renderApprovals(list) {
  const tbody = document.getElementById("approvals-tbody");
  document.getElementById("approvals-count").textContent = list.length;

  if (!list.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="6">承認レコードがありません</td></tr>`;
    return;
  }

  tbody.innerHTML = list.map(a => `
    <tr>
      <td class="truncate" title="${a.invoice_id}">${a.invoice_id.slice(0, 8)}...</td>
      <td>${esc(a.approver_name || a.approver_id)}</td>
      <td>${approvalBadge(a.status)}</td>
      <td class="truncate" title="${esc(a.comment || "")}">${esc(a.comment || "—")}</td>
      <td>${formatDate(a.created_at)}</td>
      <td>
        <div class="flex gap-2">
          ${a.status === "pending" ? `
            <button class="btn btn-outline btn-sm" style="color:var(--success);border-color:var(--success)" onclick="approveApproval('${a.id}')">承認</button>
            <button class="btn btn-outline btn-sm" style="color:var(--danger);border-color:var(--danger)" onclick="rejectApproval('${a.id}')">却下</button>
          ` : ""}
          <button class="btn btn-danger btn-sm" onclick="deleteApproval('${a.id}')">削除</button>
        </div>
      </td>
    </tr>
  `).join("");
}

function openCreateApproval() {
  openCreateApprovalFor(null);
}

function openCreateApprovalFor(invoiceId) {
  document.getElementById("a-invoice-id").value  = invoiceId || "";
  document.getElementById("a-approver-id").value = "";
  document.getElementById("a-approver-name").value = "";
  document.getElementById("a-comment").value     = "";
  showPage("approvals");
  openModal("approval-modal");
}

async function saveApproval() {
  const body = {
    invoice_id:    document.getElementById("a-invoice-id").value.trim(),
    approver_id:   document.getElementById("a-approver-id").value.trim(),
    approver_name: document.getElementById("a-approver-name").value.trim() || null,
    comment:       document.getElementById("a-comment").value.trim() || null,
  };

  if (!body.invoice_id) { toast("請求書IDは必須です", "error"); return; }
  if (!body.approver_id) { toast("承認者IDは必須です", "error"); return; }

  const btn = document.getElementById("approval-save-btn");
  btn.disabled = true;
  try {
    await api.createApproval(body);
    toast("承認レコードを作成しました", "success");
    closeModal("approval-modal");
    loadApprovals();
  } catch (e) {
    toast("作成に失敗しました: " + e.message, "error");
  } finally {
    btn.disabled = false;
  }
}

async function approveApproval(id) {
  const comment = prompt("承認コメント（任意）:");
  if (comment === null) return; // cancelled
  try {
    await api.updateApproval(id, { status: "approved", comment: comment || null });
    toast("承認しました", "success");
    loadApprovals();
  } catch (e) {
    toast("操作に失敗しました: " + e.message, "error");
  }
}

async function rejectApproval(id) {
  const comment = prompt("却下理由（任意）:");
  if (comment === null) return;
  try {
    await api.updateApproval(id, { status: "rejected", comment: comment || null });
    toast("却下しました", "success");
    loadApprovals();
  } catch (e) {
    toast("操作に失敗しました: " + e.message, "error");
  }
}

async function deleteApproval(id) {
  if (!confirm("この承認レコードを削除してもよいですか？")) return;
  try {
    await api.deleteApproval(id);
    toast("削除しました", "success");
    loadApprovals();
  } catch (e) {
    toast("削除に失敗しました: " + e.message, "error");
  }
}

function approvalBadge(status) {
  const map = {
    pending:  ["badge-pending",  "承認待ち"],
    approved: ["badge-approved", "承認済"],
    rejected: ["badge-rejected", "却下"],
  };
  const [cls, label] = map[status] || ["badge-default", status];
  return `<span class="badge ${cls}">${label}</span>`;
}
