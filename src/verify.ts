import { splitSentences, type Summary } from "./summarize.js";

export interface Finding {
  reason: string;
  detail: string;
}

export interface VerifyOptions {
  /** The source title and name. Facts in them count as source facts. */
  sourceMeta?: string[];
  /** Host-supplied text (context notes). It may support "why it matters", never the TL;DR. */
  hostText?: string[];
  requireContext: boolean;
  /** Longest allowed copied run is runWords - 1. Default 8. */
  runWords?: number;
  /** The one allowed quote may hold this many words. Default 30. */
  maxQuoteWords?: number;
}

const MONTHS = "january february march april may june july august september october november december jan feb mar apr jun jul aug sep sept oct nov dec".split(" ");
const DAYS = "monday tuesday wednesday thursday friday saturday sunday".split(" ");
const COMMON_START = new Set("the a an this that these those it its they their there here what why how when where who our your we you he she his her if in on at for to from as by with after before until while but and or so new more most some many all each every no not according reports report says said then also however now today yesterday still meanwhile next first last".split(" "));
// "one" counts only as a quantity, not in "one of", "no one", "every one" and the like.
const ONE = /(?<!\b(?:no|any|every|some|each|which|this|that|the)\s)\bone\b(?!\s+(?:of|another|by)\b)/gi;
const NUMBER_WORDS = /\b(?:zero|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|trillion|dozen|half|double|triple|twice)\b/gi;
const AMOUNT = /(?:[$€£¥]\s?|\b(?:usd|cad|eur|gbp|aud)\s?)\d+(?:,\d{3})*(?:\.\d+)?(?:\s?(?:million|billion|thousand|bn|m|k)\b)?/gi;
const NUMERIC_DATE = /\b\d{4}-\d{1,2}-\d{1,2}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g;
const AMOUNT_WORDS = /\d+(?:,\d{3})*(?:\.\d+)?\s?(?:(?:million|billion|thousand)\s)?(?:dollars?|euros?|pounds?|yen|yuan|cents?|pence|rupees?|francs?|pesos?)\b/gi;
// A leading minus sign is part of the number, so -5 is not 5.
const NUMBER = /(?<![\p{L}\p{N}])[-−]?\d+(?:,\d{3})*(?:\.\d+)?/gu;
// A month and day, with the year when one follows, so "June 12, 2027" is one fact.
const MONTH_DAY = new RegExp(`\\b(?:${MONTHS.join("|")})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?\\b|\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?(?:${MONTHS.join("|")})(?:,?\\s+\\d{4})?\\b`, "gi");

function norm(text: string): string {
  return text.toLowerCase()
    .replace(/(\d)(?:st|nd|rd|th)\b/g, "$1").replace(/(\d) of /g, "$1 ")
    .replace(/(\d),(?=\d{3})/g, "$1").replace(/(\d),\s/g, "$1 ")
    .replace(/([$€£¥])\s+(?=\d)/g, "$1").replace(/−/g, "-").replace(/\s+/g, " ");
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** needle appears whole: no letter or digit just before, no letter, digit or .digit just after. */
function hasExact(haystack: string, needle: string): boolean {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escape(needle)}(?![\\p{L}\\p{N}]|[.,]\\p{N})`, "u").test(haystack);
}

/** Capitalized word runs in one sentence. A run never starts with a common word. */
function nameRuns(sentence: string): Array<{ words: string[]; first: boolean }> {
  const runs: Array<{ words: string[]; first: boolean }> = [];
  let current: { words: string[]; first: boolean } | undefined;
  let index = 0;
  for (const m of sentence.matchAll(/[\p{L}][\p{L}'’-]*|[^\p{L}\s]+/gu)) {
    const token = m[0];
    const isWord = /^\p{L}/u.test(token);
    if (isWord && /^\p{Lu}/u.test(token) && !(current === undefined && COMMON_START.has(token.toLowerCase()))) {
      if (!current) runs.push((current = { words: [], first: index === 0 }));
      current.words.push(token);
    } else {
      current = undefined;
    }
    if (isWord) index++;
  }
  return runs;
}

/** Numbers, amounts, dates and names in text that the allowed text does not hold. */
export function checkFacts(text: string, allowed: string[]): Finding[] {
  const found: Finding[] = [];
  const raw = allowed.join("\n").replace(/\s+/g, " ");
  const hay = norm(raw);
  const add = (reason: string, detail: string) => {
    if (!found.some((f) => f.detail === detail)) found.push({ reason, detail });
  };
  for (const m of text.match(AMOUNT) ?? []) if (!hasExact(hay, norm(m))) add("unsupported_amount", m);
  for (const m of text.match(AMOUNT_WORDS) ?? []) if (!hasExact(hay, norm(m))) add("unsupported_amount", m);
  for (const m of text.match(NUMERIC_DATE) ?? []) if (!hasExact(hay, m)) add("unsupported_date", m);
  for (const m of text.match(MONTH_DAY) ?? []) if (!hasExact(hay, norm(m))) add("unsupported_date", m);
  for (const m of text.match(NUMBER) ?? []) if (!hasExact(hay, norm(m))) add("unsupported_number", m);
  for (const m of text.match(NUMBER_WORDS) ?? []) if (!hasExact(hay, m.toLowerCase())) add("unsupported_number", m);
  for (const m of text.match(ONE) ?? []) if (!hasExact(hay, "one")) add("unsupported_number", m);
  // Brand-style names that start lowercase (iPhone, eBay) are names too.
  for (const m of text.match(/(?<![\p{L}\p{N}])\p{Ll}+\p{Lu}[\p{L}\p{N}]*/gu) ?? []) if (!hasExact(raw, m)) add("unsupported_name", m);
  for (const sentence of splitSentences(text)) {
    for (const run of nameRuns(sentence)) {
      const words = run.words;
      // A run of two or more words is one name, even when one word is a month ("May Smith").
      if (words.length > 1) {
        const phrase = words.join(" ");
        if (!hasExact(raw, phrase)) add("unsupported_name", phrase);
        continue;
      }
      const lower = words[0].toLowerCase();
      if (MONTHS.includes(lower) || DAYS.includes(lower)) {
        if (!hasExact(hay, lower)) add("unsupported_date", words[0]);
      } else if (!hasExact(run.first ? hay : raw, run.first ? lower : words[0])) {
        add("unsupported_name", words[0]);
      }
    }
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
 * TL;DR facts must come from the source (or its title and name). "Why it
 * matters" may also draw on host text. Attribution is checked later, on
 * the rendered article, by checkAttribution.
 */
export function verifySummary(summary: Summary, source: string, options: VerifyOptions): Finding[] {
  const findings: Finding[] = [];
  const tldr = summary.tldr.trim();
  if (!tldr) findings.push({ reason: "empty_tldr", detail: "" });
  const count = splitSentences(tldr).length;
  if (count > 2) findings.push({ reason: "tldr_too_long", detail: `${count} sentences` });
  const sourceFacts = [source, ...(options.sourceMeta ?? [])];
  findings.push(...checkFacts(tldr, sourceFacts), ...checkFacts(summary.whyItMatters, [...sourceFacts, ...(options.hostText ?? [])]));
  findings.push(...checkCopy([tldr, summary.whyItMatters], source, options.runWords, options.maxQuoteWords));
  if (options.requireContext) {
    // A word-overlap heuristic: it catches restating the source, not a close synonym paraphrase.
    const why = summary.whyItMatters.trim();
    if (why.split(/\s+/).length < 8 || novelty(why, source) < 0.5) {
      findings.push({ reason: "no_added_context", detail: why ? "why it matters restates the source" : "why it matters is empty" });
    }
  }
  return findings;
}
