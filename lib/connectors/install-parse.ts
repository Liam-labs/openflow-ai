/**
 * Which catalog install commands the app may run for the person instead of making them copy and paste.
 * Only two shapes qualify, and they are run as an argument list with no shell: `npm install -g <package>` and
 * `docker run ...` that publishes to this computer only and mounts nothing from the disk. Anything else
 * (a `curl | sh` line, a sign-in command) stays a command to copy.
 */
const PACKAGE = /^@?[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)?$/;
const WORD = /^[A-Za-z0-9@._:/=-]+$/;
const FLAGS_OK = new Set(['-d', '--name', '-p', '-v', '--restart']);

export function installArgv(command: string | undefined): string[] | null {
  if (!command || /[|&;<>$`'"\\*(){}\n]/.test(command)) return null;
  const argv = command.trim().split(/\s+/);
  if (!argv.every((w) => WORD.test(w))) return null;
  if (argv[0] === 'npm') {
    return argv.length === 4 && argv[1] === 'install' && argv[2] === '-g' && PACKAGE.test(argv[3]) ? argv : null;
  }
  if (argv[0] === 'docker' && argv[1] === 'run') {
    const rest = argv.slice(2);
    let i = 0;
    while (i < rest.length && rest[i].startsWith('-')) {
      const flag = rest[i];
      if (!FLAGS_OK.has(flag)) return null;
      if (flag === '-d') { i += 1; continue; }
      const value = rest[i + 1];
      if (value === undefined) return null;
      if (flag === '-p' && !/^127\.0\.0\.1:\d+:\d+$/.test(value)) return null;
      // A named volume only: a path on the disk would give the container a way into the person's files.
      if (flag === '-v' && !/^[A-Za-z0-9][A-Za-z0-9_.-]*:\/[A-Za-z0-9/._-]+$/.test(value)) return null;
      i += 2;
    }
    return rest.length - i === 1 && /^[a-z0-9][a-z0-9._/-]*(:[A-Za-z0-9._-]+)?$/.test(rest[i]) ? argv : null;
  }
  return null;
}
