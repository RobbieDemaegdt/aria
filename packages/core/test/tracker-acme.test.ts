/**
 * A second tracker: the fake "Acme Tracker", made from its config (fixtures/trackers/acme.json) by the generic config
 * tracker, drives the engine end to end (helpers/acme-flow.ts has the flow). A third tracker, Globex Desk
 * (fixtures/trackers/globex.json), is loaded through the same loader and not in use: Acme runs, and no Globex word
 * appears anywhere (its label, server, host and tool names are the leftovers a hard-coded name would leave). Neither
 * label is neutral, so Acme's can't match the Conductor's own wording.
 */
import { fileURLToPath } from "node:url";
import { loadTrackerFixture } from "./helpers/acme.ts";
import { defineAcmeFlow, leftoversOf } from "./helpers/acme-flow.ts";

const globex = loadTrackerFixture(fileURLToPath(new URL("./fixtures/trackers/globex.json", import.meta.url)), "globex");

defineAcmeFlow("a second tracker (Acme), from its config, through the engine", leftoversOf(globex));
