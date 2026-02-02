// worker.js - 結合後台管理的 LINE Bot

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // --- 1. 處理跨網域 (CORS) ---
    // 這段是為了讓你的 admin.html 可以順利連線到這裡
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    // --- 2. 儲存設定的 API (給 admin.html 用) ---
    if (url.pathname === '/save' && request.method === 'POST') {
      try {
        const data = await request.json();
        
        // 簡單驗證密碼 (預設 1234)
        if (data.password !== "1234") {
           return new Response("密碼錯誤", { status: 403, headers: corsHeaders() });
        }

        // 存入 Cloudflare KV (使用你的 'DB' 綁定)
        // Key 是關鍵字，Value 是按鈕設定
        await env.DB.put(data.keyword, JSON.stringify(data.buttons));

        return new Response("儲存成功！", { status: 200, headers: corsHeaders() });
      } catch (e) {
        return new Response("儲存失敗: " + e.message, { status: 500, headers: corsHeaders() });
      }
    }

    // --- 3. LINE Webhook (處理訊息) ---
    if (request.method === 'POST') {
      try {
        const body = await request.json();
        const events = body.events;
        
        for (const event of events) {
          // 只處理文字訊息
          if (event.type === 'message' && event.message.type === 'text') {
            await handleMessage(event, env);
          }
        }
        return new Response('OK', { status: 200 });
      } catch (e) {
        return new Response('Error: ' + e.message, { status: 500 });
      }
    }

    return new Response('Bot is running!', { status: 200 });
  },
};

// 輔助函式：CORS 表頭
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "text/plain;charset=UTF-8"
  };
}

// 處理訊息的核心邏輯
async function handleMessage(event, env) {
  const userText = event.message.text.trim();

  // 1. 去 KV 資料庫找有沒有符合的關鍵字
  const storedData = await env.DB.get(userText);

  if (storedData) {
    // 2. 如果有找到，就產生 Quick Reply
    const buttons = JSON.parse(storedData);
    
    const quickReplyItems = buttons.map(btn => ({
      type: "action",
      action: {
        type: "message",
        label: btn.label.substring(0, 20), // 標籤限制 20 字
        text: btn.text
      }
    }));

    // 準備回覆內容
    const replyPayload = {
      replyToken: event.replyToken,
      messages: [{
        type: "text",
        text: `【${userText}】相關選單：`, // 主訊息文字
        quickReply: { items: quickReplyItems }
      }]
    };

    // 發送給 LINE
    await fetch('https://api.line.me/v2/bot/message/reply', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.CHANNEL_ACCESS_TOKEN}` // 記得去 Cloudflare 設定這個變數
      },
      body: JSON.stringify(replyPayload)
    });
  }
}
