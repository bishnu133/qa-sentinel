import pc from "picocolors";

export const log = {
  info: (msg: string) => console.log(msg),
  step: (msg: string) => console.log(pc.cyan("›"), msg),
  ok: (msg: string) => console.log(pc.green("✓"), msg),
  warn: (msg: string) => console.log(pc.yellow("!"), msg),
  fail: (msg: string) => console.log(pc.red("✗"), msg),
  dim: (msg: string) => console.log(pc.dim(msg)),
  title: (msg: string) => console.log("\n" + pc.bold(msg)),
};
