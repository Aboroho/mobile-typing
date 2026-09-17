import { collectConfigIssuesFromEnv, hasFirebaseClientConfig, parsePublicEnv, type ConfigIssue } from '@mt/config';
import { logger } from './logger';

/**
 * Server-side reporting for the pure rules in `lib/config/diagnostics.ts`.
 *
 * The environment is only read once per process here, and each distinct problem
 * is logged once, so a misconfigured deployment says what is wrong on boot
 * instead of surfacing much later as an unrelated-looking 401 or 500.
 */
const reported = new Set<string>();

/**
 * Logs every configuration problem once per process.
 *
 * @param phase where the check ran (`boot`, `register`, …). Deliberately not
 *   called `context`: the logger redacts any field whose name contains "text".
 */
export function reportConfigIssues(phase?: string): ConfigIssue[] {
  let issues: ConfigIssue[];
  try {
    issues = collectConfigIssuesFromEnv();
  } catch (error) {
    // An unparsable environment already throws loudly where it is used; do not
    // turn the diagnostic into a second, unrelated failure.
    logger.error('config.diagnostics_failed', { error: String(error) });
    return [];
  }

  for (const issue of issues) {
    // Keyed on the message as well as the reason: one reason can cover several
    // variables (both signing secrets being placeholders, for example), and each
    // of them is a separate thing the operator has to fix.
    const key = `${issue.reason}:${issue.message}`;
    if (reported.has(key)) continue;
    reported.add(key);
    const fields = { reason: issue.reason, detail: issue.message, ...(phase ? { phase } : {}) };
    if (issue.level === 'error') logger.error('config.issue', fields);
    else logger.warn('config.issue', fields);
  }
  return issues;
}

/**
 * Whether the browser can authenticate with Firebase at all. The client falls
 * back to the dev auth adapter when `NEXT_PUBLIC_FIREBASE_*` is unset
 * (lib/client/auth-client.ts), so a server running `AUTH_PROVIDER=firebase`
 * would otherwise reject every request without explaining why.
 */
export function firebaseClientConfigured(): boolean {
  try {
    return hasFirebaseClientConfig(parsePublicEnv());
  } catch {
    return false;
  }
}

/** Test helper. */
export function resetReportedConfigIssues(): void {
  reported.clear();
}
