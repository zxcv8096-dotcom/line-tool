// worker.js — 一整段可直接貼上覆蓋
// ✅ 你要的改動：
// 1)「原本的報告模板」不再使用（reports / reportHint 全部忽略）
// 2) 報告改成：依使用者作答自動判斷「優先方向 + 今天能做的調整 + 建議營養素」
// 3) 不顯示使用者答案、不顯示ID、不重複發送
// 4) Flex 內含：大頭貼（小）+ 名稱 + 報告
// 5) 如果狀態本來就很好：不硬推營養品（只給維持建議，不給「你需要買」的語氣）
//
// Bindings:
// - KV Namespace: DB
// Secrets:
// - CHANNEL_ACCESS_TOKEN (必填)
// - CHANNEL_SECRET (可選：有就驗簽)

export async function handleMonolith(request, env, ctx) {
  async fetch(request, env) {
    const url = new URL(request.url);

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj), {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
      });

    try {
      if (!env.DB) return json({ ok: false, error: "KV(DB) 未綁定" }, 500);

      // ========= KV Keys =========
      const Q_PREFIX = "AI_SURVEY:Q:";               // AI_SURVEY:Q:<surveyName>
      const LEAD_PREFIX = "AI_SURVEY:LEAD:";         // AI_SURVEY:LEAD:<ts>:<userId>
      const KW_MAP_KEY = "AI_SURVEY:KW_MAP";         // keyword(norm) -> surveyName
      const SESSION_PREFIX = "AI_SURVEY:SESSION:";   // AI_SURVEY:SESSION:<userId>

      // ========= health =========
      if (url.pathname === "/health" && request.method === "GET") {
        return json({ ok: true, ts: Date.now() }, 200);
      }

      // ========= Admin API (給你的後台 HTML 用) =========
      if (url.pathname === "/listAll" && request.method === "POST") {
        const dbKeys = (await env.DB.list({ limit: 1000 })).keys.map((k) => k.name);
        dbKeys.sort();
        return json({ ok: true, db: dbKeys }, 200);
      }

      if (url.pathname === "/putAny" && request.method === "POST") {
        const data = await request.json().catch(() => ({}));
        const keyword = String(data?.keyword || "").trim();
        const payload = data?.payload;
        if (!keyword) return json({ ok: false, error: "keyword 不可空白" }, 400);
        if (payload === undefined || payload === null) return json({ ok: false, error: "payload 不可空白" }, 400);
        await env.DB.put(keyword, JSON.stringify(payload));
        return json({ ok: true }, 200);
      }

      if (url.pathname === "/loadAny" && request.method === "POST") {
        const data = await request.json().catch(() => ({}));
        const keyword = String(data?.keyword || "").trim();
        if (!keyword) return json({ ok: false, error: "keyword 不可空白" }, 400);
        const stored = await env.DB.get(keyword);
        if (!stored) return json({ ok: false, error: "無資料" }, 404);
        try { return json({ ok: true, payload: JSON.parse(stored) }, 200); }
        catch { return json({ ok: true, payload: stored }, 200); }
      }

      if (url.pathname === "/deleteAny" && request.method === "POST") {
        const data = await request.json().catch(() => ({}));
        const keyword = String(data?.keyword || "").trim();
        if (!keyword) return json({ ok: false, error: "keyword 不可空白" }, 400);
        await env.DB.delete(keyword);
        return json({ ok: true }, 200);
      }

      // keyword map
      if (url.pathname === "/kwMapGet" && request.method === "POST") {
        const map = await getKwMap(env.DB, KW_MAP_KEY);
        return json({ ok: true, payload: map }, 200);
      }

      if (url.pathname === "/kwMapPut" && request.method === "POST") {
        const data = await request.json().catch(() => ({}));
        if (!data?.payload || typeof data.payload !== "object") {
          return json({ ok: false, error: "payload 必須是 object" }, 400);
        }
        await env.DB.put(KW_MAP_KEY, JSON.stringify(normalizeKwMap(data.payload)));
        return json({ ok: true }, 200);
      }

      // 刪問卷（含清 keyword 綁定）
      if (url.pathname === "/surveyDelete" && request.method === "POST") {
        const data = await request.json().catch(() => ({}));
        const surveyName = String(data?.surveyName || "").trim();
        if (!surveyName) return json({ ok: false, error: "surveyName 不可空白" }, 400);

        const map = await getKwMap(env.DB, KW_MAP_KEY);
        for (const kw of Object.keys(map)) {
          if (map[kw] === surveyName) delete map[kw];
        }
        await env.DB.put(KW_MAP_KEY, JSON.stringify(map));
        await env.DB.delete(Q_PREFIX + surveyName);

        return json({ ok: true }, 200);
      }

      // ========= LINE webhook =========
      const hasLineSig = !!request.headers.get("x-line-signature");
      if (request.method === "POST" && hasLineSig) {
        if (!env.CHANNEL_ACCESS_TOKEN) return json({ ok: false, error: "缺少 CHANNEL_ACCESS_TOKEN" }, 500);

        const signature = request.headers.get("x-line-signature") || "";
        const raw = await request.text();

        if (env.CHANNEL_SECRET) {
          const ok = await verifyLineSignature(raw, signature, env.CHANNEL_SECRET);
          if (!ok) return json({ ok: false, error: "Invalid signature" }, 401);
        }

        let body;
        try { body = JSON.parse(raw); }
        catch { return json({ ok: false, error: "Webhook body 不是 JSON" }, 400); }

        if (body && Array.isArray(body.events)) {
          for (const event of body.events) {
            if (event?.type === "postback") {
              await handlePostback(event, env, { Q_PREFIX, LEAD_PREFIX, KW_MAP_KEY, SESSION_PREFIX });
            } else if (event?.type === "message" && event?.message?.type === "text") {
              await handleMessage(event, env, { Q_PREFIX, LEAD_PREFIX, KW_MAP_KEY, SESSION_PREFIX });
            }
          }
        }

        return json({ ok: true }, 200);
      }

      return json({ ok: true, message: "Running (LINE in-chat survey + branching + smart report + leads)" }, 200);

    } catch (e) {
      return json({ ok: false, error: "Server Error", detail: String(e?.message || e) }, 500);
    }
  },
};

// ===============================
// ✅ LINE Survey (in-chat)
// ===============================

async function handleMessage(event, env, keys) {
  const userId = event?.source?.userId || "";
  const text = String(event?.message?.text || "").trim();
  if (!userId || !text) return;

  const sessionKey = keys.SESSION_PREFIX + userId;

  // 1) 若使用者正在作答：允許打字=選項文字（但會提示最好點按鈕）
  const sess = await loadSession(env, sessionKey);
  if (sess?.active && sess?.surveyName) {
    const survey = await loadSurvey(env, keys.Q_PREFIX, sess.surveyName);
    if (survey) {
      // 分支 nodes
      if (isBranchSurvey(survey) && sess?.mode === "branch") {
        const node = survey.nodes?.[sess.nodeId];
        const hit = (node?.options || []).find(o => String(o?.t || "").trim() === text);
        if (hit) {
          await applyAnswerAndNext(event.replyToken, env, keys, userId, survey, sess, hit);
          return;
        }
        await replyText(event.replyToken, "請直接點下方選項（比較不會選錯）👇", env);
        await sendBranchNode(event.replyToken, env, survey, sess);
        return;
      }

      // 線性 questions
      if (isLinearSurvey(survey) && sess?.mode === "linear") {
        const q = survey.questions?.[sess.qIndex];
        const hit = (q?.a || []).find(o => String(o || "").trim() === text);
        if (hit) {
          await applyLinearAnswerAndNext(event.replyToken, env, keys, userId, survey, sess, hit);
          return;
        }
        await replyText(event.replyToken, "請直接點下方選項（比較不會選錯）👇", env);
        await sendLinearQuestion(event.replyToken, env, survey, sess);
        return;
      }
    }
  }

  // 2) 使用者輸入「報告」：再發一次（仍不顯示答案）
  if (normKw(text) === "報告") {
    const sess2 = await loadSession(env, sessionKey);
    if (sess2?.answers?.length) {
      const survey2 = await loadSurvey(env, keys.Q_PREFIX, sess2.surveyName);
      const report = buildSmartReportText(survey2, sess2);
      await sendProfileReport(event.replyToken, userId, survey2, report, env);
      return;
    }
    await replyText(event.replyToken, "你還沒填問卷喔～請先輸入問卷關鍵字開始。", env);
    return;
  }

  // 3) 沒 session：看 keyword map 是否啟動問卷
  const map = await getKwMap(env.DB, keys.KW_MAP_KEY);
  const kw = normKw(text);
  const surveyName = map[kw];
  if (!surveyName) return; // 不是問卷 keyword，就不回（避免吵）

  const survey = await loadSurvey(env, keys.Q_PREFIX, surveyName);
  if (!survey) {
    await replyText(event.replyToken, "這份問卷找不到資料（後台可能還沒儲存成功）", env);
    return;
  }

  // 建立 session
  const sessNew = makeNewSession(surveyName, survey);
  await saveSession(env, sessionKey, sessNew, 60 * 60 * 6);

  // 送第一題
  if (sessNew.mode === "branch") {
    await sendBranchNode(event.replyToken, env, survey, sessNew);
  } else {
    await sendLinearQuestion(event.replyToken, env, survey, sessNew);
  }
}

async function handlePostback(event, env, keys) {
  const userId = event?.source?.userId || "";
  const data = String(event?.postback?.data || "");
  if (!userId || !data) return;

  // 分支：SV|B|<survey>|<nodeId>|<optIndex>
  if (data.startsWith("SV|B|")) {
    const [, , surveyName, nodeId, optIndexStr] = data.split("|");
    const optIndex = Number(optIndexStr || "0");
    const survey = await loadSurvey(env, keys.Q_PREFIX, surveyName);
    if (!survey || !isBranchSurvey(survey)) {
      await replyText(event.replyToken, "問卷資料不存在或格式錯誤（nodes）", env);
      return;
    }

    const sessionKey = keys.SESSION_PREFIX + userId;
    let sess = await loadSession(env, sessionKey);
    if (!sess || !sess.active || sess.surveyName !== surveyName) {
      sess = makeNewSession(surveyName, survey);
    }
    sess.mode = "branch";
    sess.nodeId = nodeId;

    const node = survey.nodes?.[nodeId];
    const hit = (node?.options || [])[optIndex];
    if (!hit) {
      await replyText(event.replyToken, "選項已失效，請重新輸入關鍵字開始。", env);
      await deleteSession(env, sessionKey);
      return;
    }

    await applyAnswerAndNext(event.replyToken, env, keys, userId, survey, sess, hit);
    return;
  }

  // 線性：SV|L|<survey>|<qIndex>|<optIndex>
  if (data.startsWith("SV|L|")) {
    const [, , surveyName, qIndexStr, optIndexStr] = data.split("|");
    const qIndex = Number(qIndexStr || "0");
    const optIndex = Number(optIndexStr || "0");

    const survey = await loadSurvey(env, keys.Q_PREFIX, surveyName);
    if (!survey || !isLinearSurvey(survey)) {
      await replyText(event.replyToken, "問卷資料不存在或格式錯誤（questions）", env);
      return;
    }

    const sessionKey = keys.SESSION_PREFIX + userId;
    let sess = await loadSession(env, sessionKey);
    if (!sess || !sess.active || sess.surveyName !== surveyName) {
      sess = makeNewSession(surveyName, survey);
    }
    sess.mode = "linear";
    sess.qIndex = qIndex;

    const q = survey.questions?.[qIndex];
    const hit = (q?.a || [])[optIndex];
    if (!hit) {
      await replyText(event.replyToken, "選項已失效，請重新輸入關鍵字開始。", env);
      await deleteSession(env, sessionKey);
      return;
    }

    await applyLinearAnswerAndNext(event.replyToken, env, keys, userId, survey, sess, hit);
    return;
  }
}

// ===============================
// ✅ 分支 nodes：作答→下一題/結束→智慧報告+Lead
// ===============================
async function applyAnswerAndNext(replyToken, env, keys, userId, survey, sess, pickedOpt) {
  const node = survey.nodes?.[sess.nodeId];
  const qText = String(node?.q || "").trim();
  const aText = String(pickedOpt?.t || "").trim();
  const tag = String(pickedOpt?.tag || "").trim();
  const nextId = String(pickedOpt?.next || "").trim();

  sess.answers = Array.isArray(sess.answers) ? sess.answers : [];
  sess.answers.push({ q: qText, a: aText, tag, nodeId: sess.nodeId, ts: Date.now() });

  // 讓你「第一題方向」也能被拿來當作偏好
  if (!sess.focusArea && isFocusDirectionAnswer(qText, aText)) {
    sess.focusArea = aText;
  }

  sess.updatedAt = Date.now();

  // next 为空 = 結束
  if (!nextId) {
    sess.active = false;
    sess.nodeId = "";
    await saveSession(env, keys.SESSION_PREFIX + userId, sess, 60 * 60 * 24);

    const report = buildSmartReportText(survey, sess);
    await sendProfileReport(replyToken, userId, survey, report, env);

    const lead = {
      userId,
      surveyName: sess.surveyName,
      createdAt: Date.now(),
      mode: "branch",
      answers: sess.answers,
      report,
      focusArea: sess.focusArea || "",
    };
    await env.DB.put(`${keys.LEAD_PREFIX}${Date.now()}:${userId}`, JSON.stringify(lead));

    const finalText = String(survey?.final?.text || "").trim();
    if (finalText) await pushText(userId, finalText, env);
    return;
  }

  // 下一題
  sess.nodeId = nextId;
  await saveSession(env, keys.SESSION_PREFIX + userId, sess, 60 * 60 * 6);
  await sendBranchNode(replyToken, env, survey, sess);
}

async function sendBranchNode(replyToken, env, survey, sess) {
  const nodeId = sess.nodeId || (survey.start || "q1");
  const node = survey.nodes?.[nodeId];
  if (!node) {
    await replyText(replyToken, "問卷設定少了某個 node（請在後台補齊）", env);
    return;
  }

  const q = String(node.q || "").trim() || "（未設定題目）";
  const opts = Array.isArray(node.options) ? node.options : [];
  const items = opts.slice(0, 13).map((o, idx) => ({
    type: "action",
    action: {
      type: "postback",
      label: String(o?.t || "選項").slice(0, 20),
      data: `SV|B|${survey.name}|${nodeId}|${idx}`,
      displayText: String(o?.t || "").slice(0, 300),
    },
  }));

  await replyMessage(replyToken, env, [{
    type: "text",
    text: `【${survey.title || survey.name || "問卷"}】\n\n${q}`,
    quickReply: { items },
  }]);
}

// ===============================
// ✅ 線性 questions：作答→下一題/結束→智慧報告+Lead
// ===============================
async function applyLinearAnswerAndNext(replyToken, env, keys, userId, survey, sess, pickedText) {
  const q = survey.questions?.[sess.qIndex];
  const qText = String(q?.q || "").trim();
  const aText = String(pickedText || "").trim();

  sess.answers = Array.isArray(sess.answers) ? sess.answers : [];
  sess.answers.push({ q: qText, a: aText, tag: "", qIndex: sess.qIndex, ts: Date.now() });

  if (!sess.focusArea && isFocusDirectionAnswer(qText, aText)) {
    sess.focusArea = aText;
  }

  sess.updatedAt = Date.now();
  const nextIndex = sess.qIndex + 1;

  // 結束
  if (nextIndex >= survey.questions.length) {
    sess.active = false;
    sess.qIndex = nextIndex;
    await saveSession(env, keys.SESSION_PREFIX + userId, sess, 60 * 60 * 24);

    const report = buildSmartReportText(survey, sess);
    await sendProfileReport(replyToken, userId, survey, report, env);

    const lead = {
      userId,
      surveyName: sess.surveyName,
      createdAt: Date.now(),
      mode: "linear",
      answers: sess.answers,
      report,
      focusArea: sess.focusArea || "",
    };
    await env.DB.put(`${keys.LEAD_PREFIX}${Date.now()}:${userId}`, JSON.stringify(lead));

    const finalText = String(survey?.final?.text || "").trim();
    if (finalText) await pushText(userId, finalText, env);
    return;
  }

  // 下一題
  sess.qIndex = nextIndex;
  await saveSession(env, keys.SESSION_PREFIX + userId, sess, 60 * 60 * 6);
  await sendLinearQuestion(replyToken, env, survey, sess);
}

async function sendLinearQuestion(replyToken, env, survey, sess) {
  const qIndex = Number(sess.qIndex || 0);
  const q = survey.questions?.[qIndex];
  if (!q) {
    await replyText(replyToken, "問卷題目資料錯誤（questions）", env);
    return;
  }
  const qText = String(q.q || "").trim() || "（未設定題目）";
  const opts = Array.isArray(q.a) ? q.a : [];
  const items = opts.slice(0, 13).map((t, idx) => ({
    type: "action",
    action: {
      type: "postback",
      label: String(t || "選項").slice(0, 20),
      data: `SV|L|${survey.name}|${qIndex}|${idx}`,
      displayText: String(t || "").slice(0, 300),
    },
  }));

  await replyMessage(replyToken, env, [{
    type: "text",
    text: `【${survey.title || survey.name || "問卷"}】\n\n${qText}`,
    quickReply: { items },
  }]);
}

// =====================================================
// ✅ 智慧報告（完全不使用原本 reports / reportHint）
// - 依作答自動判斷：優先方向(1~2) / 今日可做(2~3) / 營養素(3~5)
// - 若整體狀態很好：不硬推補充（只給維持建議）
// =====================================================
function buildSmartReportText(survey, sess) {
  const title = survey?.title || survey?.name || "個人化建議";

  // 1) 打分
  const scores = scoreFromAnswers(sess?.answers || []);
  // 2) 若使用者第一題「最想改善方向」有填，作為加權（但不硬推）
  if (sess?.focusArea) {
    const key = mapFocusAreaToDomain(sess.focusArea);
    if (key) scores[key] = (scores[key] || 0) + 1; // 小加權
  }

  // 3) 找出前兩名
  const ranked = Object.entries(scores)
    .sort((a, b) => (b[1] || 0) - (a[1] || 0));

  const top1 = ranked[0] || ["balance", 0];
  const top2 = ranked[1] || ["balance", 0];

  // 判斷「是否真的需要補充」
  // - 最高分 <= 2：多半狀態不差 → 走「維持版」
  const bestScore = Number(top1[1] || 0);
  const isMostlyFine = bestScore <= 2;

  // 4) 產生內容
  if (isMostlyFine) {
    const keep = [
      "你的整體狀態看起來蠻穩的，目前不需要硬補什麼。",
      "先把「作息規律 + 足夠喝水 + 每餐有蛋白質」顧好，維持就會很漂亮。",
      "如果你想更上一階：每天固定 10–20 分鐘戶外光線＋飯後散步 5–10 分鐘，精神與睡眠常會更穩。"
    ];

    return `✅【${title}】\n\n` +
      `🔎 目前整體狀態：偏穩定（以維持為主）\n\n` +
      `✅ 你今天就能開始做：\n- ${keep[0]}\n- ${keep[1]}\n- ${keep[2]}\n\n` +
      `🍽️ 營養素建議：\n- 以「均衡飲食」為主，不需要特別加碼；若外食多，可先把蔬菜量與蛋白質顧好。\n\n` +
      `（提醒：這份內容是生活營養建議，不做效果承諾；如你有特殊飲食限制/用藥需求，建議先諮詢專業人員）`;
  }

  const domain1 = top1[0];
  const domain2 = (Number(top2[1] || 0) >= 3) ? top2[0] : ""; // 第二名也要有感才列

  const plan1 = domainPlan(domain1);
  const plan2 = domain2 ? domainPlan(domain2) : null;

  // 合併「今天能做」去重
  const actions = uniq([...(plan1.actions || []), ...(plan2?.actions || [])]).slice(0, 3);
  const nutrients = uniq([...(plan1.nutrients || []), ...(plan2?.nutrients || [])]).slice(0, 5);

  const focusLines = [
    `🎯 最優先方向：${plan1.label}${domain2 ? `（次要：${plan2.label}）` : ""}`,
    ``,
    `✅ 你今天就能開始做：`,
    ...actions.map(x => `- ${x}`),
    ``,
    `🧩 建議優先留意的營養素：`,
    ...nutrients.map(x => `- ${x}`),
    ``,
    `📌 小提醒：如果你目前飲食已經很均衡、作息也穩，營養品不是必需品；我們會以「先調整生活、需要再補充」為原則。`,
    ``,
    `（提醒：這份內容是生活營養建議，不做效果承諾；如你有特殊飲食限制/用藥需求，建議先諮詢專業人員）`
  ];

  return `✅【${title}】\n\n${focusLines.join("\n")}`.trim();
}

// ===============================
// ✅ 打分規則（只用於內部判斷，不會輸出答案）
// ===============================
function scoreFromAnswers(answers) {
  const s = {
    sleep: 0,
    focus: 0,
    mood: 0,
    gut: 0,
    weight: 0,
    recovery: 0,
    diet: 0,
    skin: 0,
    cycle: 0,
    immune: 0,
    balance: 0,
  };

  for (const item of (answers || [])) {
    const q = String(item?.q || "");
    const a = String(item?.a || "");

    // 睡眠
    if (hitAny(q, ["幾點睡", "入睡", "起床", "睡到一半", "睡前", "白天最容易想睡", "放鬆"])) {
      s.sleep += severityFromAnswer(a);
    }

    // 專注/精神
    if (hitAny(q, ["專注", "節奏", "下午精神", "咖啡", "眼睛疲勞", "看螢幕"])) {
      s.focus += severityFromAnswer(a);
    }

    // 壓力/情緒
    if (hitAny(q, ["情緒", "壓力", "緊繃", "焦躁", "低落", "不耐煩", "深呼吸", "冥想"])) {
      s.mood += severityFromAnswer(a);
    }

    // 腸胃
    if (hitAny(q, ["排便", "脹氣", "飯後", "腸胃"])) {
      s.gut += severityFromAnswer(a);
    }

    // 體態/食慾
    if (hitAny(q, ["體態", "食慾", "零食", "甜點", "宵夜", "吃到飽", "吃飯速度"])) {
      s.weight += severityFromAnswer(a);
    }

    // 體能/恢復/肌肉
    if (hitAny(q, ["活動量", "恢復", "抽筋", "久坐", "體能", "蛋白質", "運動"])) {
      s.recovery += severityFromAnswer(a);
    }

    // 飲食習慣/外食
    if (hitAny(q, ["外食", "蔬菜", "水果", "含糖", "三餐", "早餐", "份量", "飲料"])) {
      s.diet += severityFromAnswer(a);
    }

    // 皮膚
    if (hitAny(q, ["皮膚", "乾燥", "出油", "暗沉", "粗糙", "保水"])) {
      s.skin += severityFromAnswer(a);
    }

    // 女性週期
    if (hitAny(q, ["週期", "波動", "水腫", "經前", "容易疲倦", "情緒敏感"])) {
      s.cycle += severityFromAnswer(a);
    }

    // 免疫/季節
    if (hitAny(q, ["換季", "人多場合", "防護", "季節"])) {
      s.immune += severityFromAnswer(a);
    }

    // 喝水額外：各面向都會受影響
    if (hitAny(q, ["喝水量", "喝水"])) {
      const sev = severityFromAnswer(a);
      s.sleep += Math.floor(sev / 2);
      s.focus += Math.floor(sev / 2);
      s.gut += Math.floor(sev / 2);
      s.skin += Math.floor(sev / 2);
    }
  }

  return s;
}

// 回傳 0~3 的嚴重度
function severityFromAnswer(a) {
  const t = String(a || "").trim();

  // 明顯不好（3）
  if (hitAny(t, ["很頻繁", "很明顯", "幾乎每天", "整天都", "02:00後", "三天以上", "很不固定", "很少", "很難", "常常翻很久"])) return 3;

  // 偏不好（2）
  if (hitAny(t, ["常常", "偏少", "容易", "需要咖啡", "需要很用力", "很撐", "想睡", "下滑", "外食+宵夜很常", "6~8小時", "8小時以上"])) return 2;

  // 些微（1）
  if (hitAny(t, ["偶爾", "普通", "還可以", "一週幾次", "一半", "10~30分鐘", "兩天一次", "有點沉"])) return 1;

  // 看起來不太是問題（0）
  return 0;
}

// 第一題「最想改善的方向」識別
function isFocusDirectionAnswer(qText, aText) {
  return hitAny(qText, ["最想先改善的方向"]) && !!String(aText || "").trim();
}
function mapFocusAreaToDomain(aText) {
  const t = String(aText || "");
  if (hitAny(t, ["睡眠", "放鬆"])) return "sleep";
  if (hitAny(t, ["精神", "專注"])) return "focus";
  if (hitAny(t, ["壓力", "情緒"])) return "mood";
  if (hitAny(t, ["腸胃", "排便"])) return "gut";
  if (hitAny(t, ["體態", "食慾"])) return "weight";
  if (hitAny(t, ["體能", "恢復"])) return "recovery";
  if (hitAny(t, ["飲食", "外食"])) return "diet";
  if (hitAny(t, ["皮膚"])) return "skin";
  if (hitAny(t, ["女性", "週期"])) return "cycle";
  if (hitAny(t, ["免疫", "季節"])) return "immune";
  return "";
}

// 每個方向的建議（不含醫療用語、避免效果承諾）
function domainPlan(domainKey) {
  const plans = {
    sleep: {
      label: "睡眠與放鬆",
      actions: [
        "睡前 60 分鐘把螢幕亮度降到最小，改成音樂/伸展/熱水澡擇一",
        "下午 2 點後盡量不喝含咖啡因，想喝就改無咖啡因或溫熱飲",
        "起床後 10–20 分鐘戶外光線，晚上更容易想睡"
      ],
      nutrients: ["鎂（放鬆用）", "B 群（白天精神）", "甘胺酸（睡前儀式）", "茶胺酸（放鬆節奏）"]
    },
    focus: {
      label: "精神與專注",
      actions: [
        "把工作切成 25 分鐘一段，中間休息 3–5 分鐘讓眼睛離開螢幕",
        "午餐先補蛋白質（豆/蛋/肉/乳擇一），下午比較不容易下滑",
        "每天至少 6–8 杯水（或依體重與活動量調整）"
      ],
      nutrients: ["B 群", "Omega-3", "鎂", "葉黃素（長時間用眼）"]
    },
    mood: {
      label: "壓力與情緒穩定",
      actions: [
        "每天 2 次 1 分鐘的慢呼吸（吸 4 秒、吐 6 秒）",
        "晚餐後 10 分鐘散步或伸展，讓身體從緊繃切換到放鬆",
        "把含糖飲改成無糖或少糖，情緒起伏通常會更穩"
      ],
      nutrients: ["鎂", "Omega-3", "維生素 C", "B6（情緒代謝參與）"]
    },
    gut: {
      label: "腸胃舒適與排便",
      actions: [
        "每餐先補 1 拳蔬菜或加一份海帶/菇類，讓纖維先到位",
        "早上起床先喝溫水，搭配固定時間上廁所（訓練節奏）",
        "外食優先選『清爽主食 + 蛋白質 + 蔬菜』，少炸少重口"
      ],
      nutrients: ["益生菌（挑適合自己的菌種）", "可溶性膳食纖維", "鎂（排便節奏）", "維生素 D（整體支持）"]
    },
    weight: {
      label: "體態管理與食慾",
      actions: [
        "晚餐先吃蛋白質＋蔬菜，再吃主食，甜食慾望通常會下降",
        "把宵夜改成『溫熱無糖飲 + 伸展 5 分鐘』先觀察 3 天",
        "零食想吃時先喝水/吃水果或堅果一小份，避免越吃越停不下來"
      ],
      nutrients: ["蛋白質（先顧每餐份量）", "鎂", "鉻（食慾控制參與）", "膳食纖維"]
    },
    recovery: {
      label: "體能耐力與恢復",
      actions: [
        "走路/運動後做 3–5 分鐘伸展，隔天緊繃感通常會少很多",
        "每餐補蛋白質（豆/蛋/肉/乳），恢復會更穩",
        "久坐每 60 分鐘起來走 2 分鐘，肩頸與腰背更舒服"
      ],
      nutrients: ["蛋白質", "鎂（抽筋/緊繃）", "Omega-3", "維生素 D"]
    },
    diet: {
      label: "飲食習慣與外食",
      actions: [
        "外食先看『蛋白質有沒有』：雞/魚/豆腐/蛋，沒有就補一份",
        "含糖飲改成無糖或半糖，先從一週減少 2–3 次開始",
        "早餐至少有蛋白質（蛋/豆漿/優格），比較不容易下午崩盤"
      ],
      nutrients: ["B 群", "維生素 C", "膳食纖維", "Omega-3"]
    },
    skin: {
      label: "皮膚狀態與保養底子",
      actions: [
        "水分先顧到（分次喝），皮膚穩定度通常會更好",
        "甜食/油炸頻率先減 2–3 次/週，觀察 14 天",
        "晚睡就把保養簡化：清潔 + 保濕，先把節奏穩住"
      ],
      nutrients: ["維生素 C", "鋅", "Omega-3", "膠原蛋白（搭配 C）"]
    },
    cycle: {
      label: "女性週期與狀態波動",
      actions: [
        "週期前一週把睡眠時間固定 15–30 分鐘，波動通常更小",
        "把含糖飲/甜食集中在白天，晚上盡量避免",
        "週期前後增加溫熱食物與規律走路，讓身體更好適應"
      ],
      nutrients: ["鎂", "維生素 B6", "Omega-3", "鐵（若飲食偏少肉類可留意）"]
    },
    immune: {
      label: "免疫防護與季節適應",
      actions: [
        "先把睡眠顧好：固定上床時間，身體適應力會更穩",
        "每天至少一份蔬果（或兩色蔬菜），讓基礎更扎實",
        "人多場合回家先補水＋洗手＋換衣，減少負擔"
      ],
      nutrients: ["維生素 D", "維生素 C", "鋅", "益生菌（腸道支持）"]
    },
    balance: {
      label: "生活節奏",
      actions: ["先把作息與三餐穩住", "每天分次補水", "每餐有蛋白質"],
      nutrients: ["以均衡飲食為主"]
    }
  };

  return plans[domainKey] || plans.balance;
}

// ===============================
// ✅ 報告送出：小頭貼 + 名稱 + 不顯示ID + 不重複
// ===============================
async function sendProfileReport(replyToken, userId, survey, reportText, env) {
  const profile = await getLineProfile(userId, env).catch(() => null);

  const displayName = profile?.displayName || "朋友";
  const pictureUrl = profile?.pictureUrl || "https://via.placeholder.com/96";

  const title = survey?.title || survey?.name || "個人化建議";
  const altText = `你的「${title}」已完成`;

  const flex = {
    type: "flex",
    altText,
    contents: {
      type: "bubble",
      size: "mega",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          {
            type: "box",
            layout: "horizontal",
            spacing: "md",
            contents: [
              {
                type: "image",
                url: pictureUrl,
                size: "xs",
                aspectMode: "cover",
                aspectRatio: "1:1",
                cornerRadius: "999px"
              },
              {
                type: "box",
                layout: "vertical",
                spacing: "xs",
                flex: 1,
                contents: [
                  { type: "text", text: displayName, weight: "bold", size: "md", wrap: true },
                  { type: "text", text: title, size: "sm", color: "#666666", wrap: true }
                ]
              }
            ]
          },
          { type: "separator" },
          { type: "text", text: reportText, size: "sm", wrap: true }
        ]
      }
    }
  };

  // ✅ 只送一次：Flex；若 Flex 因為太長被拒，才降級純文字（仍只送一次）
  try {
    await replyMessage(replyToken, env, [flex], { throwOnFail: true });
  } catch (e) {
    const safeText = reportText.length > 1800 ? reportText.slice(0, 1800) + "…" : reportText;
    await replyMessage(replyToken, env, [{ type: "text", text: safeText }], { throwOnFail: false });
  }
}

async function getLineProfile(userId, env) {
  const res = await fetch(`https://api.line.me/v2/bot/profile/${encodeURIComponent(userId)}`, {
    headers: { Authorization: `Bearer ${env.CHANNEL_ACCESS_TOKEN}` }
  });
  if (!res.ok) throw new Error("profile fetch failed");
  return await res.json();
}

// ===============================
// session helpers
// ===============================
function makeNewSession(surveyName, survey) {
  const isBranch = isBranchSurvey(survey);
  if (isBranch) {
    return {
      active: true,
      mode: "branch",
      surveyName,
      nodeId: survey.start || "q1",
      answers: [],
      focusArea: "",
      startedAt: Date.now(),
      updatedAt: Date.now(),
    };
  }
  return {
    active: true,
    mode: "linear",
    surveyName,
    qIndex: 0,
    answers: [],
    focusArea: "",
    startedAt: Date.now(),
    updatedAt: Date.now(),
  };
}

async function loadSession(env, sessionKey) {
  const raw = await env.DB.get(sessionKey);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function saveSession(env, sessionKey, sess, ttl) {
  await env.DB.put(sessionKey, JSON.stringify(sess), { expirationTtl: ttl });
}

async function deleteSession(env, sessionKey) {
  await env.DB.delete(sessionKey);
}

// ===============================
// survey helpers
// ===============================
async function loadSurvey(env, Q_PREFIX, surveyName) {
  const raw = await env.DB.get(Q_PREFIX + surveyName);
  if (!raw) return null;
  try {
    const s = JSON.parse(raw);
    if (!s || typeof s !== "object") return null;
    s.name = s.name || surveyName;
    return s;
  } catch {
    return null;
  }
}

function isBranchSurvey(s) {
  return !!(s && typeof s === "object" && s.nodes && typeof s.nodes === "object");
}
function isLinearSurvey(s) {
  return !!(s && typeof s === "object" && Array.isArray(s.questions));
}

// ===============================
// KW map helpers
// ===============================
function normKw(s) {
  return String(s || "").trim().replace(/\s+/g, "").toLowerCase();
}

function normalizeKwMap(obj) {
  const out = {};
  for (const k of Object.keys(obj || {})) {
    out[normKw(k)] = String(obj[k] || "").trim();
  }
  return out;
}

async function getKwMap(db, key) {
  const raw = await db.get(key);
  if (!raw) return {};
  try {
    return normalizeKwMap(JSON.parse(raw));
  } catch {
    return {};
  }
}

// ===============================
// LINE helpers
// ===============================
async function replyText(replyToken, text, env) {
  await replyMessage(replyToken, env, [{ type: "text", text }], { throwOnFail: false });
}

async function replyMessage(replyToken, env, messages, opts = { throwOnFail: false }) {
  const res = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ replyToken, messages }),
  });

  if (opts?.throwOnFail && !res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`LINE reply failed: ${res.status} ${t}`);
  }
}

async function pushText(userId, text, env) {
  await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ to: userId, messages: [{ type: "text", text }] }),
  });
}

// ===============================
// LINE signature verify
// ===============================
async function verifyLineSignature(rawBody, signature, channelSecret) {
  try {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(channelSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const mac = await crypto.subtle.sign("HMAC", key, enc.encode(rawBody));
    const b64 = arrayBufferToBase64(mac);
    return safeEqual(b64, signature);
  } catch {
    return false;
  }
}
function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

// ===============================
// misc helpers
// ===============================
function hitAny(text, arr) {
  const s = String(text || "");
  return arr.some(k => s.includes(k));
}
function uniq(arr) {
  const out = [];
  const seen = new Set();
  for (const x of (arr || [])) {
    const k = String(x || "").trim();
    if (!k) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}
