import assert from "node:assert/strict";
import test from "node:test";
import { deleteMemberStorageObjects, MEMBER_STORAGE_BUCKETS } from "./member-account-storage.mjs";

const userId = "11111111-1111-4111-8111-111111111111";
const anotherUserId = "11111111-1111-4111-8111-111111111112";

function makeStorage(initialObjects, { pageCap = 1000, failList = false, failRemove = false } = {}) {
  const objects = new Map(Object.entries(initialObjects));
  const removedBatches = [];
  const listedPrefixes = [];

  return {
    objects,
    removedBatches,
    listedPrefixes,
    client: {
      from(bucketId) {
        return {
          async list(prefix, { limit, offset }) {
            listedPrefixes.push({ bucketId, prefix, offset });
            if (failList) return { data: null, error: new Error("list failed") };
            const bucketPrefix = `${bucketId}:${prefix}/`;
            const objectKeys = [...objects.keys()]
              .filter((key) => key.startsWith(bucketPrefix))
              .sort();
            const entryByName = new Map();
            for (const key of objectKeys) {
              const remainder = key.slice(bucketId.length + 1 + prefix.length + 1);
              const [name, ...rest] = remainder.split("/");
              if (rest.length) entryByName.set(name, { name, id: null });
              else entryByName.set(name, { name, id: `id:${bucketId}:${key}` });
            }
            const entries = [...entryByName.values()].sort((a, b) => a.name.localeCompare(b.name));
            const effectiveLimit = Math.min(limit, pageCap);
            return { data: entries.slice(offset, offset + effectiveLimit), error: null };
          },
          async remove(paths) {
            removedBatches.push({ bucketId, paths: [...paths] });
            if (failRemove) return { data: null, error: new Error("remove failed") };
            for (const path of paths) objects.delete(`${bucketId}:${path}`);
            return { data: paths.map((name) => ({ name })), error: null };
          },
        };
      },
    },
  };
}

test("cleans only the member prefix in the two allowlisted buckets, including nested folders", async () => {
  const fake = makeStorage({
    [`candidate-source-documents:${userId}/cv.pdf`]: true,
    [`candidate-source-documents:${userId}/onboarding/source/original.docx`]: true,
    [`candidate-source-documents:${anotherUserId}/cv.pdf`]: true,
    [`application-documents:${userId}/application/version/final.pdf`]: true,
    [`application-documents:${anotherUserId}/application/other.pdf`]: true,
    ["unrelated-bucket:anything/file.txt"]: true,
  });

  const result = await deleteMemberStorageObjects(fake.client, userId);

  assert.equal(result.removedCount, 3);
  assert.deepEqual(result.buckets, [...MEMBER_STORAGE_BUCKETS]);
  assert.equal(fake.objects.has(`candidate-source-documents:${anotherUserId}/cv.pdf`), true);
  assert.equal(fake.objects.has(`application-documents:${anotherUserId}/application/other.pdf`), true);
  assert.equal(fake.objects.has("unrelated-bucket:anything/file.txt"), true);
  assert.ok(fake.listedPrefixes.every(({ prefix }) => prefix === userId || prefix.startsWith(`${userId}/`)));
});

test("paginates capped list pages and removes objects in batches no larger than 1000", async () => {
  const initial = {};
  for (let index = 0; index < 2105; index += 1) {
    initial[`candidate-source-documents:${userId}/files/${String(index).padStart(4, "0")}.pdf`] = true;
  }
  const fake = makeStorage(initial, { pageCap: 173 });

  const result = await deleteMemberStorageObjects(fake.client, userId);

  assert.equal(result.removedCount, 2105);
  assert.deepEqual(fake.removedBatches.map((batch) => batch.paths.length), [1000, 1000, 105]);
  assert.ok(fake.listedPrefixes.some(({ prefix, offset }) => prefix === `${userId}/files` && offset > 0));
  assert.equal(fake.objects.size, 0);
});

test("fails closed on listing/removal errors and rejects malformed ids", async () => {
  const failingList = makeStorage({ [`candidate-source-documents:${userId}/cv.pdf`]: true }, { failList: true });
  await assert.rejects(() => deleteMemberStorageObjects(failingList.client, userId), /Unable to list member storage objects/);
  assert.equal(failingList.removedBatches.length, 0);

  const failingRemove = makeStorage({ [`candidate-source-documents:${userId}/cv.pdf`]: true }, { failRemove: true });
  await assert.rejects(() => deleteMemberStorageObjects(failingRemove.client, userId), /Unable to remove member objects/);
  await assert.rejects(() => deleteMemberStorageObjects(failingRemove.client, `${userId}/../${anotherUserId}`), /valid member id/);
});
