import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, CheckCircle2 } from 'lucide-react';
import { ApiError } from '@sentinel/shared';
import { api } from '@/api/client';
import { errorMessage } from '@/api/hooks';
import { Button, Field, Input, Notice } from '@/components/ui/primitives';
import { PASSWORD_RULE, passwordProblem } from '@/components/misc/password';
import { AuthFrame } from './AuthFrame';

type State = 'form' | 'done' | 'invalid';

export default function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get('token')?.trim() ?? '';
  const [state, setState] = useState<State>(token ? 'form' : 'invalid');
  const [invalidMsg, setInvalidMsg] = useState('This reset link is missing its token. Request a new one.');
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [touched, setTouched] = useState(false);
  const [formError, setFormError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const errs = {
    pw: passwordProblem(pw),
    confirm: !confirm ? 'Re-enter the new password.' : confirm !== pw ? 'Passwords do not match.' : undefined,
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    setFormError(undefined);
    if (errs.pw || errs.confirm) return;
    setBusy(true);
    try {
      await api.resetPassword(token, pw);
      setState('done');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'INVALID_TOKEN') {
        setInvalidMsg(err.message);
        setState('invalid');
      } else {
        setFormError(errorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  };

  if (state === 'invalid') {
    return (
      <AuthFrame title="Reset link not valid" subtitle="Password recovery">
        <div className="space-y-4" role="alert">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-crit-ink" aria-hidden />
            <p className="text-sm text-ink-soft">{invalidMsg} Reset links work once and expire after a short time.</p>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Link to="/login" className="inline-flex items-center gap-1 text-sm text-signal hover:underline"><ArrowLeft className="h-4 w-4" /> Back to sign in</Link>
            <Link to="/forgot-password" className="inline-flex h-9 items-center rounded-ctl border border-signal-dark/20 bg-signal px-3.5 text-sm font-semibold text-on-signal hover:bg-signal-dark">Request a new link</Link>
          </div>
        </div>
      </AuthFrame>
    );
  }

  if (state === 'done') {
    return (
      <AuthFrame title="Password updated" subtitle="Password recovery">
        <div className="space-y-4" role="status">
          <div className="flex items-start gap-3">
            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-ok-ink" aria-hidden />
            <p className="text-sm text-ink-soft">Your password has been changed. Sign in with your new password.</p>
          </div>
          <Link to="/login" className="inline-flex h-9 items-center rounded-ctl border border-signal-dark/20 bg-signal px-3.5 text-sm font-semibold text-on-signal hover:bg-signal-dark">Go to sign in</Link>
        </div>
      </AuthFrame>
    );
  }

  return (
    <AuthFrame title="Choose a new password" subtitle={PASSWORD_RULE}>
      <form onSubmit={submit} noValidate className="space-y-4">
        {formError && <Notice tone="crit">{formError}</Notice>}
        <Field label="New password" htmlFor="rp-new" required error={touched ? errs.pw : undefined} hint={PASSWORD_RULE}>
          <Input id="rp-new" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} aria-invalid={touched && !!errs.pw} autoFocus />
        </Field>
        <Field label="Confirm new password" htmlFor="rp-confirm" required error={touched ? errs.confirm : undefined}>
          <Input id="rp-confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} aria-invalid={touched && !!errs.confirm} />
        </Field>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Link to="/login" className="inline-flex items-center gap-1 text-sm text-signal hover:underline"><ArrowLeft className="h-4 w-4" /> Back to sign in</Link>
          <Button type="submit" variant="primary" loading={busy}>Set new password</Button>
        </div>
      </form>
    </AuthFrame>
  );
}
