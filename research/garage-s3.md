# Garage provisioning, presigned multipart, and S3 provider comparison

Research for [issue #4](https://github.com/amaennel/nether/issues/4), feeding the "Storage credential and bucket model" decision (#12).
Researched 2026-11-02 against primary sources. Garage facts are checked against the **v2.5.0** admin OpenAPI spec and the Garage source at commit `586726e` (tag `v2.5.0`).

## Question

What does Garage offer for provisioning and access control (admin API for buckets and keys, scoping a key to one bucket), presigned URLs including multipart, and size limits? How do AWS S3+IAM, Cloudflare R2, MinIO, Backblaze B2 and Hetzner compare on minting per-bucket keys through an API and on presigned multipart, so we can shape a storage-provider interface?

## TL;DR

- **Garage can do the per-Game-Server bucket + key model entirely through its admin API v2.** Call `CreateBucket`, then `CreateKey` (optionally with an `expiration`), then `AllowBucketKey {read, write}`. A new key can't reach any bucket until it's granted one. Revoke with `DenyBucketKey` or `DeleteKey`. The Orchestrator can use a **scoped admin token** that may call only those endpoints.
- **Garage scopes keys to whole buckets only.** It has no bucket policies, ACLs or prefix scoping. To isolate one Game Server from another on Garage, each Game Server **needs its own bucket**.
- **Garage presigned URLs work for every S3 call, including `UploadPart`.** Query-string SigV4 is checked the same way on every endpoint. `X-Amz-Expires` is capped at 7 days, and an expired key stops its presigned URLs working too.
- **Garage size limits**: no object size limit is documented. The source doesn't enforce a 5 MiB minimum part size or the 10,000-part cap. Bucket quotas (`maxSize`, `maxObjects`) can be set with `UpdateBucket` and are checked on PUT and CompleteMultipartUpload. For portability we should keep to AWS limits anyway (5 MiB to 5 GiB parts, at most 10,000 parts).
- **Providers split in two ways:**
  1. *Can we mint a scoped credential through an API?* Yes for Garage, MinIO, R2, B2 and AWS (via STS). **No for Hetzner**: its credentials can only be created in the Console.
  2. *Can a credential be scoped to a prefix?* Yes for AWS, R2, B2 and MinIO. **No for Garage.**
  3. *Can we have a bucket per Game Server?* Garage has no documented limit. AWS allows 10k by default, R2 100k and MinIO is unbounded. **B2 and Hetzner allow only 100 buckets.**
- **What this means for the interface**: the provider interface should hand out a *storage scope* (bucket + optional prefix) and an *access grant*. The grant is either a scoped temporary credential or a set of presigned URLs. Each provider picks the scope shape it supports. Presigned URLs (including presigned multipart orchestrated by the Orchestrator) are the lowest common denominator. They are the only option on Hetzner, and on B2 if we outgrow 100 buckets.

## Garage

### Admin API (v2)

- Admin API v2 shipped in Garage v2.0.0. v0 and v1 are deprecated. Auth is `Authorization: Bearer <token>`. ([admin API reference](https://garagehq.deuxfleurs.fr/documentation/reference-manual/admin-api/))
- **Scoped admin tokens**: `CreateAdminToken` takes `name`, `expiration` / `neverExpires`, and `scope`. `scope` is a list of admin endpoint names, or `*`. The spec warns that granting `CreateAdminToken` or `UpdateAdminToken` "trivially allows for privilege escalation". The master `admin_token` in the config file still works but is discouraged. ([OpenAPI v2 spec](https://garagehq.deuxfleurs.fr/api/garage-admin-v2.json), `UpdateAdminTokenRequestBody`; [admin API reference](https://garagehq.deuxfleurs.fr/documentation/reference-manual/admin-api/))
  - So the Orchestrator can hold a token limited to e.g. `CreateBucket, DeleteBucket, UpdateBucket, CreateKey, DeleteKey, AllowBucketKey, DenyBucketKey, GetBucketInfo, GetKeyInfo`.
- **Buckets**: `CreateBucket` takes a `globalAlias` (the S3 bucket name) or a `localAlias` scoped to one key. A local alias can carry an `allow` permission set, so one call can create a bucket that only that key sees. `DeleteBucket` returns 400 unless the bucket is empty. `UpdateBucket` sets `quotas`, `corsRules`, `lifecycleRules` and `websiteAccess`. ([spec](https://garagehq.deuxfleurs.fr/api/garage-admin-v2.json): `CreateBucketRequest`, `CreateBucketLocalAlias`, `DeleteBucket`, `UpdateBucketRequestBody`)
- **Keys**: `CreateKey` / `UpdateKey` take `name`, `expiration` (RFC 3339) / `neverExpires`, and `allow`/`deny` of `KeyPerm`. The only global key permission is `createBucket`. The response includes `secretAccessKey` on create only; `UpdateKey` returns `null` for it. `ImportKey` exists for bringing your own key ID and secret. ([spec](https://garagehq.deuxfleurs.fr/api/garage-admin-v2.json): `UpdateKeyRequestBody`, `KeyPerm`, `GetKeyInfoResponse`)
- **Key expiry is enforced on S3 requests.** The signature check rejects an expired key with `403 "Access key … has expired"`. ([source `src/api/common/signature/payload.rs`](https://git.deuxfleurs.fr/Deuxfleurs/garage/src/tag/v2.5.0/src/api/common/signature/payload.rs))
- **Bucket↔key permissions**: `AllowBucketKey` / `DenyBucketKey` take `{bucketId, accessKeyId, permissions: {read, write, owner}}`. The semantics are additive and unusual. In `AllowBucketKey`, `true` turns a flag on and `false` *leaves it unchanged*. To remove a permission you must call `DenyBucketKey`. The spec carries an explicit disclaimer about this. `owner` lets the key change bucket settings via S3 (CORS, website, lifecycle). A Runtime only needs `read` + `write`. ([spec](https://garagehq.deuxfleurs.fr/api/garage-admin-v2.json): `AllowBucketKey`, `ApiBucketKeyPerm`)
- **No prefix scoping, policies or ACLs.** Garage "implements neither ACLs nor policies" and uses "per-access-key-per-bucket" permissions instead. `GetBucketAcl` only reflects the current key's read/write/owner. ([S3 compatibility](https://garagehq.deuxfleurs.fr/documentation/reference-manual/s3-compatibility/))

### Presigned URLs and multipart

- Presigned URLs: ✅. All multipart endpoints are implemented: Create, UploadPart, UploadPartCopy, Complete, Abort, ListParts and ListMultipartUploads. `PostObject` is also implemented. ([S3 compatibility](https://garagehq.deuxfleurs.fr/documentation/reference-manual/s3-compatibility/))
- Query-string (presigned) auth is verified in the shared signature layer, so it applies to `UploadPart` like any other call. `X-Amz-Expires` over 7 days is rejected ("may not exceed a week"). ([source `payload.rs`](https://git.deuxfleurs.fr/Deuxfleurs/garage/src/tag/v2.5.0/src/api/common/signature/payload.rs))
- Lifecycle supports only `AbortIncompleteMultipartUpload` and `Expiration`, which is enough to clean up abandoned uploads. The admin API also has `CleanupIncompleteUploads`. ([S3 compatibility](https://garagehq.deuxfleurs.fr/documentation/reference-manual/s3-compatibility/); spec)
- No object versioning (`GetBucketVersioning` is a stub). ([S3 compatibility](https://garagehq.deuxfleurs.fr/documentation/reference-manual/s3-compatibility/))

### Size limits

- The docs give no object size limit.
- Source, v2.5.0 (`src/api/s3/multipart.rs`):
  - `CompleteMultipartUpload` requires at least one part, in strictly increasing part-number order. Part numbers need not start at 1 or be contiguous.
  - **No 5 MiB minimum part size is enforced.**
  - Part numbers are `u64`; the only `10000` in the S3 code is a clamp on the ListParts marker.
  - `PostObject` limits the file field to 5 GiB.

  ([multipart.rs](https://git.deuxfleurs.fr/Deuxfleurs/garage/src/tag/v2.5.0/src/api/s3/multipart.rs), [post_object.rs](https://git.deuxfleurs.fr/Deuxfleurs/garage/src/tag/v2.5.0/src/api/s3/post_object.rs))
- **Bucket quotas**: `maxSize` (bytes) and `maxObjects`. They are checked on PUT and on CompleteMultipartUpload, and a breach returns 403 "quota is reached". This could cap one Game Server's Archive bucket. ([put.rs `check_quotas`](https://git.deuxfleurs.fr/Deuxfleurs/garage/src/tag/v2.5.0/src/api/s3/put.rs))
- Objects are stored in `block_size` chunks (default 1 MiB). This is a storage detail, not an API limit. ([configuration](https://garagehq.deuxfleurs.fr/documentation/reference-manual/configuration/#block_size))

## Other providers

### AWS S3 + IAM/STS

- Multipart: up to 10,000 parts, parts 5 MiB to 5 GiB (no minimum on the last part), max object **48.8 TiB**. ([S3 multipart limits](https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html))
- Buckets: 10,000 per account by default, and the quota can be raised. ([bucket quotas](https://docs.aws.amazon.com/AmazonS3/latest/userguide/BucketRestrictions.html))
- Scoped credentials: **STS `AssumeRole` with an inline session policy** (≤ 2,048 chars) narrowed to one bucket and/or prefix. Sessions last 900 s to 12 h, capped by the role's max and at 1 h when role-chaining. The default rate is 600 STS req/s per account and region. ([AssumeRole](https://docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRole.html), [IAM/STS quotas](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_iam-quotas.html))
  - Long-lived per-bucket IAM users are possible but clumsy. Inline user policy is ≤ 2,048 chars and users are an account-wide resource. ([IAM quotas](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_iam-quotas.html))
- Presigned: up to 7 days with IAM-user SigV4 credentials. With STS credentials a presigned URL dies when the session does. Presigning works for any operation, including PUT. S3 checks expiry when a request *starts*, so an in-flight transfer finishes. ([presigned URLs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html))

### Cloudflare R2

- Scoped credentials:
  - **API tokens** created through the Cloudflare API. An access policy can name a specific bucket (`com.cloudflare.edge.r2.bucket.<ACCOUNT>_<JURISDICTION>_<BUCKET>`). The bucket-scoped permission groups are `Workers R2 Storage Bucket Item Read/Write`. The S3 access key ID is the token `id`; the secret is SHA-256 of the token value. ([R2 API tokens](https://developers.cloudflare.com/r2/api/tokens/))
  - **Temporary credentials API**: exactly one bucket per credential, with optional `prefixes` / `objects` restriction, a TTL, and `object-read-write` etc. Revoking the parent token kills all children. ([temporary credentials](https://developers.cloudflare.com/r2/api/s3/temporary-credentials/))
- Buckets: unlimited, default limit 100,000 per account. ([R2 limits](https://developers.cloudflare.com/r2/platform/limits/))
- Multipart: parts 5 MiB to 5 GiB, ≤ 10,000 parts. **All parts except the last must be the same size.** Incomplete uploads are aborted after 7 days by default. ([multipart objects](https://developers.cloudflare.com/r2/objects/multipart-objects/))
- Presigned: `GET`, `HEAD`, `PUT`, `DELETE`. `POST` is not supported. Expiry runs from 1 s to 7 days. `UploadPart` is a `PUT` but **is not explicitly documented** as presign-able, so it needs a spike before we rely on it. ([R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/))
- No bucket policies or ACLs. ([R2 S3 API compatibility](https://developers.cloudflare.com/r2/api/s3/api/))

### MinIO

- **Project status**: "THIS REPOSITORY IS NO LONGER MAINTAINED". The community edition is "distributed as source code only", and the legacy binaries "will not receive updates". Its successor is the commercial AIStor. **Not a recommended target.** ([minio/minio README](https://github.com/minio/minio/blob/master/README.md))
- Scoped credentials: the admin API `AddServiceAccount` takes an inline `policy`, a `targetUser` and an `expiration`, so a per-bucket or per-prefix policy is possible. STS AssumeRole is also supported. ([madmin-go `AddServiceAccountReq`](https://github.com/minio/madmin-go/blob/main/user-commands.go))
- Limits: buckets unlimited (recommends ≤ 500,000), up to 10,000 parts, parts 5 MiB to 5 TiB, max object 50 TiB. Bucket policies are supported; ACLs are not. ([minio-limits.md](https://github.com/minio/minio/blob/master/docs/minio-limits.md))

### Backblaze B2

- Scoped credentials: `b2_create_key` with `capabilities`, `bucketIds` (one or more buckets), `namePrefix`, and `validDurationInSeconds` (< 1000 days). There is a lifetime cap of 100 million key creations per account. ([b2_create_key](https://www.backblaze.com/apidocs/b2-create-key))
- These application keys work directly as S3 access key ID and secret. The master key does not. Bucket-restricted keys need `listAllBucketNames` for SDK compatibility and can't create or delete buckets. ([S3-compatible app keys](https://www.backblaze.com/docs/cloud-storage-s3-compatible-app-keys))
- **Buckets: 100 per account** (Support can raise this). ([buckets](https://www.backblaze.com/docs/cloud-storage-buckets))
- Multipart: parts 5 MB to 5 GB, max file 10 TB. ([large files](https://www.backblaze.com/docs/cloud-storage-large-files))
- Presigned URLs are supported for download and upload; the max expiry isn't stated. Browser POST to presigned URLs, ACLs and IAM roles are unsupported. ([S3-compatible API](https://www.backblaze.com/docs/cloud-storage-s3-compatible-api))

### Hetzner Object Storage

- **Credentials can't be created through an API.** "Create S3 credentials" is "managed via our Hetzner Console and NOT via the S3 API". ([general FAQ](https://docs.hetzner.com/storage/object-storage/faq/general/))
- By default a key pair is valid for every bucket in the project. Restricting a key to one bucket needs a **bucket policy**, using a `NotPrincipal` deny or keys in a separate project. That breaks Console browsing of the bucket. ([S3 credentials FAQ](https://docs.hetzner.com/storage/object-storage/faq/s3-credentials/), [buckets & objects FAQ](https://docs.hetzner.com/storage/object-storage/faq/buckets-objects/))
- **Up to 100 buckets.** Each bucket holds up to 100 TB and 50 M objects. ([product page FAQ](https://www.hetzner.com/storage/object-storage/))
- Up to 5 TB per object, 5 GB per single PUT, 5 GB per part, ≤ 10,000 parts. ([overview](https://docs.hetzner.com/storage/object-storage/overview/))
- Presigned URLs work, with an expiry you choose. ([buckets & objects FAQ](https://docs.hetzner.com/storage/object-storage/faq/buckets-objects/))

## Comparison

| | Garage | AWS S3 | Cloudflare R2 | MinIO | Backblaze B2 | Hetzner |
|---|---|---|---|---|---|---|
| Create bucket via API | ✅ admin API `CreateBucket` (or S3) | ✅ S3 | ✅ S3 / CF API | ✅ S3 | ✅ S3 / native | ✅ S3 |
| Bucket limit | none documented | 10,000 default (raisable) | 100,000 default | unbounded (≤500k advised) | **100** (raisable via Support) | **100** |
| Mint credential via API | ✅ `CreateKey` | ✅ STS AssumeRole (temp) / IAM user | ✅ API token or temp-creds API | ✅ `AddServiceAccount` / STS | ✅ `b2_create_key` | ❌ Console only |
| Scope key to one bucket | ✅ `AllowBucketKey` | ✅ session/IAM policy | ✅ | ✅ policy | ✅ `bucketIds` | ⚠ bucket policy only, manual key |
| Scope key to prefix | ❌ | ✅ | ✅ temp creds `prefixes` | ✅ | ✅ `namePrefix` | ⚠ bucket policy |
| Credential expiry | ✅ `expiration` | ✅ 15 min–12 h (STS) | ✅ TTL (temp creds) | ✅ `expiration` | ✅ ≤1000 days | ❌ |
| Presigned PUT/GET | ✅ ≤7 d | ✅ ≤7 d (≤ session for STS) | ✅ ≤7 d | ✅ | ✅ | ✅ |
| Presigned `UploadPart` | ✅ (generic sig check, source) | ✅ | ⚠ undocumented (PUT allowed) | ✅ | ✅ (S3 SigV4) | ✅ presumably (not documented) |
| Multipart parts | no enforced min / count (source) | 5 MiB–5 GiB, ≤10k | 5 MiB–5 GiB, ≤10k, **equal sizes** | 5 MiB–5 TiB, ≤10k | 5 MB–5 GB | ≤5 GB, ≤10k |
| Max object | not documented | 48.8 TiB | ~5 TiB | 50 TiB | 10 TB | 5 TB |
| Per-bucket quota | ✅ `maxSize`/`maxObjects` | ❌ | ❌ | ✅ (admin) | ❌ | ❌ (100 TB cap) |
| Bucket policies | ❌ | ✅ | ❌ | ✅ | ❌ | ✅ |

## Implications for the storage-provider interface

1. **Bucket-per-Game-Server isn't portable.** It's the *only* way to isolate credentials on Garage, but B2 and Hetzner cap out at 100 buckets. The interface should expose a **scope** (bucket + optional key prefix) that the provider allocates, not hard-code "one bucket each". Use a bucket per Game Server on Garage, AWS and R2. Use a shared bucket plus a prefix where prefix-scoped credentials exist (B2, AWS, R2, MinIO).
2. **There are two kinds of access grant.**
   - **Scoped credential** (Garage, AWS STS, R2 temp creds, MinIO, B2): the Runtime gets an access key, secret and optional session token limited to its scope. Give it an expiry in line with the Session where the provider allows that.
   - **Presigned URLs** (universal fallback; the only option on Hetzner): the Orchestrator itself runs `CreateMultipartUpload`, presigns N `UploadPart` URLs (plus a GET for restore), and calls `CompleteMultipartUpload` with the ETags the Runtime reports back. This needs the part count and size fixed up front. The R2 equal-size rule fits naturally with fixed-size chunks.
3. **Keep to the AWS multipart envelope everywhere**: parts of 5 MiB to 5 GiB, all the same size except the last, at most 10,000 parts. For example, 64 MiB parts allow Archives up to about 625 GiB.
4. **Presigned URLs and STS credentials last at most 7 days** (≤ 12 h for STS). A long-running Session has to re-request a grant before it uploads its Archive. Better still, request the upload grant at stop time instead of at start.
5. **Garage specifics to wrap**:
   - The unusual `AllowBucketKey` semantics (use `DenyBucketKey` to revoke).
   - `DeleteBucket` requires an empty bucket.
   - The secret is returned only once.
   - Use a scoped admin token, not the master token.
6. **Drop MinIO** as a target: it's unmaintained and has no community binaries. Treat **Hetzner** as presign-only.

## Open questions / spikes

- R2: confirm that presigned `UploadPart` works (it isn't documented).
- Hetzner: confirm the Cloud API still has no credential endpoint when we come to implement, and check whether presigned multipart is accepted.
- Garage: no documented max object size; check large Archive uploads (> 100 GiB) in practice.
- B2: max presigned expiry isn't documented.
