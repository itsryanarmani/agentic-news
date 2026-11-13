import type { SourceArticle } from "./article.js";
import type { ContextNote, NewsConfig } from "./types.js";

export interface SummaryInput {
  article: SourceArticle;
  /** Keywords this item matched. */
  matched: string[];
  /** Host context notes whose keyword the item matched. */
  context: ContextNote[];
  language: string;
  tone: NewsConfig["tone"];
}

export interface Summary {
  /** At most 2 sentences. */
  tldr: string;
  whyItMatters: string;
  relatedLink?: { title: string; url: string };
}

/**
 * The summarizer hook. A host passes its own LLM call here; the library
 * reads no API key and names no vendor. The verifier checks every result,
 * whoever wrote it.
 */
export type Summarizer = (input: SummaryInput) => Summary | Promise<Summary>;

/**
 * Split into sentences at . ! ? (plus any closing quotes) followed by a
 * space. Decimals stay whole and paragraphs never join. No text is dropped.
 */
export function splitSentences(text: string): string[] {
  return text.split(/\n\s*\n/).flatMap((para) =>
    para.replace(/\s+/g, " ").trim().replace(/([.!?]+["”’)\]]*)\s+(?=\S)/g, "$1\u0001").split("\u0001"))
    .map((s) => s.trim()).filter(Boolean);
}

function words(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

/** Cut to maxWords at a clause break when one is near, else at the word limit. */
function shorten(sentence: string, maxWords: number): string {
  const all = words(sentence);
  if (all.length <= maxWords) return sentence.replace(/[.!?]+$/, "");
  const head = all.slice(0, maxWords).join(" ");
  const comma = head.lastIndexOf(",");
  return comma > head.length / 2 ? head.slice(0, comma) : `${head}…`;
}

/** Notes whose keyword the item matched, in config order. */
export function contextFor(config: NewsConfig, matched: string[]): ContextNote[] {
  const lower = matched.map((m) => m.toLowerCase());
  return config.context.filter((c) => lower.includes(c.keyword.toLowerCase()));
}

/**
 * Deterministic default. No network, no model. The TL;DR attributes the
 * source and quotes its key sentence (the one short quote the verifier
 * allows). Why it matters comes only from host context notes; with none,
 * it is empty and requireContext rejects the item, because this summarizer
 * cannot invent context.
 */
export function extractiveSummarizer(maxQuoteWords = 30): Summarizer {
  return ({ article, matched, context }) => {
    // Skip the headline and short fragments; quote a full sentence.
    const sentences = splitSentences(article.text).filter((s) => s !== article.title && s.split(" ").length >= 8);
    const key = sentences.find((s) => matched.some((m) => s.toLowerCase().includes(m.toLowerCase()))) ?? sentences[0] ?? article.title;
    const quote = shorten(key, maxQuoteWords);
    return {
      tldr: `${article.sourceName} reports: "${quote}."`,
      whyItMatters: context.map((c) => c.note).join(" "),
      relatedLink: context.find((c) => c.relatedLink)?.relatedLink,
    };
  };
}
