import Anthropic from "@anthropic-ai/sdk";
import { runCodex, extractAgentMessage } from "./codex-runner.js";

const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

/**
 * Explains an already-computed analysis result (allocations + market + risk)
 * in natural language. The AI never recalculates anything — it only
 * describes the data it's given. This is what makes Binance Guardians
 * "conversational" without ever letting it invent a number.
 *
 * Priority: Anthropic API (if a paid key is configured) -> Codex CLI
 * (free via a ChatGPT account, reused from the live import feature) ->
 * plain text fallback (always works, no dependency).
 */
export async function explain({ allocations, market, risk }, question) {
  if (anthropic) {
    return explainWithAnthropic({ allocations, market, risk }, question);
  }

  try {
    return await explainWithCodex({ allocations, market, risk }, question);
  } catch {
    return plainTextFallback(risk);
  }
}

function plainTextFallback(risk) {
  return risk.risks.length
    ? `Overall risk level: ${risk.level} (score ${risk.score}/100). ` +
        risk.risks.map((r) => `${r.title}: ${r.detail}`).join(" ")
    : "No significant risk detected on this portfolio.";
}

async function explainWithAnthropic({ allocations, market, risk }, question) {
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 400,
    system:
      "You are Binance Guardians, a crypto security agent. You explain ONLY the JSON data provided, " +
      "in English, in 4-6 sentences maximum. You never invent a number absent from the data. " +
      "You give no trading advice (buy/sell). You cannot execute orders or withdraw funds.",
    messages: [
      {
        role: "user",
        content: `Data: ${JSON.stringify({ allocations, market, risk })}\n\nQuestion: ${question}`,
      },
    ],
  });

  return response.content
    .map((c) => (c.type === "text" ? c.text : ""))
    .join("\n")
    .trim();
}

async function explainWithCodex({ allocations, market, risk }, question) {
  const data = JSON.stringify({ allocations, market, risk });
  const prompt =
    "You are Binance Guardians, a crypto security agent. Given this JSON data ONLY " +
    `(never invent a number not present in it): ${data}\n\n` +
    `Question: ${question}\n\n` +
    "Answer in English, in 4-6 sentences maximum, no markdown formatting, no trading advice " +
    "(buy/sell), and mention you cannot execute orders or withdraw funds if relevant. " +
    "Do not call any tool or MCP server — just reason over the JSON data given above and answer directly.";

  // Pas d'accès MCP nécessaire ici (juste du raisonnement texte) -> sandbox
  // read-only suffit, plus rapide et plus sûr que danger-full-access.
  const { stdout, stderr } = await runCodex([
    "exec",
    "--skip-git-repo-check",
    "--sandbox", "read-only",
    "-c", "approval_policy=never",
    "--json",
    prompt,
  ]);

  const text = extractAgentMessage(`${stdout}\n${stderr}`);
  if (!text) throw new Error("Codex returned no usable text");
  return text;
}
