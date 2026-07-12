import { getBotInfo, replyMessage, pushMessage } from "./line.js";
import { chatCompletion } from "./openrouter.js";

const MAX_HISTORY = 30;
const KV_TTL = 2592000;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

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

    ctx.waitUntil(handleEvents(events, env));

    return new Response("OK", { status: 200 });
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

async function handleEvents(events, env) {
  for (const event of events) {
    try {
      await handleEvent(event, env);
    } catch (err) {
      console.error("Event handling error:", err);
    }
  }
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

  if (/^(reset|เริ่มใหม่)$/i.test(userText.trim())) {
    await saveHistory(env, groupId, []);
    await replyWithFallback(
      event.replyToken,
      groupId,
      "✅ Ledger cleared! Start tracking a new trip!",
      env
    );
    return;
  }

  const history = await loadHistory(env, groupId);

  history.push({ role: "user", content: userText });
  const trimmed = history.slice(-MAX_HISTORY);

  let response;
  try {
    response = await chatCompletion(
      trimmed,
      env.OPENROUTER_API_KEY,
      env.MODEL || "google/gemini-3-pro"
    );
  } catch (err) {
    console.error("LLM call failed:", err);
    response =
      "เกิดข้อผิดพลาด ลองอีกครั้งนะ / Sorry, I had trouble processing that. Please try again.";
  }

  history.push({ role: "assistant", content: response });
  await saveHistory(env, groupId, history.slice(-MAX_HISTORY));

  const truncated = maybeTruncate(response, 5000);
  await replyWithFallback(event.replyToken, groupId, truncated, env);
}

async function loadHistory(env, groupId) {
  if (!env.TRIP_KV) return [];
  try {
    const stored = await env.TRIP_KV.get(`group:${groupId}:conv`, "json");
    return Array.isArray(stored) ? stored : [];
  } catch {
    return [];
  }
}

async function saveHistory(env, groupId, history) {
  if (!env.TRIP_KV) return;
  try {
    await env.TRIP_KV.put(`group:${groupId}:conv`, JSON.stringify(history), {
      expirationTtl: KV_TTL,
    });
  } catch (err) {
    console.error("KV save failed:", err);
  }
}

async function replyWithFallback(replyToken, groupId, message, env) {
  const sent = await replyMessage(replyToken, message, env.LINE_CHANNEL_ACCESS_TOKEN);
  if (!sent) {
    await pushMessage(groupId, message, env.LINE_CHANNEL_ACCESS_TOKEN);
  }
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