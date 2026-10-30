import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '@/auth/AuthContext';
import { errorMessage } from '@/api/hooks';
import { Button, Field, Input, Notice } from '@/components/ui/primitives';
import { AuthFrame } from './AuthFrame';

export default function LoginPage() {
  const { user, login } = useAuth();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
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

    </AuthFrame>
  );
}
