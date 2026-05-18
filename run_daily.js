const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { sendWebhookUpdate } = require('./discord_utils');

function runScraper() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scraper.js'], {
      cwd: __dirname,
      stdio: 'inherit'
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`scraper.js exited with code ${code}`));
    });
  });
}

async function main() {
  await runScraper();

  const townsPath = path.join(__dirname, 'towns.json');
  const townsData = JSON.parse(fs.readFileSync(townsPath, 'utf8')).towns || [];

  await sendWebhookUpdate(townsData);
  console.log(`Daily run finished with ${townsData.length} towns.`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
