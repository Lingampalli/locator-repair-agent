import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/**
 * Configuration. Every path is a placeholder you replace for your environment.
 * Values resolve in this order: CLI flag > env var > config file > default.
 */
export const ConfigSchema = z.object({
  /** Root of the Jenkins jobs tree on EFS. Resolve via JENKINS_HOME where possible. */
  efsRoot: z.string().default('<EFS_ROOT>'),

  /**
   * Glob patterns, relative to efsRoot, that locate per-scenario failure
   * directories for a given build. `{build}` is substituted per build number.
   * The first pattern that yields results wins.
   */
  failureGlobs: z
    .array(z.string())
    .default([
      'jobs/*/builds/{build}/archive/**/failures/*/failure.json',
      'jobs/*/jobs/*/builds/{build}/archive/**/failures/*/failure.json',
    ]),

  /** Fallback: cucumber JSON reports, used when failure.json is absent. */
  cucumberJsonGlobs: z
    .array(z.string())
    .default([
      'jobs/*/builds/{build}/archive/**/cucumber*.json',
      'jobs/*/jobs/*/builds/{build}/archive/**/cucumber*.json',
    ]),

  /** Repository root of the Playwright/Cucumber framework. */
  repoRoot: z.string().default(process.cwd()),

  /** Directory holding page objects. The ONLY directory the agent may edit. */
  pageObjectDir: z.string().default('src/pages'),

  /** Directory holding feature files. Never written to. */
  featureDir: z.string().default('features'),

  /** Command used to re-run a single scenario. `{target}` -> file:line. */
  verifyCommand: z.string().default('npx cucumber-js {target}'),

  /** Times each fixed scenario must pass before a PR may be opened. */
  verifyRepeat: z.number().int().min(1).max(10).default(2),

  /** Abort verification of a group after this many milliseconds. */
  verifyTimeoutMs: z.number().int().default(15 * 60 * 1000),

  /** Bedrock model id. Confirm with `aws bedrock list-foundation-models`. */
  bedrockModelId: z.string().default('<BEDROCK_MODEL_ID>'),
  bedrockRegion: z.string().default(process.env.AWS_REGION || 'us-east-1'),

  /** Maximum Bedrock invocations per run. Grouping keeps this naturally low. */
  maxModelCalls: z.number().int().min(1).default(10),

  /** Minimum model confidence before a proposal may be patched. */
  minConfidence: z.number().min(0).max(1).default(0.75),

  /**
   * Cascade guard: if this fraction of tags failed, report only and open
   * nothing. An environment outage must never produce pull requests.
   */
  cascadeTagFailureRatio: z.number().min(0).max(1).default(0.7),

  github: z
    .object({
      owner: z.string().default('<GITHUB_OWNER>'),
      repo: z.string().default('<GITHUB_REPO>'),
      baseBranch: z.string().default('main'),
      branchPrefix: z.string().default('ai/locator-fixes'),
      apiBaseUrl: z.string().optional(),
    })
    .default({}),
});

export type Config = z.infer<typeof ConfigSchema>;

/** Locator forms the agent is permitted to propose. */
export const ALLOWED_BUILDERS = [
  'getByRole',
  'getByLabel',
  'getByPlaceholder',
  'getByTestId',
  'getByText',
  'getByTitle',
  'locator',
] as const;

/**
 * Patterns a proposal may never contain.
 *
 * `.first()`, `.last()` and `.nth()` are banned because index-based selection
 * is how a duplicate-render bug gets quietly papered over, and it is the
 * brittle pattern that causes the next break.
 */
export const BANNED_PROPOSAL_PATTERNS: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /\.first\s*\(/, why: 'index-based selection hides duplicate-render bugs' },
  { pattern: /\.last\s*\(/, why: 'index-based selection hides duplicate-render bugs' },
  { pattern: /\.nth\s*\(/, why: 'index-based selection hides duplicate-render bugs' },
  { pattern: /\bxpath\s*=|\/\/\*\[/i, why: 'XPath is banned by the locator policy' },
  { pattern: /:nth-child\s*\(/, why: 'positional CSS is brittle' },
  { pattern: /\btimeout\s*:/, why: 'the agent never changes timeouts or waits' },
  { pattern: /waitFor|setTimeout|sleep\s*\(/, why: 'the agent never changes waits' },
  { pattern: /css-[a-z0-9]{5,}/i, why: 'generated class names are unstable' },
];

export async function loadConfig(
  configPath?: string,
  overrides: Partial<Config> = {},
): Promise<Config> {
  let fileValues: Record<string, unknown> = {};
  const resolved = configPath ?? path.join(process.cwd(), 'config', 'default.json');
  if (existsSync(resolved)) {
    fileValues = JSON.parse(await readFile(resolved, 'utf8')) as Record<string, unknown>;
  }

  const envValues: Record<string, unknown> = {};
  if (process.env.EFS_ROOT) envValues.efsRoot = process.env.EFS_ROOT;
  if (process.env.REPO_ROOT) envValues.repoRoot = process.env.REPO_ROOT;
  if (process.env.BEDROCK_MODEL_ID) envValues.bedrockModelId = process.env.BEDROCK_MODEL_ID;
  if (process.env.AWS_REGION) envValues.bedrockRegion = process.env.AWS_REGION;

  const cleanOverrides = Object.fromEntries(
    Object.entries(overrides).filter(([, v]) => v !== undefined),
  );

  return ConfigSchema.parse({ ...fileValues, ...envValues, ...cleanOverrides });
}
