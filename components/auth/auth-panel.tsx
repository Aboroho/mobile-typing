'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  loginFormSchema,
  registerFormSchema,
  reauthenticateFormSchema,
  type LoginFormValues,
  type RegisterFormValues,
  type ReauthenticateFormValues,
} from '@mt/validation';
import { Lock, LogIn, UserPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { FieldError, Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { firebaseAuthMessage, getAuthClient } from '@/lib/client/auth-client';
import { useAuthStore } from '@/stores/auth-store';
import { useAccessStore } from '@/stores/access-store';

type Mode = 'login' | 'register' | 'reauth';

/**
 * The three access branches from the product spec:
 *  - unregistered  → name + email + password
 *  - registered    → email + password
 *  - already signed in → password only
 *
 * Which branch shows depends on server state, never on a client flag alone.
 *
 * Every credential here is checked by Firebase Authentication in the browser;
 * the API call that follows carries the resulting ID token and never a password.
 */
export function AuthPanel({ initialMode }: { initialMode: Mode }) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const { register, login, reauthenticate, error, user } = useAuthStore();
  const bind = useAccessStore((state) => state.unlockWithCode);
  void bind;

  const registerForm = useForm<RegisterFormValues>({
    resolver: zodResolver(registerFormSchema),
    defaultValues: { name: '', email: '', password: '', confirmPassword: '' },
  });
  const loginForm = useForm<LoginFormValues>({
    resolver: zodResolver(loginFormSchema),
    defaultValues: { email: '', password: '' },
  });
  const reauthForm = useForm<ReauthenticateFormValues>({
    resolver: zodResolver(reauthenticateFormSchema),
    defaultValues: { password: '' },
  });

  const busy =
    registerForm.formState.isSubmitting || loginForm.formState.isSubmitting || reauthForm.formState.isSubmitting;

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-4 px-4 py-8 sm:max-w-lg md:py-12">
      {mode === 'register' ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <UserPlus className="h-4 w-4 text-brand" />
              Create your account
            </CardTitle>
            <CardDescription>Keep practising with your progress saved.</CardDescription>
          </CardHeader>
          <form
            className="space-y-3"
            noValidate
            onSubmit={registerForm.handleSubmit(async (values) => {
              await register(values);
            })}
          >
            <Field label="Name" error={registerForm.formState.errors.name?.message}>
              <Input
                {...registerForm.register('name')}
                autoComplete="name"
                placeholder="Your name"
                data-secret-ignore="true"
              />
            </Field>
            <Field label="Email" error={registerForm.formState.errors.email?.message}>
              <Input
                {...registerForm.register('email')}
                type="email"
                inputMode="email"
                autoComplete="email"
                placeholder="you@example.com"
              />
            </Field>
            <Field label="Password" error={registerForm.formState.errors.password?.message}>
              <Input {...registerForm.register('password')} type="password" autoComplete="new-password" />
            </Field>
            <Field label="Confirm password" error={registerForm.formState.errors.confirmPassword?.message}>
              <Input {...registerForm.register('confirmPassword')} type="password" autoComplete="new-password" />
            </Field>
            <FormError message={error} />
            <Button type="submit" className="w-full" size="lg" disabled={busy}>
              Create account
            </Button>
            <SwitchLink
              text="Already have an account?"
              action="Sign in"
              onClick={() => {
                registerForm.reset();
                setMode('login');
              }}
            />
          </form>
        </Card>
      ) : null}

      {mode === 'login' ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <LogIn className="h-4 w-4 text-brand" />
              Welcome back
            </CardTitle>
            <CardDescription>Sign in to continue where you left off.</CardDescription>
          </CardHeader>
          <form
            className="space-y-3"
            noValidate
            onSubmit={loginForm.handleSubmit(async (values) => {
              await login(values);
            })}
          >
            <Field label="Email" error={loginForm.formState.errors.email?.message}>
              <Input
                {...loginForm.register('email')}
                type="email"
                inputMode="email"
                autoComplete="email"
                placeholder="you@example.com"
              />
            </Field>
            <Field label="Password" error={loginForm.formState.errors.password?.message}>
              <Input {...loginForm.register('password')} type="password" autoComplete="current-password" />
            </Field>
            <FormError message={error} />
            <Button type="submit" className="w-full" size="lg" disabled={busy}>
              Sign in
            </Button>
            <div className="flex items-center justify-between text-xs">
              <SwitchLink
                text="New here?"
                action="Create an account"
                onClick={() => {
                  loginForm.reset();
                  setMode('register');
                }}
              />
              <ForgotPassword email={loginForm.getValues('email')} />
            </div>
          </form>
        </Card>
      ) : null}

      {mode === 'reauth' ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Lock className="h-4 w-4 text-brand" />
              Confirm it is you
            </CardTitle>
            <CardDescription>
              {user ? `Signed in as ${user.email}. ` : ''}Enter your password to unlock the app.
            </CardDescription>
          </CardHeader>
          <form
            className="space-y-3"
            noValidate
            onSubmit={reauthForm.handleSubmit(async (values) => {
              await reauthenticate(values.password);
            })}
          >
            <Field label="Password" error={reauthForm.formState.errors.password?.message}>
              <Input {...reauthForm.register('password')} type="password" autoComplete="current-password" autoFocus />
            </Field>
            <FormError message={error} />
            <Button type="submit" className="w-full" size="lg" disabled={busy}>
              Unlock
            </Button>
          </form>
        </Card>
      ) : null}
    </main>
  );
}

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <Label>{label}</Label>
      {children}
      <FieldError>{error}</FieldError>
    </div>
  );
}

function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">
      {message}
    </p>
  );
}

function SwitchLink({ text, action, onClick }: { text: string; action: string; onClick: () => void }) {
  return (
    <span className="text-xs text-ink-muted">
      {text}{' '}
      <button type="button" onClick={onClick} className="font-medium text-brand underline-offset-4 hover:underline">
        {action}
      </button>
    </span>
  );
}

/**
 * Password reset is sent by Firebase itself, from the browser: this API has no
 * mail transport, and a server endpoint that answered `{ sent: true }` without
 * sending anything would be worse than none. Firebase never reveals whether the
 * address has an account.
 */
function ForgotPassword({ email }: { email: string }) {
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  return (
    <span className="flex flex-col items-end gap-1">
      <button
        type="button"
        disabled={busy || sent || !email}
        className="text-xs text-ink-muted underline-offset-4 hover:underline disabled:opacity-50"
        onClick={async () => {
          setBusy(true);
          setFailure(null);
          try {
            const client = await getAuthClient();
            await client.sendPasswordReset(email);
            setSent(true);
          } catch (error) {
            setFailure(
              firebaseAuthMessage(error) ?? 'that reset email could not be sent, try again later',
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        {sent ? 'Reset link sent' : 'Forgot password?'}
      </button>
      {failure ? <span className="text-xs text-danger">{failure}</span> : null}
    </span>
  );
}
