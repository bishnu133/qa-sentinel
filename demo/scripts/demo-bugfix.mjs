#!/usr/bin/env node
// Play the developer for a BUG card: make the fix, open the merge request with the bug key in its title, optionally merge it.
//   WRITES TO GITLAB (with --yes). Each pipeline it starts can COST AI MONEY (see the messages it prints).
//
//   node demo/scripts/demo-bugfix.mjs --card slot-cap-bug --yes --merge      # needs the delivery-slot story merged first
//   node demo/scripts/demo-bugfix.mjs --card blank-item-hotfix --yes --merge # hotfix: merged into the RELEASE branch
//   node demo/scripts/demo-bugfix.mjs --card blank-item-hotfix --yes --cherry-pick   # then copy the fix to main
import { isMain, runCli } from "./lib.mjs";
import { runChangeFlow } from "./flow.mjs";

export const demoBugfix = (o) => runChangeFlow({ ...o, kind: "bug" });
if (isMain(import.meta.url)) await runCli((args) => demoBugfix({ args }));
