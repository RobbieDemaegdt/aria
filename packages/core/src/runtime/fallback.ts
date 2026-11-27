import type { RuntimeFallback } from "./types.ts";

const protocols = (range: { min: number; max: number }) => (range.min === range.max ? `protocol ${range.min}` : `protocols ${range.min}–${range.max}`);

/**
 * What to tell you when ARIA runs its bundled Copilot runtime because the CLI it found first speaks a wire protocol
 * its SDK doesn't: `why` the CLI couldn't be used, what comes `next`, and the whole notice as `text`.
 */
export function describeRuntimeFallback(fallback: RuntimeFallback): { why: string; next: string; text: string } {
  const { cliProtocol, sdkProtocols } = fallback;
  const sdk = sdkProtocols ? protocols(sdkProtocols) : undefined;
  let why: string;
  let next: string;
  if (cliProtocol !== undefined && sdkProtocols && cliProtocol > sdkProtocols.max) {
    why = `speaks wire protocol ${cliProtocol}, but ARIA's Copilot SDK only speaks ${sdk}`;
    next = "Models and features that need the newer CLI aren't available until ARIA's SDK is updated; then ARIA uses your CLI again.";
  } else if (cliProtocol !== undefined && sdkProtocols && cliProtocol < sdkProtocols.min) {
    why = `speaks wire protocol ${cliProtocol}, older than the ${sdk} ARIA's Copilot SDK speaks`;
    next = "Update Copilot CLI to have ARIA use it again.";
  } else if (cliProtocol === undefined && sdkProtocols) {
    why = `is too old to report a wire protocol (ARIA's Copilot SDK speaks ${sdk})`;
    next = "Update Copilot CLI to have ARIA use it again.";
  } else {
    why = `can't be used by ARIA's Copilot SDK (${fallback.reason})`;
    next = "ARIA tries your CLI again each time it starts.";
  }
  const bundled = `its bundled Copilot runtime${fallback.version ? ` ${fallback.version}` : ""}`;
  return { why, next, text: `The Copilot CLI at ${fallback.from} ${why}, so ARIA is running on ${bundled} instead. ${next}` };
}
