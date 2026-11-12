import { splitSentences, type Summary } from "./summarize.js";

export interface Finding {
  reason: string;
  detail: string;
}

export interface VerifyOptions {
  /** Text the output may draw facts from: the source plus host-supplied text. */
  trusted: string[];
  requireContext: boolean;
  /** Longest allowed copied run is runWords - 1. Default 8. */
  runWords?: number;
  /** The one allowed quote may hold this many words. Default 30. */
  maxQuoteWords?: number;
}

const MONTHS = "january february march april may june july august september october november december jan feb mar apr jun jul aug sep sept oct nov dec".split(" ");
const DAYS = "monday tuesday wednesday thursday friday saturday sunday".split(" ");
const COMMON_START = new Set("the a an this that these those it its they their there here what why how when where who our your we you he she his her if in on at for to from as by with after before until while but and or so new more most some many all each every no not one two three four five six seven eight nine ten according reports report says said".split(" "));
const AMOUNT = /(?:[$€£¥]|\b(?:usd|cad|eur|gbp|aud)\s?)\d+(?:,\d{3})*(?:\.\d+)?(?:\s?(?:million|billion|thousand|bn|m|k)\b)?/gi;
const NUMBER = /\d+(?:,\d{3})*(?:\.\d+)?/g;
const MONTH_DAY = new RegExp(`\\b(?:${MONTHS.join("|")})\\.?\\s+\\d{1,2}\\b|\\b\\d{1,2}\\s+(?:${MONTHS.join("|")})\\b`, "gi");

function norm(text: string): string {
  return text.toLowerCase().replace(/(\d),(?=\d{3})/g, "$1").replace(/\s+/g, " ");
}

function hasWord(haystack: string, word: string, flags: string): boolean {
  return new RegExp(`(^|[^\\p{L}\\p{N}])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}\\p{N}])`, flags).test(haystack);
}

/** Numbers, amounts, dates and names in text that the trusted text does not hold. */
export function checkFacts(text: string, trusted: string[]): Finding[] {
  const found: Finding[] = [];
  const raw = trusted.join("\n");
  const hay = norm(raw);
  const add = (reason: string, detail: string) => {
    if (!found.some((f) => f.detail === detail)) found.push({ reason, detail });
  };
  for (const m of text.match(AMOUNT) ?? []) if (!hay.includes(norm(m))) add("unsupported_amount", m);
  for (const m of text.match(MONTH_DAY) ?? []) if (!hay.includes(norm(m))) add("unsupported_date", m);
  for (const m of text.match(NUMBER) ?? []) if (!hasWord(hay, norm(m), "u")) add("unsupported_number", m);
  for (const sentence of splitSentences(text)) {
    const tokens = sentence.match(/[\p{L}][\p{L}'’-]*/gu) ?? [];
    tokens.forEach((token, i) => {
      const lower = token.toLowerCase();
      if (!/^\p{Lu}/u.test(token)) return;
      if (MONTHS.includes(lower) || DAYS.includes(lower)) {
        if (!hasWord(hay, lower, "u")) add("unsupported_date", token);
        return;
      }
      const first = i === 0 || sentence.trimStart().startsWith(`"${token}`);
      if (first && COMMON_START.has(lower)) return;
      if (!hasWord(first ? hay : raw, first ? lower : token, "u")) add("unsupported_name", token);
    });
  }
  return found;
}

function tokens(text: string): string[] {
  return norm(text).match(/[\p{L}\p{N}$%€£]+(?:['’.][\p{L}\p{N}]+)*/gu) ?? [];
}

/** Runs of runWords or more words copied from the source, outside the one allowed quote. */
export function checkCopy(fields: string[], source: string, runWords = 8, maxQuoteWords = 30): Finding[] {
  const found: Finding[] = [];
  const grams = new Set<string>();
  const src = tokens(source);
  for (let i = 0; i + runWords <= src.length; i++) grams.add(src.slice(i, i + runWords).join(" "));
  let quotes = 0;
  for (const field of fields) {
    const outside = field.replace(/["“]([^"”]*)["”]/g, (_, inner: string) => {
      quotes++;
      if (quotes > 1) found.push({ reason: "too_many_quotes", detail: inner });
      else if (tokens(inner).length > maxQuoteWords) found.push({ reason: "quote_too_long", detail: `${tokens(inner).length} words` });
      return " \u0000 ";
    });
    for (const part of outside.split("\u0000")) {
      const t = tokens(part);
      for (let i = 0; i + runWords <= t.length; i++) {
        if (!grams.has(t.slice(i, i + runWords).join(" "))) continue;
        let end = i + runWords;
        while (end < t.length && grams.has(t.slice(end - runWords + 1, end + 1).join(" "))) end++;
        found.push({ reason: "copied_run", detail: t.slice(i, end).join(" ") });
        i = end - 1;
      }
    }
  }
  return found;
}

/** Share of the content words in text that are not in the source. */
export function novelty(text: string, source: string): number {
  const src = new Set(tokens(source));
  const own = tokens(text).filter((w) => w.length > 3);
  return own.length ? own.filter((w) => !src.has(w)).length / own.length : 0;
}

/**
 * Check one summary against its source. Returns every finding; an empty
 * list means the summary may be rendered. Never edits the summary.
 */
export function verifySummary(summary: Summary, source: string, options: VerifyOptions): Finding[] {
  const findings: Finding[] = [];
  const tldr = summary.tldr.trim();
  if (!tldr) findings.push({ reason: "empty_tldr", detail: "" });
  const count = splitSentences(tldr).length;
  if (count > 2) findings.push({ reason: "tldr_too_long", detail: `${count} sentences` });
  const trusted = [source, ...options.trusted];
  findings.push(...checkFacts(tldr, trusted), ...checkFacts(summary.whyItMatters, trusted));
  findings.push(...checkCopy([tldr, summary.whyItMatters], source, options.runWords, options.maxQuoteWords));
  if (options.requireContext) {
    const why = summary.whyItMatters.trim();
    if (why.split(/\s+/).length < 8 || novelty(why, source) < 0.5) {
      findings.push({ reason: "no_added_context", detail: why ? "why it matters restates the source" : "why it matters is empty" });
    }
  }
  return findings;
}
