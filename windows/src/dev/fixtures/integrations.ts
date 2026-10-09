// Fixture integration data for mock mode (see plan-v2.md § 0.2).
//
// Shapes match what `views/integrations.ts` reads via `get(id)`/`arr(id, key)`
// — field names are load-bearing, not decorative, so they are copied from the
// real poller payloads rather than invented.

const now = Date.now();
const minutesAgo = (n: number) => now - n * 60_000;

/** Which pills are "on" — drives `others.length > 0` in views.ts, i.e. whether
 *  the overview's right card shows the services grid instead of consoles. */
export const MOCK_ACTIVE_INTEGRATIONS = [
  "integration_n8n",
  "integration_vercel",
  "integration_github",
  "integration_stripe",
];

export const MOCK_INTEGRATION_DATA: Record<string, Record<string, unknown>> = {
  integration_n8n: {
    runs: [
      { workflow: "Nightly backup", status: "success", startedAt: minutesAgo(12) },
      { workflow: "Lead sync", status: "success", startedAt: minutesAgo(40) },
    ],
  },
  integration_vercel: {
    deployments: [
      {
        projectName: "verifikame-web",
        state: "READY",
        branch: "main",
        commitMessage: "fix: carrusel de proveedores en móvil",
        url: "verifikame-web.vercel.app",
        createdAt: minutesAgo(8),
      },
      {
        projectName: "coucou-site",
        state: "READY",
        branch: "main",
        commitMessage: "docs: plan v2",
        url: "coucou.app",
        createdAt: minutesAgo(190),
      },
      {
        projectName: "verifikame-web",
        state: "ERROR",
        branch: "feat/pagos",
        commitMessage: "wip: integración de pagos",
        url: "verifikame-web-git-feat-pagos.vercel.app",
        createdAt: minutesAgo(400),
      },
    ],
  },
  integration_github: {
    totalStars: 128,
    totalRepos: 14,
  },
  integration_stripe: {
    balance: 184230,
    currency: "eur",
    payments: [
      { description: "Plan Pro — Verifikame", status: "succeeded", amount: 2900 },
      { description: "Plan Pro — Verifikame", status: "succeeded", amount: 2900 },
      { description: "Reembolso", status: "failed", amount: 1200 },
    ],
  },
  integration_resend: {
    total: 342,
    emails: [
      { to: ["diego@example.com"], subject: "Bienvenido a Coucou", lastEvent: "delivered", createdAt: minutesAgo(5) },
      { to: ["proveedor@example.com"], subject: "Verificación pendiente", lastEvent: "delivered", createdAt: minutesAgo(50) },
    ],
  },
};
