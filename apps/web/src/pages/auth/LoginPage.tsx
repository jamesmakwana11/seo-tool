import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { Eye } from 'lucide-react';
import { DEMO_PASSWORD, ROLE_LABELS, type Role } from '@sentinel/shared';
import { useAuth } from '@/auth/AuthContext';
import { API_MODE } from '@/api/client';
import { errorMessage } from '@/api/hooks';
import { Button, Field, Input, Notice } from '@/components/ui/primitives';
import { AuthFrame } from './AuthFrame';

/** In-browser demo build only: the form starts filled with the demo Admin, so "Sign in" works with one click. */
const DEMO_MODE = API_MODE === 'mock';
const DEMO_ADMIN_EMAIL = 'aarav.admin@demo.deodap.local';

export default function LoginPage() {
  const { user, login, previewAs } = useAuth();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const [email, setEmail] = useState(DEMO_MODE ? DEMO_ADMIN_EMAIL : '');
  const [password, setPassword] = useState(DEMO_MODE ? DEMO_PASSWORD : '');
  const [errors, setErrors] = useState<{ email?: string; password?: string; form?: string }>({});
  const [busy, setBusy] = useState<string | null>(null);
  const next = params.get('next') || '/';
  if (user) return <Navigate to={next} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const errs: typeof errors = {};
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) errs.email = 'Enter your work email address.';
    if (!password) errs.password = 'Enter your password.';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy('login');
    try {
      await login(email.trim(), password);
      nav(next, { replace: true });
    } catch (err) {
      setErrors({ form: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  const preview = async (r: Role) => {
    setBusy(r);
    try {
      await previewAs(r);
      nav('/', { replace: true });
    } catch (err) {
      setErrors({ form: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <AuthFrame title="Sign in" subtitle="DeoDap SEO Sentinel — internal SEO operations">
      <form onSubmit={submit} noValidate className="space-y-4">
        {errors.form && <Notice tone="crit">{errors.form}</Notice>}
        <Field label="Work email" htmlFor="email" error={errors.email} required>
          <Input id="email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} aria-invalid={!!errors.email} autoFocus />
        </Field>
        <Field label="Password" htmlFor="password" error={errors.password} required>
          <Input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} aria-invalid={!!errors.password} />
        </Field>
        <div className="flex items-center justify-between">
          <Link to="/forgot-password" className="text-sm text-signal hover:underline">Forgot password?</Link>
          <Button type="submit" variant="primary" loading={busy === 'login'}>Sign in</Button>
        </div>
      </form>

      {(DEMO_MODE || import.meta.env.DEV) && (
        <div className="mt-6 border-t border-line pt-5">
          <div className="demo-hatch rounded-ctl border border-demo/30 p-3">
            <p className="text-sm font-semibold text-[#8A5408]">Development role preview</p>
            <p className="mt-0.5 text-xs text-[#8A5408]">Mock users for previewing each role. This is not production authentication and nothing persists.</p>
            <div className="mt-3 grid gap-2 sm:grid-cols-3">
              {(['admin', 'seo_specialist', 'developer'] as Role[]).map((r) => (
                <Button key={r} size="sm" icon={<Eye className="h-3.5 w-3.5" />} loading={busy === r} onClick={() => preview(r)}>
                  {ROLE_LABELS[r]}
                </Button>
              ))}
            </div>
            <p className="mt-2 text-xs text-[#8A5408]">{DEMO_MODE ? 'The form above is already filled with the demo Admin — just click Sign in. ' : 'These buttons work only when the server was started with SEED_DEMO_DATA=true. '}Any demo employee (e.g. <span className="font-mono">ritesh.seo@demo.deodap.local</span>) uses the password <span className="font-mono">{DEMO_PASSWORD}</span>.</p>
          </div>
        </div>
      )}
    </AuthFrame>
  );
}
