import { getBotInfo, pushMessage, replyMessage, showLoading, leaveGroup } from "./line.js";
import { chatCompletion } from "./openrouter.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/test-loading") {
      const groupId = url.searchParams.get("groupId");
      const results = {};
      if (groupId) {
        try {
          const res = await fetch("https://api.line.me/v2/bot/chat/loading/start", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              chat: { type: "group", id: groupId },
              loadingSeconds: 60,
            }),
          });
          results.status = res.status;
          results.body = await res.text();
        } catch (err) {
          results.error = err.message;
        }
      } else {
        results.error = "Add ?groupId=YOUR_GROUP_ID to test";
      }
      return new Response(JSON.stringify(results, null, 2), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (request.method === "GET" && url.pathname === "/test") {
      const prompt = url.searchParams.get("q") || "Say hello in 50 words";
      const results = {};
      results.model = env.MODEL || "google/gemini-3.1-pro-preview";

      try {
        const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://line-trip-bot.workers.dev",
            "X-Title": "LINE Trip Bot",
          },
          body: JSON.stringify({
            model: env.MODEL || "google/gemini-3.1-pro-preview",
            messages: [{ role: "user", content: prompt }],
            max_tokens: 10000,
            temperature: 0.3,
          }),
        });
        results.status = res.status;
        const data = await res.json();
        results.finish_reason = data.choices?.[0]?.finish_reason;
        results.usage = data.usage;
        results.content = data.choices?.[0]?.message?.content;
      } catch (err) {
        results.error = err.message;
      }

      return new Response(JSON.stringify(results, null, 2), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (request.method !== "POST" || url.pathname !== "/webhook") {
      return new Response("Not Found", { status: 404 });
    }

    const body = await request.text();
    const signature = request.headers.get("X-Line-Signature");

    if (!signature || !(await verifySignature(body, signature, env.LINE_CHANNEL_SECRET))) {
      return new Response("Unauthorized", { status: 401 });
    }

    const payload = JSON.parse(body);
    const events = payload.events || [];

for (const event of events) {
      if (event.type === "join" && event?.source?.groupId) {
        const gid = event.source.groupId;
        const allowed = (env.ALLOWED_GROUP_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
        if (allowed.length && !allowed.includes(gid)) {
          console.log(`Auto-leaving unauthorized group: ${gid}`);
          ctx.waitUntil(leaveGroup(gid, env.LINE_CHANNEL_ACCESS_TOKEN));
          continue;
        }
        ctx.waitUntil(
          pushMessage(
            gid,
            "👋 Hi! I'm TripSplit Bot.\n\nTag me to track trip expenses!",
            env.LINE_CHANNEL_ACCESS_TOKEN
          )
        );
        continue;
      }

      if (event.type === "message" && event.source?.groupId) {
        ctx.waitUntil(
          showLoading("group", event.source.groupId, env.LINE_CHANNEL_ACCESS_TOKEN)
            .then((ok) => console.log("showLoading result:", ok))
            .catch((e) => console.error("showLoading error:", e.message))
        );
      }

      ctx.waitUntil(env.EVENT_QUEUE.send(event));
    }

    return new Response("OK", { status: 200 });
  },

  async queue(batch, env) {
    for (const message of batch.messages) {
      try {
        console.log("Processing queue message:", JSON.stringify(message.body).substring(0, 200));
        await handleEvent(message.body, env);
        message.ack();
      } catch (err) {
        console.error("Queue processing error:", err);
        message.retry();
      }
    }
  },
};

async function verifySignature(body, signature, secret) {
  if (!secret) return false;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  const expected = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return expected === signature;
}

async function handleEvent(event, env) {
  const { type, source } = event;

  if (type !== "message" || event.message?.type !== "text") return;

  const groupId = source?.groupId;
  if (!groupId) return;

  const allowed = (env.ALLOWED_GROUP_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (allowed.length && !allowed.includes(groupId)) {
    console.log(`Blocked message from unauthorized group: ${groupId}`);
    return;
  }

  const mention = event.message.mention;
  if (!mention?.mentionees?.length) return;

  const mentionees = mention.mentionees.filter((m) => m.userId !== "@all");
  if (!mentionees.length) return;

  let botInfo;
  try {
    botInfo = await getBotInfo(env.LINE_CHANNEL_ACCESS_TOKEN);
  } catch (err) {
    console.error("Failed to get bot info:", err);
    return;
  }

  const isMentioned = mentionees.some((m) => m.userId === botInfo.userId);
  if (!isMentioned) return;

  const userText = stripMentions(event.message.text, mention);

  if (/จุดอ่อน/.test(userText)) {
    await pushMessage(groupId, "Thep", env.LINE_CHANNEL_ACCESS_TOKEN);
    return;
  }

  if (/^groupid$/i.test(userText.trim())) {
    await pushMessage(groupId, `Group ID: ${groupId}`, env.LINE_CHANNEL_ACCESS_TOKEN);
    return;
  }

  if (/^(reset|เริ่มใหม่)$/i.test(userText.trim())) {
    await pushMessage(groupId, "✅ Ledger cleared! Start tracking a new trip!", env.LINE_CHANNEL_ACCESS_TOKEN);
    return;
  }

  let response;
  try {
    console.log("Calling OpenRouter...");
    response = await chatCompletion(
      [{ role: "user", content: userText }],
      env.OPENROUTER_API_KEY,
      env.MODEL || "google/gemini-3.1-pro-preview"
    );
    console.log("OpenRouter response:", response?.substring(0, 200));
  } catch (err) {
    console.error("LLM call failed:", err);
    response =
      "เกิดข้อผิดพลาด ลองอีกครั้งนะ / Sorry, I had trouble processing that. Please try again.";
  }

  const truncated = maybeTruncate(response, 5000);
  const replyToken = event.replyToken;
  let sentVia = "push API";
  let sent = false;

  if (replyToken) {
    sent = await replyMessage(replyToken, truncated, env.LINE_CHANNEL_ACCESS_TOKEN);
    if (sent) sentVia = "reply token";
  }

  if (!sent) {
    sent = await pushMessage(groupId, `${truncated}\n\n_[via ${sentVia}]_`, env.LINE_CHANNEL_ACCESS_TOKEN);
  }

  console.log(`Sent via ${sentVia}, result: ${sent}`);
}

function stripMentions(text, mention) {
  if (!mention?.mentionees?.length) return text;
  let result = text;
  let offset = 0;
  for (const m of mention.mentionees) {
    const start = m.index + offset;
    const length = m.length;
    result = result.substring(0, start) + result.substring(start + length);
    offset -= length;
  }
  return result.replace(/\s+/g, " ").trim();
}

function maybeTruncate(text, maxLen) {
  if (text.length <= maxLen) return text;
  return text.substring(0, maxLen - 3) + "...";
}