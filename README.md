# actions-cache-gcs

This action enables caching dependencies to Google Cloud Storage, with native support for Workload Identity Federation and Application Default Credentials.

It also has github [actions/cache@v5](https://github.com/actions/cache) fallback if GCS save & restore fails.

Fork of [tespkg/actions-cache](https://github.com/tespkg/actions-cache), replacing the S3/MinIO backend with native GCS.

## Usage

Authenticate with [google-github-actions/auth](https://github.com/google-github-actions/auth) before using this action. The GCS client picks up credentials automatically via Application Default Credentials.

```yaml
name: dev ci

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

permissions:
  contents: read
  id-token: write

jobs:
  build_test:
    runs-on: [ubuntu-latest]

    steps:
      - uses: google-github-actions/auth@v2
        with:
          workload_identity_provider: ${{ vars.GCP_WORKLOAD_IDENTITY_PROVIDER }}
          service_account: ${{ vars.GCP_SERVICE_ACCOUNT }}

      - uses: komastudios/actions-cache-gcs@v1
        with:
          bucket: my-cache-bucket # required
          use-fallback: true # optional, use github actions cache fallback, default true
          retry: true # optional, enable retry on failure, default false

          # actions/cache compatible properties: https://github.com/actions/cache
          key: ${{ runner.os }}-yarn-${{ hashFiles('**/yarn.lock') }}
          path: |
            node_modules
            .cache
          restore-keys: |
            ${{ runner.os }}-yarn-
```

To write to the cache only:

```yaml
      - uses: komastudios/actions-cache-gcs/save@v1
        with:
          bucket: my-cache-bucket
          key: ${{ runner.os }}-yarn-${{ hashFiles('**/yarn.lock') }}
          path: |
            node_modules
```

To restore from the cache only:

```yaml
      - uses: komastudios/actions-cache-gcs/restore@v1
        with:
          bucket: my-cache-bucket
          key: ${{ runner.os }}-yarn-${{ hashFiles('**/yarn.lock') }}
          path: |
            node_modules
```

To fail the workflow if no cache entry is found:

```yaml
      - uses: komastudios/actions-cache-gcs/restore@v1
        with:
          bucket: my-cache-bucket
          fail-on-cache-miss: true
          key: ${{ runner.os }}-yarn-${{ hashFiles('**/yarn.lock') }}
          path: |
            node_modules
```

To check if a cache exists without downloading:

```yaml
      - uses: komastudios/actions-cache-gcs@v1
        id: cache
        with:
          bucket: my-cache-bucket
          lookup-only: true
          key: ${{ runner.os }}-yarn-${{ hashFiles('**/yarn.lock') }}
          path: |
            node_modules
```

## Inputs

| Input | Description | Required | Default |
|---|---|---|---|
| `bucket` | GCS bucket name | Yes | |
| `project` | GCP project ID (uses ADC project if omitted) | No | |
| `path` | Files, directories, and wildcard patterns to cache and restore | Yes | |
| `prefix` | Prefix prepended to all object keys in the GCS bucket | No | `""` |
| `normalize_keys` | Replace backslashes with forward slashes in GCS object keys | No | `true` |
| `key` | An explicit key for restoring and saving the cache | Yes | |
| `restore-keys` | Ordered list of prefix keys to try if `key` has no exact match | No | |
| `use-fallback` | Fall back to github actions/cache on GCS failure | No | `true` |
| `fail-on-cache-miss` | Fail the workflow if no cache entry is found | No | `false` |
| `lookup-only` | Check if a cache entry exists but don't download it | No | `false` |
| `retry` | Enable retry on GCS operation failure | No | `false` |
| `retry-count` | Number of retries on failure | No | `3` |

## Outputs

| Output | Description |
|---|---|
| `cache-hit` | A boolean value (`true`/`false`). `true` when an exact match is found for the primary `key`. |
| `cache-size` | Size of the cache object found, measured in bytes. |
| `cache-matched-key` | The key of the cache entry that was restored. On exact match this equals the input `key`. On a `restore-keys` prefix match this is the matched restore key. Empty string if no cache was found. |

## Restore keys

`restore-keys` works similar to how github's `@actions/cache@v5` works: it searches each item in `restore-keys`
as a prefix in object names and uses the latest one.

```yaml
      - uses: komastudios/actions-cache-gcs/restore@v1
        with:
          bucket: my-cache-bucket
          key: ${{ runner.os }}-yarn-${{ hashFiles('**/yarn.lock') }}
          restore-keys: |
            ${{ runner.os }}-yarn-
            ${{ runner.os }}-
          path: |
            node_modules
```

If a match is found using one of the `restore-keys` options, then `cache-hit` will be `false` but the
`cache-matched-key` output will be set to the key that matched.

## GCS permissions

The service account used for authentication needs the following IAM permissions on the cache bucket:

- `storage.objects.create`
- `storage.objects.get`
- `storage.objects.list`
- `storage.objects.delete`

The predefined role `roles/storage.objectUser` covers all of these and is the recommended choice.

## Note on release

This project follows semantic versioning. Backward incompatible changes will
increase major version.

The `v1` tag is automatically pinned to the latest commit on `main`.
