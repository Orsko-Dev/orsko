/**
 * Wraps a request body so exactly `declaredSize` bytes may pass.
 *
 * The counting transform errors the pipeline as soon as one byte too many
 * arrives, and at end-of-stream if fewer bytes arrived than declared. The
 * result is piped through a `FixedLengthStream` because R2 only accepts a
 * stream of known length; that also aborts the in-flight R2 write when the
 * pipeline errors, so an oversized body never lands in the bucket.
 */
export function boundedBody(
  body: ReadableStream<Uint8Array>,
  declaredSize: number,
): ReadableStream<Uint8Array> {
  let seen = 0;
  const counting = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > declaredSize) {
        throw new Error(`body exceeds the declared size of ${declaredSize} bytes`);
      }
      controller.enqueue(chunk);
    },
    flush() {
      if (seen < declaredSize) {
        throw new Error(`body is shorter than the declared ${declaredSize} bytes`);
      }
    },
  });
  const fixed = new FixedLengthStream(declaredSize);
  // The rejection is surfaced by erroring `fixed.readable`, which is what the
  // caller awaits; catching here only keeps it from being unhandled.
  void body
    .pipeThrough(counting)
    .pipeTo(fixed.writable)
    .catch(() => {});
  return fixed.readable;
}
