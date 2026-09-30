export const MEMBER_STORAGE_BUCKETS = Object.freeze([
  "candidate-source-documents",
  "application-documents",
]);

const USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PAGE_SIZE = 1000;
const REMOVE_BATCH_SIZE = 1000;

function assertSafeEntryName(name) {
  if (typeof name !== "string" || name.length === 0 || name === "." || name === ".."
      || name.includes("/") || name.includes("\\") || name.includes("\0")) {
    throw new Error("Storage returned an unsafe object name.");
  }
}

async function listUserObjects(bucket, userId) {
  const files = [];
  const visitedFolders = new Set();

  async function walk(folder) {
    if (visitedFolders.has(folder)) throw new Error("Storage returned a repeated folder while listing member files.");
    visitedFolders.add(folder);

    let offset = 0;
    while (true) {
      const { data, error } = await bucket.list(folder, {
        limit: PAGE_SIZE,
        offset,
        sortBy: { column: "name", order: "asc" },
      });
      if (error) throw new Error("Unable to list member storage objects.");
      const entries = Array.isArray(data) ? data : [];
      if (entries.length === 0) break;

      for (const entry of entries) {
        assertSafeEntryName(entry?.name);
        const path = `${folder}/${entry.name}`;
        if (!path.startsWith(`${userId}/`)) throw new Error("Storage listing escaped the target member prefix.");
        if (entry.id === null) {
          await walk(path);
        } else {
          files.push(path);
        }
      }

      // Continue until an empty page instead of trusting a possibly capped
      // server page size; this makes pagination safe if the API caps below 1000.
      offset += entries.length;
    }
  }

  await walk(userId);
  return files;
}

/** Remove and verify the two application-owned storage prefixes for a user. */
export async function deleteMemberStorageObjects(storage, userId) {
  if (typeof userId !== "string" || !USER_ID_PATTERN.test(userId)) {
    throw new Error("A valid member id is required for storage cleanup.");
  }

  let removedCount = 0;
  for (const bucketId of MEMBER_STORAGE_BUCKETS) {
    const bucket = storage.from(bucketId);
    const paths = await listUserObjects(bucket, userId);

    for (let offset = 0; offset < paths.length; offset += REMOVE_BATCH_SIZE) {
      const batch = paths.slice(offset, offset + REMOVE_BATCH_SIZE);
      const { error } = await bucket.remove(batch);
      if (error) throw new Error(`Unable to remove member objects from ${bucketId}.`);
      removedCount += batch.length;
    }

    const remaining = await listUserObjects(bucket, userId);
    if (remaining.length > 0) {
      throw new Error(`Member storage cleanup did not empty ${bucketId}.`);
    }
  }

  return { removedCount, buckets: [...MEMBER_STORAGE_BUCKETS] };
}
