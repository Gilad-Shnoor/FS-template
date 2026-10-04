import { Outlet, createFileRoute, redirect } from '@tanstack/react-router';
import { queries } from '@/lib/api';

/** Pathless layout: every route under routes/_authed/ requires a signed-in user. */
export const Route = createFileRoute('/_authed')({
  beforeLoad: async ({ context, location }) => {
    const me = await context.queryClient.ensureQueryData(queries.me());
    if (!me.user) {
      throw redirect({ to: '/login', search: { redirect: location.href } });
    }
    return { user: me.user };
  },
  component: Outlet,
});
