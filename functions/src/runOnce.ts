import { runPaperBotTickOnce } from './index.js';

const ledgerId = process.argv[2];
const ownerId = process.argv[3];

runPaperBotTickOnce({ ledgerId, ownerId })
  .then((summary) => {
    console.log(JSON.stringify(summary, null, 2));
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  });
