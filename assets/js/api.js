/* assets/js/api.js
 * 全站共用：Worker API Base 設定 + fetch 包裝
 * 用法：
 *   api.setBase("https://api.xxx.workers.dev"); // 存到 localStorage
 *   const r = await api.post("/save", {a:1});
 */

(function () {
  const STORE_KEY = "line_worker_url"; // ✅ 全站共用同一把 key（你首頁那段也用這個）
  const DEFAULT_BASE = ""; // 可留空；你想預設固定也可填 "https://api.zxcv8096.workers.dev"

  function normalizeBase(base) {
    base = String(base || "").trim();
    if (!base) return "";
    // 去掉尾巴的 /
    base = base.replace(/\/+$/, "");
    return base;
  }

  function getStoredBase() {
    const v = localStorage.getItem(STORE_KEY);
    return normalizeBase(v) || normalizeBase(DEFAULT_BASE);
  }

  function setStoredBase(base) {
    const v = normalizeBase(base);
    if (!v) throw new Error("Worker 網址不可空白");
    localStorage.setItem(STORE_KEY, v);
    return v;
  }

  function requireBase() {
    const base = getStoredBase();
    if (!base) {
      throw new Error("尚未設定 Worker 網址（請先到任一頁輸入並儲存）");
    }
    return base;
  }

  async function request(path, opts = {}) {
    const base = requireBase();
    const url = base + (path.startsWith("/") ? path : ("/" + path));

    const method = (opts.method || "GET").toUpperCase();
    const headers = Object.assign({}, opts.headers || {});
    const isJson = opts.json !== undefined;

    let body = opts.body;
    if (isJson) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.json);
    }

    const res = await fetch(url, {
      method,
      headers,
      body,
      mode: "cors",
    });

    const contentType = res.headers.get("content-type") || "";
    const text = await res.text();

    // 盡量解析 JSON
    let data = null;
    if (contentType.includes("application/json")) {
      try { data = JSON.parse(text); } catch (_) {}
    } else {
      // 某些 Worker 可能回 text 但其實是 JSON
      try { data = JSON.parse(text); } catch (_) {}
    }

    if (!res.ok) {
      const msg =
        (data && (data.error || data.detail || data.message)) ||
        text ||
        `HTTP ${res.status}`;
      throw new Error(msg);
    }

    return data !== null ? data : text;
  }

  // 小工具：帶 querystring
  function qs(obj = {}) {
    const p = new URLSearchParams();
    Object.entries(obj).forEach(([k, v]) => {
      if (v === undefined || v === null) return;
      p.append(k, String(v));
    });
    const s = p.toString();
    return s ? `?${s}` : "";
  }

  // 對外 API
  window.api = {
    // base
    getBase: () => getStoredBase(),
    setBase: (base) => setStoredBase(base),
    clearBase: () => localStorage.removeItem(STORE_KEY),

    // request
    request,
    get: (path) => request(path, { method: "GET" }),
    post: (path, json) => request(path, { method: "POST", json }),
    put: (path, json) => request(path, { method: "PUT", json }),
    del: (path, json) => request(path, { method: "DELETE", json }),

    // helper
    qs,
    // health check（你現在有 /health）
    health: () => request("/health", { method: "GET" }),
  };
})();
