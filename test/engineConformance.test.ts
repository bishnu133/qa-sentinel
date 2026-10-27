import path from "node:path";
import { describeEngineConformance } from "./helpers/engineConformance.js";
import { CommandEngine } from "../src/engines/CommandEngine.js";

const fixture = path.resolve(__dirname, "fixtures/engine-fixture.mjs");
const node = JSON.stringify(process.execPath);

// The same four situations against the command engine, with a scripted program. Nothing here calls a model.
describeEngineConformance("command engine, task on stdin", () => new CommandEngine({ command: `${node} ${JSON.stringify(fixture)}` }));
describeEngineConformance("command engine, with a {taskFile} argument too", () => new CommandEngine({ command: `${node} ${JSON.stringify(fixture)} {taskFile}` }), { skipTimeout: true });
