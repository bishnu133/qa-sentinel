export { ConfigSchema, loadConfig, writeConfig, type Config } from "./config.js";
export { detectProject, discoverServices } from "./detect.js";
export { initCommand } from "./commands/init.js";
export { gapReportCommand } from "./commands/gapReport.js";
export { generateCommand } from "./commands/generate.js";
export { learnCommand } from "./commands/learn.js";
export { runChecks } from "./commands/doctor.js";
