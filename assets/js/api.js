/* /assets/js/api.js
 * 全站共用：Worker URL 記憶 + API 呼叫 + 需要 API 的頁面自動防呆
 * - 讀取 localStorage: line_worker_url
 * - 沒設定就 redirect 回首頁（預設 /index.html）
 * - 提供 api.get / api.post / api.setBase / api.base
 */

(function () {
  const STORAGE_KEY = "line_worker_url";

  // 你入口頁在 repo 根目錄：/index.html
  // 如果你未來把入口搬到 /pages/tools/index.html，再改這行就好
  const DEFAULT_HOME = "/index.html";

  function trimSlashEnd(s) {
    return String(s || "").trim().replace(/\/+$/, "");
  }

  function readBase() {
    return trimSlashEnd(localStorage.getItem(STORAGE_KEY) || "");
  }

  function setBase(url) {
    const v = trimSlashEnd(url);
    if (!v) return;
    localStorage.setItem(STORAGE_KEY, v);
  }

  function clearBase() {
    localStorage.removeItem(STORAGE_KEY);
  }

  function buildUrl(path) {
    const base = readBase();
    const p = String(path || "");
    if (!base) return "";
    if (!p) return base;
    if (p.startsWith("http://") || p.startsWith("https://")) return p;
    return base + (p.startsWith("/") ? p : "/" + p);
  }

  // ✅ 讓「需要 API 的頁面」自動檢查（沒設定就回首頁）
  function requireWorkerUrl(options = {}) {
    const home = options.home || DEFAULT_HOME;
    const base = readBase();
    if (!base) {
      // 你想顯示訊息，可以用 querystring 帶回去
      const msg = encodeURIComponent("請先在入口頁設定 Worker API 網址");
      window.location.href = `${home}?needWorker=1&msg=${msg}`;
      return false;
    }
    return true;
  }

  async function request(method, path, body, opts = {}) {
    const url = buildUrl(path);
    if (!url) throw new Error("尚未設定 Worker API 網址（line_worker_url）");

    const headers = Object.assign(
      { "Content-Type": "application/json" },
      opts.headers || {}
    );

    const init = {
      method,
      headers,
    };

    if (method !== "GET" && method !== "HEAD") {
      init.body = body === undefined ? "{}" : JSON.stringify(body);
    }

    const res = await fetch(url, init);

    // 兼容：有些 endpoint 回 text
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (e) {
      data = text; // 非 JSON
    }

    if (!res.ok) {
      const msg =
        (data && data.error) ||
        (typeof data === "string" ? data : "") ||
        `HTTP ${res.status}`;
      throw new Error(msg);
    }

    // 若你的 API 統一回 {ok:false,error:""} 也擋掉
    if (data && typeof data === "object" && data.ok === false) {
      throw new Error(data.error || "API 回傳失敗");
    }

    return data;
  }

  // ✅ 對外暴露全站可用的 api
  window.api = {
    storageKey: STORAGE_KEY,

    // base
    base() {
      return readBase();
    },
    setBase(url) {
      setBase(url);
      return readBase();
    },
    clearBase() {
      clearBase();
    },

    // guard
    requireWorkerUrl,

    // http
    get(path, opts) {
      return request("GET", path, undefined, opts);
    },
    post(path, body, opts) {
      return request("POST", path, body, opts);
    },
  };
})();
