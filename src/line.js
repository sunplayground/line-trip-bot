const LINE_API_BASE = "https://api.line.me/v2/bot";

let cachedBotInfo = null;

export async function getBotInfo(accessToken) {
  if (cachedBotInfo) return cachedBotInfo;
  const res = await fetch(`${LINE_API_BASE}/info`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`LINE getBotInfo failed: ${res.status} ${await res.text()}`);
  }
  cachedBotInfo = await res.json();
  return cachedBotInfo;
}

export async function replyMessage(replyToken, message, accessToken) {
  const res = await fetch(`${LINE_API_BASE}/message/reply`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text: message }],
    }),
  });
  return res.ok;
}

export async function showLoading(chatType, chatId, accessToken) {
  const res = await fetch(`${LINE_API_BASE}/chat/loading/start`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      chat: { type: chatType, id: chatId },
      loadingSeconds: 60,
    }),
  });
  const ok = res.ok;
  if (!ok) console.error("showLoading failed:", res.status, await res.text());
  return ok;
}

export async function leaveGroup(groupId, accessToken) {
  const res = await fetch(`${LINE_API_BASE}/group/${groupId}/leave`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return res.ok;
}

export async function pushMessage(to, message, accessToken) {
  const res = await fetch(`${LINE_API_BASE}/message/push`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      to,
      messages: [{ type: "text", text: message }],
    }),
  });
  return res.ok;
}