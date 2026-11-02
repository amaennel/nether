# Archive access is presigned-only, in one shared bucket

Runtimes never hold storage credentials. The Orchestrator keeps one static S3 key for a single bucket per Nether deployment and hands Runtimes presigned URLs: a GET to restore, and multipart part URLs to upload. The Orchestrator creates every multipart upload and completes it, so it alone decides which upload becomes a Game Server's Archive. Game Servers are isolated by which object keys the Orchestrator agrees to presign, not by separate buckets or keys. There is nothing to mint, rotate or revoke: URLs simply expire.

## Considered Options

- **A bucket and key per Game Server (Garage admin API), with presigned URLs as a fallback.** Garage supports this and has bucket quotas. But it isn't portable (B2 and Hetzner allow 100 buckets; Hetzner can't create keys by API), and it means two grant code paths plus credential lifetime and revocation to manage.
- **Scoped temporary credentials on a shared prefix** (AWS STS, R2, B2). Garage can't scope a key to a prefix, so the only storage we run today couldn't do it.

## Consequences

- Storage is the plain S3 API behind a thin module configured by endpoint, bucket and key. There is no storage-provider interface, and moving to another S3 provider is a config change.
- Without per-bucket quotas, the Orchestrator enforces a maximum Archive size per tier by refusing to presign parts past it.
- Uploads cost round trips: the Runtime asks for part URLs in batches as it streams.
