// worker.js - 終極版 (支援文字 + 圖片卡片 + 紅色按鈕)

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 1. CORS 設定
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    // 2. 儲存 API
    if (url.pathname === '/save' && request.method === 'POST') {
      try {
        const data = await request.json();
        if (data.password !== "1234") return new Response("密碼錯誤", { status: 403, headers: corsHeaders() });

        // 存入所有資料 (文字、卡片、按鈕)
        await env.DB.put(data.keyword, JSON.stringify(data));
        return new Response("儲存成功", { status: 200, headers: corsHeaders() });
      } catch (e) {
        return new Response("錯誤: " + e.message, { status: 500, headers: corsHeaders() });
      }
    }

    // 3. LINE Webhook
    if (request.method === 'POST') {
      try {
        const body = await request.json();
        const events = body.events;
        for (const event of events) {
          if (event.type === 'message' && event.message.type === 'text') {
            await handleMessage(event, env);
          }
        }
        return new Response('OK', { status: 200 });
      } catch (e) { return new Response('Error', { status: 500 }); }
    }

    return new Response('API Running', { status: 200 });
  },
};

function corsHeaders() {
  return { "Access-Control-Allow-Origin": "*", "Content-Type": "text/plain" };
}

async function handleMessage(event, env) {
  const userText = event.message.text.trim();
  const storedData = await env.DB.get(userText); 

  if (storedData) {
    const data = JSON.parse(storedData);
    const messages = [];

    // --- 1. 準備文字訊息 ---
    if (data.replyText) {
      messages.push({ type: "text", text: data.replyText });
    }

    // --- 2. 準備圖片卡片 (Flex Message Carousel) ---
    if (data.cards && data.cards.length > 0) {
      const bubbles = data.cards.map(card => ({
        type: "bubble",
        size: "micro", // 卡片大小
        hero: {
          type: "image",
          url: card.img,
          size: "full",
          aspectMode: "cover",
          aspectRatio: "320:213", // 圖片比例
          action: { type: "uri", uri: card.link } // 點圖片開啟連結
        },
        body: {
          type: "box",
          layout: "vertical",
          contents: [
            {
              type: "text",
              text: card.title || "點擊查看詳情",
              weight: "bold",
              size: "xs",
              wrap: true
            }
          ],
          paddingAll: "sm"
        },
        action: { type: "uri", uri: card.link } // 點整張卡都開啟連結
      }));

      messages.push({
        type: "flex",
        altText: "查看推薦清單",
        contents: {
          type: "carousel",
          contents: bubbles
        }
      });
    }

    // --- 3. 準備紅色按鈕 (Quick Reply) ---
    // LINE 規定 Quick Reply 必須掛在「最後一則」訊息上
    if (data.buttons && data.buttons.length > 0 && messages.length > 0) {
      const lastMsgIndex = messages.length - 1;
      messages[lastMsgIndex].quickReply = {
        items: data.buttons.map(btn => ({
          type: "action",
          action: { type: "message", label: btn.label.substring(0, 20), text: btn.text }
        }))
      };
    }

    // 如果沒有任何訊息就不發送
    if (messages.length === 0) return;

    // 發送給 LINE
    await fetch('https://api.line.me/v2/bot/message/reply', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.CHANNEL_ACCESS_TOKEN}`
      },
      body: JSON.stringify({
        replyToken: event.replyToken,
        messages: messages
      })
    });
  }
}
