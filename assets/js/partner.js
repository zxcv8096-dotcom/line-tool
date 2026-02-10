/* ========= 夥伴前端邏輯 ========= */

guardPartner();

const Partner = {
  id: localStorage.getItem("partner_id"),

  profileKey() {
    return "partner_profile_" + this.id;
  },

  productsKey() {
    return "partner_products_" + this.id;
  },

  loadProfile() {
    return JSON.parse(localStorage.getItem(this.profileKey()) || "{}");
  },

  saveProfile(data) {
    localStorage.setItem(this.profileKey(), JSON.stringify(data));
  },

  loadProducts() {
    return localStorage.getItem(this.productsKey()) || "";
  },

  saveProducts(text) {
    localStorage.setItem(this.productsKey(), text);
  }
};
