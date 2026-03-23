import { CompressionMethod } from "@actions/cache/lib/internal/constants";
import * as utils from "@actions/cache/lib/internal/cacheUtils";
import * as core from "@actions/core";
import { Storage, File } from "@google-cloud/storage";
import { State } from "./state";
import path from "path";
import { createTar, listTar } from "@actions/cache/lib/internal/tar";
import * as cache from "@actions/cache";
import pRetry from "p-retry";

export function isGhes(): boolean {
  const ghUrl = new URL(
    process.env["GITHUB_SERVER_URL"] || "https://github.com"
  );
  return ghUrl.hostname.toUpperCase() !== "GITHUB.COM";
}

export function newGCSClient(): Storage {
  const project = core.getInput("project");
  return new Storage(project ? { projectId: project } : undefined);
}

export function withRetry<A>(name: string, fn: () => Promise<A>): Promise<A> {
  if (getInputAsBoolean("retry")) {
    return pRetry(fn, {
      retries: getInputAsInt("retry-count") ?? 3,
      onFailedAttempt: (error) => {
        core.info(
          `Failed to ${name}. Attempt ${error.attemptNumber} failed. ${error.message}`
        );
      },
    });
  } else {
    return fn();
  }
}

export function getInputAsBoolean(
  name: string,
  options?: core.InputOptions
): boolean {
  return core.getInput(name, options) === "true";
}

export function getInputAsArray(
  name: string,
  options?: core.InputOptions
): string[] {
  return core
    .getInput(name, options)
    .split("\n")
    .map((s) => s.trim())
    .filter((x) => x !== "");
}

export function getInputAsInt(
  name: string,
  options?: core.InputOptions
): number | undefined {
  const value = parseInt(core.getInput(name, options));
  if (isNaN(value) || value < 0) {
    return undefined;
  }
  return value;
}

export function formatSize(value?: number, format = "bi") {
  if (!value) return "";
  const [multiple, k, suffix] = (
    format === "bi" ? [1000, "k", "B"] : [1024, "K", "iB"]
  ) as [number, string, string];
  const exp = (Math.log(value) / Math.log(multiple)) | 0;
  const size = Number((value / Math.pow(multiple, exp)).toFixed(2));
  return (
    size +
    (exp ? (k + "MGTPEZY")[exp - 1] + suffix : "byte" + (size !== 1 ? "s" : ""))
  );
}

export function setCacheHitOutput(isCacheHit: boolean): void {
  core.setOutput("cache-hit", isCacheHit.toString());
}

export function setCacheSizeOutput(cacheSize: number): void {
  core.setOutput("cache-size", cacheSize.toString());
}

export function setCacheMatchedKeyOutput(cacheMatchedKey: string): void {
  core.setOutput("cache-matched-key", cacheMatchedKey);
}

type FindObjectResult = {
  item: File;
  matchingKey: string;
};

export async function findObject(
  storage: Storage,
  bucket: string,
  key: string,
  restoreKeys: string[],
  compressionMethod: CompressionMethod
): Promise<FindObjectResult> {
  core.debug("Key: " + JSON.stringify(key));
  core.debug("Restore keys: " + JSON.stringify(restoreKeys));

  core.debug(`Finding exact match for: ${key}`);
  const keyMatches = await listObjects(storage, bucket, key);
  core.debug(`Found ${JSON.stringify(keyMatches.map((f) => f.name), null, 2)}`);
  if (keyMatches.length > 0) {
    const exactMatch = keyMatches.find((f) => f.name.startsWith(key + "/"));
    if (exactMatch) {
      core.debug(
        `Found an exact match; using ${JSON.stringify({ name: exactMatch.name, matchingKey: key })}`
      );
      return { item: exactMatch, matchingKey: key };
    }
  }
  core.debug(`Didn't find an exact match`);

  for (const restoreKey of restoreKeys) {
    const fn = utils.getCacheFileName(compressionMethod);
    core.debug(`Finding object with prefix: ${restoreKey}`);
    let objects = await listObjects(storage, bucket, restoreKey);
    objects = objects.filter((f) => f.name.includes(fn));
    core.debug(
      `Found ${JSON.stringify(objects.map((f) => f.name), null, 2)}`
    );
    if (objects.length < 1) {
      continue;
    }
    const sorted = objects.sort((a, b) => {
      const aTime = new Date(a.metadata?.updated ?? 0).getTime();
      const bTime = new Date(b.metadata?.updated ?? 0).getTime();
      return bTime - aTime;
    });
    core.debug(
      `Using latest ${JSON.stringify({ name: sorted[0].name, matchingKey: restoreKey })}`
    );
    return { item: sorted[0], matchingKey: restoreKey };
  }
  throw new Error("Cache item not found");
}

export async function listObjects(
  storage: Storage,
  bucket: string,
  prefix: string
): Promise<File[]> {
  const [files] = await storage.bucket(bucket).getFiles({ prefix });
  return files;
}

export function saveMatchedKey(matchedKey: string) {
  return core.saveState(State.MatchedKey, matchedKey);
}

function getMatchedKey() {
  return core.getState(State.MatchedKey);
}

export function isExactKeyMatch(): boolean {
  const matchedKey = getMatchedKey();
  const inputKey = core.getState(State.PrimaryKey);
  const result = matchedKey === inputKey;
  core.debug(
    `isExactKeyMatch: matchedKey=${matchedKey} inputKey=${inputKey}, result=${result}`
  );
  return result;
}

export async function saveCache(standalone: boolean) {
  try {
    if (!standalone && isExactKeyMatch()) {
      core.info("Cache was exact key match, not saving");
      return;
    }

    const bucket = core.getInput("bucket", { required: true });
    // Inputs are re-evaluated before the post action, so we want the original key
    const key = standalone
      ? core.getInput("key", { required: true })
      : core.getState(State.PrimaryKey);
    const useFallback = getInputAsBoolean("use-fallback");
    const paths = getInputAsArray("path");

    try {
      const storage = newGCSClient();

      const compressionMethod = await utils.getCompressionMethod();
      const cachePaths = await utils.resolvePaths(paths);
      core.debug("Cache Paths:");
      core.debug(`${JSON.stringify(cachePaths)}`);

      const archiveFolder = await utils.createTempDirectory();
      const cacheFileName = utils.getCacheFileName(compressionMethod);
      const archivePath = path.join(archiveFolder, cacheFileName);

      core.debug(`Archive Path: ${archivePath}`);

      await createTar(archiveFolder, cachePaths, compressionMethod);
      if (core.isDebug()) {
        await listTar(archivePath, compressionMethod);
      }

      const object = key + "/" + cacheFileName;

      core.info(`Uploading tar to GCS. Bucket: ${bucket}, Object: ${object}`);
      await withRetry("upload", () =>
        storage.bucket(bucket).upload(archivePath, { destination: object })
      );
      core.info("Cache saved to GCS successfully");
    } catch (e) {
      if (useFallback) {
        if (isGhes()) {
          core.warning("Cache fallback is not supported on Github Enterprise.");
        } else {
          core.info("Saving cache using fallback");
          await cache.saveCache(paths, key);
          core.info("Save cache using fallback successfully");
        }
      } else {
        core.debug("skipped fallback cache");
        core.warning("Save GCS cache failed: " + e.message);
      }
    }
  } catch (e) {
    core.info("warning: " + e.message);
  }
}
