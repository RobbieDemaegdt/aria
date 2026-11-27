/**
 * Named handlers for failures that are deliberately not acted on, so a `.catch` says why (the lint config rejects a bare
 * `() => {}`). Any other failure should be logged or shown.
 */

/**
 * Letting go of something that's finished with: a session, a connection, a response body, a temp file. The work it
 * belonged to has its own outcome, and nothing can be done about a cleanup that fails.
 */
export function ignoreCleanupFailure(): void {
  // Deliberately nothing: see above.
}

/**
 * A promise kept only to wait for, like the tail of a queue or a lock. Whoever asked for the work gets its failure from
 * the promise they were given, so it isn't lost here. For `.catch`, or both sides of `.then`.
 */
export function onlyWaitedFor(): void {
  // Deliberately nothing: see above.
}
