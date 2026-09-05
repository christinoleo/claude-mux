/** POSIX single-quoting; safe for any byte a shell might otherwise read. */
export function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_./=:@%+,-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}
