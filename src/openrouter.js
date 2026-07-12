import { SYSTEM_PROMPT } from "./prompt.js";

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";

export async function chatCompletion(messages, apiKey, model) {
  const fullMessages = [{ role: "system", content: SYSTEM_PROMPT }, ...messages];

  const res = await fetch(OPENROUTER_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://line-trip-bot.workers.dev",
      "X-Title": "LINE Trip Bot",
    },
    body: JSON.stringify({
      model,
      messages: fullMessages,
      max_tokens: 4000,
      temperature: 0.7,
    }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`OpenRouter API error ${res.status}: ${errorText}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content || "Sorry, I could not generate a response.";
}