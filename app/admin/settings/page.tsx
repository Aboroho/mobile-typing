'use client';

import { useEffect, useState } from 'react';
import { KeyRound, ShieldAlert } from 'lucide-react';
import { SECRET_CODE_MAX_LENGTH, type AuditLogEntry, type SecretCodeStatus } from '@mt/types';
import { api } from '@/lib/client/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useUiStore } from '@/stores/ui-store';
import { errorMessage } from '@/stores/access-store';

export default function AdminSettingsPage() {
  const [status, setStatus] = useState<SecretCodeStatus | null>(null);
  const [code, setCode] = useState('');
  const [confirm, setConfirm] = useState('');
  const [strategy, setStrategy] = useState<'rotate' | 'replace'>('rotate');
  const [audit, setAudit] = useState<AuditLogEntry[]>([]);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const [secret, logs] = await Promise.all([api.admin.secretCode(), api.admin.audit({ limit: 40 })]);
    setStatus(secret.status);
    setAudit(logs.items);
  };

  useEffect(() => {
    void load().catch(() => undefined);
  }, []);

  const save = async () => {
    if (code !== confirm) {
      useUiStore.getState().pushToast('The confirmation does not match', 'error');
      return;
    }
    setBusy(true);
    try {
      const result = await api.admin.changeSecretCode({ code, confirmCode: confirm, strategy });
      setStatus(result.status);
      setCode('');
      setConfirm('');
      await load();
      useUiStore.getState().pushToast(
        strategy === 'rotate' ? 'Secret code rotated — all sessions were signed out' : 'Secret code replaced',
        'success',
      );
    } catch (error) {
      useUiStore.getState().pushToast(errorMessage(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-brand" />
            Secret code
          </CardTitle>
          <CardDescription>
            The code is never displayed here — only whether one is configured and how long it is.
          </CardDescription>
        </CardHeader>
        <dl className="mb-4 grid grid-cols-2 gap-2 text-sm">
          <Row label="Configured" value={status?.configured ? 'yes' : 'no'} />
          <Row label="Length" value={status?.length ? String(status.length) : '—'} />
          <Row label="Epoch" value={String(status?.epoch ?? '—')} />
          <Row label="Max length" value={String(status?.maxLength ?? SECRET_CODE_MAX_LENGTH)} />
          <Row label="Case sensitive" value={status?.caseSensitive ? 'yes' : 'no'} />
          <Row label="Unlocks (this epoch)" value={String(status?.unlockCount ?? 0)} />
        </dl>

        <div className="space-y-3">
          <div>
            <Label>New code</Label>
            <Input
              value={code}
              onChange={(event) => setCode(event.target.value.slice(0, SECRET_CODE_MAX_LENGTH))}
              autoComplete="off"
              spellCheck={false}
              placeholder={`${SECRET_CODE_MAX_LENGTH} characters max`}
            />
          </div>
          <div>
            <Label>Confirm new code</Label>
            <Input value={confirm} onChange={(event) => setConfirm(event.target.value.slice(0, SECRET_CODE_MAX_LENGTH))} autoComplete="off" spellCheck={false} />
          </div>
          <div>
            <Label>Strategy</Label>
            <div className="flex gap-2">
              <Button variant={strategy === 'rotate' ? 'primary' : 'secondary'} size="sm" onClick={() => setStrategy('rotate')}>
                Rotate (sign everyone out)
              </Button>
              <Button variant={strategy === 'replace' ? 'primary' : 'secondary'} size="sm" onClick={() => setStrategy('replace')}>
                Replace only
              </Button>
            </div>
          </div>
          <p className="flex items-start gap-2 rounded-lg bg-warning/10 px-3 py-2 text-xs text-ink-muted">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            Rotating bumps the epoch, which instantly invalidates every access session and challenge.
          </p>
          <Button className="w-full" onClick={() => void save()} disabled={busy || !code || !confirm}>
            {busy ? 'Saving…' : 'Update secret code'}
          </Button>
        </div>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Audit log</CardTitle>
          <CardDescription>Sensitive administrative actions, newest first.</CardDescription>
        </CardHeader>
        <ul className="max-h-[36rem] divide-y divide-line overflow-y-auto text-sm">
          {audit.map((entry) => (
            <li key={entry.id} className="py-2">
              <div className="flex items-center gap-2">
                <Badge tone="warning">{entry.action}</Badge>
                <span className="text-[11px] text-ink-faint">{new Date(entry.createdAt).toLocaleString()}</span>
              </div>
              <p className="mt-1 text-xs text-ink-muted">
                {entry.actorEmail ?? entry.actorUid} · {entry.targetType}
                {entry.targetId ? ` · ${entry.targetId}` : ''}
              </p>
              {Object.keys(entry.metadata).length > 0 ? (
                <p className="mt-0.5 font-mono text-[11px] text-ink-faint">{JSON.stringify(entry.metadata)}</p>
              ) : null}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-surface-sunken px-3 py-2">
      <dt className="text-[10px] uppercase tracking-wide text-ink-faint">{label}</dt>
      <dd className="font-mono text-sm">{value}</dd>
    </div>
  );
}
