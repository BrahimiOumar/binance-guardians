# 🛡️ Binance Guardians

**AI Security & Intelligence Agent powered by Binance Agent OS**

Binance Guardians is an AI agent that reads a crypto portfolio, runs a
deterministic risk analysis on it (concentration, volatility, momentum), and
explains the result in plain language through a conversational interface.
It does **not** trade. It never has the ability to withdraw funds.

Built for the **Binance Agent OS Mini Hackathon — Track A**.

---

## Table of contents

- [Concept](#concept)
- [Architecture](#architecture)
- [Features](#features)
- [Setup](#setup)
- [Connecting to your Binance account](#connecting-to-your-binance-account)
- [Known limitation: OAuth for custom clients](#known-limitation-oauth-for-custom-clients)
- [Usage](#usage)
- [Security principles](#security-principles)
- [Known issues / honesty section](#known-issues--honesty-section)
- [Tech stack](#tech-stack)

---

## Concept

A Binance user can hold many assets, be heavily concentrated on one token, or
be exposed to volatility they don't fully realize. Binance gives you the raw
data. Guardians adds the layer on top: *"I looked at this data, here is what
it means, and here is the risk level."*

It does this through three MVP functions:

1. **Portfolio Analysis** — pulls real market data (via Binance Agent OS /
   Binance public API) for every asset in the portfolio.
2. **Risk Detection** — a fully deterministic "Risk Gate" scores the
   portfolio (0–100) based on concentration, volatility exposure, and
   momentum. The AI never touches this calculation.
3. **AI Assistant** — a conversational layer (Claude or, if unavailable, the
   user's own Codex/ChatGPT session) explains the Risk Gate's output in
   natural language, and answers free-form follow-up questions. It only
   describes the data it's given — it never invents a number.

---

## Architecture

```
User (browser)
      │
      ▼
Express backend (server.js)
      │
      ├── Portfolio import (manual entry OR live import)
      │        │
      │        ├── Manual: user types allocations directly
      │        └── Live: spawns Codex CLI, which is authenticated to
      │             Binance Agent OS (agent.binance.com/mcp/agentic)
      │             and calls spot.getAccount / sub_account.getMainAccountAsset
      │
      ├── Market data (agentos-connect.js) → Binance public REST API
      │        (ticker + klines, no auth required)
      │
      ├── Risk Gate (server.js: assessRisk()) → deterministic scoring,
      │        no AI involved
      │
      └── Explanation layer (src/explain.js)
               ├── Anthropic API (if ANTHROPIC_API_KEY is set)
               ├── Codex CLI reasoning (free fallback, via the same
               │    ChatGPT-authenticated Codex session, no MCP tool call —
               │    just reasons over the already-computed JSON)
               └── Plain-text template (last-resort fallback, always works)
```

---

## Features

- 📊 Real-time market data (price, 24h volatility via ATR%) for every asset
  in the portfolio, pulled live from Binance's public API.
- 🛡️ Deterministic Risk Gate: concentration risk, volatility exposure,
  overbought/momentum risk — with a 0–100 score and LOW/MEDIUM/HIGH level.
- 🤖 Conversational AI explanation layer, with free-form follow-up questions.
- 🔗 **Live portfolio import via Binance Agent OS** — reads your *real*
  sub-account and/or main account balances (see limitation below for how
  this is actually wired up).
- ✍️ Manual portfolio entry, always available, requires no authentication at
  all — the reliable fallback path for any user.
- 🌐 Full English UI.
- 🔒 Read-only by design: no trading, no withdrawal capability, anywhere in
  the codebase.

---

## Setup

```bash
git clone <this-repo>
cd binance-guardians
npm install
cp .env.example .env
npm start
```

Open `http://localhost:3000`.

### Optional: enable the AI explanation layer via Anthropic

```env
# .env
ANTHROPIC_API_KEY=sk-ant-...
```

Without this key, Guardians automatically falls back to using your local
Codex CLI session (see below) to generate explanations, and if that's also
unavailable, to a simple text template. The app never breaks because of a
missing key.

---

## Connecting to your Binance account

The **manual entry** path (typing your allocations directly in the UI)
requires nothing — it works immediately for anyone, out of the box.

The **live import** button additionally requires Codex CLI to be installed
and authenticated on the machine running the server (see the limitation
section below for why).

```bash
npm install -g @openai/codex
codex login   # choose "Sign in with ChatGPT" — free, no credit card needed

codex mcp add binance-mcp-server \
  --url https://agent.binance.com/mcp/agentic \
  --oauth-client-id codex
```

This opens a browser window to Binance's "Agentic Account Access" consent
screen. Recommended scopes for this project (principle of least privilege):

- ✅ Read agentic account and market data
- ✅ Read master account data (only if you want the "main account" import
  option to work)
- ❌ Spot & Margin trading — leave OFF
- ❌ Futures trading — leave OFF

Once connected, the "Import live via Agent OS" button in the UI will spawn
Codex CLI in the background to fetch your real balances.

---

## Known limitation: OAuth for custom clients

This is the most important thing to understand about this project, and we
want to be fully transparent about it rather than hide it.

Binance Agent OS's official documentation and launch announcement state that
Agent OS currently supports a specific set of AI clients: **ChatGPT, Claude
Code, Codex, and Cursor**. A fully custom OAuth client (our own Express
backend, registered via a Client ID Metadata Document) consistently hit an
**"The AI Agent you are using is not currently supported"** error at the
Binance consent screen, no matter how the OAuth/CIMD flow was configured on
our end (we verified the metadata document was correctly hosted, valid, and
reachable).

**What we did instead:** rather than fake it or give up on real account data,
we built a working bridge:

1. Codex CLI (an officially whitelisted client) handles the actual OAuth
   authentication with Binance, using the exact same
   `agent.binance.com/mcp/agentic` endpoint our own code also talks to for
   market data.
2. Our backend spawns Codex CLI as a subprocess (`codex exec`, in
   non-interactive JSON mode) to perform the authenticated tool calls
   (`spot.getAccount`, `sub_account.getMainAccountAsset`) on our behalf, and
   parses the real result.
3. Everything else — market data retrieval, the Risk Gate scoring, the AI
   explanation logic, the UI — is entirely our own code, using Agent OS/MCP
   directly and without needing any authentication at all (public market
   data endpoints).

This means: **the live import feature only works on a machine where Codex
CLI is already logged in and connected to Binance** (i.e., the developer's
own machine during the demo). It is **not** a multi-user, production-ready
authentication flow — a real product would need Binance to open OAuth to
custom clients, or would need to build against whatever official path
Binance provides for that in the future.

The **manual entry** path exists specifically so that the core product
(portfolio analysis + risk detection + AI explanation) works for *any* user,
with *zero* dependency on this limitation.

---

## Usage

1. Either:
   - Type your portfolio allocations manually (symbol + % of portfolio,
     must total ~100%), **or**
   - Click **"Import live via Agent OS"** and pick Sub-account / Main
     account / Both (requires the Codex CLI setup above).
2. Click **"Analyze Portfolio"**.
3. Read the Risk Score, the detected risk factors, and the AI's natural
   language explanation.
4. Ask Guardians a free-form follow-up question (e.g. *"Why is my portfolio
   risky?"*).

---

## Security principles

- **Least privilege**: the OAuth scopes requested never include trading or
  withdrawal permissions.
- **Guardians can analyze an account. It cannot move funds.** This is true
  by construction — no code path in this repository calls any
  order-placement, transfer, or withdrawal endpoint.
- The Risk Gate score is 100% deterministic and auditable
  (`server.js: assessRisk()`) — the AI only explains it, never computes it,
  and is explicitly instructed never to invent a number that isn't in the
  data it's given.

---

## Known issues / honesty section

We'd rather list these plainly than have a judge discover them silently:

- **Live import can be intermittent.** `codex exec` latency varies (10s to
  ~1 min), and depending on model reasoning it occasionally fails to
  correctly reach the MCP tool call in one pass. Manual entry is the
  reliable fallback — the demo video shows a pre-verified successful run of
  the live import for transparency.
- **`sub_account.getMainAccountAsset` behavior was reverse-engineered** from
  actual tool output during development (see git history / dev notes) — the
  official documentation for this specific tool's response shape (e.g. the
  `assetInfoList` structure, the `valuation` field) was not fully explicit,
  so parsing logic includes some defensive fallbacks.
- **Tokens without a direct USDT trading pair** (e.g. some obscure assets in
  a "Simple Earn" locked position, prefixed `LD...`) are unwrapped to their
  underlying asset for pricing (`LDBTC` → `BTC`) where possible; assets with
  neither a known valuation nor a resolvable price are shown at 0% rather
  than silently dropped.
- **Live import is single-tenant by design** (see the OAuth limitation
  section above) — it is a proof of concept that real account access via
  Agent OS is achievable today, not a production authentication system.

---

## Tech stack

- **Backend**: Node.js, Express
- **Agent OS / MCP**: `@modelcontextprotocol/sdk`, Codex CLI (`@openai/codex`)
  for the authenticated bridge, public Binance REST API for unauthenticated
  market data
- **AI explanation layer**: Anthropic API (optional) → Codex CLI reasoning
  (free fallback) → plain text (last resort)
- **Frontend**: vanilla HTML/CSS/JS, no framework

---

## Disclaimer

This is a hackathon MVP, not financial or security advice. Binance Guardians
never recommends buying or selling anything, and cannot execute trades or
withdrawals under any circumstance in this codebase.

## 🚀 Future Roadmap & Community Feedback

Following insightful feedback from the community regarding financial risk auditability, the V2 roadmap includes:

- **Immutable Risk Artifacts**: Serializing the full context (holdings snapshot, raw price feeds, ATR lookback, and exact formulas) into a replayable JSON artifact.
- **Resilience Testing & Abstention**: Implementing failure logs for stale/conflicting inputs to ensure the AI assistant clean-abstains rather than hallucinating when data is missing.
- 
## 🏗️ System Architecture

To understand how the Express backend, the portfolio import module, and the AI integration layers (Anthropic / Binance Agent OS) work together, here is the complete architecture diagram of the project:

<p align="center">
  <img width="600" alt="Binance Guardians Architecture Diagram" src="https://github.com" />
</p>

### Key Components:
* **API Orchestration:** Powered by `server.js`, `AnalysisController.js`, and the portfolio importer.
* **Explanation Layer:** The bridge to Anthropic and Binance Agent OS APIs that translates raw risk scores into actionable, human-readable insights.
* **Analysis Engine:** The deterministic framework (`RiskGate.js`) ensuring high-precision calculations for risk metrics like volatility and concentration.
* 
