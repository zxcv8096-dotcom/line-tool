// worker/src/worker.js
// 入口檔（之後所有功能都從這裡分流）

import { handleMonolith } from "./monolith.js";

export default {
  async fetch(request, env, ctx) {
    // 目前：先全部交給舊版 monolith
    // 下一步我們才會一段一段拆出來
    return handleMonolith(request, env, ctx);
  }
};
