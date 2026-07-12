import { getBotInfo, pushMessage, showLoading } from "./line.js";
import { chatCompletion } from "./openrouter.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/test") {
      const results = {};
      results.hasLineToken = !!env.LINE_CHANNEL_ACCESS_TOKEN;
      results.hasLineSecret = !!env.LINE_CHANNEL_SECRET;
      results.hasOpenrouterKey = !!env.OPENROUTER_API_KEY;
      results.model = env.MODEL || "google/gemini-3.1-pro-preview";

      try {
        const botInfo = await getBotInfo(env.LINE_CHANNEL_ACCESS_TOKEN);
        results.botInfo = botInfo;
      } catch (err) {
        results.botInfoError = err.message;
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

    console.log("Webhook received:", { path: url.pathname, hasSignature: !!signature, bodyLen: body.length });

    if (!signature || !(await verifySignature(body, signature, env.LINE_CHANNEL_SECRET))) {
      console.log("Signature verification failed");
      return new Response("Unauthorized", { status: 401 });
    }

    console.log("Signature verified OK");

    const payload = JSON.parse(body);
    const events = payload.events || [];
    console.log(`Processing ${events.length} event(s)`);
    console.log("Events:", JSON.stringify(events).substring(0, 1000));

    for (const event of events) {
      try {
        await handleEvent(event, env);
      } catch (err) {
        console.error("Event handling error:", err);
      }
    }

    return new Response("OK", { status: 200 });
  },
};

async function verifySignature(body, signature, secret) {
  if (!secret) {
    console.log("No secret configured");
    return false;
  }
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
  const match = expected === signature;
  console.log("Signature compare:", { expected: expected?.substring(0, 10), got: signature?.substring(0, 10), match });
  return match;
}

async function handleEvent(event, env) {
  const { type, source } = event;
  console.log("Handling event:", type, "source:", JSON.stringify(source));

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

  if (type !== "message" || event.message?.type !== "text") {
    console.log("Skipping event: not a text message");
    return;
  }

  const groupId = source?.groupId;
  if (!groupId) {
    console.log("Skipping: no groupId (not a group chat)");
    return;
  }

  console.log("Message text:", event.message.text);
  console.log("Mention data:", JSON.stringify(event.message.mention));

  const mention = event.message.mention;
  if (!mention?.mentionees?.length) {
    console.log("Skipping: no mentions");
    return;
  }

  let botInfo;
  try {
    botInfo = await getBotInfo(env.LINE_CHANNEL_ACCESS_TOKEN);
    console.log("Bot userId:", botInfo.userId);
  } catch (err) {
    console.error("Failed to get bot info:", err);
    return;
  }

  console.log("Mentionees:", JSON.stringify(mention.mentionees));
  const isMentioned = mention.mentionees.some((m) => m.userId === botInfo.userId);
  console.log("Is bot mentioned:", isMentioned);
  if (!isMentioned) return;

  const userText = stripMentions(event.message.text, mention);
  console.log("Stripped text:", userText);

  await showLoading(groupId, env.LINE_CHANNEL_ACCESS_TOKEN).catch((e) =>
    console.log("showLoading failed (non-fatal):", e.message)
  );

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
  console.log("Pushing message to group:", groupId);
  const sent = await pushMessage(groupId, truncated, env.LINE_CHANNEL_ACCESS_TOKEN);
  console.log("Push result:", sent);
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