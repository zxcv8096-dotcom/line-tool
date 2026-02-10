/* ========= 問卷前端共用 ========= */
/* 這支專門給 questionnaire/index.html 使用 */

const Questionnaire = {
  workerUrl() {
    return localStorage.getItem("questionnaire_worker_url")
        || localStorage.getItem("admin_worker_url")
        || "";
  },

  async saveSurvey(payload) {
    const url = this.workerUrl();
    if (!url) throw new Error("尚未設定 Worker URL");
    return fetch(url + "/putAny", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }).then(r => r.json());
  }
};
