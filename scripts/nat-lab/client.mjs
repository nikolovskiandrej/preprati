// NAT lab device: drives the real preprati. app in headless Chrome, as the
// receiving host or the sending guest, and records what happened and what the
// app told the user. Runs inside a lab container's network namespace (see lab.sh).
//
//   node client.mjs <host|guest> <app url> <tag> [timeout s] [payload MB] [retry|relay]
//
// Nobody presses anything to get connected: when a direct attempt fails, the
// app recovers on its own (relay mode, or one more attempt), and the devices
// record whether an error was ever shown on the way. With "retry": after the
// failure is finally shown, wait for <dir>/go-retry-<tag>, then the guest
// presses "Try again". Each device writes <dir>/recovering-<tag>-<role> when
// it first says it is trying another way. Files are exchanged through <dir>
// (LAB_DIR, default /tmp: the lab's shared results directory inside the
// container).
/* global window -- the init script and evaluate callbacks run in the page */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const { chromium } = await import(`${process.env.PROJECT}/node_modules/playwright-core/index.mjs`);
const [role, base, tag, timeoutSec = '75', payloadMb = '2', mode = ''] = process.argv.slice(2);
const dir = process.env.LAB_DIR ?? '/tmp';
const timeout = Number(timeoutSec) * 1000;
const started = Date.now();
const result = { role, tag, outcome: 'unknown', said: [], events: [] };
const mark = (event) =>
  result.events.push(`${((Date.now() - started) / 1000).toFixed(1)}s ${event}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitForFile = async (file, ms) => {
  for (let waited = 0; waited < ms && !existsSync(file); waited += 200) await sleep(200);
};

const browser = await chromium.launch({
  executablePath: process.env.CHROME_BIN,
  headless: true,
  args: [
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--disable-crash-reporter',
    `--unsafely-treat-insecure-origin-as-secure=${base}`,
  ],
});
const context = await browser.newContext({ acceptDownloads: true });
// Keep an ICE log (candidates, states) for the report.
await context.addInitScript(() => {
  const Native = window.RTCPeerConnection;
  window.__iceLogs = [];
  window.RTCPeerConnection = class extends Native {
    constructor(...args) {
      super(...args);
      const log = [];
      window.__iceLogs.push(log);
      const t0 = performance.now();
      const at = () => `${((performance.now() - t0) / 1000).toFixed(1)}s`;
      const short = (candidate) => candidate.split(' generation')[0];
      this.addEventListener('icecandidate', (event) => {
        if (event.candidate) log.push(`${at()} local ${short(event.candidate.candidate)}`);
      });
      this.addEventListener('iceconnectionstatechange', () =>
        log.push(`${at()} ice ${this.iceConnectionState}`),
      );
      const add = this.addIceCandidate.bind(this);
      this.addIceCandidate = (candidate) => {
        if (candidate?.candidate) log.push(`${at()} remote ${short(candidate.candidate)}`);
        return add(candidate);
      };
    }
  };
});
const page = await context.newPage();

const connected = page.getByText(/Direct connection|Relayed connection|Through preprati\./).first();
const failure = page.getByText(/Couldn’t connect the devices|Disconnected/).first();
const recovering = page
  .getByText(/preprati\. is trying another way|A direct connection wasn’t possible/)
  .first();

async function describeFailure() {
  const text = await page
    .locator('[role=alert]')
    .filter({ hasText: 'Couldn’t connect' })
    .first()
    .innerText()
    .catch(() => '');
  const details = page.getByText('Connection details');
  if (await details.isVisible().catch(() => false)) {
    await details.click();
    result.details = (await page.locator('details dl > div').allInnerTexts()).map((row) =>
      row.replace(/\s*\n\s*/g, ': '),
    );
  }
  result.buttons = await page.locator('main button').allInnerTexts();
  return text.replace(/\s+/g, ' ');
}

const connectOrFail = () =>
  Promise.race([
    connected
      .waitFor({ timeout })
      .then(async () => `connected (${(await connected.textContent()).trim()})`),
    failure.waitFor({ timeout }).then(async () => `failed: ${await describeFailure()}`),
  ]).catch(() => 'timed out');

let sawReconnecting = false;
let sawRecovering = false;
let sawFailure = false;
const watcher = setInterval(async () => {
  const visible = await page
    .getByText('Connection interrupted. Reconnecting…')
    .isVisible()
    .catch(() => false);
  if (visible && !sawReconnecting) mark('showed "Connection interrupted. Reconnecting…"');
  sawReconnecting ||= visible;
  if (!sawRecovering && (await recovering.isVisible().catch(() => false))) {
    sawRecovering = true;
    mark(`said "${(await recovering.textContent().catch(() => '')).slice(0, 60)}…"`);
    writeFileSync(`${dir}/recovering-${tag}-${role}`, '');
  }
  if (!sawFailure && (await failure.isVisible().catch(() => false))) {
    sawFailure = true;
    mark('showed an error');
  }
}, 250);

async function connect() {
  let outcome = await connectOrFail();
  mark(outcome);
  if (outcome.startsWith('failed') && mode === 'retry') {
    result.said.push(outcome);
    writeFileSync(`${dir}/failed-${tag}-${role}`, '');
    await waitForFile(`${dir}/go-retry-${tag}`, 120_000);
    if (role === 'guest') {
      await page.getByRole('button', { name: 'Try again' }).click();
      result.pressed = (result.pressed ?? 0) + 1;
      mark('pressed "Try again"');
    }
    // The new attempt replaces the failure view (the host's once the guest's request arrives).
    await failure.waitFor({ state: 'hidden', timeout: 30_000 }).catch(() => undefined);
    outcome = await connectOrFail();
    mark(`after "Try again": ${outcome}`);
  }
  return outcome;
}

async function receive(route) {
  await page.getByRole('button', { name: 'Accept' }).click({ timeout: 60_000 });
  await page.getByText(/1 file received from/).waitFor({ timeout: 180_000 });
  const download = page.waitForEvent('download');
  await page
    .getByRole('button', { name: /^Save: / })
    .first()
    .click();
  const bytes = readFileSync(await (await download).path());
  result.receivedSha256 = createHash('sha256').update(bytes).digest('hex');
  mark('file received');
  return `received the file ${route}`;
}

function payload() {
  const file = `${dir}/payload-${tag}.bin`;
  const data = randomBytes(Math.round(Number(payloadMb) * 1_000_000));
  writeFileSync(file, data);
  result.sentSha256 = createHash('sha256').update(data).digest('hex');
  return file;
}

try {
  const codeFile = `${dir}/code-${tag}`;
  if (role === 'host') {
    await page.goto(`${base}/receive`);
    const code = page.getByTestId('pairing-code');
    await code.waitFor({ timeout: 20_000 });
    writeFileSync(codeFile, (await code.textContent()).replace('-', '').trim());
    result.outcome = await connect();
    if (result.outcome.startsWith('connected')) {
      const route = result.outcome.replace(/^connected \((.*)\)$/, '$1');
      result.outcome = await receive(
        route === 'Through preprati.' ? 'through preprati.' : `over a ${route.toLowerCase()}`,
      );
    }
  } else {
    await waitForFile(codeFile, 60_000);
    await page.goto(`${base}/j/${readFileSync(codeFile, 'utf8').trim()}`);
    result.outcome = await connect();
    if (result.outcome.startsWith('connected')) {
      await page.locator('input[type=file]').setInputFiles(payload());
      await page.getByRole('button', { name: 'Send 1 file' }).click();
      writeFileSync(`${dir}/sending-${tag}`, '');
      await page.getByText(/Sent! 1 file delivered to/).waitFor({ timeout: 180_000 });
      result.outcome = result.outcome.includes('Through preprati.')
        ? `sent ${payloadMb} MB through preprati.`
        : `sent ${payloadMb} MB`;
      mark('file sent');
    }
  }
  if (result.outcome.startsWith('failed') && !result.said.includes(result.outcome))
    result.said.push(result.outcome);
} catch (error) {
  result.outcome = `error: ${String(error.message).split('\n')[0]}`;
}
clearInterval(watcher);
result.reconnecting = sawReconnecting;
result.recovering = sawRecovering;
result.showedError = sawFailure;
result.ice = await page.evaluate(() => window.__iceLogs).catch(() => []);
writeFileSync(`${dir}/result-${tag}-${role}.json`, JSON.stringify(result, null, 2));
await browser.close();
