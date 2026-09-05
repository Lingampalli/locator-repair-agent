import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';
import type { Config } from './config.js';
import type { FailureRecord } from './types.js';
import { log } from './logger.js';

/**
 * Collect failed scenarios from the Jenkins EFS tree for a set of build numbers.
 *
 * Two sources, in order of preference:
 *
 *  1. `failure.json` written by the Cucumber After hook. Preferred, because it
 *     is written next to the DOM/ARIA/HAR artifacts the agent actually needs
 *     and requires no report parsing at all.
 *  2. Cucumber JSON reports. Fallback for runs predating the hook change.
 *     These carry no DOM, so such failures can be reported but not repaired.
 */

/** Shape written by the After hook. See docs/hooks-snippet.ts. */
interface FailureJson {
  tag?: string;
  buildNumber?: string;
  featureFile?: string;
  featureName?: string;
  scenarioName?: string;
  scenarioLine?: number;
  failingStepText?: string;
  errorMessage?: string;
  lastLocator?: string;
}

const ARTIFACT_NAMES = {
  dom: 'dom.html',
  aria: 'aria.yaml',
  har: 'network.har',
  screenshot: 'failure.png',
} as const;

function resolveArtifacts(dir: string): FailureRecord['artifacts'] {
  const out: FailureRecord['artifacts'] = {};
  for (const [key, filename] of Object.entries(ARTIFACT_NAMES) as Array<
    [keyof typeof ARTIFACT_NAMES, string]
  >) {
    const p = path.join(dir, filename);
    if (existsSync(p)) out[key] = p;
  }
  // aria.json is the fallback when page.accessibility.snapshot() was used.
  if (!out.aria) {
    const altAria = path.join(dir, 'aria.json');
    if (existsSync(altAria)) out.aria = altAria;
  }
  return out;
}

/** Best-effort tag inference from a Jenkins job path, e.g. jobs/@login/builds/12. */
function inferTagFromPath(filePath: string): string {
  const parts = filePath.split(path.sep);
  const idx = parts.lastIndexOf('jobs');
  const candidate = idx >= 0 && idx + 1 < parts.length ? parts[idx + 1] : undefined;
  return candidate ?? 'unknown';
}

function inferBuildFromPath(filePath: string): string {
  const m = /[\\/]builds[\\/](\d+)[\\/]/.exec(filePath);
  return m?.[1] ?? 'unknown';
}

function expandGlobs(globs: string[], build: string): string[] {
  return globs.map((g) => g.replace(/\{build\}/g, build));
}

async function collectFromFailureJson(
  cfg: Config,
  build: string,
): Promise<FailureRecord[]> {
  const patterns = expandGlobs(cfg.failureGlobs, build);
  const files = await fg(patterns, { cwd: cfg.efsRoot, absolute: true, dot: false });
  const records: FailureRecord[] = [];

  for (const file of files) {
    try {
      const raw = JSON.parse(await readFile(file, 'utf8')) as FailureJson;
      const dir = path.dirname(file);
      records.push({
        tag: raw.tag ?? inferTagFromPath(file),
        buildNumber: raw.buildNumber ?? inferBuildFromPath(file),
        artifactDir: dir,
        featureFile: raw.featureFile ?? 'unknown',
        featureName: raw.featureName ?? 'unknown',
        scenarioName: raw.scenarioName ?? 'unknown',
        scenarioLine: raw.scenarioLine ?? 0,
        failingStepText: raw.failingStepText ?? '',
        errorMessage: raw.errorMessage ?? '',
        lastLocator: raw.lastLocator,
        artifacts: resolveArtifacts(dir),
      });
    } catch (e) {
      log.warn(`could not read failure.json at ${file}`, e);
    }
  }
  return records;
}

/* ---------- Cucumber JSON fallback ---------- */

interface CucumberStep {
  keyword?: string;
  name?: string;
  line?: number;
  result?: { status?: string; error_message?: string };
}
interface CucumberElement {
  name?: string;
  line?: number;
  type?: string;
  tags?: Array<{ name?: string }>;
  steps?: CucumberStep[];
}
interface CucumberFeature {
  uri?: string;
  name?: string;
  elements?: CucumberElement[];
}

async function collectFromCucumberJson(
  cfg: Config,
  build: string,
): Promise<FailureRecord[]> {
  const patterns = expandGlobs(cfg.cucumberJsonGlobs, build);
  const files = await fg(patterns, { cwd: cfg.efsRoot, absolute: true });
  const records: FailureRecord[] = [];

  for (const file of files) {
    let features: CucumberFeature[];
    try {
      const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
      features = Array.isArray(parsed) ? (parsed as CucumberFeature[]) : [];
    } catch (e) {
      log.warn(`could not parse cucumber json at ${file}`, e);
      continue;
    }

    for (const feature of features) {
      for (const el of feature.elements ?? []) {
        const failing = (el.steps ?? []).find((s) => s.result?.status === 'failed');
        if (!failing) continue;

        const tag =
          el.tags?.map((t) => t.name).find((n): n is string => Boolean(n)) ??
          inferTagFromPath(file);

        records.push({
          tag,
          buildNumber: inferBuildFromPath(file),
          // No hook-written artifact dir for this path; DOM is unavailable.
          artifactDir: path.dirname(file),
          featureFile: feature.uri ?? 'unknown',
          featureName: feature.name ?? 'unknown',
          scenarioName: el.name ?? 'unknown',
          scenarioLine: el.line ?? 0,
          failingStepText: `${failing.keyword ?? ''}${failing.name ?? ''}`.trim(),
          errorMessage: failing.result?.error_message ?? '',
          artifacts: {},
        });
      }
    }
  }
  return records;
}

/** De-duplicate identical scenario failures (same tag, feature, scenario, build). */
function dedupe(records: FailureRecord[]): FailureRecord[] {
  const seen = new Map<string, FailureRecord>();
  for (const r of records) {
    const key = `${r.buildNumber}|${r.tag}|${r.featureFile}|${r.scenarioName}|${r.scenarioLine}`;
    const existing = seen.get(key);
    // Prefer the record that actually has artifacts.
    if (!existing || (!existing.artifacts.dom && r.artifacts.dom)) seen.set(key, r);
  }
  return [...seen.values()];
}

export async function collect(cfg: Config, builds: string[]): Promise<FailureRecord[]> {
  const all: FailureRecord[] = [];

  for (const build of builds) {
    const fromHook = await collectFromFailureJson(cfg, build);
    if (fromHook.length > 0) {
      log.info(`build ${build}: ${fromHook.length} failure(s) from failure.json`);
      all.push(...fromHook);
      continue;
    }

    const fromJson = await collectFromCucumberJson(cfg, build);
    if (fromJson.length > 0) {
      log.warn(
        `build ${build}: ${fromJson.length} failure(s) from cucumber JSON only — ` +
          `no DOM captured, these can be reported but not repaired`,
      );
      all.push(...fromJson);
    } else {
      log.warn(`build ${build}: no failures found (check efsRoot and glob patterns)`);
    }
  }

  return dedupe(all);
}

/** Count of failures that carry a DOM snapshot, i.e. are repairable at all. */
export function withArtifacts(records: FailureRecord[]): number {
  return records.filter((r) => Boolean(r.artifacts.dom || r.artifacts.aria)).length;
}
