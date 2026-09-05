/**
 * Shared types for the locator repair agent.
 *
 * The pipeline is: FailureRecord[] -> ClassifiedFailure[] -> FailureGroup[]
 *                  -> Proposal -> PatchResult -> VerifyResult -> PR
 */

/** How a failure was surfaced by the test run. */
export type FailureSignature =
  | 'locator_timeout' // TimeoutError ... waiting for locator(...)
  | 'strict_mode' // strict mode violation: locator(...) resolved to N elements
  | 'detached' // element is not attached to the DOM
  | 'target_closed' // Target closed / Browser closed
  | 'assertion' // chai AssertionError (locator may or may not be the cause)
  | 'http_error' // 4xx/5xx observed for the failing page
  | 'unknown';

/** What the agent decided to do with a failure. */
export type Verdict =
  | 'fixable' // a locator repair is appropriate
  | 'regression' // the element is genuinely gone -> report, do not fix
  | 'duplicate_render' // strict mode caused by an app bug -> report, do not fix
  | 'value_failure' // locator resolves; the asserted value was wrong -> real test failure
  | 'environment' // HTTP/app error -> report, do not fix
  | 'timing' // detached/race -> needs a wait strategy, which we never change
  | 'no_evidence' // no DOM captured, or locator unresolvable
  | 'unclear'; // model was not confident enough

/** One failed Cucumber scenario, as collected from the run artifacts. */
export interface FailureRecord {
  /** Cucumber tag whose Jenkins job produced this (e.g. "@login"). */
  tag: string;
  /** Jenkins build number of the child job. */
  buildNumber: string;
  /** Absolute path of the directory holding dom.html / aria.yaml / etc. */
  artifactDir: string;

  featureFile: string;
  featureName: string;
  scenarioName: string;
  /** 1-based line of the scenario (or Examples row) in the feature file. */
  scenarioLine: number;

  failingStepText: string;
  errorMessage: string;

  /**
   * Locator expression the page object used, when the framework recorded it.
   * Populated by the optional `world.lastLocator` instrumentation; without it,
   * chai assertion failures cannot be traced back to a locator.
   */
  lastLocator?: string;

  /** Artifact availability, resolved at collect time. */
  artifacts: {
    dom?: string;
    aria?: string;
    har?: string;
    screenshot?: string;
  };
}

/** A locator definition found in a page object by static analysis. */
export interface LocatorDefinition {
  /** Absolute path of the page object file. */
  filePath: string;
  /** Property or method name holding the locator, e.g. "submitButton". */
  symbol: string;
  /** Full source text of the locator expression. */
  expression: string;
  /** Playwright builder used, e.g. "locator" | "getByRole" | "getByTestId". */
  builder: string;
  /**
   * The raw selector string for `locator()` / `getByTestId()` style builders,
   * or the accessible name for `getByRole()` / `getByLabel()` style ones.
   */
  selectorValue: string;
  /** ARIA role when the builder is getByRole. */
  role?: string;
  /** 1-based line of the expression. */
  line: number;
}

/** Result of re-querying a locator against the captured DOM. */
export interface DomProbe {
  /** How many elements the locator matched in the captured DOM. */
  matchCount: number;
  /** True when the probe could not run (no DOM, unsupported selector form). */
  indeterminate: boolean;
  /** Reason the probe was indeterminate. */
  reason?: string;
}

/** A failure after signature matching, DOM probing and verdict assignment. */
export interface ClassifiedFailure {
  record: FailureRecord;
  signature: FailureSignature;
  verdict: Verdict;
  /** Human-readable justification for the verdict. */
  rationale: string;
  /** The page object locator this failure maps to, when resolvable. */
  definition?: LocatorDefinition;
  probe?: DomProbe;
  strictMode?: StrictModeDetail;
}

/** One element that matched an over-broad locator. */
export interface StrictModeMatch {
  index: number;
  /** outerHTML snippet as reported by Playwright. */
  html: string;
  /** Playwright's own suggested replacement locator, when present. */
  suggestion?: string;
}

/** Parsed detail of a strict mode violation. */
export interface StrictModeDetail {
  selector: string;
  matchCount: number;
  matches: StrictModeMatch[];
  /** Structural reading of the matches; drives fixable vs duplicate_render. */
  structure: 'repeating' | 'distinct_regions' | 'duplicate' | 'hidden_present' | 'unknown';
}

/**
 * A set of failures sharing one root cause: the single line of code a fix
 * would edit. Two failures belong together iff one edit fixes both.
 */
export interface FailureGroup {
  /** `<pageObjectFile>::<symbol>` or a selector hash when unresolvable. */
  groupId: string;
  definition?: LocatorDefinition;
  signature: FailureSignature;
  verdict: Verdict;
  rationale: string;
  failures: ClassifiedFailure[];
  affectedTags: string[];
  instanceCount: number;
  strictMode?: StrictModeDetail;
}

/** A candidate locator replacement, from Playwright's hint or from the model. */
export interface Proposal {
  groupId: string;
  source: 'playwright_suggestion' | 'bedrock';
  verdict: Verdict;
  proposedLocator: string;
  disambiguationMethod: 'accessible_name' | 'region_scope' | 'content_filter' | null;
  matchedRole?: string;
  matchedAccessibleName?: string;
  reasoning: string;
  confidence: number;
}

/** Outcome of applying a proposal to a page object. */
export interface PatchResult {
  groupId: string;
  filePath: string;
  symbol: string;
  before: string;
  after: string;
  applied: boolean;
  error?: string;
}

/** Outcome of re-running the affected scenarios with a patch applied. */
export interface VerifyResult {
  groupId: string;
  passed: boolean;
  scenarioRuns: number;
  scenarioPasses: number;
  featureFilesRun: string[];
  featureFilesPassed: boolean;
  durationMs: number;
  output?: string;
}

/** Everything the run produced, for reporting and PR creation. */
export interface RunSummary {
  startedAt: string;
  finishedAt: string;
  mode: 'report-only' | 'propose-pr';
  buildsProcessed: string[];
  totalFailures: number;
  withArtifacts: number;
  groups: FailureGroup[];
  proposals: Proposal[];
  patches: PatchResult[];
  verifications: VerifyResult[];
  /** Groups deliberately not acted on, with the reason. */
  notFixed: Array<{ groupId: string; verdict: Verdict; rationale: string; tags: string[] }>;
  prUrl?: string;
  cascadeGuardTripped?: boolean;
  cascadeGuardReason?: string;
}

/** Verdicts that permit a code change. Everything else is report-only. */
export const FIXABLE_VERDICTS: readonly Verdict[] = ['fixable'] as const;

export function isFixable(v: Verdict): boolean {
  return FIXABLE_VERDICTS.includes(v);
}
