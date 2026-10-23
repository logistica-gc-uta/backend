export {
  createOwnedDatabase, runPrismaMigrate, runPrismaVerify, execPsqlCommand,
  startOwnedContainer, cleanupOwnedResources, createScratchFile,
  backupOwnedDatabase, restoreOwnedDatabase,
} from './geolocation-migration.fixtures.js';

export const CATALOG_ORIGIN = 'eb8ebd14b89f17eea5458cd12220be7bd572fa8f0e3771b68d2089c880e18f83';
export const CATALOG_CURRENT = 'b263aff9f248d0da2ead5a0700a5b035ab3653ec79e1f8c651ab5f936e21e1ea';
