/* ========= 管理端前端邏輯 ========= */

guardAdmin();

const Admin = {
  partnersKey: "admin_partners",

  getPartners() {
    return JSON.parse(localStorage.getItem(this.partnersKey) || "[]");
  },

  savePartners(list) {
    localStorage.setItem(this.partnersKey, JSON.stringify(list));
  },

  upsertPartner(p) {
    const list = this.getPartners();
    const i = list.findIndex(x => x.pid === p.pid);
    if (i >= 0) list[i] = p;
    else list.unshift(p);
    this.savePartners(list);
  },

  removePartner(pid) {
    const list = this.getPartners().filter(x => x.pid !== pid);
    this.savePartners(list);
  }
};
