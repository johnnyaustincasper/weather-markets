import { runPaperBotTickOnce } from './index.js';

const ledgerId = process.argv[2];
const ownerId = process.argv[3];

if (!ownerId?.trim()) {
  console.error('Missing ownerId. Usage: npm --prefix functions run tick:once -- <ledgerId> <ownerUid>');
  console.error('Use the Firebase Auth uid that owns the ledger document you want the backend runner to mutate.');
  process.exit(1);
}

runPaperBotTickOnce({ ledgerId, ownerId, trigger: 'script' })
  .then((summary) => {
    console.log(JSON.stringify(summary, null, 2));
    process.exit(0);
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exit(1);
  });
