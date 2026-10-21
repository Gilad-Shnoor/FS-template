import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In the cluster the browser reaches Vite through the gateway on port 80 (http://app.localhost),
// so HMR must connect back on that port: VITE_HMR_CLIENT_PORT=80 is set by the generated Deployment.
// Outside the cluster (`npm run dev:local -w apps/web`, i.e. `vite --mode host`), /api is proxied
// to the cluster's gateway (VITE_API_PROXY overrides it). The proxy connects to 127.0.0.1 and sets
// Host itself, because Node on Windows doesn't resolve *.localhost, and it presents the gateway's
// origin so Better Auth (TRUSTED_ORIGINS) accepts sign-in from http://localhost:5173.
const hmrClientPort = process.env.VITE_HMR_CLIENT_PORT ? Number(process.env.VITE_HMR_CLIENT_PORT) : undefined;

export default defineConfig(({ mode }) => {
  const apiProxy = process.env.VITE_API_PROXY ?? (mode === 'host' ? 'http://app.localhost' : undefined);
  const proxyTarget = apiProxy ? new URL(apiProxy) : undefined;
  const connectTo = proxyTarget?.hostname.endsWith('localhost')
    ? `${proxyTarget.protocol}//127.0.0.1:${proxyTarget.port || 80}`
    : apiProxy;

  return {
    plugins: [tanstackRouter({ target: 'react', autoCodeSplitting: true }), react(), tailwindcss()],
    resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
    server: {
      host: '0.0.0.0',
      port: 5173,
      strictPort: true,
      allowedHosts: true,
      hmr: hmrClientPort ? { clientPort: hmrClientPort } : undefined,
      proxy: proxyTarget
        ? {
            '/api': {
              target: connectTo,
              headers: { host: proxyTarget.host, origin: proxyTarget.origin },
            },
          }
        : undefined,
    },
  };
});
