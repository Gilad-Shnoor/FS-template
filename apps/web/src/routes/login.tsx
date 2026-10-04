import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useRouter } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { z } from 'zod';
import { Button, Card, ErrorText, Input } from '@/components/ui';
import { authClient } from '@/lib/auth';

export const Route = createFileRoute('/login')({
  validateSearch: z.object({ redirect: z.string().optional() }),
  component: Login,
});

function Login() {
  const { redirect } = Route.useSearch();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<'signIn' | 'signUp'>('signIn');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const email = String(form.get('email'));
    const password = String(form.get('password'));
    setPending(true);
    setError(null);

    const result =
      mode === 'signIn'
        ? await authClient.signIn.email({ email, password })
        : await authClient.signUp.email({ email, password, name: String(form.get('name') || email.split('@')[0]) });

    setPending(false);
    if (result.error) {
      setError(result.error.message ?? 'Authentication failed');
      return;
    }
    await queryClient.invalidateQueries({ queryKey: ['me'] });
    // `redirect` is the full href captured by the _authed guard, so go through history.
    router.history.push(redirect ?? '/todos');
  };

  return (
    <div className="mx-auto max-w-sm">
      <Card>
        <h1 className="mb-1 text-xl font-semibold">{mode === 'signIn' ? 'Sign in' : 'Create an account'}</h1>
        <p className="mb-6 text-sm text-zinc-500">Email and password, powered by Better Auth.</p>
        <form onSubmit={onSubmit} className="space-y-3">
          {mode === 'signUp' && <Input name="name" placeholder="Name" autoComplete="name" />}
          <Input name="email" type="email" placeholder="you@example.com" autoComplete="email" required />
          <Input
            name="password"
            type="password"
            placeholder="Password (8+ characters)"
            autoComplete={mode === 'signIn' ? 'current-password' : 'new-password'}
            minLength={8}
            required
          />
          <ErrorText>{error}</ErrorText>
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? 'Please wait…' : mode === 'signIn' ? 'Sign in' : 'Sign up'}
          </Button>
        </form>
        <button
          type="button"
          onClick={() => setMode(mode === 'signIn' ? 'signUp' : 'signIn')}
          className="mt-4 w-full text-center text-sm text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
        >
          {mode === 'signIn' ? "Don't have an account? Sign up" : 'Already have an account? Sign in'}
        </button>
      </Card>
    </div>
  );
}
