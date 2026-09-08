import { spawn } from "node:child_process";

/**
 * Lance Codex CLI en sous-processus de façon fiable.
 * IMPORTANT : execFile ne supporte pas l'option `stdio` (silencieusement
 * ignorée) — Codex peut rester bloqué en attente sur stdin si ce flux
 * n'est jamais fermé. spawn() permet de le fermer explicitement (`ignore`).
 */
export function runCodex(args, { timeout = 120000, maxBuffer = 20 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("codex", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(Object.assign(new Error("codex exec timeout"), { stdout, stderr, timedOut: true }));
    }, timeout);

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > maxBuffer) child.kill("SIGKILL");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });
}

/** Extrait le texte du dernier "agent_message" d'une sortie --json de Codex. */
export function extractAgentMessage(combinedOutput) {
  const lines = combinedOutput.trim().split("\n").filter(Boolean);
  let finalText = "";
  for (const line of lines) {
    try {
      const evt = JSON.parse(line);
      if (evt.type === "item.completed" && evt.item?.type === "agent_message" && evt.item.text) {
        finalText = evt.item.text;
      }
    } catch {
      /* ligne non-JSON, on l'ignore */
    }
  }
  return finalText;
}
