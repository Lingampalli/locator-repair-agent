import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import type { DomProbe } from './types.js';

/**
 * Re-query a locator against the DOM captured at the moment of failure.
 *
 * This is what removes the need for Playwright traces. The DOM snapshot is the
 * evidence: 0 matches means the locator broke, 1+ means it resolved fine and
 * the failure was about a value, not a selector.
 */

/** A locator expression decomposed into something we can query with. */
export interface ParsedLocator {
  builder: string;
  /** First argument: a CSS selector, a role, a test id, or visible text. */
  primary: string;
  /** `name` option for getByRole, when present. */
  accessibleName?: string;
  /** True when the expression chains .filter()/.and()/.or() we cannot model. */
  hasUnsupportedChain: boolean;
}

const BUILDER_RE =
  /\.(locator|getByRole|getByLabel|getByPlaceholder|getByTestId|getByText|getByTitle|getByAltText)\s*\(\s*(['"`])([\s\S]*?)\2/;
const NAME_OPTION_RE = /name\s*:\s*(['"`])([\s\S]*?)\1/;
/** Any locator-producing call, used to detect multi-step chains. */
const BUILDER_CALL_RE = /\.(?:locator|getBy[A-Za-z]+)\s*\(/g;
/** Refinements we cannot evaluate statically. */
const REFINEMENT_CALL_RE = /\.(?:filter|and|or)\s*\(/g;

export function parseLocatorExpression(expression: string): ParsedLocator | undefined {
  const m = BUILDER_RE.exec(expression);
  if (!m) return undefined;

  const builder = m[1]!;
  const primary = m[3]!;
  const nameMatch = NAME_OPTION_RE.exec(expression);

  // More than one builder call, or any refinement, means a chain the static
  // probe cannot model. Say so rather than silently probing only the first part.
  const builderCount = (expression.match(BUILDER_CALL_RE) ?? []).length;
  const refinementCount = (expression.match(REFINEMENT_CALL_RE) ?? []).length;

  return {
    builder,
    primary,
    accessibleName: nameMatch?.[2],
    hasUnsupportedChain: builderCount > 1 || refinementCount > 0,
  };
}

/** Minimal implicit ARIA role mapping, enough for a DOM fallback probe. */
const IMPLICIT_ROLE_SELECTORS: Record<string, string> = {
  button: 'button, input[type="button"], input[type="submit"], input[type="reset"]',
  link: 'a[href]',
  textbox:
    'input[type="text"], input[type="email"], input[type="password"], input[type="search"], input:not([type]), textarea',
  checkbox: 'input[type="checkbox"]',
  radio: 'input[type="radio"]',
  combobox: 'select',
  heading: 'h1, h2, h3, h4, h5, h6',
  img: 'img',
  list: 'ul, ol',
  listitem: 'li',
  table: 'table',
  row: 'tr',
  cell: 'td, th',
  navigation: 'nav',
  main: 'main',
  banner: 'header',
  contentinfo: 'footer',
  dialog: 'dialog',
};

function normalise(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Accessible-name approximation for an element. */
function accessibleNameOf($: cheerio.CheerioAPI, el: AnyNode): string {
  const $el = $(el);
  return normalise(
    $el.attr('aria-label') ??
      $el.attr('alt') ??
      $el.attr('title') ??
      $el.attr('value') ??
      $el.text(),
  );
}

function countByRole(
  $: cheerio.CheerioAPI,
  role: string,
  name: string | undefined,
): number {
  const explicit = `[role="${role}"]`;
  const implicit = IMPLICIT_ROLE_SELECTORS[role];
  const selector = implicit ? `${explicit}, ${implicit}` : explicit;

  const candidates = $(selector).toArray();
  if (!name) return candidates.length;

  const target = normalise(name);
  return candidates.filter((el) => accessibleNameOf($, el) === target).length;
}

function countByText($: cheerio.CheerioAPI, text: string): number {
  const target = normalise(text);
  return $('*')
    .toArray()
    .filter((el) => {
      const $el = $(el);
      if ($el.children().length > 0) return false; // leaf nodes only
      return normalise($el.text()) === target;
    }).length;
}

/**
 * Probe the captured DOM. `aria` is the ARIA snapshot text when available;
 * it is preferred for role-based locators because it already encodes the
 * accessibility tree Playwright itself resolves against.
 */
export function probe(
  expression: string,
  dom: string | undefined,
  aria?: string,
): DomProbe {
  if (!dom && !aria) {
    return { matchCount: 0, indeterminate: true, reason: 'no DOM or ARIA snapshot captured' };
  }

  const parsed = parseLocatorExpression(expression);
  if (!parsed) {
    return { matchCount: 0, indeterminate: true, reason: 'could not parse locator expression' };
  }
  if (parsed.hasUnsupportedChain) {
    return {
      matchCount: 0,
      indeterminate: true,
      reason: 'chained locator (.filter/.and/.or) cannot be probed statically',
    };
  }

  // Role-based locators: prefer the ARIA snapshot.
  if (parsed.builder === 'getByRole' && aria) {
    const count = countInAriaSnapshot(aria, parsed.primary, parsed.accessibleName);
    if (count !== undefined) return { matchCount: count, indeterminate: false };
  }

  if (!dom) {
    return { matchCount: 0, indeterminate: true, reason: 'only ARIA snapshot available' };
  }

  const $ = cheerio.load(dom);

  switch (parsed.builder) {
    case 'locator':
      try {
        return { matchCount: $(parsed.primary).length, indeterminate: false };
      } catch {
        return {
          matchCount: 0,
          indeterminate: true,
          reason: `selector not supported by the static probe: ${parsed.primary}`,
        };
      }
    case 'getByRole':
      return {
        matchCount: countByRole($, parsed.primary, parsed.accessibleName),
        indeterminate: false,
      };
    case 'getByTestId':
      return {
        matchCount: $(`[data-testid="${parsed.primary}"]`).length,
        indeterminate: false,
      };
    case 'getByLabel': {
      const byAria = $(`[aria-label="${parsed.primary}"]`).length;
      const labelled = $('label')
        .toArray()
        .filter((el) => normalise($(el).text()) === normalise(parsed.primary)).length;
      return { matchCount: byAria + labelled, indeterminate: false };
    }
    case 'getByPlaceholder':
      return { matchCount: $(`[placeholder="${parsed.primary}"]`).length, indeterminate: false };
    case 'getByTitle':
      return { matchCount: $(`[title="${parsed.primary}"]`).length, indeterminate: false };
    case 'getByAltText':
      return { matchCount: $(`[alt="${parsed.primary}"]`).length, indeterminate: false };
    case 'getByText':
      return { matchCount: countByText($, parsed.primary), indeterminate: false };
    default:
      return { matchCount: 0, indeterminate: true, reason: `unknown builder ${parsed.builder}` };
  }
}

/**
 * Count occurrences of `role "name"` in a Playwright ARIA snapshot.
 * Returns undefined when the snapshot is not in the expected text form.
 */
export function countInAriaSnapshot(
  aria: string,
  role: string,
  name?: string,
): number | undefined {
  if (!aria.trim()) return undefined;

  // aria.json fallback (page.accessibility.snapshot()).
  if (aria.trimStart().startsWith('{')) {
    try {
      const tree: unknown = JSON.parse(aria);
      return countInAccessibilityTree(tree, role, name);
    } catch {
      return undefined;
    }
  }

  const escapedRole = role.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = name
    ? new RegExp(`\\b${escapedRole}\\s+"${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'g')
    : new RegExp(`\\b${escapedRole}\\b`, 'g');
  return (aria.match(re) ?? []).length;
}

interface AxNode {
  role?: string;
  name?: string;
  children?: AxNode[];
}

function countInAccessibilityTree(tree: unknown, role: string, name?: string): number {
  let count = 0;
  const walk = (node: AxNode | undefined): void => {
    if (!node || typeof node !== 'object') return;
    if (node.role === role && (!name || normalise(node.name ?? '') === normalise(name))) {
      count += 1;
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(tree as AxNode);
  return count;
}

/**
 * Does an element with equivalent role and accessible name still exist?
 *
 * This is the safety property the whole design rests on. If nothing equivalent
 * is present, the control is genuinely gone and the failure is a regression,
 * not a cosmetic selector break.
 */
export function hasEquivalentElement(
  role: string | undefined,
  accessibleName: string | undefined,
  dom: string | undefined,
  aria?: string,
): boolean {
  if (!role && !accessibleName) return false;

  if (aria && role) {
    const c = countInAriaSnapshot(aria, role, accessibleName);
    if (c !== undefined && c > 0) return true;
  }

  if (!dom) return false;
  const $ = cheerio.load(dom);

  if (role) return countByRole($, role, accessibleName) > 0;

  if (accessibleName) {
    const target = normalise(accessibleName);
    return (
      $('*')
        .toArray()
        .some((el) => accessibleNameOf($, el) === target)
    );
  }
  return false;
}

/** True when the HAR shows a 4xx/5xx response, i.e. an app or env problem. */
export function harHasHttpErrors(harContent: string): { found: boolean; statuses: number[] } {
  try {
    const har = JSON.parse(harContent) as {
      log?: { entries?: Array<{ response?: { status?: number } }> };
    };
    const statuses = (har.log?.entries ?? [])
      .map((e) => e.response?.status ?? 0)
      .filter((s) => s >= 400);
    return { found: statuses.length > 0, statuses: [...new Set(statuses)] };
  } catch {
    return { found: false, statuses: [] };
  }
}
