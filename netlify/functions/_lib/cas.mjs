// Compare-and-swap helper around @netlify/blobs.
// Reads a JSON value, lets the caller mutate it, then writes it back with
// onlyIfMatch(etag). If a concurrent write happened, retry.

const DEFAULT_MAX_RETRIES = 8;

export async function updateJsonWithCAS(store, key, mutator, { maxRetries = DEFAULT_MAX_RETRIES, fallback } = {}) {
  let lastError;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    let current;
    let etag;
    try {
      const result = await store.getWithMetadata(key, { type: "json" });
      if (result) {
        current = result.data;
        etag = result.etag;
      } else {
        current = null;
        etag = null;
      }
    } catch (e) {
      // If the blob doesn't exist or metadata fetch fails, start fresh.
      current = null;
      etag = null;
    }

    if (current == null) {
      current = typeof fallback === "function" ? fallback() : (fallback ?? {});
    }

    const next = await mutator(current);
    if (next === undefined) {
      return current;
    }

    const setOptions = {};
    if (etag) {
      setOptions.onlyIfMatch = etag;
    } else {
      // First ever write — make sure we don't clobber a concurrent first write.
      setOptions.onlyIfNew = true;
    }

    try {
      const writeResult = await store.set(key, JSON.stringify(next), setOptions);
      // @netlify/blobs returns { modified: false } when the precondition fails.
      if (writeResult && writeResult.modified === false) {
        // Conflict: someone wrote between our read and write. Retry.
        continue;
      }
      return next;
    } catch (e) {
      // Some providers throw on precondition failure with a 412. Retry in that case,
      // bubble other errors up.
      lastError = e;
      if (e && (e.status === 412 || /precondition/i.test(String(e.message)))) {
        continue;
      }
      throw e;
    }
  }
  throw lastError || new Error("CAS update failed after retries");
}
