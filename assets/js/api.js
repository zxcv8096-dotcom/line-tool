// assets/js/api.js
export function getWorkerBase() {
  const v = (localStorage.getItem("line_worker_url") || "").trim();
  // 你首頁就是用 line_worker_url 這個 key :contentReference[oaicite:1]{index=1}
  return v || "https://api.zxcv8096.workers.dev";
}

export async function apiFetch(path, { method = "GET", body, headers } = {}) {
  const base = getWorkerBase().replace(/\/+$/, "");
  const url = base + path;

  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(headers || {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }

  if (!res.ok) {
    throw new Error(json?.message || json?.error || `API Error ${res.status}`);
  }
  return json;
}
