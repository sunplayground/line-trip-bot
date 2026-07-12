import { getBotInfo, pushMessage, showLoading } from "./line.js";
import { chatCompletion } from "./openrouter.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

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
            max_tokens: 8000,
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

    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    writer.write(encoder.encode("OK"));

    const keepalive = setInterval(() => {
      writer.write(encoder.encode(" ")).catch(() => {});
    }, 10000);

    const processing = (async () => {
      try {
        for (const event of events) {
          try {
            await handleEvent(event, env);
          } catch (err) {
            console.error("Event error:", err);
          }
        }
      } finally {
        clearInterval(keepalive);
        try { await writer.close(); } catch (e) {}
      }
    })();

    ctx.waitUntil(processing);

    return new Response(readable, { status: 200 });
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

  if (type === "join" && source?.groupId) {
    const welcome =
      "👋 Hi! I'm TripSplit Bot.\n\n" +
      "Tag me to track trip expenses — e.g.:\n" +
      '"@bot Alice paid 500 for dinner"\n\n' +
      'Ask me to "settle" or "สรุป" when the trip is done to calculate who owes whom.\n' +
      'Type "help" for more.';
    await pushMessage(source.groupId, welcome, env.LINE_CHANNEL_ACCESS_TOKEN);
    return;
  }

  if (type !== "message" || event.message?.type !== "text") return;

  const groupId = source?.groupId;
  if (!groupId) return;

  const mention = event.message.mention;
  if (!mention?.mentionees?.length) return;

  let botInfo;
  try {
    botInfo = await getBotInfo(env.LINE_CHANNEL_ACCESS_TOKEN);
  } catch (err) {
    console.error("Failed to get bot info:", err);
    return;
  }

  const isMentioned = mention.mentionees.some((m) => m.userId === botInfo.userId);
  if (!isMentioned) return;

  const userText = stripMentions(event.message.text, mention);

  await showLoading(groupId, env.LINE_CHANNEL_ACCESS_TOKEN).catch(() => {});

  if (/^(reset|เริ่มใหม่)$/i.test(userText.trim())) {
    await pushMessage(groupId, "✅ Ledger cleared! Start tracking a new trip!", env.LINE_CHANNEL_ACCESS_TOKEN);
    return;
  }

  let response;
  try {
    response = await chatCompletion(
      [{ role: "user", content: userText }],
      env.OPENROUTER_API_KEY,
      env.MODEL || "google/gemini-3.1-pro-preview"
    );
  } catch (err) {
    console.error("LLM call failed:", err);
    response =
      "เกิดข้อผิดพลาด ลองอีกครั้งนะ / Sorry, I had trouble processing that. Please try again.";
  }

  const truncated = maybeTruncate(response, 5000);
  await pushMessage(groupId, truncated, env.LINE_CHANNEL_ACCESS_TOKEN);
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