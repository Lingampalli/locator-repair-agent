import { readFile } from 'node:fs/promises';
import {
  BedrockRuntimeClient,
  ConverseCommand,
  type Message,
} from '@aws-sdk/client-bedrock-runtime';
import { z } from 'zod';
import { BANNED_PROPOSAL_PATTERNS, type Config } from './config.js';
import type { FailureGroup, Proposal, Verdict } from './types.js';
import { probe } from './dom.js';
import { suggestionsFrom } from './strictmode.js';
import { log } from './logger.js';

/**
 * Produce a replacement locator for a group.
 *
 * Two sources, cheapest first:
 *   1. Playwright's own suggested locators from a strict mode error. If one
 *      resolves to exactly one element in the captured DOM, no model call is
 *      needed at all.
 *   2. Bedrock, with a schema-validated response.
 */

const ModelResponse = z.object({
  verdict: z.enum(['fixable', 'regression', 'duplicate_render', 'unclear']),
  failureKind: z.enum(['not_found', 'strict_mode']),
  proposedLocator: z.string().nullable(),
  disambiguationMethod: z
    .enum(['accessible_name', 'region_scope', 'content_filter'])
    .nullable()
    .optional(),
  matchedRole: z.string().nullable().optional(),
  matchedAccessibleName: z.string().nullable().optional(),
  reasoning: z.string(),
  confidence: z.number().min(0).max(1),
});

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['fixable', 'regression', 'duplicate_render', 'unclear'] },
    failureKind: { type: 'string', enum: ['not_found', 'strict_mode'] },
    proposedLocator: {
      type: ['string', 'null'],
      description: 'Full Playwright locator expression, e.g. page.getByRole("button", { name: "Sign In" })',
    },
    disambiguationMethod: {
      type: ['string', 'null'],
      enum: ['accessible_name', 'region_scope', 'content_filter', null],
    },
    matchedRole: { type: ['string', 'null'] },
    matchedAccessibleName: { type: ['string', 'null'] },
    reasoning: { type: 'string' },
    confidence: { type: 'number' },
  },
  required: ['verdict', 'failureKind', 'reasoning', 'confidence'],
} as const;

const SYSTEM_PROMPT = `You repair broken Playwright locators in a Cucumber test framework.

RULES, in order of importance:

1. You may ONLY propose a fix when an element with an equivalent ARIA role and
   accessible name still exists in the supplied DOM. If nothing equivalent is
   present, the control is genuinely gone: return verdict "regression".

2. For a strict mode violation the task is DISAMBIGUATION, not discovery. Narrow
   the existing locator; never invent an unrelated one. If the matched elements
   are identical with nothing legitimately distinguishing them, that is an
   application bug: return verdict "duplicate_render".

3. NEVER propose .first(), .last() or .nth(). Index-based selection hides
   duplicate-render bugs and is the brittle pattern that causes the next break.
   If index is the only way to disambiguate, return verdict "unclear".

4. NEVER propose a change to a timeout, wait, sleep or polling interval.

5. Locator preference order:
     getByRole(role, { name })  >  getByLabel / getByPlaceholder
     >  getByTestId  >  getByText  >  scoped CSS
   Never XPath, never :nth-child, never generated class names (css-1a2b3c).

6. The proposed locator must satisfy the intent of the Gherkin step. If the
   step says the user clicks "Sign In" and no such control exists, that is a
   regression, not a naming change.

Be conservative. A wrong fix is far worse than no fix: it masks a real defect.
When evidence is ambiguous, return "unclear" with a low confidence.`;

function violatesPolicy(expression: string): string | undefined {
  for (const { pattern, why } of BANNED_PROPOSAL_PATTERNS) {
    if (pattern.test(expression)) return why;
  }
  return undefined;
}

async function readArtifacts(
  group: FailureGroup,
): Promise<{ dom?: string; aria?: string }> {
  const withDom = group.failures.find((f) => f.record.artifacts.dom || f.record.artifacts.aria);
  if (!withDom) return {};
  const read = async (p?: string): Promise<string | undefined> => {
    if (!p) return undefined;
    try {
      return await readFile(p, 'utf8');
    } catch {
      return undefined;
    }
  };
  return {
    dom: await read(withDom.record.artifacts.dom),
    aria: await read(withDom.record.artifacts.aria),
  };
}

/**
 * Free path: test Playwright's own suggestions against the captured DOM.
 * Returns the first suggestion that resolves to exactly one element.
 */
export function tryPlaywrightSuggestions(
  group: FailureGroup,
  dom: string | undefined,
  aria: string | undefined,
): Proposal | undefined {
  if (!group.strictMode) return undefined;

  for (const suggestion of suggestionsFrom(group.strictMode)) {
    const banned = violatesPolicy(suggestion);
    if (banned) {
      log.debug(`suggestion rejected (${banned}): ${suggestion}`);
      continue;
    }
    const expression = suggestion.startsWith('page.') ? suggestion : `page.${suggestion}`;
    const p = probe(expression, dom, aria);
    if (!p.indeterminate && p.matchCount === 1) {
      return {
        groupId: group.groupId,
        source: 'playwright_suggestion',
        verdict: 'fixable',
        proposedLocator: expression,
        disambiguationMethod: 'accessible_name',
        reasoning:
          "Playwright's own suggested locator for this match resolves to exactly one element in the captured DOM.",
        confidence: 0.95,
      };
    }
  }
  return undefined;
}

/** Trim a DOM snapshot so a large page does not dominate the request. */
export function pruneDom(dom: string, maxChars = 120_000): string {
  const stripped = dom
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s(src|href)="data:[^"]*"/gi, ' $1="data:…"')
    .replace(/\n\s*\n/g, '\n');
  return stripped.length > maxChars ? `${stripped.slice(0, maxChars)}\n<!-- truncated -->` : stripped;
}

function buildUserMessage(group: FailureGroup, dom?: string, aria?: string): string {
  const samples = group.failures.slice(0, 3);
  const parts: string[] = [];

  parts.push(`## Failure kind\n${group.signature}`);
  parts.push(
    `## Current locator\nFile: ${group.definition?.filePath ?? 'unknown'}\n` +
      `Symbol: ${group.definition?.symbol ?? 'unknown'}\n` +
      `Expression: ${group.definition?.expression ?? 'unknown'}`,
  );
  parts.push(
    `## Impact\n${group.instanceCount} failure(s) across ${group.affectedTags.length} tag(s): ${group.affectedTags.join(', ')}`,
  );
  parts.push(
    `## Sample failures\n` +
      samples
        .map(
          (f, i) =>
            `${i + 1}. [${f.record.tag}] ${f.record.featureFile}:${f.record.scenarioLine}\n` +
            `   Scenario: ${f.record.scenarioName}\n` +
            `   Failing step: ${f.record.failingStepText}\n` +
            `   Error: ${f.record.errorMessage.slice(0, 800)}`,
        )
        .join('\n'),
  );

  if (group.strictMode) {
    parts.push(
      `## Strict mode matches (structure: ${group.strictMode.structure})\n` +
        group.strictMode.matches
          .map((m) => `${m.index}) ${m.html}${m.suggestion ? `  aka ${m.suggestion}` : ''}`)
          .join('\n') +
        `\n\nThis is a DISAMBIGUATION task. Narrow the existing locator.`,
    );
  }

  if (aria) parts.push(`## ARIA snapshot at failure\n${aria.slice(0, 40_000)}`);
  if (dom) parts.push(`## DOM at failure (pruned)\n${pruneDom(dom)}`);

  parts.push(
    `## Task\nPropose a replacement locator, or explain why no fix is appropriate. Respond using the provided tool schema only.`,
  );

  return parts.join('\n\n');
}

export class Proposer {
  private readonly client: BedrockRuntimeClient;
  private calls = 0;

  constructor(private readonly cfg: Config) {
    this.client = new BedrockRuntimeClient({ region: cfg.bedrockRegion });
  }

  get callCount(): number {
    return this.calls;
  }

  async propose(group: FailureGroup): Promise<Proposal | undefined> {
    const { dom, aria } = await readArtifacts(group);

    // 1. Free path.
    const free = tryPlaywrightSuggestions(group, dom, aria);
    if (free) {
      log.info(`${group.groupId}: resolved from Playwright's own suggestion, no model call`);
      return free;
    }

    // 2. Model path.
    if (this.calls >= this.cfg.maxModelCalls) {
      log.warn(`${group.groupId}: model call budget (${this.cfg.maxModelCalls}) exhausted, skipping`);
      return undefined;
    }

    const messages: Message[] = [
      { role: 'user', content: [{ text: buildUserMessage(group, dom, aria) }] },
    ];

    let raw: unknown;
    try {
      this.calls += 1;
      const response = await this.client.send(
        new ConverseCommand({
          modelId: this.cfg.bedrockModelId,
          system: [{ text: SYSTEM_PROMPT }],
          messages,
          inferenceConfig: { temperature: 0, maxTokens: 2000 },
          toolConfig: {
            tools: [
              {
                toolSpec: {
                  name: 'propose_locator',
                  description: 'Return the locator repair decision.',
                  // The SDK types this as a smithy DocumentType; a JSON Schema
                  // object is the documented shape, so the cast is safe.
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  inputSchema: { json: RESPONSE_SCHEMA as any },
                },
              },
            ],
            toolChoice: { tool: { name: 'propose_locator' } },
          },
        }),
      );

      const toolUse = response.output?.message?.content?.find((c) => 'toolUse' in c);
      raw = toolUse && 'toolUse' in toolUse ? toolUse.toolUse?.input : undefined;
    } catch (e) {
      // The SDK's error objects are enormous; the name and message are what
      // actually tell you whether this is credentials, region or model access.
      const err = e as { name?: string; message?: string };
      log.error(
        `${group.groupId}: Bedrock call failed — ${err.name ?? 'Error'}: ${err.message ?? String(e)}`,
      );
      log.debug('full Bedrock error', e);
      return undefined;
    }

    const parsed = ModelResponse.safeParse(raw);
    if (!parsed.success) {
      log.warn(`${group.groupId}: model response failed schema validation`, parsed.error.issues);
      return undefined;
    }
    const r = parsed.data;

    if (r.verdict !== 'fixable' || !r.proposedLocator) {
      log.info(`${group.groupId}: model returned "${r.verdict}" — ${r.reasoning}`);
      return {
        groupId: group.groupId,
        source: 'bedrock',
        verdict: r.verdict as Verdict,
        proposedLocator: '',
        disambiguationMethod: null,
        reasoning: r.reasoning,
        confidence: r.confidence,
      };
    }

    if (r.confidence < this.cfg.minConfidence) {
      log.info(
        `${group.groupId}: confidence ${r.confidence} below threshold ${this.cfg.minConfidence}, discarding`,
      );
      return undefined;
    }

    const banned = violatesPolicy(r.proposedLocator);
    if (banned) {
      log.warn(`${group.groupId}: proposal rejected by locator policy (${banned}): ${r.proposedLocator}`);
      return undefined;
    }

    // Static pre-check: must resolve to exactly one element in the saved DOM.
    // This is free and catches most bad proposals before a verification run.
    const p = probe(r.proposedLocator, dom, aria);
    if (!p.indeterminate && p.matchCount !== 1) {
      log.warn(
        `${group.groupId}: proposal matches ${p.matchCount} element(s) in the captured DOM, expected exactly 1 — discarding`,
      );
      return undefined;
    }

    return {
      groupId: group.groupId,
      source: 'bedrock',
      verdict: 'fixable',
      proposedLocator: r.proposedLocator,
      disambiguationMethod: r.disambiguationMethod ?? null,
      matchedRole: r.matchedRole ?? undefined,
      matchedAccessibleName: r.matchedAccessibleName ?? undefined,
      reasoning: r.reasoning,
      confidence: r.confidence,
    };
  }
}
