import express from "express";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getTicker, getKlines } from "./agentos-connect.js";
import { explain } from "./src/explain.js";
import { runCodex } from "./src/codex-runner.js";

const execFileAsync = promisify(execFile);

const app = express();
app.use(express.json());
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;
let lastAnalysis = null; // simple mémoire en RAM pour le MVP (un seul utilisateur à la fois)

/** Récupère prix + volatilité (ATR%) via l'API publique Binance (pas d'auth requise). */
async function getMarketData(symbol) {
  const ticker = await getTicker(symbol);
  const rows = await getKlines(symbol);

  const closes = rows.map((r) => r.close);

  // ATR% simplifié sur 14 dernières bougies
  const trs = [];
  for (let i = 1; i < rows.length; i++) {
    trs.push(
      Math.max(
        rows[i].high - rows[i].low,
        Math.abs(rows[i].high - closes[i - 1]),
        Math.abs(rows[i].low - closes[i - 1])
      )
    );
  }
  const atrPct = (trs.slice(-14).reduce((a, b) => a + b, 0) / 14 / closes.at(-1)) * 100;

  return { symbol, price: +ticker.lastPrice, atrPct, volatile: atrPct > 4 };
}

/** Risk Gate déterministe — l'IA n'y touche jamais, elle ne fait qu'expliquer le résultat. */
function assessRisk(allocations, market) {
  const risks = [];
  let score = 0;

  const top = allocations.reduce((a, b) => (a.weightPct > b.weightPct ? a : b));
  if (top.weightPct >= 60) {
    score += 40;
    risks.push({ title: "Excessive concentration", detail: `${top.weightPct}% of the portfolio is exposed to ${top.symbol}.` });
  }

  const volatileExposure = allocations.filter((a) => market[a.symbol]?.volatile).reduce((s, a) => s + a.weightPct, 0);
  if (volatileExposure >= 50) {
    score += 35;
    risks.push({ title: "Volatility exposure", detail: `${volatileExposure}% of the portfolio is in highly volatile assets.` });
  }

  const level = score >= 60 ? "HIGH" : score >= 30 ? "MEDIUM" : "LOW";
  return { score: Math.min(score, 100), level, risks };
}

/**
 * Lit le snapshot exporté manuellement par Codex CLI / Claude Code
 * (après leur propre auth OAuth, whitelistée par Binance).
 * On ne fait aucune auth ici : on lit juste un fichier local déjà produit.
 */
app.get("/api/portfolio/import", async (_req, res) => {
  try {
    const fs = await import("node:fs/promises");
    const raw = await fs.readFile("./data/portfolio-snapshot.json", "utf-8");
    const snapshot = JSON.parse(raw);

    // Adapte cette normalisation au format réel renvoyé par le tool
    // (à ajuster une fois que tu vois la vraie structure du fichier exporté).
    const balances = (snapshot.balances || snapshot.result || snapshot).filter(
      (b) => Number(b.free ?? b.balance ?? 0) > 0
    );
    const totalValue = balances.reduce((s, b) => s + Number(b.usdValue ?? b.free ?? 0), 0);

    const allocations = balances.map((b) => ({
      symbol: `${b.asset}USDT`,
      weightPct: totalValue ? +((Number(b.usdValue ?? b.free) / totalValue) * 100).toFixed(1) : 0,
    }));

    res.json({ allocations, importedAt: new Date().toISOString(), source: "codex-cli-export" });
  } catch (err) {
    res.status(404).json({
      error: "No snapshot found. Run the Codex CLI export first (./data/portfolio-snapshot.json).",
    });
  }
});

/**
 * Déclenche Codex CLI en mode non-interactif pour lire le VRAI portefeuille
 * du compte authentifié sur cette machine, via Agent OS.
 * IMPORTANT : fonctionne uniquement avec l'identité déjà authentifiée
 * localement (codex login) — pas un flow multi-utilisateur, voir README.
 */
app.get("/api/portfolio/live", async (req, res) => {
  const account = req.query.account === "main" || req.query.account === "sub" ? req.query.account : "both";

  const promptByAccount = {
    sub:
      "On the binance-mcp-server MCP server, directly call tool_execute with " +
      '{"toolName":"spot.getAccount","arguments":{"omitZeroBalances":true}}. ' +
      "Do NOT call tool_search first, call tool_execute immediately with the exact arguments above. " +
      "Reply with the raw JSON result only, no text around it, no markdown.",
    main:
      "On the binance-mcp-server MCP server, directly call tool_execute with " +
      '{"toolName":"sub_account.getMainAccountAsset","arguments":{}}. ' +
      "Do NOT call tool_search first, call tool_execute immediately with the exact arguments above. " +
      "Reply with the raw JSON result only, no text around it, no markdown.",
    both:
      "On the binance-mcp-server MCP server, directly call tool_execute TWICE, with no tool_search step first: " +
      '1) {"toolName":"spot.getAccount","arguments":{"omitZeroBalances":true}} ; ' +
      '2) {"toolName":"sub_account.getMainAccountAsset","arguments":{}}. ' +
      "Call both immediately, one after the other. Reply with both raw JSON results, no text around them, no markdown. " +
      "If call 2 fails, say so briefly but still return the raw result of call 1.",
  };
  const prompt = promptByAccount[account];

  try {
    const { stdout, stderr } = await runCodex([
      "exec",
      "--skip-git-repo-check",
      "--sandbox", "danger-full-access",
      "-c", "approval_policy=never",
      "--json",
      prompt,
    ]);

    // Debug : on garde toujours la sortie brute (stdout + stderr fusionnés,
    // car Codex peut écrire ses événements sur l'un ou l'autre selon le
    // contexte d'exécution sans TTY) pour pouvoir l'inspecter si besoin.
    const combinedOutput = `${stdout}\n${stderr}`;
    const fs = await import("node:fs/promises");
    await fs.mkdir("./data", { recursive: true }).catch(() => {});
    await fs.writeFile("./data/last-codex-output.ndjson", combinedOutput, "utf-8").catch(() => {});

    // codex exec --json renvoie des lignes NDJSON d'événements. On collecte
    // TOUS les résultats de tool_call contenant des soldes (sous-compte +
    // compte principal), pas un seul, puis on les fusionne.
    const lines = combinedOutput.trim().split("\n").filter(Boolean);
    let finalText = "";
    const toolResultTexts = [];
    for (const line of lines) {
      try {
        const evt = JSON.parse(line);
        if (evt.type === "item.completed" && evt.item?.type === "agent_message" && evt.item.text) {
          finalText = evt.item.text;
        }
        if (
          evt.type === "item.completed" &&
          evt.item?.type === "mcp_tool_call" &&
          evt.item.result?.content?.[0]?.text
        ) {
          const text = evt.item.result.content[0].text;
          if (text.includes("balances") || text.includes("asset")) toolResultTexts.push(text);
        }
      } catch {
        /* ligne non-JSON, on l'ignore */
      }
    }

    // Fusionne les soldes de tous les résultats trouvés (sous-compte + principal).
    // spot.getAccount renvoie "balances", sub_account.getMainAccountAsset
    // renvoie "assetInfoList" — on gère les deux formats.
    let mergedBalances = [];
    for (const text of toolResultTexts) {
      const m = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
      if (!m) continue;
      try {
        const parsed = JSON.parse(m[0]);
        const list =
          parsed.balances || parsed.assetInfoList || parsed.result || (Array.isArray(parsed) ? parsed : null);
        if (Array.isArray(list)) mergedBalances = mergedBalances.concat(list);
      } catch {
        /* résultat non exploitable, on l'ignore */
      }
    }

    if (!mergedBalances.length) {
      const sourceText = toolResultTexts.join(" ") || finalText;
      throw new Error("Codex n'a renvoyé aucun JSON exploitable : " + sourceText.slice(0, 200));
    }

    const balances = mergedBalances.filter((b) => Number(b.free ?? b.balance ?? 0) > 0);

    // Fusionne les doublons si un même actif apparaît sur les deux comptes.
    // Le compte principal (assetInfoList) donne directement une "valuation"
    // déjà convertie — on la garde telle quelle plutôt que de recalculer via
    // un prix de marché (indispensable pour les tokens LD... type staking
    // liquide qui n'ont pas de paire USDT classique).
    const byAsset = new Map(); // asset -> { qty, knownValuation }
    for (const b of balances) {
      const qty = Number(b.free ?? b.balance ?? 0);
      const entry = byAsset.get(b.asset) || { qty: 0, knownValuation: 0 };
      entry.qty += qty;
      if (b.valuation != null) entry.knownValuation += Number(b.valuation) || 0;
      byAsset.set(b.asset, entry);
    }

    // Le JSON du sous-compte donne des QUANTITÉS d'actifs sans valeur —
    // on convertit ceux-là en USD via le prix de marché public. Les tokens
    // "LD..." (Simple Earn / staking verrouillé) n'ont pas de paire directe :
    // on retombe sur l'actif sous-jacent (LDBTC -> BTC) pour trouver un prix.
    const STABLES = new Set(["USDC", "USDT", "FDUSD", "BUSD"]);
    const valued = [];
    for (const [asset, { qty, knownValuation }] of byAsset) {
      let usdValue;
      const underlying = asset.startsWith("LD") ? asset.slice(2) : asset;

      if (knownValuation > 0) {
        usdValue = knownValuation; // déjà fourni par sub_account.getMainAccountAsset
      } else if (STABLES.has(asset) || STABLES.has(underlying)) {
        usdValue = qty; // ~1:1
      } else {
        try {
          const ticker = await getTicker(`${underlying}USDT`);
          usdValue = qty * Number(ticker.lastPrice);
        } catch {
          usdValue = 0; // vraiment aucun prix trouvable — gardé à 0 plutôt que supprimé
        }
      }
      valued.push({ asset: underlying, usdValue });
    }

    const totalValue = valued.reduce((s, v) => s + v.usdValue, 0);
    const allocations = valued
      .map((v) => ({
        symbol: STABLES.has(v.asset) ? `${v.asset}USDT` : `${v.asset}USDT`,
        weightPct: totalValue ? +((v.usdValue / totalValue) * 100).toFixed(1) : 0,
      }))
      .filter((a) => a.weightPct > 0);

    res.json({ allocations, importedAt: new Date().toISOString(), source: "agent-os-live-codex" });
  } catch (err) {
    console.error("[/api/portfolio/live]", err);
    res.status(500).json({
      error:
        err.code === "ENOENT"
          ? "Codex CLI not found on this machine (npm i -g @openai/codex, then codex login)."
          : `Live import failed: ${err.message}`,
    });
  }
});

/**
 * Déclenche `codex login` + la connexion MCP Binance en un clic.
 * ATTENTION : n'ouvre le navigateur que sur LA MACHINE QUI FAIT TOURNER
 * ce serveur — ça ne peut fonctionner que si tu lances Guardians en local,
 * sur ta propre machine. Ce n'est pas transposable à un vrai utilisateur
 * distant (voir README).
 */
app.post("/api/codex/connect-openai", async (_req, res) => {
  try {
    // `codex login` ouvre le navigateur système et bloque jusqu'à la fin du flow.
    await execFileAsync("codex", ["login"], { timeout: 120000 });
    res.json({ success: true, step: "openai" });
  } catch (err) {
    res.status(500).json({ error: `codex login failed: ${err.message}` });
  }
});

app.post("/api/codex/connect-binance", async (_req, res) => {
  const prompt =
    "Connecte-toi au serveur MCP https://agent.binance.com/mcp/agentic et authentifie-toi " +
    "avec mon compte Binance si ce n'est pas déjà fait. Confirme une fois connecté.";
  try {
    const { stdout } = await execFileAsync("codex", ["exec", prompt], { timeout: 120000 });
    res.json({ success: true, step: "binance", output: stdout.slice(-500) });
  } catch (err) {
    res.status(500).json({ error: `Binance connection failed: ${err.message}` });
  }
});

app.post("/api/analyze", async (req, res) => {
  try {
    const { allocations } = req.body; // [{ symbol: "BTCUSDT", weightPct: 60 }, ...]
    if (!Array.isArray(allocations) || !allocations.length) {
      return res.status(400).json({ error: "Empty or invalid portfolio." });
    }

    const market = {};
    for (const a of allocations) {
      market[a.symbol] = await getMarketData(a.symbol);
    }

    const risk = assessRisk(allocations, market);
    const analysis = { allocations, market, risk };
    lastAnalysis = analysis; // pour les questions de suivi via /api/ask

    const explanation = await explain(
      analysis,
      "Analyze my portfolio and tell me if there are any significant risks."
    );

    res.json({ ...analysis, explanation });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Question libre de suivi ("Pourquoi mon risque est moyen ?", etc.)
 * Réutilise le dernier résultat calculé par /api/analyze — ne relance
 * aucun calcul, l'IA explique seulement.
 */
app.post("/api/ask", async (req, res) => {
  try {
    const { question } = req.body;
    if (!question) return res.status(400).json({ error: "Missing question." });
    if (!lastAnalysis) {
      return res.status(400).json({ error: "Run an analysis first via /api/analyze." });
    }
    const answer = await explain(lastAnalysis, question);
    res.json({ answer });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`Guardians MVP sur http://localhost:${PORT}`));
