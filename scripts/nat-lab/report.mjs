// Prints what both lab devices experienced in one scenario.
//   node report.mjs <results dir> <tag> [--ice]
import { existsSync, readFileSync } from 'node:fs';

const [dir, tag, flag] = process.argv.slice(2);
const read = (role) => {
  const file = `${dir}/result-${tag}-${role}.json`;
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
};
const host = read('host');
const guest = read('guest');

for (const [label, result] of [
  ['A (receiving host)', host],
  ['B (sending guest) ', guest],
]) {
  if (!result) {
    console.log(`  ${label}: no result`);
    continue;
  }
  console.log(`  ${label}: ${result.outcome.slice(0, 120)}`);
  for (const said of result.said) console.log(`      app said: ${said.replace(/^failed: /, '')}`);
  if (result.details) console.log(`      details:  ${result.details.join(' | ')}`);
  if (result.reconnecting) console.log('      showed "Connection interrupted. Reconnecting…"');
  console.log(
    `      recovered on its own: ${result.recovering ? 'yes' : 'no'} · error shown: ${result.showedError ? 'yes' : 'no'} · buttons pressed to connect: ${result.pressed ?? 0}`,
  );
  console.log(`      timeline: ${result.events.join(' → ')}`);
  if (flag === '--ice')
    result.ice.forEach((log, index) =>
      console.log(`      ICE #${index + 1}:\n        ${log.join('\n        ')}`),
    );
}
if (host?.receivedSha256 && guest?.sentSha256)
  console.log(
    `  file: ${host.receivedSha256 === guest.sentSha256 ? 'byte-identical (SHA-256 match)' : 'CORRUPTED (SHA-256 mismatch)'}`,
  );
