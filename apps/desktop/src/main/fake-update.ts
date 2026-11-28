/**
 * ARIA_FAKE_UPDATE=<version> (a development build only: the UI tests and demos). GitHub's latest release says ARIA
 * v<version> is out, and its installer is a few hundred KB made here. Nothing goes on the network: this fetch answers
 * the release, GitHub's redirect and the download itself, so Update now goes through all of its checks (D80). The
 * installer is never started (the hooks record it).
 */
import { createHash } from "node:crypto";
import { ARIA_LATEST_RELEASE_URL, installerNameFor, installerUrlFor, type FetchLike } from "@aria/core";

/** ARIA_FAKE_UPDATE's own: a release whose installer doesn't match its checksum. */
export const FAKE_UPDATE_BAD_CHECKSUM = "bad-checksum";

export function fakeUpdateFetch(version: string, mode?: string): FetchLike {
  const tagName = `v${version}`;
  const name = installerNameFor(version);
  const assetUrl = installerUrlFor(tagName, name);
  const cdnUrl = `https://release-assets.githubusercontent.com/github-production-release-asset/fake/${name}`;
  const bytes = new TextEncoder().encode(`ARIA v${version}: not a real installer.\n`.repeat(8192));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const release = {
    tag_name: tagName,
    name: `ARIA ${tagName}`,
    body: "A release made up for a test: nothing in it is real.",
    html_url: `https://github.com/RobbieDemaegdt/aria/releases/tag/${tagName}`,
    draft: false,
    prerelease: false,
    published_at: "2026-11-28T09:00:00Z",
    assets: [
      {
        name,
        browser_download_url: assetUrl,
        size: bytes.byteLength,
        digest: `sha256:${mode === FAKE_UPDATE_BAD_CHECKSUM ? "0".repeat(64) : sha256}`,
      },
    ],
  };
  return async (input) => {
    const url = String(input);
    if (url === ARIA_LATEST_RELEASE_URL) return Response.json(release);
    if (url === assetUrl) return new Response(null, { status: 302, headers: { location: cdnUrl } });
    if (url === cdnUrl) {
      // In pieces, so the window has progress to show.
      const piece = Math.ceil(bytes.byteLength / 20);
      let at = 0;
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (at >= bytes.byteLength) {
            controller.close();
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
          controller.enqueue(bytes.subarray(at, at + piece));
          at += piece;
        },
      });
      return new Response(body, { headers: { "content-length": String(bytes.byteLength) } });
    }
    return new Response(null, { status: 404 });
  };
}
