import { tokenize } from "@livekit/agents";

// Same thresholds the Sarvam plugin uses with its default basic tokenizer.
export const MIN_SENTENCE_LENGTH = 8;
export const STREAM_CONTEXT_LENGTH = 10;

const TERMINATORS = new Set([".", "?", "!", "\u0964", "\u0965"]);
const CLOSERS = new Set(['"', "'", "\u201d", "\u2019", ")", "]"]);
const TITLES = new Set(["Mr", "Mrs", "Ms", "Dr", "St", "Prof", "Smt", "Shri", "Sh", "Capt", "Lt", "Col", "Gen", "Mt", "Sr", "Jr", "vs", "approx"]);
const BEFORE_NUMBER = new Set(["Rs", "Re", "No", "Nos"]);

/** End offset of the sentence closed by the terminator at `i`, or -1 when it does not end one. */
function boundaryEnd(text: string, i: number): number {
  let j = i + 1;
  while (j < text.length && CLOSERS.has(text[j]!)) j++;
  // Terminators glued to the next character belong to URLs, decimals, dates and query strings.
  if (j < text.length && !/\s/.test(text[j]!)) return -1;
  if (text[i] !== ".") return j;
  if (text[i - 1] === ".") return -1;
  const word = /([\p{L}\p{N}.]+)$/u.exec(text.slice(0, i))?.[1] ?? "";
  const next = /\S/u.exec(text.slice(j))?.[0];
  if (TITLES.has(word)) return -1;
  if (BEFORE_NUMBER.has(word) && (next === undefined || /\p{N}/u.test(next))) return -1;
  if (/^\p{Lu}$/u.test(word)) return -1;
  if (word.includes(".") && (next === undefined || !/\p{Lu}/u.test(next))) return -1;
  return j;
}

/**
 * Splits text into sentences for streaming synthesis. Returns [sentence, start, end] offsets
 * into `text` so the buffered stream can consume exactly what was emitted. Unlike the basic
 * tokenizer it ends sentences at the Devanagari danda and keeps currency and serial-number
 * abbreviations ("Rs. 1,250", "No. 4") and URL query strings in one piece.
 */
export function splitSentences(text: string, minLength = MIN_SENTENCE_LENGTH): [string, number, number][] {
  const out: [string, number, number][] = [];
  let buf = "", start = 0, segStart = 0;
  const take = (end: number) => {
    const piece = text.slice(segStart, end).replace(/\s+/g, " ").trim();
    segStart = end;
    if (!piece) return;
    buf = buf ? `${buf} ${piece}` : piece;
    if (buf.length > minLength) { out.push([buf, start, end]); buf = ""; start = end; }
  };
  for (let i = 0; i < text.length; i++) {
    if (!TERMINATORS.has(text[i]!)) continue;
    const end = boundaryEnd(text, i);
    if (end >= 0) { take(end); i = end - 1; }
  }
  const rest = text.slice(segStart).replace(/\s+/g, " ").trim();
  if (rest) buf = buf ? `${buf} ${rest}` : rest;
  if (buf) out.push([buf, start, text.length]);
  return out;
}

export class DialogSentenceTokenizer extends tokenize.SentenceTokenizer {
  tokenize(text: string): string[] { return splitSentences(text).map(([sentence]) => sentence); }
  stream(): tokenize.SentenceStream {
    return new tokenize.BufferedSentenceStream(text => splitSentences(text), MIN_SENTENCE_LENGTH, STREAM_CONTEXT_LENGTH);
  }
}
