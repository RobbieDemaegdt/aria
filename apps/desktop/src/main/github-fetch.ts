/**
 * The fetch GitHub's requests go through (core's guard sits on top, packages/core/src/github/fetch.ts): Chromium's
 * network stack, so Windows' proxy settings (PAC included) and certificate store apply, as in the browser. Built on
 * `net.request` rather than `session.fetch`: with `redirect: "manual"`, Electron's fetch rejects a redirect ("Redirect
 * was cancelled") instead of returning it, and core's guard has to see a redirect to decide whether to follow it. A
 * redirect comes back as its own response (status and Location), and nothing follows it here. No cookies (`omit`), and
 * Chromium's HTTP cache never answers (`no-store`).
 */
import { net, type Session } from "electron";
import type { FetchLike } from "@aria/core";

const headersOf = (raw: Record<string, string | string[]>): Headers => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) for (const one of Array.isArray(value) ? value : [value]) headers.append(name, one);
  return headers;
};

const NO_BODY = new Set([101, 204, 205, 304]);

/**
 * `session`: GitHub's own session, once it's ready (under the test hooks, set to connect without a proxy first). The
 * answer comes as soon as its headers do, its body as a stream (item 4: a job log is read and cut as it arrives, and a
 * reader that stops early cancels the request). The abort signal is listened to until the body has ended: a stalled
 * body is still stopped by the caller's timeout.
 */
export function chromiumFetch(session: () => Promise<Session>): FetchLike {
  return async (input, init = {}) => {
    const ready = await session();
    if (init.signal?.aborted) throw new DOMException("The request was aborted.", "AbortError");
    return new Promise<Response>((resolve, reject) => {
      let answered = false;
      let finished = false;
      let fail: ((error: Error) => void) | undefined;
      const finish = () => {
        if (finished) return;
        finished = true;
        init.signal?.removeEventListener("abort", onAbort);
      };
      const request = net.request({
        url: String(input),
        method: init.method ?? "GET",
        session: ready,
        redirect: "manual",
        credentials: "omit",
        useSessionCookies: false,
        cache: "no-store",
      });
      const onAbort = () => {
        request.abort();
        const error = new DOMException("The request was aborted.", "AbortError");
        // Before the answer: the fetch fails; after it: its body does.
        if (!answered) {
          answered = true;
          reject(error);
        } else fail?.(error);
        finish();
      };
      init.signal?.addEventListener("abort", onAbort, { once: true });
      for (const [name, value] of new Headers(init.headers).entries()) request.setHeader(name, value);
      request.on("redirect", (statusCode, _method, redirectUrl, responseHeaders) => {
        // Not followed here: core decides (same origin and an allowed path only).
        request.abort();
        const headers = headersOf(responseHeaders);
        headers.set("location", redirectUrl);
        if (answered) return;
        answered = true;
        finish();
        resolve(new Response(null, { status: statusCode, headers }));
      });
      request.on("response", (response) => {
        if (answered) return;
        answered = true;
        const init2 = { status: response.statusCode, statusText: response.statusMessage, headers: headersOf(response.headers) };
        if (NO_BODY.has(response.statusCode)) {
          response.on("data", () => {
            // Nothing to keep: reading it is what lets the response end.
          });
          response.on("end", finish);
          resolve(new Response(null, init2));
          return;
        }
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            fail = (error) => {
              try {
                controller.error(error);
              } catch {
                // Already closed.
              }
            };
            response.on("data", (chunk: Buffer) => {
              try {
                controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
              } catch {
                // The reader cancelled: nothing more is wanted.
              }
            });
            response.on("end", () => {
              finish();
              try {
                controller.close();
              } catch {
                // Cancelled or errored before.
              }
            });
            response.on("error", (error: Error) => {
              finish();
              fail?.(error);
            });
          },
          cancel() {
            // The reader stopped early (a log at its cap): the request goes too.
            request.abort();
            finish();
          },
        });
        resolve(new Response(body, init2));
      });
      request.on("error", (error) => {
        if (!answered) {
          answered = true;
          reject(error);
        } else fail?.(error);
        finish();
      });
      if (init.body !== undefined && init.body !== null) request.write(String(init.body));
      request.end();
    });
  };
}
