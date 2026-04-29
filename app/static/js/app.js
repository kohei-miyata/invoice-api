/* Main application bootstrap */

/* ── Page navigation ────────────────────────────────────────── */

function showPage(name) {
  document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
  document.querySelectorAll(".nav-item").forEach(n => n.classList.remove("active"));

  document.getElementById(`page-${name}`)?.classList.add("active");
  document.querySelector(`.nav-item[data-page="${name}"]`)?.classList.add("active");

  const titles = {
    invoices: "📄 請求書管理",
    masters:  "🏢 会社マスタ",
    approvals:"✅ 承認管理",
  };
  document.getElementById("page-title").textContent = titles[name] || "";

  if (name === "invoices")  loadInvoices();
  if (name === "masters")   loadMasters();
  if (name === "approvals") loadApprovals();
}

/* ── Modal helpers ──────────────────────────────────────────── */

function openModal(id) {
  document.getElementById(id)?.classList.add("open");
}

function closeModal(id) {
  document.getElementById(id)?.classList.remove("open");
}

// Close on overlay click
document.addEventListener("click", e => {
  if (e.target.classList.contains("modal-overlay")) {
    e.target.classList.remove("open");
  }
});

// Close on Escape
document.addEventListener("keydown", e => {
  if (e.key === "Escape") {
    document.querySelectorAll(".modal-overlay.open").forEach(m => m.classList.remove("open"));
  }
});

/* ── Toast notifications ────────────────────────────────────── */

function toast(message, type = "info") {
  const container = document.getElementById("toast-container");
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  const icons = { success: "✅", error: "❌", info: "ℹ️" };
  el.innerHTML = `<span>${icons[type] || "ℹ️"}</span><span>${esc(message)}</span>`;
  container.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

/* ── Escape helper ──────────────────────────────────────────── */

function esc(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* ── Tenant change ──────────────────────────────────────────── */

document.getElementById("tenant-select").addEventListener("change", () => {
  // Reload current page data on tenant switch
  const active = document.querySelector(".nav-item.active");
  if (active) showPage(active.dataset.page);
});

/* ── Boot ───────────────────────────────────────────────────── */

document.addEventListener("DOMContentLoaded", () => {
  initUploadZone();
  showPage("invoices");
});
