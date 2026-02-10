/* ========= Cloudflare API 中央管理 ========= */

const API = {
  get base() {
    return localStorage.getItem("admin_worker_url") || "";
  },

  headers(extra = {}) {
    const token = localStorage.getItem("admin_token") || "";
    return {
      "Content-Type": "application/json",
      ...(token ? { "X-Admin-Token": token } : {}),
      ...extra
    };
  },

  async get(path) {
    if (!this.base) throw new Error("尚未設定 Worker URL");
    const res = await fetch(this.base + path);
    return res.json();
  },

  async post(path, body = {}) {
    if (!this.base) throw new Error("尚未設定 Worker URL");
    const res = await fetch(this.base + path, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body)
    });
    return res.json();
  }
};

/* ========= 共用工具 ========= */
function guardAdmin() {
  if (localStorage.getItem("admin_logged_in") !== "1") {
    location.href = "/pages/admin/login.html";
  }
}

function guardPartner() {
  if (!localStorage.getItem("partner_id")) {
    location.href = "/pages/partner/login.html";
  }
}
