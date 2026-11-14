import 'dotenv/config';
import { startApplication } from './bootstrap.js';

void startApplication().then(({ exitCode }) => {
  if (exitCode !== 0) process.exitCode = exitCode;
});
