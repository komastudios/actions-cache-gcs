import * as cache from "@actions/cache";
import * as utils from "@actions/cache/lib/internal/cacheUtils";
import { extractTar, listTar } from "@actions/cache/lib/internal/tar";
import * as core from "@actions/core";
import * as path from "path";
import { State } from "./state";
import {
  findObject,
  formatSize,
  getInputAsArray,
  getInputAsBoolean,
  isGhes,
  newGCSClient,
  setCacheHitOutput,
  setCacheMatchedKeyOutput,
  setCacheSizeOutput,
  saveMatchedKey,
  withRetry,
} from "./utils";

process.on("uncaughtException", (e) => core.info("warning: " + e.message));

async function restoreCache() {
  try {
    const bucket = core.getInput("bucket", { required: true });
    const key = core.getInput("key", { required: true });
    const useFallback = getInputAsBoolean("use-fallback");
    const failOnCacheMiss = getInputAsBoolean("fail-on-cache-miss");
    const paths = getInputAsArray("path");
    const restoreKeys = getInputAsArray("restore-keys");
    const lookupOnly = getInputAsBoolean("lookup-only");

    try {
      core.saveState(State.PrimaryKey, key);

      const storage = newGCSClient();

      const compressionMethod = await utils.getCompressionMethod();
      const cacheFileName = utils.getCacheFileName(compressionMethod);
      const archivePath = path.join(
        await utils.createTempDirectory(),
        cacheFileName
      );

      const { item: obj, matchingKey } = await findObject(
        storage,
        bucket,
        key,
        restoreKeys,
        compressionMethod
      );
      core.debug("found cache object");
      saveMatchedKey(matchingKey);
      const cacheHit = matchingKey === key;
      const size = Number(obj.metadata?.size ?? 0);
      setCacheHitOutput(cacheHit);
      setCacheSizeOutput(size);
      setCacheMatchedKeyOutput(matchingKey);
      if (lookupOnly) {
        if (cacheHit && size > 0) {
          core.info(
            `Cache Hit. NOT downloading cache from GCS because lookup-only is set. Bucket: ${bucket}, Object: ${obj.name}`
          );
        } else {
          core.info(
            `Cache Miss or cache size is 0. NOT downloading cache from GCS because lookup-only is set. Bucket: ${bucket}, Object: ${obj.name}`
          );
        }
      } else {
        core.info(
          `Downloading cache from GCS to ${archivePath}. Bucket: ${bucket}, Object: ${obj.name}`
        );
        await withRetry("download", () =>
          obj.download({ destination: archivePath })
        );

        if (core.isDebug()) {
          await listTar(archivePath, compressionMethod);
        }

        core.info(`Cache Size: ${formatSize(size)} (${size} bytes)`);

        await extractTar(archivePath, compressionMethod);
        core.info("Cache restored from GCS successfully");
      }
    } catch (e) {
      core.info("Restore GCS cache failed: " + e.message);
      setCacheHitOutput(false);
      setCacheMatchedKeyOutput("");

      let restored = false;
      if (useFallback) {
        if (isGhes()) {
          core.warning("Cache fallback is not supported on Github Enterprise.");
        } else {
          core.info("Restore cache using fallback cache");
          const fallbackMatchingKey = await cache.restoreCache(
            paths,
            key,
            restoreKeys
          );
          if (fallbackMatchingKey) {
            setCacheHitOutput(fallbackMatchingKey === key);
            setCacheMatchedKeyOutput(fallbackMatchingKey);
            core.info("Fallback cache restored successfully");
            restored = true;
          } else {
            core.info("Fallback cache restore failed");
          }
        }
      }

      if (!restored && failOnCacheMiss) {
        core.setFailed(
          `Cache entry not found for keys: ${JSON.stringify([key, ...restoreKeys])}`
        );
      }
    }
  } catch (e) {
    core.setFailed(e.message);
  }
}

restoreCache();
