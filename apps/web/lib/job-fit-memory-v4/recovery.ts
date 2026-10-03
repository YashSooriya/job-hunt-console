/** A locally recoverable result exists only for an explicitly named captured group. */
export function findRequestedCapturedRepair(
  chunks: Array<Record<string, any>>,
  items: Array<Record<string, any>>,
  requestedChunkId?: string,
) {
  if (!requestedChunkId) return undefined;
  return chunks.find((chunk) => chunk.id === requestedChunkId && chunk.state === "completed"
    && typeof chunk.captured_response === "string" && Boolean(chunk.captured_response_hash)
    && items.some((item) => item.chunk_id === chunk.id && ["invalid_response", "missing_result"].includes(String(item.state))));
}
