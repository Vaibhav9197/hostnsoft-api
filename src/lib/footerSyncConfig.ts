/**
 * Config for the footer sync — see src/services/footerSync.ts. Defaults
 * are sensible, so these are soft-configurable like orphanConfig.ts.
 */
import { envNumber } from "./env";

// How often every company's plan is re-checked. Catches what no route of
// ours sees: a downgrade or cancel taking effect at period end in Lago, a
// failed payment, a plan edited in the Lago console.
export const FOOTER_SYNC_INTERVAL_MS: number = envNumber("FOOTER_SYNC_INTERVAL_MS", 6 * 60 * 60 * 1000);

// A company whose plan hasn't changed is still re-applied this often, to
// repair anything a single push missed (e.g. an app deployed while Lago
// was unreachable, which deploys without the footer).
export const FOOTER_SYNC_REFRESH_MS: number = envNumber("FOOTER_SYNC_REFRESH_MS", 24 * 60 * 60 * 1000);

// Pause after each full config push, which restarts a container app.
// Keeps a big first run (every app before it has the flag mount) from
// restarting many apps at once.
export const FOOTER_SYNC_PUSH_GAP_MS: number = envNumber("FOOTER_SYNC_PUSH_GAP_MS", 5000);
