import { Rain } from "@buidlrrr/rain-sdk";
import { Router } from "express";
import { createPublicClient, createWalletClient, decodeEventLog, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";

/** Emitted by Rain factory when a pool is created (same as @buidlrrr/rain-sdk CreateMarketAbi). */
const POOL_CREATED_EVENT_ABI = [
  {
    type: "event",
    name: "PoolCreated",
    inputs: [
      { name: "poolAddress", type: "address", indexed: true },
      { name: "poolCreator", type: "address", indexed: true },
      { name: "uri", type: "string", indexed: false },
    ],
  },
];

const DEFAULT_RAIN_ENV = "production";

const BASE_TOKEN_BY_ENV = {
  production: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
  stage: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
  development: "0xCa4f77A38d8552Dd1D5E44e890173921B67725F4",
};

const POOL_CONTRACT_ADDR_RE = /^0x[a-fA-F0-9]{40}$/;

const router = Router();

function normalizeMarketTitle(s) {
  return String(s || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function poolAddressFromReceipt(receipt) {
  if (!receipt?.logs?.length) return null;
  const matches = [];
  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({
        abi: POOL_CREATED_EVENT_ABI,
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName === "PoolCreated" && decoded.args?.poolAddress) {
        matches.push(String(decoded.args.poolAddress));
      }
    } catch {
      /* not PoolCreated */
    }
  }
  if (matches.length === 0) return null;
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one PoolCreated event, found ${matches.length}. Ambiguous receipt.`,
    );
  }
  return matches[0];
}

async function resolveMarketIdViaTxHash(rain, rpcUrl, txHash) {
  const hash = String(txHash || "").trim();
  if (!hash.startsWith("0x")) return { marketId: "", contractAddress: "" };

  const client = createPublicClient({
    chain: arbitrum,
    transport: http(rpcUrl),
  });
  const receipt = await client.getTransactionReceipt({ hash });
  const poolAddr = poolAddressFromReceipt(receipt);
  if (!poolAddr) return { marketId: "", contractAddress: "" };

  const attempts = 12;
  const delayMs = 2500;
  for (let i = 0; i < attempts; i++) {
    try {
      const id = await rain.getMarketId(poolAddr);
      if (id) return { marketId: String(id), contractAddress: poolAddr };
    } catch (e) {
      console.warn(`sync: getMarketId retry ${i + 1}/${attempts}:`, e?.message || e);
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return { marketId: "", contractAddress: poolAddr };
}

function looksLikePoolContractAddress(s) {
  return POOL_CONTRACT_ADDR_RE.test(String(s || "").trim());
}

/** Pool contract address → Rain canonical market id. */
async function canonicalRainMarketId(raw) {
  const key = String(raw || "").trim();
  if (!key || !looksLikePoolContractAddress(key)) return key;
  const env = process.env.RAIN_ENVIRONMENT || DEFAULT_RAIN_ENV;
  const rpcUrl = process.env.ARBITRUM_RPC_URL || "https://arb1.arbitrum.io/rpc";
  try {
    const rain = new Rain({ environment: env, rpcUrl });
    const id = await rain.getMarketId(key);
    return id ? String(id).trim() : key;
  } catch (e) {
    console.warn("canonicalRainMarketId:", e?.message || e);
    return key;
  }
}

function equalBarValues(n) {
  const out = [];
  let acc = 0;
  for (let i = 0; i < n; i++) {
    if (i === n - 1) {
      out.push(Number((100 - acc).toFixed(2)));
    } else {
      const v = Number((100 / n).toFixed(2));
      out.push(v);
      acc += v;
    }
  }
  return out;
}

function normalizePrivateKey(key) {
  if (!key) return null;
  const t = key.trim();
  return t.startsWith("0x") ? t : `0x${t}`;
}

function normalizeTagList(tags) {
  const tagList = (Array.isArray(tags) ? tags : String(tags || "").split(","))
    .map((t) => String(t).trim().toLowerCase())
    .filter(Boolean);
  while (tagList.length < 1) tagList.push("general");
  if (tagList.length > 3) tagList.splice(3);
  return tagList;
}

function publicPoolId(pool) {
  if (pool == null || typeof pool !== "object") return "";
  const p = pool;
  const v = p.id ?? p._id ?? p.poolId ?? p.marketId;
  if (v == null) return "";
  return String(v).trim();
}

/**
 * Resolve new market id + contract from tx hash / public list (no database).
 */
async function resolveMarketFromRainOnly({
  rain,
  question,
  contractAddressHint,
  lastHash,
  rpcUrl,
}) {
  let marketId = "";
  let contractAddress = String(contractAddressHint || "").trim();

  if (lastHash && rpcUrl) {
    const viaTx = await resolveMarketIdViaTxHash(rain, rpcUrl, lastHash);
    marketId = viaTx.marketId;
    contractAddress = contractAddress || viaTx.contractAddress;
  }

  if (!marketId) {
    await new Promise((r) => setTimeout(r, 2500));
    const listed = await rain.getPublicMarkets({ limit: 100, sortBy: "latest" });
    const qNorm = normalizeMarketTitle(question);
    const found =
      listed.find((m) => normalizeMarketTitle(m.title) === qNorm) ||
      (contractAddress
        ? listed.find(
            (m) =>
              m.contractAddress &&
              String(m.contractAddress).toLowerCase() === contractAddress.toLowerCase(),
          )
        : null);

    if (found?.id) {
      marketId = String(found.id);
      contractAddress = found.contractAddress || contractAddress;
    }
  }

  return { marketId, contractAddress };
}

function barValuesFromSdkOptions(options) {
  const n = options.length;
  if (!n) return [];
  const pcts = options.map((o) =>
    Math.min(100, Math.max(0, Math.round((Number(o.currentPrice) / 1e18) * 100))),
  );
  const sum = pcts.reduce((a, b) => a + b, 0);
  if (sum <= 0) {
    return options.map((_, i) =>
      i === n - 1 ? 100 - Math.floor(100 / n) * (n - 1) : Math.floor(100 / n),
    );
  }
  const scaled = pcts.map((p) => Math.round((p / sum) * 100));
  const drift = 100 - scaled.reduce((a, b) => a + b, 0);
  if (drift !== 0 && scaled.length > 0) {
    scaled[scaled.length - 1] += drift;
  }
  return scaled;
}

function sdkStatusToRowStatus(s) {
  const t = String(s || "");
  if (t === "Closed") return "resolved";
  if (t === "Live" || t === "New" || t === "Trading") return "active";
  return "pending";
}

async function marketDetailsToBackendRow(rain, marketId) {
  const d = await rain.getMarketDetails(marketId);
  if (!d?.id) return null;
  const opts = Array.isArray(d.options)
    ? d.options.map((o) =>
        o && typeof o === "object" && "optionName" in o ? o.optionName : String(o),
      )
    : [];
  const barVals =
    Array.isArray(d.options) && d.options.length ? barValuesFromSdkOptions(d.options) : [];
  return {
    market_id: String(d.id),
    question: d.title || d.marketQuestion || "",
    description: String(d.marketDescription || d.description || ""),
    options: opts,
    tags: [],
    status: sdkStatusToRowStatus(d.status),
    contract_address: d.contractAddress || null,
    liquidity_usdt: 0,
    duration_days: 30,
    country: "Global",
    bar_values: barVals.length ? JSON.stringify(barVals) : null,
  };
}

function parseGeminiJsonObject(text) {
  let s = String(text).trim();
  if (s.startsWith("```")) {
    s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "");
  }
  try {
    return JSON.parse(s);
  } catch {
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(s.slice(start, end + 1));
    }
    const err = new Error("AI returned text that is not valid JSON");
    err.statusCode = 422;
    throw err;
  }
}

function coerceAiOptions(body) {
  const raw =
    body?.options ?? body?.outcomes ?? body?.choices ?? body?.marketOptions ?? body?.answers;
  let list = [];
  if (Array.isArray(raw)) {
    list = raw.map((x) => String(x).trim()).filter(Boolean);
  } else if (typeof raw === "string") {
    const lines = raw
      .split(/\r?\n/)
      .map((line) =>
        line
          .replace(/^\s*[-*]\s*/, "")
          .replace(/^\d+[\).\s]+/, "")
          .trim(),
      )
      .filter(Boolean);
    if (lines.length > 1) {
      list = lines;
    } else {
      const bySemi = raw
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean);
      list =
        bySemi.length > 1
          ? bySemi
          : raw
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
    }
  } else if (raw && typeof raw === "object") {
    list = Object.values(raw)
      .flatMap((v) => (Array.isArray(v) ? v : [v]))
      .map((x) => String(x).trim())
      .filter(Boolean);
  }
  const seen = new Set();
  const unique = [];
  for (const o of list) {
    const k = o.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      unique.push(o);
    }
  }
  return unique;
}

function ensureAtLeastThreeOptions(options, question) {
  const out = [...options];
  const PAD = ["Unclassified", "Uncertain", "Other", "None of the above"];
  const lower = new Set(out.map((o) => o.toLowerCase()));
  for (const p of PAD) {
    if (out.length >= 3) break;
    if (!lower.has(p.toLowerCase())) {
      out.push(p);
      lower.add(p.toLowerCase());
    }
  }
  if (out.length >= 3) return out.slice(0, 8);
  if (out.length === 0 && question) {
    return ["Yes", "No", "Unclassified"];
  }
  while (out.length < 3) {
    out.push(`Outcome ${out.length + 1}`);
  }
  return out.slice(0, 8);
}

async function callGeminiForMarketDraft(country, topic) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey?.trim()) {
    const err = new Error("GEMINI_API_KEY is not set");
    err.statusCode = 503;
    throw err;
  }
  /** @see https://ai.google.dev/gemini-api/docs/models — avoid deprecated preview IDs in production */
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const now = new Date();
  const todayUtc = now.toISOString().slice(0, 10);
  const year = now.getUTCFullYear();

  const prompt = `You design **production-quality** prediction markets for **Rain** (rain.one style: clear headline, hard deadline, publicly verifiable facts — suitable for an AI oracle and traders on /pred).

## Today (UTC)
**${todayUtc}** — calendar year **${year}**. Do not use outcomes already known to be decided before this date.

## User constraints (NON-NEGOTIABLE)
You MUST anchor the entire market to BOTH:
- **Country / region:** ${country}
- **Topic:** ${topic}

**Geography lock:** The event, entity, or jurisdiction in the question must be **about "${country}"** (its government, elections, national teams/leagues where "${country}" is the primary locus, domestic policy, domestic companies as specified, etc.). Do not substitute a different country unless "${country}" is genuinely global (e.g. "World" / "Global") — then say so explicitly in the question.
**Topic lock:** The scenario must be a **single, concrete** storyline under "${topic}" — not a generic essay topic. If "${topic}" is broad, pick **one** specific upcoming catalyst (match, vote, release, policy decision, ranking, award, milestone) that a reader would recognize.

**Language:** Write \`question\`, \`description\`, and \`options\` (except the literal label "Unclassified") in the **same language** as the user's \`Country / region\` and \`Topic\` inputs when those inputs are not English; if they are English, use English.

## Style = Rain /pred quality (match this bar)
- **Title-like question:** Short, scannable, often starts with **Will / Which / Who** when natural. Include a **clear cutoff**: by date, "before end of ${year}", "during [named competition + year]", "by Q3 ${year}", first round of [named election], etc.
- **Measurable or observable:** Outcomes must be decidable from **public** information (official sites, federations, regulators, certified results, major wires for uncontested facts). Think: prices crossing a threshold, team winning a named stage, bill passing, candidate placing, metric published — not vibes.
- **Multi-outcome:** Besides **Unclassified**, use **3–7** substantive, **mutually exclusive** outcomes for **one** defined event (e.g. which party wins, which team advances, which bucket a published number falls into). Avoid overlapping labels.
- **Oracle-friendly:** Description should name **what evidence** settles each outcome (e.g. "Per official league table after the final whistle", "per national electoral commission certified results").

## Self-check before you output JSON
1. Could a stranger see only \`question\` and know it is about **"${country}"** AND **"${topic}"**? If not, rewrite.
2. Is the cutoff time realistic and still **open** after ${todayUtc}?
3. Is every non-Unclassified outcome clearly distinguishable?

## Do NOT
- Generic "future of X" without a named event and deadline.
- **USA-default** or random country when the user said **"${country}"**.
- Fictional dates; if exact day unknown, bind to a **named** round, season, month window, or official schedule.

## Output (single JSON object only, no markdown)
- "question": string
- "description": string — 3–5 sentences: resolution rules, sources, edge cases; state that **"Unclassified"** wins only when no listed outcome clearly applies.
- "options": array of 3–8 strings; **exactly one** must be **"Unclassified"** (exact ASCII); other labels short and distinct.
- "tags": 1–3 lowercase tags tying **"${country}"** + **"${topic}"** (ascii or romanization OK).
- "durationDays": integer 14–90 (end **after** expected resolution).
- "liquidityUsdt": integer 10–500 — **default 10** (Rain on-chain minimum); use a higher number only when the topic clearly needs deeper initial liquidity.

Validate JSON and exactly one "Unclassified".`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey.trim())}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.42,
        responseMimeType: "application/json",
      },
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    const err = new Error(`Gemini request failed: ${res.status} ${t}`);
    err.statusCode = 502;
    throw err;
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text || typeof text !== "string") {
    const err = new Error("Gemini returned an empty response");
    err.statusCode = 502;
    throw err;
  }
  return parseGeminiJsonObject(text);
}

function normalizeAiDraft(body, country, topic) {
  const question = String(body?.question || "").trim();
  const description = String(body?.description || "").trim() || question;
  let options = coerceAiOptions(body);
  options = ensureAtLeastThreeOptions(options, question);
  if (options.length < 3) {
    const err = new Error("AI draft must include at least 3 options");
    err.statusCode = 422;
    throw err;
  }
  const hasUnclassified = options.some((o) => o.trim().toLowerCase() === "unclassified");
  if (!hasUnclassified) {
    if (options.length < 8) options.push("Unclassified");
    else options[options.length - 1] = "Unclassified";
  }
  if (options.length > 8) options = options.slice(0, 8);
  const tags = normalizeTagList(body?.tags);
  let durationDays = parseInt(String(body?.durationDays ?? 30), 10);
  if (Number.isNaN(durationDays)) durationDays = 30;
  durationDays = Math.min(90, Math.max(7, durationDays));
  let liquidityUsdt = Number(body?.liquidityUsdt);
  if (Number.isNaN(liquidityUsdt)) liquidityUsdt = 10;
  liquidityUsdt = Math.min(500, Math.max(10, liquidityUsdt));
  return {
    question,
    description,
    options,
    tags,
    durationDays,
    liquidityUsdt,
    country: String(country || "Global").trim() || "Global",
    topic: String(topic || "").trim(),
  };
}

router.post("/generate-site-logo", async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey?.trim()) {
    return res.status(503).json({ error: "GEMINI_API_KEY is not set" });
  }
  const { description, primaryColor, siteName: _siteName, country, topic } = req.body;
  const brief =
    String(description || "").trim() ||
    [country, topic]
      .map((x) => String(x || "").trim())
      .filter(Boolean)
      .join(" — ");
  if (!brief || brief.length < 8) {
    return res.status(400).json({ error: "description is required (at least 8 characters)" });
  }
  /** Image generation: use preview image model (2.5 flash image IDs were deprecated/shut down on some dates). */
  const model = process.env.GEMINI_LOGO_MODEL || "gemini-2.0-flash-preview-image-generation";
  const col = String(primaryColor || "#8B5CF6").trim();

  const prompt = `Design a flat logo mark for a prediction-markets product.

CREATIVE BRIEF — follow this closely; it is the main source of imagery and symbolism:
${brief}

TECHNICAL:
- Flat design only — no gradients, shadows, glows, 3D, textures
- Colors: ONLY ${col} and white
- Background must be fully transparent (alpha background), no solid white card/canvas
- Legible at 32px; prefer a clear symbol or monogram. Include lettering only if the brief explicitly asks for words or a name.
- Style reference: Stripe, Linear, Vercel — not clip-art

OUTPUT: one logo with transparent background. Do not invent a site title or slogan unless the brief asks for specific text.`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey.trim())}`;
  try {
    const gres = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseModalities: ["TEXT", "IMAGE"],
          imageConfig: { aspectRatio: "1:1" },
        },
      }),
    });
    const data = await gres.json();
    if (!gres.ok) {
      console.error("generate-site-logo Gemini error:", data);
      return res.status(502).json({ error: data?.error?.message || "Gemini image request failed" });
    }
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const inlineOf = (p) => p?.inlineData || p?.inline_data;
    const imagePart = parts.find((p) => {
      const id = inlineOf(p);
      const mt = id?.mimeType || id?.mime_type || "";
      return typeof mt === "string" && mt.startsWith("image/");
    });
    const inline = imagePart ? inlineOf(imagePart) : null;
    const dataBase64 = inline?.data;
    if (!dataBase64) {
      const textPart = parts.find((p) => p.text);
      return res.status(422).json({
        error: "Model returned no image",
        detail: textPart?.text || null,
      });
    }
    res.json({
      mimeType: inline.mimeType || inline.mime_type || "image/png",
      dataBase64,
    });
  } catch (e) {
    console.error("generate-site-logo failed:", e);
    res.status(500).json({ error: e?.message || "generate-site-logo failed" });
  }
});

router.post("/ai-draft", async (req, res) => {
  const { country, topic } = req.body;
  if (!country || !topic) {
    return res.status(400).json({ error: "country and topic are required" });
  }
  try {
    const raw = await callGeminiForMarketDraft(String(country).trim(), String(topic).trim());
    const draft = normalizeAiDraft(raw, country, topic);
    if (!draft.question) {
      return res.status(422).json({ error: "AI did not return a valid question" });
    }
    res.json(draft);
  } catch (e) {
    const code = e?.statusCode || 500;
    console.error("ai-draft failed:", e);
    res.status(code).json({ error: e?.message || "ai-draft failed" });
  }
});

router.post("/sync-after-create", async (req, res) => {
  const {
    question,
    description: _description,
    options,
    tags: _tags = [],
    durationDays: _durationDays = 30,
    liquidityUsdt: _liquidityUsdt = 10,
    country: _country = "Global",
    transactionHash = "",
    contractAddress: contractAddressHint,
    runId: runIdBody,
    creator_wallet: _creatorWalletBody,
  } = req.body;

  const runId = runIdBody || `srv-${Date.now()}`;
  console.log("[rain-market:createMarket] sync-after-create:start", {
    runId,
    transactionHash: String(transactionHash || ""),
    questionLen: String(question || "").length,
    optionsCount: Array.isArray(options) ? options.length : 0,
  });

  if (!question || !Array.isArray(options) || options.length < 3) {
    return res.status(400).json({
      error: "question and at least 3 options are required",
    });
  }

  const env = process.env.RAIN_ENVIRONMENT || DEFAULT_RAIN_ENV;
  const rpcUrl = process.env.ARBITRUM_RPC_URL || "https://arb1.arbitrum.io/rpc";
  const rain = new Rain({ environment: env, rpcUrl });

  const t0 = Date.now();
  try {
    const { marketId, contractAddress } = await resolveMarketFromRainOnly({
      rain,
      question,
      contractAddressHint,
      lastHash: String(transactionHash || ""),
      rpcUrl,
    });

    const ms = Date.now() - t0;
    console.log("[rain-market:createMarket] sync-after-create:done", {
      runId,
      ms,
      marketId: marketId || null,
      hasContractAddress: Boolean(contractAddress),
    });

    res.json({
      marketId,
      contractAddress,
      transactionHash: transactionHash || null,
      synced: Boolean(marketId),
      note: marketId
        ? "Rain market id resolved (no site database)"
        : "Could not resolve market id yet; try sync again shortly",
    });
  } catch (e) {
    console.error("[rain-market:createMarket] sync-after-create failed", {
      runId,
      transactionHash: String(transactionHash || ""),
      error: e,
    });
    res.status(500).json({ error: e?.message || "sync-after-create failed" });
  }
});

router.post("/create-on-chain", async (req, res) => {
  const pk = normalizePrivateKey(process.env.RAIN_WALLET_PRIVATE_KEY);
  if (!pk) {
    return res.status(500).json({ error: "RAIN_WALLET_PRIVATE_KEY not set" });
  }

  const env = process.env.RAIN_ENVIRONMENT || DEFAULT_RAIN_ENV;
  const rpcUrl = process.env.ARBITRUM_RPC_URL || "https://arb1.arbitrum.io/rpc";
  const baseToken = BASE_TOKEN_BY_ENV[env] || BASE_TOKEN_BY_ENV[DEFAULT_RAIN_ENV];

  const {
    question,
    description,
    options,
    tags = [],
    durationDays = 30,
    liquidityUsdt = 10,
    country = "Global",
    isPublic = true,
    isPublicPoolResolverAi = true,
  } = req.body;

  if (!question || !Array.isArray(options) || options.length < 3) {
    return res.status(400).json({
      error: "question and at least 3 options are required (Rain SDK v2 constraint)",
    });
  }

  const tagList = normalizeTagList(tags);

  const desc = (description && String(description).trim()) || question;
  const liquidity = Math.max(Number(liquidityUsdt) || 0, 10);
  const inputAmountWei = BigInt(Math.floor(liquidity * 1_000_000));

  try {
    const account = privateKeyToAccount(pk);
    const rain = new Rain({ environment: env, rpcUrl });
    const now = Math.floor(Date.now() / 1000);
    const end = now + Number(durationDays) * 86400;
    const barValues = equalBarValues(options.length);

    const txs = await rain.buildCreateMarketTx({
      marketQuestion: question,
      marketOptions: options,
      marketTags: tagList,
      marketDescription: desc,
      isPublic,
      isPublicPoolResolverAi,
      creator: account.address,
      startTime: BigInt(now),
      endTime: BigInt(end),
      no_of_options: BigInt(options.length),
      inputAmountWei,
      barValues,
      baseToken,
      tokenDecimals: 6,
    });

    const walletClient = createWalletClient({
      account,
      chain: arbitrum,
      transport: http(rpcUrl),
    });
    const publicClient = createPublicClient({
      chain: arbitrum,
      transport: http(rpcUrl),
    });

    let lastHash = "";
    for (const tx of txs) {
      const hash = await walletClient.sendTransaction({
        to: tx.to,
        data: tx.data,
        value: tx.value ?? 0n,
      });
      lastHash = hash;
      await publicClient.waitForTransactionReceipt({ hash });
    }

    const { marketId, contractAddress } = await resolveMarketFromRainOnly({
      rain,
      question,
      contractAddressHint: "",
      lastHash,
      rpcUrl,
    });

    res.json({
      marketId,
      contractAddress,
      transactionHash: lastHash,
      note: marketId
        ? "Rain market id resolved (no site database)"
        : "Transactions confirmed; refresh markets shortly if ID missing",
    });
  } catch (e) {
    console.error("create-on-chain failed:", e);
    res.status(500).json({ error: e?.message || "create-on-chain failed" });
  }
});

router.get("/", async (req, res) => {
  res.json([]);
});

router.get("/opened-by/:wallet", async (req, res) => {
  const w = String(req.params.wallet || "")
    .trim()
    .toLowerCase();
  if (!w.startsWith("0x") || w.length < 10) {
    return res.status(400).json({ error: "invalid wallet" });
  }
  const limit = Math.min(parseInt(String(req.query.limit || "100"), 10) || 100, 500);
  const env = process.env.RAIN_ENVIRONMENT || DEFAULT_RAIN_ENV;
  const rpcUrl = process.env.ARBITRUM_RPC_URL || "https://arb1.arbitrum.io/rpc";
  try {
    const rain = new Rain({ environment: env, rpcUrl });
    const pools = await rain.getPublicMarkets({
      creator: w,
      limit: Math.min(limit, 100),
      sortBy: "latest",
    });
    const rows = [];
    for (const pool of pools) {
      const pid = publicPoolId(pool);
      if (!pid) continue;
      try {
        const row = await marketDetailsToBackendRow(rain, pid);
        if (row) rows.push({ ...row, creator_wallet: w });
      } catch {
        const p = pool;
        rows.push({
          market_id: pid,
          question: String(p.title || p.marketQuestion || `Market ${pid}`),
          description: String(p.description || ""),
          options: [],
          tags: [],
          status: "active",
          contract_address: p.contractAddress || null,
          creator_wallet: w,
          liquidity_usdt: 0,
          duration_days: 30,
          country: "Global",
        });
      }
    }
    res.json(rows);
  } catch (e) {
    console.error("opened-by failed:", e);
    res.status(500).json({ error: e?.message || "opened-by failed" });
  }
});

router.get("/:marketId", async (req, res) => {
  let key = req.params.marketId;
  const env = process.env.RAIN_ENVIRONMENT || DEFAULT_RAIN_ENV;
  const rpcUrl = process.env.ARBITRUM_RPC_URL || "https://arb1.arbitrum.io/rpc";
  const rain = new Rain({ environment: env, rpcUrl });

  let canonical = key;
  if (looksLikePoolContractAddress(key)) {
    canonical = await canonicalRainMarketId(key);
  }

  try {
    const row = await marketDetailsToBackendRow(rain, canonical);
    if (row) return res.json(row);
  } catch {
    /* fall through */
  }

  if (canonical !== key) {
    try {
      const row = await marketDetailsToBackendRow(rain, key);
      if (row) return res.json(row);
    } catch {
      /* 404 */
    }
  }

  return res.status(404).json({ error: "Not found" });
});

router.post("/", async (req, res) => {
  const {
    market_id,
    workflow_id: _workflow_id,
    question,
    description = "",
    options = [],
    tags = [],
    market_type: _market_type = "binary",
    country = "Global",
    liquidity_usdt = 0,
    duration_days = 30,
    contract_address,
    transaction_hash,
    image_url: _image_url,
    creator_wallet,
    bar_values,
    status = "active",
  } = req.body;

  if (!market_id || !question) {
    return res.status(400).json({ error: "market_id and question required" });
  }

  const mid = await canonicalRainMarketId(String(market_id).trim());
  const creatorW = creator_wallet ? String(creator_wallet).trim().toLowerCase() : null;
  const barValuesJson = JSON.stringify(Array.isArray(bar_values) ? bar_values : []);

  res.status(201).json({
    market_id: mid,
    workflow_id: null,
    question,
    description,
    options: JSON.stringify(options),
    tags: JSON.stringify(tags),
    market_type: "binary",
    country,
    liquidity_usdt,
    duration_days,
    contract_address: contract_address || null,
    transaction_hash: transaction_hash || null,
    image_url: null,
    bar_values: barValuesJson,
    creator_wallet: creatorW,
    status,
    note: "SDK-only mode: not persisted to PostgreSQL",
  });
});

router.put("/:marketId/status", async (req, res) => {
  const { status } = req.body;
  if (!status) return res.status(400).json({ error: "status required" });

  res.json({
    market_id: req.params.marketId,
    status,
    note: "SDK-only mode: status not persisted",
  });
});

export default router;
