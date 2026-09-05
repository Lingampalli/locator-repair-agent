/**
 * Copy this into your framework's `src/support/hooks.ts`.
 *
 * This is the ONLY change required in the test framework. It writes, per failed
 * scenario, the evidence the agent needs:
 *
 *   dom.html      the DOM at the moment of failure   (required for repair)
 *   aria.yaml     the accessibility tree             (preferred for role lookups)
 *   failure.json  scenario metadata                  (removes all report parsing)
 *   failure.png   screenshot                         (you already capture this)
 *   network.har   HAR                                (you already capture this)
 *
 * Three things that will bite otherwise:
 *
 *  1. Use the PROMISE api. `await fs.writeFile(path, data)` on the callback-style
 *     `fs` resolves immediately to undefined and the context teardown races the
 *     write, producing empty or missing files intermittently.
 *  2. `mkdir` with `recursive: true` — the directory will not exist on the first
 *     failure of a run.
 *  3. Wrap it all in try/catch. A throwing hook destabilises the whole run, and
 *     losing one snapshot is not worth failing a scenario over.
 */

import { After, Before, Status, type ITestCaseHookParameter } from '@cucumber/cucumber';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Replace with your own World type.
interface CustomWorld {
  browser: import('@playwright/test').Browser;
  context: import('@playwright/test').BrowserContext;
  page: import('@playwright/test').Page;
  /** Optional: set by page functions so chai failures can be traced to a locator. */
  lastLocator?: string;
}

/** Where artifacts are written. Jenkins should archive this directory. */
const ARTIFACT_ROOT = process.env.ARTIFACT_ROOT ?? 'artifacts/failures';

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

Before(async function (this: CustomWorld) {
  this.context = await this.browser.newContext({
    // You already record HAR; keep whatever options you use today.
    recordHar: { path: path.join(ARTIFACT_ROOT, '_pending', 'network.har') },
  });
  this.page = await this.context.newPage();
});

After(async function (this: CustomWorld, scenario: ITestCaseHookParameter) {
  const failed = scenario.result?.status === Status.FAILED;

  if (!failed) {
    await this.context.close();
    return;
  }

  const featureFile = scenario.gherkinDocument.uri ?? 'unknown';
  const scenarioName = scenario.pickle.name;
  const scenarioLine =
    scenario.pickle.astNodeIds.length > 0
      ? findLine(scenario, scenario.pickle.astNodeIds[0]!)
      : 0;

  const dir = path.join(
    ARTIFACT_ROOT,
    `${slugify(path.basename(featureFile, '.feature'))}--${slugify(scenarioName)}`,
  );

  try {
    await mkdir(dir, { recursive: true });

    // --- the two lines that are new ---
    await writeFile(path.join(dir, 'dom.html'), await this.page.content(), 'utf8');
    await writeFile(
      path.join(dir, 'aria.yaml'),
      await this.page.locator('body').ariaSnapshot(),
      'utf8',
    );
    // On older Playwright without ariaSnapshot(), use this instead and name the
    // file aria.json — page.accessibility.snapshot() returns an object:
    //
    //   const tree = await this.page.accessibility.snapshot();
    //   await writeFile(path.join(dir, 'aria.json'), JSON.stringify(tree), 'utf8');

    await this.page.screenshot({ path: path.join(dir, 'failure.png'), fullPage: true });

    // Metadata: this is what lets the agent skip report parsing entirely.
    const failingStep = scenario.result?.message ?? '';
    await writeFile(
      path.join(dir, 'failure.json'),
      JSON.stringify(
        {
          tag: process.env.CUCUMBER_TAG ?? scenario.pickle.tags[0]?.name ?? 'unknown',
          buildNumber: process.env.BUILD_NUMBER ?? 'unknown',
          featureFile,
          featureName: scenario.gherkinDocument.feature?.name ?? 'unknown',
          scenarioName,
          scenarioLine,
          failingStepText: currentStepText(scenario),
          errorMessage: failingStep,
          lastLocator: this.lastLocator,
          timestamp: new Date().toISOString(),
        },
        null,
        2,
      ),
      'utf8',
    );
  } catch (e) {
    console.warn(`[locator-agent] artifact capture failed for ${dir}:`, e);
  } finally {
    await this.context.close();
  }
});

/** Resolve the scenario's line number from the Gherkin AST. */
function findLine(scenario: ITestCaseHookParameter, astNodeId: string): number {
  for (const child of scenario.gherkinDocument.feature?.children ?? []) {
    if (child.scenario?.id === astNodeId) return child.scenario.location.line;
    for (const example of child.scenario?.examples ?? []) {
      for (const row of example.tableBody ?? []) {
        if (row.id === astNodeId) return row.location.line;
      }
    }
  }
  return scenario.gherkinDocument.feature?.location.line ?? 0;
}

/** Text of the step that failed. */
function currentStepText(scenario: ITestCaseHookParameter): string {
  const steps = scenario.pickle.steps;
  return steps.length > 0 ? (steps[steps.length - 1]?.text ?? '') : '';
}

/* ---------------------------------------------------------------------------
 * OPTIONAL, but it unlocks the chai path.
 *
 * Because chai assertions do not auto-retry, a broken locator usually surfaces
 * as `expected null to equal 'Sign In'` with no selector anywhere in the error.
 * If your page functions record the locator they just used, the agent can trace
 * those failures back to a page object. Without it, chai failures are reported
 * but not repaired.
 *
 *   // in a page object base class
 *   protected track<T>(expression: string, locator: T): T {
 *     (this.world as CustomWorld).lastLocator = expression;
 *     return locator;
 *   }
 *
 *   readonly submitButton = this.track(
 *     "page.locator('#btn-submit-login')",
 *     this.page.locator('#btn-submit-login'),
 *   );
 * ------------------------------------------------------------------------- */
