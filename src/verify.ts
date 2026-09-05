import { spawn } from 'node:child_process';
import path from 'node:path';
import type { Config } from './config.js';
import type { FailureGroup, VerifyResult } from './types.js';
import { log } from './logger.js';

/**
 * Prove a fix works before anyone sees it.
 *
 * A fix nobody verified is a guess with a commit message. This step is also
 * what makes staleness handling free: if the environment moved since the run,
 * or someone already fixed the break, the re-run simply fails and no pull
 * request is opened.
 */

export interface RunOutcome {
  ok: boolean;
  code: number | null;
  output: string;
  timedOut: boolean;
}

export function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<RunOutcome> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      env: { ...process.env, FORCE_COLOR: '0' },
    });

    let output = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    const capture = (chunk: Buffer): void => {
      output += chunk.toString();
      if (output.length > 500_000) output = output.slice(-500_000);
    };

    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0 && !timedOut, code, output, timedOut });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, output: `${output}\n${String(err)}`, timedOut });
    });
  });
}

function buildTarget(featureFile: string, line: number): string {
  return line > 0 ? `${featureFile}:${line}` : featureFile;
}

function renderCommand(template: string, target: string): string {
  return template.includes('{target}')
    ? template.replace(/\{target\}/g, target)
    : `${template} ${target}`;
}

/**
 * Verify one group.
 *
 * 1. Re-run each distinct failing scenario `verifyRepeat` times. Every run must
 *    pass — a single pass can be luck. Deliberately not `--retry`, which would
 *    mask exactly the condition under test.
 * 2. Re-run each affected feature file in full, to catch collateral damage from
 *    editing a page object that other scenarios also use.
 */
export async function verifyGroup(
  cfg: Config,
  group: FailureGroup,
): Promise<VerifyResult> {
  const started = Date.now();

  const scenarios = [
    ...new Map(
      group.failures.map((f) => [
        `${f.record.featureFile}:${f.record.scenarioLine}`,
        f.record,
      ]),
    ).values(),
  ];

  const featureFiles = [...new Set(scenarios.map((s) => s.featureFile))].filter(
    (f) => f && f !== 'unknown',
  );

  let scenarioRuns = 0;
  let scenarioPasses = 0;
  let transcript = '';

  for (const scenario of scenarios) {
    if (!scenario.featureFile || scenario.featureFile === 'unknown') {
      log.warn(`${group.groupId}: scenario has no resolvable feature file, cannot verify`);
      return {
        groupId: group.groupId,
        passed: false,
        scenarioRuns: 0,
        scenarioPasses: 0,
        featureFilesRun: [],
        featureFilesPassed: false,
        durationMs: Date.now() - started,
        output: 'scenario could not be addressed for re-run',
      };
    }

    const target = buildTarget(scenario.featureFile, scenario.scenarioLine);
    const command = renderCommand(cfg.verifyCommand, target);

    for (let attempt = 1; attempt <= cfg.verifyRepeat; attempt += 1) {
      log.info(`${group.groupId}: verifying ${target} (${attempt}/${cfg.verifyRepeat})`);
      const outcome = await runCommand(command, cfg.repoRoot, cfg.verifyTimeoutMs);
      scenarioRuns += 1;
      transcript += `\n$ ${command}\n${outcome.output.slice(-4000)}`;

      if (!outcome.ok) {
        log.warn(
          `${group.groupId}: verification failed on ${target}${outcome.timedOut ? ' (timed out)' : ''}`,
        );
        return {
          groupId: group.groupId,
          passed: false,
          scenarioRuns,
          scenarioPasses,
          featureFilesRun: [],
          featureFilesPassed: false,
          durationMs: Date.now() - started,
          output: transcript,
        };
      }
      scenarioPasses += 1;
    }
  }

  // Collateral damage check across the whole feature file.
  let featureFilesPassed = true;
  for (const featureFile of featureFiles) {
    const command = renderCommand(cfg.verifyCommand, featureFile);
    log.info(`${group.groupId}: running full feature ${path.basename(featureFile)}`);
    const outcome = await runCommand(command, cfg.repoRoot, cfg.verifyTimeoutMs);
    transcript += `\n$ ${command}\n${outcome.output.slice(-4000)}`;
    if (!outcome.ok) {
      featureFilesPassed = false;
      log.warn(`${group.groupId}: full feature run failed for ${featureFile}`);
      break;
    }
  }

  const passed = scenarioPasses === scenarioRuns && scenarioRuns > 0 && featureFilesPassed;

  return {
    groupId: group.groupId,
    passed,
    scenarioRuns,
    scenarioPasses,
    featureFilesRun: featureFiles,
    featureFilesPassed,
    durationMs: Date.now() - started,
    output: transcript,
  };
}
