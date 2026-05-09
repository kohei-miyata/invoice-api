/* Admin dashboard — tenant statistics */

async function loadDashboard() {
  const container = document.getElementById("dashboard-cards");
  container.innerHTML = '<p style="color:var(--text-muted);padding:16px;">読み込み中...</p>';
  try {
    const data = await api.getDashboard();
    renderDashboard(data);
  } catch (e) {
    container.innerHTML = `<p style="color:var(--danger,#e53e3e);padding:16px;">${esc(e.message)}</p>`;
  }
}

function renderDashboard(tenants) {
  const container = document.getElementById("dashboard-cards");

  // Summary row
  const totalInvoices = tenants.reduce((s, t) => s + t.total_invoices, 0);
  const totalTokens   = tenants.reduce((s, t) => s + t.input_tokens + t.output_tokens, 0);
  const totalUsers    = tenants.reduce((s, t) => s + t.user_count, 0);
  const totalCompanies = tenants.reduce((s, t) => s + t.company_count, 0);

  container.innerHTML = `
    <div class="dashboard-summary">
      <div class="dash-summary-card">
        <div class="dash-summary-label">テナント数</div>
        <div class="dash-summary-value">${tenants.length}</div>
      </div>
      <div class="dash-summary-card">
        <div class="dash-summary-label">総請求書数</div>
        <div class="dash-summary-value">${totalInvoices.toLocaleString()}</div>
      </div>
      <div class="dash-summary-card">
        <div class="dash-summary-label">累計トークン</div>
        <div class="dash-summary-value">${fmtTokens(totalTokens)}</div>
      </div>
      <div class="dash-summary-card">
        <div class="dash-summary-label">総ユーザー数</div>
        <div class="dash-summary-value">${totalUsers}</div>
      </div>
      <div class="dash-summary-card">
        <div class="dash-summary-label">総会社マスタ数</div>
        <div class="dash-summary-value">${totalCompanies.toLocaleString()}</div>
      </div>
    </div>

    <div class="dashboard-grid">
      ${tenants.map(renderTenantCard).join("")}
    </div>
  `;
}

function renderTenantCard(t) {
  const totalTokens = t.input_tokens + t.output_tokens;
  const inputCost   = (t.input_tokens  / 1_000_000 * 3).toFixed(3);
  const outputCost  = (t.output_tokens / 1_000_000 * 15).toFixed(3);
  const totalCost   = (parseFloat(inputCost) + parseFloat(outputCost)).toFixed(3);

  const statuses = [
    { key: "pending",    label: "未処理",  color: "#e2e8f0", text: "#4a5568" },
    { key: "processing", label: "処理中",  color: "#bee3f8", text: "#2b6cb0" },
    { key: "processed",  label: "解析済",  color: "#c6f6d5", text: "#276749" },
    { key: "approved",   label: "承認済",  color: "#d4edda", text: "#155724" },
    { key: "error",      label: "エラー",  color: "#fed7d7", text: "#822727" },
  ];

  const statusBadges = statuses
    .filter(s => t.status_counts[s.key] > 0)
    .map(s => `<span class="dash-status-badge" style="background:${s.color};color:${s.text};">${s.label} ${t.status_counts[s.key]}</span>`)
    .join("");

  const lastUpload = t.last_upload
    ? new Date(t.last_upload).toLocaleDateString("ja-JP", { year:"numeric", month:"2-digit", day:"2-digit" })
    : "—";

  return `
    <div class="dash-tenant-card">
      <div class="dash-tenant-header">
        <div>
          <div class="dash-tenant-name">${esc(t.name)}</div>
          <div class="dash-tenant-slug">${esc(t.slug)}</div>
        </div>
        <div class="dash-tenant-since">作成 ${t.created_at ? new Date(t.created_at).toLocaleDateString("ja-JP") : "—"}</div>
      </div>

      <div class="dash-stats-grid">
        <div class="dash-stat">
          <div class="dash-stat-label">請求書数</div>
          <div class="dash-stat-value">${t.total_invoices.toLocaleString()}</div>
        </div>
        <div class="dash-stat">
          <div class="dash-stat-label">AI処理済</div>
          <div class="dash-stat-value">${t.ai_processed.toLocaleString()}</div>
        </div>
        <div class="dash-stat">
          <div class="dash-stat-label">ユーザー数</div>
          <div class="dash-stat-value">${t.user_count}</div>
        </div>
        <div class="dash-stat">
          <div class="dash-stat-label">会社マスタ</div>
          <div class="dash-stat-value">${t.company_count.toLocaleString()}</div>
        </div>
      </div>

      <div class="dash-token-row">
        <div class="dash-token-item">
          <span class="dash-token-label">入力トークン</span>
          <span class="dash-token-value">${fmtTokens(t.input_tokens)}</span>
        </div>
        <div class="dash-token-item">
          <span class="dash-token-label">出力トークン</span>
          <span class="dash-token-value">${fmtTokens(t.output_tokens)}</span>
        </div>
        <div class="dash-token-item">
          <span class="dash-token-label">推定コスト</span>
          <span class="dash-token-value">$${totalCost}</span>
        </div>
      </div>

      ${statusBadges ? `<div class="dash-status-row">${statusBadges}</div>` : ""}

      <div class="dash-footer">
        <span>最終アップロード: ${lastUpload}</span>
      </div>
    </div>
  `;
}

function fmtTokens(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + "K";
  return String(n);
}
