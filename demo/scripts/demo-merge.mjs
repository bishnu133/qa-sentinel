#!/usr/bin/env node
// Play the developer for a STORY card: make the change, open the merge request, optionally merge it.
//   WRITES TO GITLAB (with --yes). Each pipeline it starts can COST AI MONEY (see the messages it prints).
//
//   node demo/scripts/demo-merge.mjs --card delivery-slot                 # dry run: checks that the change fits, writes nothing
//   node demo/scripts/demo-merge.mjs --card delivery-slot --yes           # branch + commit + merge request
//   node demo/scripts/demo-merge.mjs --card delivery-slot --yes --merge   # ... and merge it (squash)
//   node demo/scripts/demo-merge.mjs --card cancel-refund --part payments-service --yes --merge   # a card with two parts
import { isMain, runCli } from "./lib.mjs";
import { runChangeFlow } from "./flow.mjs";

export const demoMerge = (o) => runChangeFlow({ ...o, kind: "story" });
if (isMain(import.meta.url)) await runCli((args) => demoMerge({ args }));
