import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, MailCheck } from 'lucide-react';
import { api } from '@/api/client';
import { errorMessage } from '@/api/hooks';
import { Button, Field, Input, Notice } from '@/components/ui/primitives';
import { EMAIL_RE } from '@/components/misc/password';
import { AuthFrame } from './AuthFrame';

type Result = Awaited<ReturnType<typeof api.requestPasswordReset>>;

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string>();
  const [formError, setFormError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(undefined);
    if (!EMAIL_RE.test(email.trim())) {
      setError('Enter your work email address.');
      return;
    }
    setError(undefined);
    setBusy(true);
    try {
      setResult(await api.requestPasswordReset(email.trim()));
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    return (
      <AuthFrame title={result.emailConfigured ? 'Check your email' : 'No email was sent'} subtitle="Password recovery">
        <div className="space-y-4">
          {result.emailConfigured ? (
            <div className="flex items-start gap-3">
              <MailCheck className="mt-0.5 h-5 w-5 shrink-0 text-signal" aria-hidden />
              <p className="text-sm text-ink-soft" role="status">
                If an account exists for <span className="font-medium text-ink">{email.trim()}</span>, a password reset link has been sent to it. The link expires after 1 hour.
              </p>
            </div>
          ) : (
            <Notice tone="med"><span role="status">{result.note}</span></Notice>
          )}
          {result.devResetToken && (
            <div className="caution-hatch rounded-ctl border border-caution/30 p-3">
              <p className="text-sm font-semibold text-[#8A5408]">Development only — never shown in production</p>
              <p className="mt-0.5 text-xs text-[#8A5408]">This server cannot send email, so the reset link is shown here instead.</p>
              <Link to={`/reset-password?token=${encodeURIComponent(result.devResetToken)}`} className="mt-2 inline-block text-sm font-medium text-signal hover:underline">Open development reset link</Link>
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <Link to="/login" className="inline-flex items-center gap-1 text-sm text-signal hover:underline"><ArrowLeft className="h-4 w-4" /> Back to sign in</Link>
            <Button variant="ghost" size="sm" onClick={() => setResult(null)}>Use a different email</Button>
          </div>
        </div>
      </AuthFrame>
    );
  }

  return (
    <AuthFrame title="Reset your password" subtitle="Enter your work email and we’ll send you a link to choose a new password.">
      <form onSubmit={submit} noValidate className="space-y-4">
        {formError && <Notice tone="crit">{formError}</Notice>}
        <Field label="Work email" htmlFor="fp-email" error={error} required>
          <Input id="fp-email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} aria-invalid={!!error} autoFocus />
        </Field>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Link to="/login" className="inline-flex items-center gap-1 text-sm text-signal hover:underline"><ArrowLeft className="h-4 w-4" /> Back to sign in</Link>
          <Button type="submit" variant="primary" loading={busy}>Send reset link</Button>
        </div>
      </form>
    </AuthFrame>
  );
}
