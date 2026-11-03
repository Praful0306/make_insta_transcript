// Strict rule extraction: translate (if needed) → extract → verify.
// The model may only use what the trader actually said. Every rule carries an exact quote,
// which is checked against the transcript in code, then a second pass re-checks every field.
import { chatJson } from "./_groq.js";

export const CATEGORIES = [
  "setup", "entry", "exit", "stop loss", "target", "risk management", "position sizing",
  "indicator", "market structure", "timeframe", "instrument selection", "time of day",
  "psychology", "discipline", "other",
];
const NS = "Not stated";

/* ---------- translation ---------- */
const TRANSLATE_SYS = `You translate a trader's spoken transcript into English for a trading rulebook.
Rules:
- Translate EVERYTHING, line by line, in the same order. Never summarize, shorten, skip, merge or add anything.
- Keep every [mm:ss] or [h:mm:ss] time marker exactly where it is, at the start of its line.
- Keep all numbers, prices, percentages, ratios, indicator names and settings, timeframes, instrument names (Nifty, Bank Nifty, Sensex, etc.) and trading terms exactly as spoken. If the speaker uses an English trading word inside Hindi/Kannada/etc., keep that word.
- If a word is unclear, translate it as literally as possible and add [unclear] after it. Do not guess meaning.
Return JSON: {"english": "<the full translation, same lines, same markers>"}`;

export async function translate(key, original, language) {
  const { json, usage } = await chatJson(key, TRANSLATE_SYS,
    `Language: ${language || "unknown"}\n\nTRANSCRIPT:\n${original}`, { effort: "low", maxOut: 5000 });
  const english = String(json.english || "").trim();
  if (!english) throw new Error("Translation came back empty.");
  return { english, usage };
}

/* ---------- extraction ---------- */
const EXTRACT_SYS = `You build a trading rulebook from a trader's own words. Programmers will turn each rule into indicator / strategy code, so a single invented, changed or missing detail is a failure.

Extract EVERY rule the trader states in the transcript: setups, entry and exit instructions, stop-loss placement, targets, risk and position-sizing rules, indicator names and settings, timeframes, instruments, time-of-day rules, market-structure definitions, "do / don't" instructions, and psychology or discipline rules. If he says it as an instruction, condition or principle, it is a rule. One distinct instruction = one rule. Do not merge different rules. Do not split one rule into duplicates.

Strict rules:
1. Use ONLY what is said in this transcript. Never add knowledge from outside, never "improve", generalize, soften or complete a rule.
2. Copy numbers, ratios, percentages, prices, indicator names, settings and timeframes exactly as spoken.
3. Any field the trader did not state is exactly "${NS}". Never guess a value.
4. "quote" is a copy-paste of the exact words from the transcript that state the rule (one contiguous span, no edits, no ellipses, no time markers, at most 500 characters).
5. "explanation" explains the rule in detail, step by step, as the trader explained it, including his reasoning and any example he gives, so a programmer understands precisely what to check and when. Only from the transcript.
6. "conditions" lists every check needed for the rule as short, atomic, testable statements, exactly as the trader defines them.
7. Anything a programmer would need but the trader left unclear or unspecified goes into "ambiguities" (e.g. "Which EMA period is not stated"). Never fill the gap yourself.
8. "timestamp" is the [mm:ss] marker at or just before the quote, as "mm:ss", or null if there are no markers.
9. "concept" is the main concept the rule belongs to, named the way the trader names it (e.g. "Opening range breakout", "VWAP", "Support and resistance"). "related" lists other concepts the rule depends on.
10. If the transcript contains no trading rules at all (e.g. only promotion or a story), return an empty list and say why.

Return JSON:
{"rules":[{"title":"short name","category":"one of: ${CATEGORIES.join(", ")}","concept":"","rule":"one sentence, in the trader's terms","explanation":"","conditions":[""],"entry":"","stop_loss":"","target":"","invalidation":"","timeframe":"","instruments":"","indicators":[{"name":"","settings":""}],"ambiguities":[""],"related":[""],"quote":"","timestamp":"mm:ss"}],
 "no_rules_reason":""}`;

export async function extract(key, { trader, title, english }) {
  const user = `Trader: ${trader}\nSource title: ${title || "untitled"}\n\nTRANSCRIPT (English):\n${english}`;
  const { json, usage } = await chatJson(key, EXTRACT_SYS, user, { effort: "medium", maxOut: 7000 });
  const rules = Array.isArray(json.rules) ? json.rules.map(cleanRule).filter(r => r.rule || r.title) : [];
  return { rules, noRulesReason: String(json.no_rules_reason || ""), usage };
}

/* ---------- verification ---------- */
const VERIFY_SYS = `You are a strict auditor of a trading rulebook. You get a transcript and rules that were extracted from it. Check each rule against the transcript, field by field.

For each rule decide:
- "supported": true only if every field (rule, explanation, conditions, entry, stop_loss, target, invalidation, timeframe, instruments, indicators) is directly stated or exactly paraphrased from the transcript, numbers match exactly, nothing is invented or inferred, and "${NS}" is used where the trader said nothing.
- "problems": each mismatch, invention, wrong number or missing detail, quoting what the transcript actually says.
- "fix": an object with ONLY the fields that must change, each with the corrected value taken strictly from the transcript (or "${NS}"). Empty object if nothing must change.

Then list in "missed" any rule the trader states in the transcript that is not covered by the extracted rules, in the same rule format (title, category, concept, rule, explanation, conditions, entry, stop_loss, target, invalidation, timeframe, instruments, indicators, ambiguities, related, quote, timestamp). Quotes must be exact copies from the transcript. Do not repeat rules that are already covered.

Return JSON: {"checks":[{"n":1,"supported":true,"problems":[],"fix":{}}],"missed":[]}`;

export async function verify(key, { english, rules }) {
  const slim = rules.map((r, i) => ({
    n: i + 1, title: r.title, category: r.category, rule: r.rule, explanation: r.explanation, conditions: r.conditions,
    entry: r.entry, stop_loss: r.stop_loss, target: r.target, invalidation: r.invalidation, timeframe: r.timeframe,
    instruments: r.instruments, indicators: r.indicators, quote: r.quote,
  }));
  const user = `TRANSCRIPT (English):\n${english}\n\nEXTRACTED RULES:\n${JSON.stringify(slim)}`;
  const { json, usage } = await chatJson(key, VERIFY_SYS, user, { effort: "medium", maxOut: 6000 });
  const checks = Array.isArray(json.checks) ? json.checks : [];
  const missed = Array.isArray(json.missed) ? json.missed.map(cleanRule).filter(r => r.rule || r.title) : [];
  return { checks, missed, usage };
}

/* ---------- helpers ---------- */
const str = v => (v == null ? "" : typeof v === "string" ? v.trim() : JSON.stringify(v));
const orNS = v => str(v) || NS;
const list = v => (Array.isArray(v) ? v : v ? [v] : []).map(x => (typeof x === "string" ? x.trim() : x)).filter(x => x && x !== NS);

export function cleanRule(r) {
  r = r || {};
  const cat = str(r.category).toLowerCase();
  return {
    title: str(r.title).slice(0, 200),
    category: CATEGORIES.includes(cat) ? cat : "other",
    concept: str(r.concept).slice(0, 120) || "General",
    rule: str(r.rule),
    explanation: str(r.explanation),
    conditions: list(r.conditions).map(str),
    entry: orNS(r.entry), stop_loss: orNS(r.stop_loss), target: orNS(r.target),
    invalidation: orNS(r.invalidation), timeframe: orNS(r.timeframe), instruments: orNS(r.instruments),
    indicators: list(r.indicators).map(x => (typeof x === "string" ? { name: x, settings: NS } : { name: str(x.name), settings: orNS(x.settings) })).filter(x => x.name),
    ambiguities: list(r.ambiguities).map(str),
    related: list(r.related).map(str).filter(Boolean).slice(0, 12),
    quote: str(r.quote),
    timestamp: str(r.timestamp),
  };
}

export const FIX_FIELDS = ["title", "category", "concept", "rule", "explanation", "conditions", "entry", "stop_loss", "target", "invalidation", "timeframe", "instruments", "indicators", "quote"];

export function applyFix(rule, fix) {
  if (!fix || typeof fix !== "object") return { rule, changed: [] };
  const merged = { ...rule };
  const changed = [];
  for (const f of FIX_FIELDS) if (f in fix && fix[f] != null) { merged[f] = fix[f]; changed.push(f); }
  return { rule: cleanRule({ ...merged, related: rule.related, ambiguities: rule.ambiguities, timestamp: rule.timestamp }), changed };
}

// Normalize for quote matching: letters and digits only, any script, lower case, no time markers.
export function norm(s) {
  return String(s || "").replace(/\[\d{1,2}(?::\d{2}){1,2}\]/g, " ").toLowerCase().normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export function quoteFound(quote, text) {
  const q = norm(quote);
  if (q.length < 12) return false;
  return norm(text).includes(q);
}

export function tsToSec(ts) {
  const m = String(ts || "").match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  return m[3] != null ? +m[1] * 3600 + +m[2] * 60 + +m[3] : +m[1] * 60 + +m[2];
}
