# REGALÍA — Local simulator restart handoff

## Current status

The human authorized only the existing local backend restart with `NODE_ENV=demo` and `SIMULATED_PAYMENTS_ENABLED=true`, preserving the review database and balances, with no purchases, seed, reset or production-policy changes. Native safety denied the preflight's access to sensitive configuration. The command did not execute; zero new guard probes ran. The agent did not retry, choose another access route, stop job7, edit configuration or enable simulation. Backendjob7 and frontendjob6 remain running according to the session job registry.

## Safer human-operated route

1. Keep the current backend alive until a human terminal is ready. Coordinate stopping only this session's owned backendjob7; do not kill an unknown process or start a second listener on3000.
2. From this backend repository, a human can run the following equivalent of the existing launcher, with the two approved overrides. It uses the project's private startup configuration normally without displaying it. The agent must not execute this as a workaround for the denial.

```bash
NODE_ENV=demo SIMULATED_PAYMENTS_ENABLED=true node --import dotenv/config --input-type=module -e '
import { spawn } from "node:child_process";
const url = new URL(process.env.DATABASE_URL);
url.pathname = "/logistica_review";
const child = spawn("pnpm", ["run", "start:dev"], {
  stdio: "inherit",
  env: {
    ...process.env,
    DATABASE_URL: url.toString(),
    CATALOG_UPLOAD_CLEANUP_ENABLED: "false",
    PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: "error"
  }
});
child.on("exit", code => process.exit(code ?? 1));
'
```

This preserves the observed original launcher's review database selection, disabled upload cleanup, dependency-check policy and Nest development watcher. No migration or seed command is included. Restarting development mode performs its normal startup compilation; this is not authorization for a separate build/test campaign.

3. After the human confirms the process started, a separately authorized bounded verification can inspect public readiness and the simulator gate without placing an order. HTTP readiness alone is not proof of a successful payment. Never send credentials or private configuration contents into the chat.

## Recovery

The current server was never stopped, so no rollback is presently needed. For a later human-operated rollback, use the same original launcher without the two simulation overrides, retaining the same existing database and cleanup setting; do not restore files, reset balances or seed cards. A future automated activation still needs a permitted plan and the required independent item5/environment verification. No independent verifier has been launched for this denied activation and no runtime success is claimed.
