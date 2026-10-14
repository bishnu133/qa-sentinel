/** Mute console.log while library code runs. Reference-counted, so parallel jobs can't leave it muted. */
const realLog = console.log;
let depth = 0;
export async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  if (depth++ === 0) console.log = () => {};
  try {
    return await fn();
  } finally {
    if (--depth === 0) console.log = realLog;
  }
}
