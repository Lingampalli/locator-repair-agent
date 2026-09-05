import type { StrictModeDetail, StrictModeMatch } from './types.js';

/**
 * Parsing and structural analysis of Playwright strict mode violations.
 *
 * A strict mode violation asks "which of these N did you mean?" rather than
 * "where did the element go?". That makes it a disambiguation problem — and
 * one where the wrong fix actively hides application bugs, so the structure of
 * the matches decides whether a fix is appropriate at all.
 *
 * Playwright's error text looks roughly like:
 *
 *   strict mode violation: locator('.nav-item') resolved to 3 elements:
 *       1) <a class="nav-item">Help Desk</a> aka getByRole('link', { name: 'Help Desk' })
 *       2) <a class="nav-item">Help Desk</a> aka getByRole('link', { name: 'Help Desk' })
 *       3) ...
 */

const HEADER = /strict mode violation:\s*(?:locator|getBy\w+)\((.*?)\)\s*resolved to\s*(\d+)\s*element/i;
const MATCH_LINE = /^\s*(\d+)\)\s*(.+?)\s*$/;
const AKA = /\s+aka\s+(.+)$/i;

function stripQuotes(s: string): string {
  const t = s.trim();
  return (t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))
    ? t.slice(1, -1)
    : t;
}

/** Tag name of an outerHTML snippet, e.g. `<a class="x">` -> "a". */
export function tagNameOf(html: string): string | undefined {
  return /^<\s*([a-zA-Z][\w-]*)/.exec(html.trim())?.[1]?.toLowerCase();
}

/** Visible text of an outerHTML snippet, crudely but adequately. */
export function textOf(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isHidden(html: string): boolean {
  return (
    /aria-hidden\s*=\s*["']true["']/i.test(html) ||
    /\bhidden\b(?!-)/i.test(html) ||
    /style\s*=\s*["'][^"']*display\s*:\s*none/i.test(html)
  );
}

/**
 * Decide what the set of matches means.
 *
 * - repeating         siblings of a repeating structure; selector under-specified
 * - distinct_regions  matches differ in text or tag; selector too broad
 * - duplicate         identical elements, no distinguishing feature -> app bug
 * - hidden_present    at least one match is hidden -> stale DOM, likely app bug
 */
export function analyseStructure(
  matches: StrictModeMatch[],
): StrictModeDetail['structure'] {
  if (matches.length === 0) return 'unknown';

  if (matches.some((m) => isHidden(m.html))) return 'hidden_present';

  const texts = matches.map((m) => textOf(m.html));
  const tags = matches.map((m) => tagNameOf(m.html) ?? '');
  const uniqueTexts = new Set(texts);
  const uniqueTags = new Set(tags);

  // Every match identical in tag and text, with no suggestion able to tell
  // them apart: nothing legitimately distinguishes these, so treat as a bug.
  if (uniqueTexts.size === 1 && uniqueTags.size === 1) {
    const suggestions = new Set(matches.map((m) => m.suggestion ?? ''));
    if (suggestions.size <= 1) return 'duplicate';
    return 'repeating';
  }

  // Same tag, differing text: a list, table or card collection.
  if (uniqueTags.size === 1 && uniqueTexts.size === matches.length) return 'repeating';

  // Mixed tags or partially differing text: the selector spans regions.
  return 'distinct_regions';
}

/** Parse a strict mode violation out of a raw error message. */
export function parseStrictMode(errorMessage: string): StrictModeDetail | undefined {
  const header = HEADER.exec(errorMessage);
  if (!header) return undefined;

  const selector = stripQuotes(header[1] ?? '');
  const matchCount = Number.parseInt(header[2] ?? '0', 10);

  const matches: StrictModeMatch[] = [];
  for (const rawLine of errorMessage.split('\n')) {
    const m = MATCH_LINE.exec(rawLine);
    if (!m) continue;
    const index = Number.parseInt(m[1] ?? '0', 10);
    let body = m[2] ?? '';
    if (!body.startsWith('<')) continue; // not an element line

    let suggestion: string | undefined;
    const aka = AKA.exec(body);
    if (aka?.[1]) {
      suggestion = aka[1].trim();
      body = body.slice(0, aka.index).trim();
    }
    matches.push({ index, html: body, suggestion });
  }

  return {
    selector,
    matchCount: matchCount || matches.length,
    matches,
    structure: analyseStructure(matches),
  };
}

/**
 * Playwright's own suggested locators, in match order.
 *
 * These are the free path: if one of them resolves to exactly one element in
 * the captured DOM and matches the step's intent, no model call is needed.
 */
export function suggestionsFrom(detail: StrictModeDetail): string[] {
  return detail.matches
    .map((m) => m.suggestion)
    .filter((s): s is string => Boolean(s && s.trim().length > 0));
}

/** True when the structure permits an automated disambiguation. */
export function isDisambiguable(structure: StrictModeDetail['structure']): boolean {
  return structure === 'repeating' || structure === 'distinct_regions';
}
