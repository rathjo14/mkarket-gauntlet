#!/usr/bin/env node
/**
 * Market Gauntlet — Mid-day Bot
 * Runs via GitHub Actions at 12:30pm ET on weekdays.
 *
 * What it does:
 *   1. Reads pool.json (the full play pool synced from the app)
 *   2. Re-evaluates all active plays via Claude + web search
 *   3. If pool has < 10 plays, generates new ones to fill slots
 *   4. Writes results back: pool.json, run_log.json
 *   5. Commits and pushes so the app can pull on next open
 *
 * Secrets needed in GitHub repo:
 *   ANTHROPIC_API_KEY  — your Anthropic key
 *   GITHUB_TOKEN       — auto-provided, no setup needed
 */

const fs  = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const POOL_FILE    = "pool.json";
const LOG_FILE     = "run_log.json";
const POOL_MAX = 10;
const CRITERIA = {
  accumulation: { minEvals:4, minAvg:7.5, minAdverse:2, minDays:7, minDaysToCatalyst:14, maxIvRank:null },
  options:      { minEvals:3, minAvg:7.5, minAdverse:1, minDays:0, minDaysToCatalyst:21, maxDaysToCatalyst:45, maxIvRank:50 },
  tactical:     { minEvals:2, minAvg:7.0, minAdverse:0, minDays:0, minDaysToCatalyst:0,  maxIvRank:null, needsApproval:true },
};

/* ─── Prompts ─── */
const EVAL_PROMPT = `You are a brutally honest trade monitor. Search for current price and news, then re-evaluate this active watchlist play.

Key questions:
1. Has the catalyst started, happened, or failed?
2. Is the invalidation level close or breached?
3. Did price move AGAINST the thesis today? (mark adverse_day=true)
4. Any new macro/sector news changing the picture?

Output ONLY valid JSON. No markdown, no backticks.

{
  "checked_at": "ISO timestamp",
  "source": "midday_scan",
  "current_price": "current price",
  "price_change_24h": "e.g. '+2.1%' or '-3.4%'",
  "thesis_status": "intact|weakening|broken|strengthened",
  "signal": "hold|add|close|watch",
  "signal_reason": "1-2 honest sentences",
  "summary": "2-3 sentences — specific prices, news, what changed",
  "updated_bear_case": "Anything new that strengthens the bear case?",
  "key_level_to_watch": "Single most important level right now",
  "adverse_day": false,
  "conviction_score": 8,
  "conviction_delta": 0
}`;

const GEN_PROMPT = `You are a sophisticated financial analyst and options strategist. Brutally honest — real money is at risk. Rather output zero plays than mediocre ones.

## FRAMEWORKS
Benjamin Cowen: Log regression rainbow, 4-year halving cycle (April 2024 halving), BTC dominance, NUPL/MVRV risk metrics, ETH/BTC ratio, 200-week MA, DXY inverse. Never chase. Size to risk.
Macro: Fed policy, yield curve, M2 liquidity, CPI/PCE, DXY, VIX, treasury yields, credit spreads.
Options: Buy IV rank <30, spread/sell >70. 30-90 DTE. Never >3% per play. Specific datable catalyst required.

## ROBINHOOD TICKERS
Crypto direct (crypto_spot): BTC, ETH, SOL, DOGE, AVAX, LINK, UNI, AAVE, XRP, ADA, DOT
Crypto proxies (options): IBIT, MSTR, COIN, BITO, MARA, RIOT, CLSK, HUT
Rates/Macro: TLT, GLD, IAU, SLV, USO, XLE, UUP
Broad: SPY, QQQ, IWM, UVXY
AI/Semis: NVDA, AMD, AVGO, ARM, QCOM, MRVL, SMCI, TSM, AMAT, MU
Big Tech: AAPL, MSFT, GOOGL, META, AMZN, NFLX
Software: PLTR, SNOW, DDOG, CRWD, CRM, NOW, ZS
Fintech: V, MA, PYPL, SQ, HOOD
Energy: CVX, XOM, OXY, COP, MRO
Biotech: LLY, NVO, MRNA, ABBV, VRTX
Banks: JPM, BAC, WFC, GS, MS, C, KRE

## SELF-REVIEW (mandatory)
Build thesis → steelman the opposite → score conviction 1-10 after steelman → below 7 = REJECT.
Specific datable catalyst required. "Macro tailwinds" = reject. 3 strong plays > 6 mediocre.

## OUTPUT — VALID JSON ONLY
{
  "market_thesis": "honest 2-3 sentence view",
  "macro_context": "specific data points with numbers",
  "cowen_lens": "BTC cycle position with current price",
  "cycle_phase": "early_bull|mid_bull|late_bull|top|early_bear|mid_bear|late_bear|accumulation",
  "risk_level": "low|moderate|elevated|high|extreme",
  "plays_reviewed": 8,
  "plays": [
    {
      "id": 1,
      "ticker": "BTC",
      "name": "Bitcoin",
      "asset_type": "crypto|equity|etf|macro",
      "play_type": "call|put|call_spread|put_spread|long|short",
      "instrument": "options|spot|futures",
      "strike_guidance": "specific guidance",
      "expiration_guidance": "specific e.g. '45 DTE (June expiry)'",
      "conviction": 8,
      "position_size_pct": "1.5% of portfolio",
      "direction": "bullish|bearish|neutral",
      "thesis": "2-3 sentences on why NOW",
      "play_category": "accumulation|options|tactical",
      "days_to_catalyst": 21,
      "iv_rank_estimate": 35,
      "binary_outcome": "For TACTICAL only: what happens if right vs wrong",
      "catalyst": "SPECIFIC event with date or timeframe",
      "bear_case": "strongest honest argument against",
      "invalidation": "specific price level or event = exit",
      "timeframe": "1-2 weeks|1 month|1 quarter",
      "framework": "Cowen|Macro|Technical|Fundamental|Multi",
      "robinhood_tickers": [
        { "symbol": "IBIT", "type": "options|crypto_spot|etf_spot", "liquidity": "high|medium|low", "note": "why best RH vehicle" }
      ]
    }
  ],
  "key_levels": [
    { "asset": "BTC", "level": "85000", "type": "support|resistance|target", "significance": "why it matters" }
  ],
  "headlines_used": ["headline 1", "headline 2"]
}`;

/* ─── Helpers ─── */
function robustParseJSON(raw) {
  let text = raw.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  const start = text.indexOf("{");
  if (start === -1) throw new Error("No JSON in response");
  text = text.slice(start);
  let depth = 0, end = -1, inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (esc) { esc = false; continue; }
    if (c === "\\" && inStr) { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (!inStr) {
      if (c === "{" || c === "[") depth++;
      else if (c === "}" || c === "]") { depth--; if (depth === 0) { end = i; break; } }
    }
  }
  if (end === -1) {
    depth = 0; inStr = false; esc = false;
    const br = [];
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (esc) { esc = false; continue; }
      if (c === "\\" && inStr) { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (!inStr) {
        if (c === "{") br.push("}");
        else if (c === "[") br.push("]");
        else if (c === "}" || c === "]") br.pop();
      }
    }
    if (inStr) text += '"';
    text = text.replace(/,\s*$/, "") + br.reverse().join("");
  } else { text = text.slice(0, end + 1); }
  text = text.replace(/,(\s*[}\]])/g, "$1").replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
  try { return JSON.parse(text); } catch (_) {}
  try { return JSON.parse(text.replace(/"(?:[^"\\]|\\.)*"/gs, m => m.replace(/\n/g, "\\n").replace(/\r/g, "\\r"))); }
  catch (e) { throw new Error(`Parse failed: ${e.message}`); }
}

function safeStr(v) { return typeof v === "string" ? v : v == null ? "" : String(v); }
function safeNum(v) { return typeof v === "number" ? v : Number(v) || 0; }

async function callClaude(system, userMsg, maxTokens = 3000) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: maxTokens,
      system,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content: userMsg }],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `API error ${res.status}`);
  return data.content.filter(b => b.type === "text").map(b => b.text).join("");
}

function git(cmd) {
  return execSync(`git ${cmd}`, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function configureGit() {
  git('config user.email "github-actions[bot]@users.noreply.github.com"');
  git('config user.name "Market Gauntlet Bot"');
}

function daysAgo(isoDate) {
  return Math.floor((Date.now() - new Date(isoDate).getTime()) / (1000 * 60 * 60 * 24));
}

function calcStats(play) {
  const cat   = play.play_category || "accumulation";
  const crit  = CRITERIA[cat] || CRITERIA.accumulation;
  const evals = play.evaluations || [];
  const scores = evals.map(e => e.conviction_score).filter(Boolean);
  const rollingAvg  = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : play.conviction || 0;
  const latestScore = scores.at(-1) || play.conviction || 0;
  const adverseDays = evals.filter(e => e.adverse_day).length;
  const daysTracked = daysAgo(play.added_to_pool || play.generated_at);
  const latestEval  = evals[evals.length - 1] || {};
  const daysToCatalyst = latestEval.days_to_catalyst ?? play.days_to_catalyst ?? 999;
  const ivRank      = latestEval.iv_rank_current ?? play.iv_rank_estimate ?? null;
  const entryWindow = latestEval.entry_window_status || null;

  let meetsGL = (
    evals.length >= crit.minEvals &&
    rollingAvg  >= crit.minAvg &&
    latestScore >= 7 &&
    adverseDays >= crit.minAdverse &&
    daysTracked >= crit.minDays
  );

  if (cat === "accumulation") {
    meetsGL = meetsGL && daysToCatalyst >= crit.minDaysToCatalyst;
  }
  if (cat === "options") {
    const inWindow = daysToCatalyst >= crit.minDaysToCatalyst && daysToCatalyst <= (crit.maxDaysToCatalyst || 999);
    const ivOk     = ivRank === null || ivRank <= crit.maxIvRank;
    const windowOk = entryWindow === "optimal" || entryWindow === "acceptable";
    meetsGL = meetsGL && inWindow && ivOk && windowOk;
  }
  if (cat === "tactical") {
    meetsGL = meetsGL && play.manually_approved === true;
  }

  return { evals: evals.length, rollingAvg, latestScore, adverseDays, daysTracked, daysToCatalyst, ivRank, meetsGL, crit, cat };
}

/* ─── Main ─── */
async function main() {
  const runStart = new Date().toISOString();
  const log = {
    run_at: runStart,
    trigger: process.env.GITHUB_EVENT_NAME || "schedule",
    evaluations: [],
    new_plays: [],
    slots_before: 0,
    slots_after: 0,
    errors: [],
    status: "ok",
  };

  console.log("╔══════════════════════════════════════╗");
  console.log("║  Market Gauntlet — Mid-day Bot       ║");
  console.log(`║  ${runStart.slice(0, 16).replace("T", " ")} UTC              ║`);
  console.log("╚══════════════════════════════════════╝\n");

  if (!process.env.ANTHROPIC_API_KEY) throw new Error("Missing ANTHROPIC_API_KEY secret");

  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });

  /* ─── Load pool ─── */
  const poolPath = path.join(process.cwd(), POOL_FILE);
  let pool = [];
  if (fs.existsSync(poolPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(poolPath, "utf8"));
      pool = Array.isArray(raw.pool) ? raw.pool : Array.isArray(raw) ? raw : [];
    } catch (e) {
      log.errors.push(`Pool read error: ${e.message}`);
    }
  }

  log.slots_before = pool.length;
  console.log(`Pool: ${pool.length}/${POOL_MAX} slots filled\n`);

  /* ─── Step 1: Archive stale plays (≥7 days, criteria not met) ─── */
  const toArchive = pool.filter(p => {
    if (p.status === "open") return false;
    const stats = calcStats(p);
    const crit  = CRITERIA[p.play_category || "accumulation"] || CRITERIA.accumulation;
    const minDays = crit.minDays || 0;
    // Only auto-archive if play has been tracked long enough and still doesn't meet criteria
    // For accumulation: 7+ days. For options/tactical: 14+ days (give some time, they have no day gate)
    const archiveAfter = minDays > 0 ? minDays : 14;
    return stats.daysTracked >= archiveAfter && !stats.meetsGL;
  });

  if (toArchive.length > 0) {
    const archiveIds = new Set(toArchive.map(p => p.id));
    pool = pool.filter(p => !archiveIds.has(p.id));
    console.log(`Archived ${toArchive.length} stale play(s) that didn't meet criteria after 7+ days`);
    log.evaluations.push(...toArchive.map(p => ({ ticker: p.ticker, action: "archived_stale", reason: "criteria_not_met_after_7d" })));
  }

  /* ─── Step 2: Re-evaluate all active plays ─── */
  const activePlays = pool.filter(p => p.status === "" || p.status === "open");
  console.log(`Evaluating ${activePlays.length} active play(s)...\n`);

  for (const play of activePlays) {
    const evalNum = (play.evaluations || []).length + 1;
    console.log(`  [${evalNum}] ${play.ticker} (${play.play_type} ${play.direction})`);
    try {
      const rh = play.robinhood_tickers?.map(t => t.symbol).join(", ") || play.ticker;
      const stats = calcStats(play);

      const text = await callClaude(EVAL_PROMPT,
        `Today is ${today}. Time: ~12:30pm ET.\n\nPLAY (Eval #${evalNum}):\nTicker: ${play.ticker} (${play.name})\nType: ${play.play_type} — ${play.direction}\nStrike: ${play.strike_guidance} | Expiry: ${play.expiration_guidance}\nTimeframe: ${play.timeframe} | Original conviction: ${play.conviction}/10\nRH vehicles: ${rh}\nDays tracked: ${stats.daysTracked} | Evals so far: ${stats.evals} | Rolling avg: ${stats.rollingAvg.toFixed(1)}\n\nThesis: ${play.thesis}\nCatalyst: ${play.catalyst}\nBear case: ${play.bear_case}\nInvalidation: ${play.invalidation}\n\nSearch current price, 24h news, catalyst progress, invalidation proximity. Be honest. Output ONLY valid JSON.`,
        2000
      );

      const evalResult = robustParseJSON(text);
      evalResult.checked_at = new Date().toISOString();
      evalResult.source = "midday_scan";

      // Append to play's evaluation history
      const idx = pool.findIndex(p => p.id === play.id);
      if (idx !== -1) {
        pool[idx] = {
          ...pool[idx],
          evaluations: [...(pool[idx].evaluations || []), evalResult],
          review: evalResult,
        };
      }

      console.log(`     → ${evalResult.signal?.toUpperCase()} | ${evalResult.thesis_status} | conv: ${evalResult.conviction_score}`);
      log.evaluations.push({
        ticker: play.ticker,
        play_id: play.id,
        action: "evaluated",
        signal: evalResult.signal,
        thesis_status: evalResult.thesis_status,
        conviction_score: evalResult.conviction_score,
        adverse_day: evalResult.adverse_day,
        checked_at: evalResult.checked_at,
      });

    } catch (err) {
      console.error(`     ✗ Failed: ${err.message}`);
      log.errors.push({ ticker: play.ticker, error: err.message });
    }

    // Delay between calls
    if (activePlays.indexOf(play) < activePlays.length - 1) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  /* ─── Step 3: Generate new plays if slots open ─── */
  const slots = POOL_MAX - pool.length;
  console.log(`\nSlots available: ${slots}`);

  if (slots > 0) {
    console.log(`Generating up to ${slots} new play(s)...\n`);
    try {
      const existingTickers = pool.map(p => p.ticker).join(", ");

      const text = await callClaude(GEN_PROMPT,
        `Today is ${today}. Time: ~12:30pm ET.\n\nI need up to ${slots} new high-conviction plays for my watchlist.\nAlready watching: ${existingTickers || "nothing"} — avoid duplicating.\n\nSearch:\n1. BTC/ETH prices and performance\n2. Major crypto news last 48h\n3. SPY/QQQ/IWM/DXY — macro picture\n4. Fed commentary, rate expectations\n5. Recent CPI/PCE/jobs data\n6. Major equity movers — earnings, guidance\n7. Geopolitical/macro events last 48h\n8. Current VIX and credit conditions\n\nRun full self-review. Steelman each play. Reject below 7 conviction. Specific datable catalyst required.\nOutput max ${slots} plays. Output ONLY valid JSON.`,
        8000
      );

      const parsed = robustParseJSON(text);
      const newPlays = (parsed.plays || []).slice(0, slots);
      const sid = `bot_${Date.now()}`;
      const now = new Date().toISOString();

      const normalized = newPlays.map((p, i) => ({
        id: `${sid}_${i + 1}`,
        ticker: safeStr(p.ticker),
        name: safeStr(p.name),
        asset_type: safeStr(p.asset_type),
        play_category: safeStr(p.play_category) || "accumulation",
        days_to_catalyst: typeof p.days_to_catalyst === "number" ? p.days_to_catalyst : null,
        iv_rank_estimate: typeof p.iv_rank_estimate === "number" ? p.iv_rank_estimate : null,
        binary_outcome: safeStr(p.binary_outcome || ""),
        manually_approved: false,
        play_type: safeStr(p.play_type),
        instrument: safeStr(p.instrument),
        strike_guidance: safeStr(p.strike_guidance),
        expiration_guidance: safeStr(p.expiration_guidance),
        conviction: safeNum(p.conviction ?? p.confidence),
        position_size_pct: safeStr(p.position_size_pct),
        direction: safeStr(p.direction),
        thesis: safeStr(p.thesis),
        catalyst: safeStr(p.catalyst),
        bear_case: safeStr(p.bear_case),
        invalidation: safeStr(p.invalidation),
        timeframe: safeStr(p.timeframe),
        framework: safeStr(p.framework),
        robinhood_tickers: Array.isArray(p.robinhood_tickers) ? p.robinhood_tickers.map(t => ({
          symbol: safeStr(t.symbol), type: safeStr(t.type),
          liquidity: safeStr(t.liquidity), note: safeStr(t.note),
        })) : [],
        status: "",
        evaluations: [],
        review: null,
        generated_at: now,
        added_to_pool: now,
        generated_by: "midday_bot",
        session_context: {
          market_thesis: safeStr(parsed.market_thesis),
          cycle_phase: safeStr(parsed.cycle_phase),
          risk_level: safeStr(parsed.risk_level),
        },
      }));

      pool = [...pool, ...normalized];

      normalized.forEach(p => {
        console.log(`  + ${p.ticker} (${p.play_type} ${p.direction}) conviction: ${p.conviction}`);
        log.new_plays.push({ ticker: p.ticker, play_type: p.play_type, direction: p.direction, conviction: p.conviction });
      });

      console.log(`\nAdded ${normalized.length} new play(s)`);

    } catch (err) {
      console.error(`New play generation failed: ${err.message}`);
      log.errors.push({ phase: "generate", error: err.message });
    }
  }

  log.slots_after = pool.length;
  log.status = log.errors.length > 0 ? "partial" : "ok";

  /* ─── Step 4: Write files ─── */
  const poolOut = { pool, last_updated: new Date().toISOString() };
  fs.writeFileSync(poolPath, JSON.stringify(poolOut, null, 2));
  console.log(`\n✓ Wrote ${POOL_FILE}`);

  // Append to run log (keep last 30 runs)
  const logPath = path.join(process.cwd(), LOG_FILE);
  let runHistory = [];
  if (fs.existsSync(logPath)) {
    try { runHistory = JSON.parse(fs.readFileSync(logPath, "utf8")).runs || []; } catch (_) {}
  }
  runHistory = [log, ...runHistory].slice(0, 30);
  fs.writeFileSync(logPath, JSON.stringify({ runs: runHistory, last_run: runStart }, null, 2));
  console.log(`✓ Wrote ${LOG_FILE}`);

  /* ─── Step 5: Commit and push ─── */
  configureGit();
  git(`add ${POOL_FILE} ${LOG_FILE}`);
  try {
    git(`commit -m "bot: mid-day scan ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC — ${activePlays.length} evals, ${log.new_plays.length} new plays"`);
    git("push");
    console.log("✓ Committed and pushed\n");
  } catch (e) {
    if (e.message?.includes("nothing to commit")) {
      console.log("No file changes to commit\n");
    } else throw e;
  }

  /* ─── Summary ─── */
  console.log("╔══════════════════════════════════════╗");
  console.log("║  RUN SUMMARY                         ║");
  console.log(`║  Evaluated:  ${String(activePlays.length).padEnd(25)}║`);
  console.log(`║  New plays:  ${String(log.new_plays.length).padEnd(25)}║`);
  console.log(`║  Pool:       ${String(`${log.slots_before} → ${log.slots_after}/${POOL_MAX}`).padEnd(25)}║`);
  console.log(`║  Errors:     ${String(log.errors.length).padEnd(25)}║`);
  console.log(`║  Status:     ${String(log.status.toUpperCase()).padEnd(25)}║`);
  console.log("╚══════════════════════════════════════╝");
}

main().catch(err => {
  console.error("\n✗ FATAL:", err.message);
  process.exit(1);
});
