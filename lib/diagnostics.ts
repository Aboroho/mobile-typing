import { collectConfigIssuesFromEnv, type ConfigIssue } from '@mt/config';
import { logger } from './logger';

/**
 * Server-side reporting for configuration problems.
 */
const reported = new Set<string>();

export function reportConfigIssues(phase?: string): ConfigIssue[] {
  let issues: ConfigIssue[];
  try {
    issues = collectConfigIssuesFromEnv();
  } catch (error) {
    logger.error('config.diagnostics_failed', { error: String(error) });
    return [];
  }

  for (const issue of issues) {
    const key = `${issue.reason}:${issue.message}`;
    if (reported.has(key)) continue;
    reported.add(key);
    const fields = { reason: issue.reason, detail: issue.message, ...(phase ? { phase } : {}) };
    if (issue.level === 'error') logger.error('config.issue', fields);
    else logger.warn('config.issue', fields);
  }
  return issues;
}

export function resetReportedConfigIssues(): void {
  reported.clear();
}
