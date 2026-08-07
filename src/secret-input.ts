/** Terminal input helpers for credentials that must never be echoed or put in argv. */

import { readFileSync } from 'node:fs';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';

export function createSecretOutput(output: NodeJS.WritableStream = stdout) {
  let muted = false;
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) output.write(chunk);
      callback();
    },
  });

  return {
    stream,
    async question(rl: { question(q: string): Promise<string> }, prompt: string): Promise<string> {
      output.write(prompt);
      muted = true;
      try {
        return (await rl.question('')).trim();
      } finally {
        muted = false;
        output.write('\n');
      }
    },
  };
}

/** Read from a no-echo TTY prompt, or from stdin when piped/redirected. */
export async function readSecret(prompt: string): Promise<string> {
  if (!stdin.isTTY) return readFileSync(0, 'utf8').trim();

  const secretOutput = createSecretOutput(stdout);
  const rl = createInterface({
    input: stdin,
    output: secretOutput.stream,
    terminal: true,
  });
  try {
    return await secretOutput.question(rl, prompt);
  } finally {
    rl.close();
  }
}
