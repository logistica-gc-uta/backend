import 'dotenv/config';
import { db } from './db.js';
import { seedProductionAdmin } from './prod-admin-seed.js';

async function main() {
  const result = await seedProductionAdmin(db, process.env);
  if (result.status === 'created') {
    console.log(`Production ADMIN seeded: ${result.email} (${result.userId})`);
    return;
  }
  console.log(`Production ADMIN seed skipped (${result.reason}): ${result.email}`);
}

main()
  .catch((error) => {
    console.error(
      'Production ADMIN seed failed:',
      error instanceof Error ? error.message : String(error),
    );
    process.exitCode = 1;
  })
  .finally(() => db.close());
