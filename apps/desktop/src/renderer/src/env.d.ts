import type { AriaApi } from "@aria/protocol";

declare global {
  interface Window {
    aria: AriaApi;
  }
}

export {};
