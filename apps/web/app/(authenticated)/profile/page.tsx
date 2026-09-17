'use client';

import { useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { updateProfileSchema } from '@mt/validation';
import { useAuthStore } from '@/stores/auth-store';
import { api } from '@/lib/client/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FieldError, Label } from '@/components/ui/label';
import { useUiStore } from '@/stores/ui-store';
import { errorMessage } from '@/stores/access-store';

export default function ProfilePage() {
  const user = useAuthStore((state) => state.user);
  const [saving, setSaving] = useState(false);
  const form = useForm<{ name: string }>({
    resolver: zodResolver(updateProfileSchema.pick({ name: true }).required()),
    defaultValues: { name: user?.name ?? '' },
  });

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-lg flex-col gap-4 px-4 py-6">
      <header className="flex items-center gap-2">
        <Link href="/settings" aria-label="Back" className="rounded-full p-2 text-ink-muted hover:bg-surface-raised">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <h1 className="text-lg font-semibold">Profile</h1>
      </header>

      <form
        className="space-y-3"
        noValidate
        onSubmit={form.handleSubmit(async (values) => {
          setSaving(true);
          try {
            await api.auth.updateProfile({ name: values.name });
            await useAuthStore.getState().initialize();
            useUiStore.getState().pushToast('Profile updated', 'success');
          } catch (error) {
            useUiStore.getState().pushToast(errorMessage(error), 'error');
          } finally {
            setSaving(false);
          }
        })}
      >
        <div>
          <Label>Name</Label>
          <Input {...form.register('name')} data-secret-ignore="true" />
          <FieldError>{form.formState.errors.name?.message}</FieldError>
        </div>
        <div>
          <Label>Email</Label>
          <Input value={user?.email ?? ''} readOnly className="opacity-60" />
        </div>
        <Button type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Save changes'}
        </Button>
      </form>
    </main>
  );
}
