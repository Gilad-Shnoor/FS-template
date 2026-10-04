import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { Link, Outlet, createRootRouteWithContext, useRouter } from '@tanstack/react-router';
import { TanStackRouterDevtools } from '@tanstack/react-router-devtools';
import { Button } from '@/components/ui';
import { queries } from '@/lib/api';
import { authClient } from '@/lib/auth';

export interface RouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
});

function RootLayout() {
  return (
    <div className="flex min-h-dvh flex-col">
      <Header />
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10">
        <Outlet />
      </main>
      {import.meta.env.DEV && (
        <>
          <TanStackRouterDevtools position="bottom-right" />
          <ReactQueryDevtools buttonPosition="bottom-left" />
        </>
      )}
    </div>
  );
}

function Header() {
  const { data: me } = useQuery(queries.me());
  const queryClient = useQueryClient();
  const router = useRouter();

  const signOut = async () => {
    await authClient.signOut();
    await queryClient.invalidateQueries();
    await router.navigate({ to: '/' });
  };

  const navLink =
    'rounded-md px-2.5 py-1.5 text-sm text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100 [&.active]:font-medium [&.active]:text-zinc-900 dark:[&.active]:text-white';

  return (
    <header className="border-b border-zinc-200 bg-white/80 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/80">
      <div className="mx-auto flex h-14 max-w-3xl items-center gap-2 px-4">
        <Link to="/" className="mr-4 font-semibold tracking-tight">
          FS Template
        </Link>
        <Link to="/" className={navLink} activeOptions={{ exact: true }}>
          Home
        </Link>
        <Link to="/todos" className={navLink}>
          Todos
        </Link>
        <div className="ml-auto flex items-center gap-3 text-sm">
          {me?.user ? (
            <>
              <span className="hidden text-zinc-500 sm:inline">{me.user.email}</span>
              {me.authEnabled && (
                <Button variant="ghost" onClick={signOut}>
                  Sign out
                </Button>
              )}
            </>
          ) : (
            <Link to="/login" className={navLink}>
              Sign in
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}
