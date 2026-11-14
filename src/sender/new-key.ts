import { existsSync } from 'node:fs';
import { appendFile, readFile } from 'node:fs/promises';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

/**
 * Creates the sender's key and stores it in .env, which git ignores. It prints only the address,
 * and refuses to run if a key exists, because replacing one would lose the money it holds.
 */

const ENV_FILE = '.env';
const VARIABLE = 'SENDER_PRIVATE_KEY';

const existing = existsSync(ENV_FILE) ? await readFile(ENV_FILE, 'utf8') : '';
const line = existing.split(/\r?\n/).find((entry) => entry.startsWith(`${VARIABLE}=`));
if (line) {
  const address = privateKeyToAccount(line.slice(VARIABLE.length + 1).trim() as `0x${string}`).address;
  console.log(`Ключ уже есть, новый не создан. Адрес отправителя: ${address}`);
} else {
  const key = generatePrivateKey();
  await appendFile(ENV_FILE, `${existing === '' || existing.endsWith('\n') ? '' : '\n'}${VARIABLE}=${key}\n`);
  console.log(`Ключ создан и сохранён в ${ENV_FILE}. Адрес отправителя: ${privateKeyToAccount(key).address}`);
}
console.log('Держи на этом адресе только небольшой запас на газ: это предел возможной потери.');
