import { useQuery } from '@tanstack/react-query';
import { Link, createFileRoute } from '@tanstack/react-router';
import { Card } from '@/components/ui';
import { queries } from '@/lib/api';

export const Route = createFileRoute('/')({
  component: Home,
});

function Home() {
  const { data, isLoading } = useQuery(queries.readiness());

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <h1 className="text-3xl font-semibold tracking-tight">It works.</h1>
        <p className="max-w-prose text-zinc-600 dark:text-zinc-400">
          React + TanStack Router/Query + Tailwind, talking to an Express API backed by Postgres, all running in your
          local Kubernetes namespace. Start with the{' '}
          <Link to="/todos" className="font-medium text-zinc-900 underline underline-offset-4 dark:text-white">
            todos example
          </Link>
          , then replace it with the assignment.
        </p>
      </section>

      <Card>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-medium">System status</h2>
          <span className="text-xs text-zinc-500">refreshes every 10s</span>
        </div>
        {isLoading ? (
          <p className="text-sm text-zinc-500">Checking…</p>
        ) : !data ? (
          <StatusRow name="api" ok={false} detail="unreachable or degraded" />
        ) : (
          <ul className="space-y-2">
            <StatusRow name={data.service} ok={data.status === 'ok'} detail={`up ${data.uptimeSeconds}s`} />
            {Object.entries(data.checks).map(([name, check]) => (
              <StatusRow key={name} name={`└ ${name}`} ok={check.ok} detail={check.error} />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function StatusRow({ name, ok, detail }: { name: string; ok: boolean; detail?: string }) {
  return (
    <li className="flex items-center gap-3 font-mono text-sm">
      <span className={`size-2 rounded-full ${ok ? 'bg-emerald-500' : 'bg-red-500'}`} aria-hidden />
      <span>{name}</span>
      <span className="ml-auto text-zinc-500">{detail ?? (ok ? 'ok' : 'failing')}</span>
    </li>
  );
}
