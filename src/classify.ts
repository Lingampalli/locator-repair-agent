import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { Config } from './config.js';
import type {
  ClassifiedFailure,
  FailureGroup,
  FailureRecord,
  FailureSignature,
  Verdict,
} from './types.js';
import { LocatorIndex, extractLocatorRef } from './locator.js';
import { probe, hasEquivalentElement, harHasHttpErrors, parseLocatorExpression } from './dom.js';
import { parseStrictMode, isDisambiguable } from './strictmode.js';
import { log } from './logger.js';

/**
 * Turn raw failures into classified failures and then into root-cause groups.
 *
 * Two paths, per the design:
 *   A. Playwright driver errors, which name their own cause in the message.
 *   B. chai assertion failures, whose cause is recovered by re-querying the DOM.
 *
 * Everything fails closed: any ambiguity produces a report-only verdict.
 */

const SIGNATURES: Array<{ signature: FailureSignature; test: RegExp }> = [
  { signature: 'strict_mode', test: /strict mode violation/i },
  { signature: 'locator_timeout', test: /timeout.*waiting for (?:locator|getBy)/is },
  { signature: 'locator_timeout', test: /waiting for (?:locator|getBy)\w*\(/i },
  { signature: 'detached', test: /element is not attached to the DOM/i },
  { signature: 'target_closed', test: /target (?:page, context or browser has been )?closed|browser has been closed/i },
  { signature: 'assertion', test: /AssertionError|expected .* to (?:equal|be|contain|deep)/i },
];

export function detectSignature(errorMessage: string): FailureSignature {
  for (const { signature, test } of SIGNATURES) {
    if (test.test(errorMessage)) return signature;
  }
  return 'unknown';
}

async function readIfPresent(p: string | undefined): Promise<string | undefined> {
  if (!p) return undefined;
  try {
    return await readFile(p, 'utf8');
  } catch {
    return undefined;
  }
}

/** Assertion errors where `actual` is empty are the ones a locator break causes. */
function assertionLooksEmpty(errorMessage: string): boolean {
  return /expected\s+(null|undefined|''|""|<empty string>|\[\])\s+to\b/i.test(errorMessage);
}

/** Noun -> ARIA role, for reading intent out of a Gherkin step. */
const ROLE_WORDS: Array<[RegExp, string]> = [
  [/\bbuttons?\b/i, 'button'],
  [/\blinks?\b/i, 'link'],
  [/\b(?:text ?box|field|input)\b/i, 'textbox'],
  [/\bcheckbox(?:es)?\b/i, 'checkbox'],
  [/\bradio\b/i, 'radio'],
  [/\b(?:dropdowns?|selects?|combobox(?:es)?)\b/i, 'combobox'],
  [/\btabs?\b/i, 'tab'],
  [/\bmenus?\b/i, 'menu'],
  [/\b(?:headings?|titles?)\b/i, 'heading'],
  [/\brows?\b/i, 'row'],
  [/\bcells?\b/i, 'cell'],
];

/**
 * Read the intended element out of the Gherkin step.
 *
 * A CSS locator like `#btn-submit-login` says nothing about what the element
 * IS, so it cannot support the role/accessible-name equivalence check on its
 * own. The step text can: `When I click the "Sign In" button` names both.
 */
export function inferIntentFromStep(step: string): { role?: string; name?: string } {
  const quoted = /["'“”]([^"'“”]{2,})["'“”]/.exec(step);
  let role: string | undefined;
  for (const [pattern, mapped] of ROLE_WORDS) {
    if (pattern.test(step)) {
      role = mapped;
      break;
    }
  }
  return { role, name: quoted?.[1] };
}

export async function classifyOne(
  cfg: Config,
  record: FailureRecord,
  index: LocatorIndex,
): Promise<ClassifiedFailure> {
  const signature = detectSignature(record.errorMessage);

  const dom = await readIfPresent(record.artifacts.dom);
  const aria = await readIfPresent(record.artifacts.aria);
  const har = await readIfPresent(record.artifacts.har);

  const base = { record, signature } as const;

  // Environment check first: an app returning 5xx is not a locator problem.
  if (har) {
    const { found, statuses } = harHasHttpErrors(har);
    if (found && statuses.some((s) => s >= 500)) {
      return {
        ...base,
        verdict: 'environment',
        rationale: `HAR shows server errors (${statuses.join(', ')}); application or environment problem`,
      };
    }
  }

  // Signatures that are never locator breaks, whatever else is true.
  if (signature === 'target_closed') {
    return {
      ...base,
      verdict: 'no_evidence',
      rationale: 'browser or page closed; no reliable DOM captured. Treat as crash or infrastructure failure',
    };
  }

  // Resolve the failing locator back to a page object definition.
  const ref =
    extractLocatorRef(record.errorMessage) ??
    (record.lastLocator ? extractLocatorRef(record.lastLocator) : undefined);
  const definition = ref ? index.findByRef(ref) : undefined;

  if (!definition) {
    return {
      ...base,
      verdict: 'no_evidence',
      rationale: ref
        ? `locator ${ref.builder ?? ''}(${ref.primary}) does not map to any indexed page object locator`
        : 'no locator recoverable from the error message (populate world.lastLocator to enable this path)',
    };
  }

  if (!dom && !aria) {
    return {
      ...base,
      definition,
      verdict: 'no_evidence',
      rationale: 'no DOM or ARIA snapshot captured for this scenario',
    };
  }

  // --- Path A: strict mode violation ---
  if (signature === 'strict_mode') {
    const detail = parseStrictMode(record.errorMessage);
    if (!detail) {
      return { ...base, definition, verdict: 'unclear', rationale: 'strict mode error could not be parsed' };
    }
    if (!isDisambiguable(detail.structure)) {
      const why =
        detail.structure === 'duplicate'
          ? `${detail.matchCount} identical elements in the same container with nothing to distinguish them — likely a duplicate render`
          : 'one or more matches are hidden or aria-hidden — likely a stale element left in the DOM';
      return {
        ...base,
        definition,
        strictMode: detail,
        verdict: 'duplicate_render',
        rationale: `${why}. Disambiguating would hide the defect`,
      };
    }
    return {
      ...base,
      definition,
      strictMode: detail,
      verdict: 'fixable',
      rationale: `locator resolved to ${detail.matchCount} elements (${detail.structure}); needs narrowing`,
    };
  }

  // --- Path A: detached element ---
  if (signature === 'detached') {
    const p = probe(definition.expression, dom, aria);
    if (!p.indeterminate && p.matchCount === 0) {
      return {
        ...base,
        definition,
        probe: p,
        verdict: 'fixable',
        rationale: 'element detached and the locator now matches nothing in the captured DOM',
      };
    }
    return {
      ...base,
      definition,
      probe: p,
      verdict: 'timing',
      rationale:
        'element re-rendered between resolution and action. The honest fix is a wait strategy, which the agent never changes',
    };
  }

  // --- Path A: locator timeout, and Path B: assertion failures ---
  const p = probe(definition.expression, dom, aria);

  if (p.indeterminate) {
    return {
      ...base,
      definition,
      probe: p,
      verdict: 'unclear',
      rationale: `DOM probe inconclusive: ${p.reason ?? 'unknown reason'}`,
    };
  }

  if (p.matchCount > 0) {
    // The locator resolves. For an assertion failure that means the value was
    // wrong — a real test failure. For a timeout it means something else went on.
    return {
      ...base,
      definition,
      probe: p,
      verdict: signature === 'assertion' ? 'value_failure' : 'unclear',
      rationale:
        signature === 'assertion'
          ? `locator resolves to ${p.matchCount} element(s) in the captured DOM; the asserted value was wrong`
          : `locator resolves to ${p.matchCount} element(s); the failure is not a broken selector`,
    };
  }

  // Zero matches. For assertions, only trust this when `actual` was empty.
  if (signature === 'assertion' && !assertionLooksEmpty(record.errorMessage)) {
    return {
      ...base,
      definition,
      probe: p,
      verdict: 'unclear',
      rationale:
        'locator matches nothing, but the assertion reported a concrete value. Failing closed',
    };
  }

  // The safety check: is an equivalent control still present anywhere?
  //
  // A role-based locator carries the role and accessible name directly. A CSS
  // locator carries neither, so the expected identity comes from the Gherkin
  // step instead. With no identity from either source we cannot claim the
  // element is gone, so we must not call it a regression.
  const parsed = parseLocatorExpression(definition.expression);
  const intent = inferIntentFromStep(record.failingStepText);

  const role = definition.role ?? intent.role;
  const name = definition.role
    ? definition.selectorValue
    : (parsed?.accessibleName ?? intent.name);

  if (!role && !name) {
    return {
      ...base,
      definition,
      probe: p,
      verdict: 'unclear',
      rationale:
        'locator matches nothing, but neither the CSS selector nor the step text identifies what element was expected, so no regression claim can be made',
    };
  }

  if (!hasEquivalentElement(role, name, dom, aria)) {
    return {
      ...base,
      definition,
      probe: p,
      verdict: 'regression',
      rationale: `no element with role "${role ?? 'unknown'}" and name "${name ?? 'unknown'}" exists anywhere in the captured DOM. The control is gone, so this is a regression rather than a selector break`,
    };
  }

  return {
    ...base,
    definition,
    probe: p,
    verdict: 'fixable',
    rationale: 'locator matches nothing, but an equivalent element is still present in the DOM',
  };
}

export async function classify(
  cfg: Config,
  records: FailureRecord[],
  index: LocatorIndex,
): Promise<ClassifiedFailure[]> {
  const out: ClassifiedFailure[] = [];
  for (const record of records) {
    out.push(await classifyOne(cfg, record, index));
  }
  return out;
}

/**
 * Group by the single line of code a fix would edit.
 *
 * Two failures share a root cause if and only if one edit fixes both, which
 * makes `<file>::<symbol>` the correct key. This is what stops several hundred
 * failures becoming several hundred model calls.
 */
export function group(classified: ClassifiedFailure[]): FailureGroup[] {
  const buckets = new Map<string, ClassifiedFailure[]>();

  for (const c of classified) {
    const key = c.definition
      ? `${c.definition.filePath}::${c.definition.symbol}`
      : `unresolved::${createHash('sha256')
          .update(`${c.signature}|${c.record.errorMessage.slice(0, 200)}`)
          .digest('hex')
          .slice(0, 12)}`;
    const list = buckets.get(key);
    if (list) list.push(c);
    else buckets.set(key, [c]);
  }

  const groups: FailureGroup[] = [];
  for (const [groupId, failures] of buckets) {
    // The group's verdict is the most common one; ties resolve to the most
    // conservative, because a group is only fixed when the evidence is clear.
    const counts = new Map<Verdict, number>();
    for (const f of failures) counts.set(f.verdict, (counts.get(f.verdict) ?? 0) + 1);

    let verdict: Verdict = 'unclear';
    let best = -1;
    for (const [v, n] of counts) {
      if (n > best) {
        best = n;
        verdict = v;
      }
    }
    // Any regression or duplicate_render reading in the group wins outright.
    if (counts.has('regression')) verdict = 'regression';
    else if (counts.has('duplicate_render')) verdict = 'duplicate_render';

    const representative = failures.find((f) => f.verdict === verdict) ?? failures[0]!;

    groups.push({
      groupId,
      definition: representative.definition,
      signature: representative.signature,
      verdict,
      rationale: representative.rationale,
      failures,
      affectedTags: [...new Set(failures.map((f) => f.record.tag))].sort(),
      instanceCount: failures.length,
      strictMode: representative.strictMode,
    });
  }

  groups.sort((a, b) => b.instanceCount - a.instanceCount);
  log.info(`grouped ${classified.length} failure(s) into ${groups.length} root cause(s)`);
  return groups;
}

/**
 * Cascade guard. When most tags fail at once the cause is almost never many
 * separate locator breaks — it is the environment. Open nothing.
 */
export function cascadeGuard(
  cfg: Config,
  classified: ClassifiedFailure[],
): { tripped: boolean; reason?: string } {
  if (classified.length === 0) return { tripped: false };

  const tags = new Set(classified.map((c) => c.record.tag));
  const envFailures = classified.filter((c) => c.verdict === 'environment').length;

  if (envFailures / classified.length > 0.3) {
    return {
      tripped: true,
      reason: `${envFailures}/${classified.length} failures show server errors — environment problem, not locator breaks`,
    };
  }

  const noEvidence = classified.filter((c) => c.verdict === 'no_evidence').length;
  if (noEvidence === classified.length) {
    return { tripped: true, reason: 'no scenario produced usable evidence' };
  }

  // Cross-tag breadth combined with a shared entry-step failure.
  const entryStepFailures = classified.filter((c) =>
    /log ?in|sign ?in|authenticat|landing|home page/i.test(c.record.failingStepText),
  ).length;

  if (
    tags.size >= 3 &&
    entryStepFailures / classified.length > cfg.cascadeTagFailureRatio
  ) {
    return {
      tripped: true,
      reason: `${entryStepFailures}/${classified.length} failures occur at a shared entry step across ${tags.size} tags — looks environment-wide`,
    };
  }

  return { tripped: false };
}
