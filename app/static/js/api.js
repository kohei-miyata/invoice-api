/* Centralised API client — reads tenant from the selector in sidebar */

const BASE = "";

function getTenant() {
  return document.getElementById("tenant-select")?.value || "demo";
}

function headers(extra = {}) {
  return {
    "X-Tenant-Slug": getTenant(),
    "Content-Type": "application/json",
    ...extra,
  };
}

async function request(method, path, body = null, isFormData = false) {
  const opts = { method };
  if (isFormData) {
    opts.headers = { "X-Tenant-Slug": getTenant() };
    opts.body = body;
  } else {
    opts.headers = headers();
    if (body !== null) opts.body = JSON.stringify(body);
  }

  const res = await fetch(BASE + path, opts);
  if (res.status === 204) return null;

  const data = await res.json().catch(() => ({ detail: res.statusText }));
  if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
  return data;
}

const api = {
  // Masters
  listCompanies:  ()           => request("GET",    "/api/masters"),
  getCompany:     (id)         => request("GET",    `/api/masters/${id}`),
  createCompany:  (body)       => request("POST",   "/api/masters", body),
  updateCompany:  (id, body)   => request("PUT",    `/api/masters/${id}`, body),
  deleteCompany:  (id)         => request("DELETE", `/api/masters/${id}`),

  // Invoices
  listInvoices:   (status)     => request("GET",    "/api/invoices" + (status ? `?status=${status}` : "")),
  getInvoice:     (id)         => request("GET",    `/api/invoices/${id}`),
  uploadInvoice:  (formData)   => request("POST",   "/api/invoices", formData, true),
  updateInvoice:  (id, body)   => request("PUT",    `/api/invoices/${id}`, body),
  deleteInvoice:  (id)         => request("DELETE", `/api/invoices/${id}`),
  processInvoice: (id)         => request("POST",   `/api/invoices/${id}/process`),
  getDownloadUrl: (id)         => request("GET",    `/api/invoices/${id}/download-url`),

  // Approvals
  listApprovals:  (invoiceId)  => request("GET",    "/api/approvals" + (invoiceId ? `?invoice_id=${invoiceId}` : "")),
  createApproval: (body)       => request("POST",   "/api/approvals", body),
  updateApproval: (id, body)   => request("PUT",    `/api/approvals/${id}`, body),
  deleteApproval: (id)         => request("DELETE", `/api/approvals/${id}`),
};
