import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { hasFirebaseClientConfig, parsePublicEnv, publicEnvSchema } from '@/lib/config/public-env';

const buildEnv: Record<string, string> = {
  NEXT_PUBLIC_FIREBASE_API_KEY: 'demo-web-key',
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: 'demo-keypad.firebaseapp.com',
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: 'demo-keypad',
  NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET: 'demo-keypad.appspot.com',
  NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: '1234567890',
  NEXT_PUBLIC_FIREBASE_APP_ID: '1:1234567890:web:test',
  NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_ENABLED: 'true',
  NEXT_PUBLIC_APP_URL: 'https://keypad.example',
  NEXT_PUBLIC_APP_NAME: 'Test Keypad',
  NEXT_PUBLIC_STUN_URLS: 'stun:example.com',
  NEXT_PUBLIC_SENTRY_DSN: 'https://example.com/sentry',
  NEXT_PUBLIC_ENABLE_TYPING_GAME: 'false',
};

describe('public environment in the browser', () => {
  it('survives static env replacement with an empty browser process.env', () => {
    const source = readFileSync(new URL('../lib/config/public-env.ts', import.meta.url), 'utf8');
    // Model Next's documented replacement rule: only literal process.env.KEY
    // reads are inlined, NOT an aliased, spread, or dynamically indexed env.
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      transformers: {
        before: [
          (context) => {
            const visit: ts.Visitor = (node) => {
              if (
                ts.isPropertyAccessExpression(node) &&
                ts.isPropertyAccessExpression(node.expression) &&
                ts.isIdentifier(node.expression.expression) &&
                node.expression.expression.text === 'process' &&
                node.expression.name.text === 'env' &&
                node.name.text.startsWith('NEXT_PUBLIC_')
              ) {
                const value = buildEnv[node.name.text];
                return value === undefined
                  ? ts.factory.createIdentifier('undefined')
                  : ts.factory.createStringLiteral(value);
              }
              return ts.visitEachChild(node, visit, context);
            };
            return (file) => ts.visitNode(file, visit) as ts.SourceFile;
          },
        ],
      },
    });
    const exports: { parsePublicEnv?: typeof parsePublicEnv } = {};
    runInNewContext(outputText, {
      exports,
      require: createRequire(import.meta.url),
      process: { env: {} },
    });
    const browserEnv = exports.parsePublicEnv?.();
    expect(browserEnv).toEqual(parsePublicEnv(buildEnv));
    expect(browserEnv && hasFirebaseClientConfig(browserEnv)).toBe(true);
    expect(browserEnv?.NEXT_PUBLIC_ENABLE_TYPING_GAME).toBe(false);
    // Cover every schema field: new public keys must also be in the allowlist.
    expect(Object.keys(buildEnv).sort()).toEqual(Object.keys(publicEnvSchema.shape).sort());
  });

  it('does not expose server credentials, even with an explicit server env', () => {
    const env = parsePublicEnv({
      ...buildEnv,
      FIREBASE_PRIVATE_KEY: 'server-only-test-value',
      APP_SECRET: 'server-only-signing-secret',
      ADMIN_PASSWORD: 'server-only-admin-password',
    });
    expect(Object.keys(env).every((key) => key.startsWith('NEXT_PUBLIC_'))).toBe(true);
    expect(JSON.stringify(env)).not.toContain('server-only');
  });

  it('keeps optional blanks and default flags consistent', () => {
    const env = parsePublicEnv({ NEXT_PUBLIC_FIREBASE_API_KEY: '  ' });
    expect(env.NEXT_PUBLIC_FIREBASE_API_KEY).toBeUndefined();
    expect(env.NEXT_PUBLIC_ENABLE_TYPING_GAME).toBe(true);
    expect(env.NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_ENABLED).toBe(false);
    expect(hasFirebaseClientConfig(env)).toBe(false);
  });
});
