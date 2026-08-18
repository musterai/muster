// File: src/index.ts
//
// Direct entry point for `npm run dev` / `npm start` / `node dist/index.js`.
// Equivalent to `muster serve` — see src/cli.ts for the full serve/connect/
// login/logout dispatcher. Kept as a thin wrapper so this exact invocation
// keeps working unchanged.

import { startServer } from './server.js';

function exitFatal(message: string): never {
  console.error(message);
  process.exit(1);
}

function parseAndValidateDbOption(): string | undefined {
  const argv = process.argv.slice(2);
  let dbOption: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--db' || arg === '--db-name' || arg === '--database' || arg === '-d') {
      const next = argv[i + 1];
      if (!next || next.startsWith('-')) {
        exitFatal(`Error: ${arg} option requires a database name or file path (e.g. --db myproject).`);
      }
      dbOption = next;
      i++;
    } else if (arg.startsWith('--db=') || arg.startsWith('--db-name=') || arg.startsWith('--database=')) {
      dbOption = arg.split('=')[1];
      if (!dbOption) {
        exitFatal(`Error: ${arg} option requires a database name or file path.`);
      }
    } else if (arg.startsWith('-')) {
      exitFatal(`Error: Unknown option "${arg}". Valid database options: --db, --db-name, --database, -d`);
    }
  }

  return dbOption;
}

startServer({ db: parseAndValidateDbOption() }).catch((err) => {
  console.error(err);
  process.exit(1);
});
