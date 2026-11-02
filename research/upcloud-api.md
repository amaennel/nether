# UpCloud API capabilities for ephemeral Nodes

Research for [amaennel/nether#5](https://github.com/amaennel/nether/issues/5). Gathered 2026-11-02 from UpCloud's own docs, its API reference (v1.3), the OpenAPI spec UpCloud publishes in its own SDK repo, and UpCloud's GitHub org. Each claim links to the source it came from.

## TL;DR

- **Create**: one `POST /1.3/server` call does it all. It clones a public template disk, attaches a public IPv4, injects `user_data` (a shell script or URL) plus SSH keys, and turns on the metadata service. Public templates are `cloud-init` type, so `user_data` runs as root on first boot. Nothing needs to be pre-baked to bootstrap the Runtime.
- **Delete**: the server must be `stopped` first. Then `DELETE /1.3/server/{uuid}?storages=1&backups=delete` removes the server, its disks and their backups, and releases its IPs. Billing stops when the resources are gone.
- **Billing**: hourly, capped at 672 h/month. Starter and Premium plans bill while stopped. Cloud Native plans bill CPU/RAM only while powered, but disk and IPv4 are separate hourly add-ons. Ephemeral Nodes are destroyed rather than kept stopped, so this mostly affects which plan family is cheapest per Session-hour.
- **Plans**: API names look like `PREMIUM-2xCPU-4GB`, `STARTER-2xCPU-4GB` and `CLOUDNATIVE-2xCPU-8GB`. List them with `GET /1.3/plan`. Get prices in the account's currency with `GET /1.3/price`. Get zones with `GET /1.3/zone` (e.g. `de-fra1`, `fi-hel1`, `nl-ams1`, `uk-lon1`, `us-chi1`, `sg-sin1`).
- **Firewall**: per-server rules. `PUT /1.3/server/{uuid}/firewall_rule` replaces the whole rule set in one call. Changes take 1–2 min to apply. Max 1000 rules.
- **Boot time**: UpCloud only advertises "under 45 seconds" from deploy to login. I found no published SLA or benchmark, so we should measure it.
- **Rate limits**: not documented anywhere I could find (API docs, OpenAPI spec, guides). Plan for a client-side limit and back off on 429/5xx.
- **TypeScript SDK**: none is maintained. The official JS SDK `@upcloud/upcloud` is archived and deprecated, and it uses Basic auth. Options are raw `fetch` with Bearer tokens, or types generated from UpCloud's OpenAPI 3.1 spec (marked "work-in-progress preview").

## Authentication and transport

- Base URL `https://api.upcloud.com/`, versioned paths like `/1.3/server`. ([Architecture](https://developers.upcloud.com/1.3/2-architecture/))
- Recommended auth: `Authorization: Bearer ucat_…` API tokens. HTTP Basic still works but "is discouraged, and it will be deprecated and disabled at a later date". ([Architecture](https://developers.upcloud.com/1.3/2-architecture/))
- Tokens are created with `POST /1.3/account/tokens` or in the Control Panel. Fields: `name`, `expires_at`/`expires_in` (max 8760 h, so tokens must be rotated at least yearly), `can_create_tokens` (default false), and `allowed_ip_ranges` (up to 100 CIDRs, so a token can be pinned to the Orchestrator's egress IPs). There are no fine-grained scopes. To restrict a token, create it under a dedicated subaccount. ([API tokens](https://developers.upcloud.com/1.3/24-api-tokens/), [Getting started with the API](https://upcloud.com/docs/guides/getting-started-upcloud-api/))
- Errors are JSON `{ "error": { "error_code", "error_message" } }`. Async work returns 202. ([Architecture](https://developers.upcloud.com/1.3/2-architecture/))
- **Rate limits**: the 4xx table in the API docs lists 400/401/402/403/404/405/406/409 and no 429. The OpenAPI spec doesn't mention rate limits or 429, and neither do the getting-started guide or introduction. **Undocumented.** ([Architecture](https://developers.upcloud.com/1.3/2-architecture/), [Introduction](https://developers.upcloud.com/1.3/1-introduction/))
- `402` is in the table, and storage operations can return `INSUFFICIENT_CREDITS`. Creates can therefore fail on account balance, and that error should reach the caller. ([Storages](https://developers.upcloud.com/1.3/9-storages/))

## Server creation, cloud-init, user_data

`POST /1.3/server` ([Servers](https://developers.upcloud.com/1.3/8-servers/)):

- Required: `zone`, `title`, `hostname`, `storage_devices`, and `networking.interfaces`. `plan` selects the size.
- Disk: a `storage_device` with `"action": "clone"`, `storage: <template UUID>` and an optional `size`/`tier`. Starter and Premium plans include disk up to the plan's quota (Standard or MaxIOPS tier respectively). Cloud Native has no included disk. ([Configurations](https://upcloud.com/docs/products/cloud-servers/configurations/), [Block Storage billing](https://upcloud.com/docs/products/block-storage/billing/))
- Networking: interfaces of type `public`, `utility` or `private`. A public interface requests an address with `ip_addresses: { ip_address: [{ family: "IPv4" }] }`.
- `login_user: { username, ssh_keys }`. On cloud-init templates, SSH keys are the only login method and `ssh_keys` is required, so the Orchestrator must supply at least one key (it can be a throwaway or break-glass key).
- `user_data`: "A valid URL or shell script". It runs as root during initialization. The OpenAPI spec describes it as "Setup script body or URL processed during Cloud Server initialization". ([OpenAPI spec `serverUserData`](https://github.com/UpCloudLtd/upcloud-php-api/blob/main/generator/openapi/spec.json))
- `metadata: "yes"` turns on the metadata service at `169.254.169.254`, which is reachable only from inside the server. It can't be disabled on cloud-init templates (`METADATA_DISABLED_ON_CLOUD-INIT`). cloud-init's UpCloud datasource reads `user_data` from there. User data can't be changed for the server's lifetime. ([Servers](https://developers.upcloud.com/1.3/8-servers/), [Metadata service](https://upcloud.com/docs/products/cloud-servers/features/metadata-service), [cloud-init UpCloud datasource](https://cloudinit.readthedocs.io/en/latest/topics/datasources/upcloud.html))
- `labels` (key 2–32 chars, value up to 255) are supported on servers. They let us tag Nodes with a Nether ID and sweep orphans later (`GET /1.3/server?label=…`-style filtering is documented for server groups). ([Servers](https://developers.upcloud.com/1.3/8-servers/))
- Server-level `firewall: "on" | "off"` attribute. ([OpenAPI spec](https://github.com/UpCloudLtd/upcloud-php-api/blob/main/generator/openapi/spec.json))
- States: `started`, `stopped`, `maintenance` (also used during create), and `error`. A new server moves from `maintenance` to `started`, and the Orchestrator has to poll `GET /1.3/server/{uuid}` to see it. ([Servers](https://developers.upcloud.com/1.3/8-servers/))

**What this means for Runtime delivery:** a `#!/bin/sh` user_data script on a stock Ubuntu/Debian cloud-init template can install Docker, fetch the Runtime agent, and start it with a per-Node credential. The credential is visible to anything on the Node that can reach the metadata endpoint, so it should be short-lived or single-use. Pre-baking a custom template would cut boot time but needs extra steps (below).

## Templates and custom images

- `GET /1.3/storage/template` lists templates. `template_type` is `cloud-init` or `native` (OpenAPI enum: "`cloud-init` templates support cloud-init metadata, while `native` templates use the operating system's native initialization"). ([Storages](https://developers.upcloud.com/1.3/9-storages/), [OpenAPI spec `storageTemplateType`](https://github.com/UpCloudLtd/upcloud-php-api/blob/main/generator/openapi/spec.json))
- Public Linux templates: AlmaLinux, CentOS Stream, Debian, Fedora, Rocky Linux, Ubuntu. GPU servers also get Ubuntu with NVIDIA/CUDA and Docker CE. Linux templates don't ship Docker. "Using the templates is the fastest way to deploy new Cloud Server instances." ([Public templates](https://upcloud.com/docs/products/block-storage/templates/))
- Custom template: `POST /1.3/storage/{uuid}/templatize` with a `title`. It runs async (`maintenance` then `online`), and the source storage must not be attached to a running server. The docs contradict themselves on the source tier (MaxIOPS only, or also Standard/Archive), and deployments from a custom template must use the same tier. ([Storages](https://developers.upcloud.com/1.3/9-storages/))
- Image import: `POST /1.3/storage/{uuid}/import` with `source: "http_import"` and a URL. It accepts raw/img/iso, optionally gzip/xz. qcow2 isn't listed. ([Storages](https://developers.upcloud.com/1.3/9-storages/))
- Cloning a storage into another zone works but is slower. The docs don't say whether a custom template can be used from other zones or what it costs. Custom templates are stored storage, so presumably they bill per GB-hour like other storage (unconfirmed). ([Storages](https://developers.upcloud.com/1.3/9-storages/), [Block Storage billing](https://upcloud.com/docs/products/block-storage/billing/))
- UpCloud maintains a [Packer plugin](https://github.com/UpCloudLtd/packer-plugin-upcloud) for building custom templates.

## Plans, pricing, zones

- `GET /1.3/plan` returns `name`, `core_number`, `memory_amount` (MB), `storage_size`, `storage_tier`, `public_traffic_out`, plus `gpu_amount`/`gpu_model` on GPU plans. ([Plans API](https://developers.upcloud.com/1.3/7-plans/))
- There are three current plan families, with API names from [Configurations](https://upcloud.com/docs/products/cloud-servers/configurations/) and [Plans](https://upcloud.com/docs/products/cloud-servers/plans/):

| Family | API names (examples) | Disk | Public IPv4 | Billed while stopped? |
|---|---|---|---|---|
| Starter | `STARTER-2xCPU-4GB`, `STARTER-2xCPU-8GB`, `STARTER-4xCPU-8GB`, `STARTER-4xCPU-16GB` (max 4 vCPU / 16 GB) | Standard, 10–50 GB included | 1 included | Yes |
| Premium (incl. High CPU / High Memory shapes) | `PREMIUM-2xCPU-4GB`, `PREMIUM-2xCPU-8GB`, `PREMIUM-4xCPU-8GB`, `PREMIUM-4xCPU-16GB` … up to 80 vCPU / 512 GB | MaxIOPS, 25–500 GB included | 1 included | Yes |
| Cloud Native | `CLOUDNATIVE-2xCPU-8GB`, `CLOUDNATIVE-4xCPU-16GB`, `CLOUDNATIVE-2xCPU-16GB` … | Add-on (any tier, per GB-hour) | Add-on (hourly) | No: "only billed when powered" |

`STARTER-1xCPU-1GB` is limited to 5 per account. The older `1xCPU-2GB`-style General Purpose and Developer plans still appear in API examples and pricing notes but aren't in the current configurations page. Note: the [pricing page](https://upcloud.com/pricing/) shows a dated revision for 2026-11-16 that changes prices of the "previous Cloud Server plans" (only seen in search snippets).

- Billing: "Cloud Servers are billed hourly and capped at 672 hours (24 h x 28 days) per month." "Starter and Premium plan Cloud Servers are billed per hour regardless of whether the server is powered on or shut down. Cloud Native plans are only billed when powered." Backups, floating IPs, extra IPv4 and extra storage bill hourly. ([Configurations](https://upcloud.com/docs/products/cloud-servers/configurations/)) The pricing comparison page says "billed by the starting hour", so a 10-minute Node costs a full hour. ([Cloud Native pricing comparison](https://upcloud.com/global/cloud-native-pricing-comparison/), search snippet) I found no minimum charge beyond that.
- Prices: `GET /1.3/price` returns per-zone prices "in the currency used by the account" with hourly rates (e.g. `server_plan_2xCPU-4GB`, `ipv4_address`, `storage_maxiops`). ([Pricing API](https://developers.upcloud.com/1.3/4-pricing/)) The public pricing page blocks automated fetches (403). Search snippets of upcloud.com/pricing show Premium 2 vCPU / 4 GB at €26/mo and Cloud Native 2 vCPU / 4 GB at €15/mo (1 vCPU at €12/mo). Re-check these in a browser or via `/1.3/price` before using them in tiers.
- Zones: `GET /1.3/zone` → `{ id, description, public, parent_zone? }`. The example list includes `de-fra1`, `fi-hel1`, `fi-hel2`, `nl-ams1`, `sg-sin1`, `uk-lon1`, `us-chi1` and `us-sjo1`. The live list is longer (UpCloud advertises 15 DCs), so Nether's region→zone map should be checked against the live endpoint. ([Zones API](https://developers.upcloud.com/1.3/5-zones/)) Plan availability per zone isn't on `/plan`. The per-zone entries in `/price` are the closest signal.

## Firewall

- Per-server rules at `/1.3/server/{uuid}/firewall_rule`: `GET` (list), `POST` (add one), `PUT` (replace all, "overwrite any previous chain of rules"), and `DELETE …/{index}` (one at a time). ([Firewall API](https://developers.upcloud.com/1.3/11-firewall/))
- Rule fields: `direction` in/out, `action` accept/drop, `family` IPv4/IPv6, `protocol` tcp/udp/icmp, port and address ranges, `position`, and `comment`. The last rule is the default policy and holds only direction and action. Max 1000 rules. **Changes can take 1–2 minutes to take effect.** The firewall doesn't apply to private-network interfaces.
- Nether can lock a Node to inbound TCP 25565 (plus SSH from an admin range if wanted) with default-drop inbound. The Runtime dials out, so it needs no inbound rule. Rules can only be set after create, so for the first 1–2 minutes the Node runs under the account/server defaults. The safest default is to bind nothing public until the agent is up.

## Public IPv4

- Requested per interface at create time (`family: "IPv4"` on a `public` interface). Max 5 public IPv4+IPv6 addresses per server, and 1 utility IPv4. ([IP addresses](https://developers.upcloud.com/1.3/10-ip-addresses/))
- Starter and Premium include one public IPv4. Cloud Native and extra IPs bill hourly. ([Configurations](https://upcloud.com/docs/products/cloud-servers/configurations/), [Network billing](https://upcloud.com/docs/products/networking/billing/))
- Each address has a `release_policy` of `release` or `keep`. `keep` converts the IP into a detached **floating IP that keeps billing**. The IP docs say the default is `keep`, but the `DELETE /server` description says it "releases its IP addresses". **Set `release_policy: "release"` explicitly** to avoid leaking billed IPs. ([IP addresses](https://developers.upcloud.com/1.3/10-ip-addresses/), [OpenAPI `deleteServer` / `serverIpReleasePolicy`](https://github.com/UpCloudLtd/upcloud-php-api/blob/main/generator/openapi/spec.json))
- Floating IPs (stable across Nodes) exist and bill whether or not they're attached. ([Network billing](https://upcloud.com/docs/products/networking/billing/))

## Stop and delete (incl. storage cleanup)

1. `POST /1.3/server/{uuid}/stop` with `stop_type: "hard"` (or `soft` + `timeout` 1–600 s, which hard-stops when the timeout expires). The response still says `started`, so poll until `stopped`. ([Servers](https://developers.upcloud.com/1.3/8-servers/))
2. `DELETE /1.3/server/{uuid}?storages=1&backups=delete`. The server "must be `stopped`". `storages=1` deletes attached disks (default `0` keeps them, and kept disks are billed). `backups` = `keep` (default) / `keep_latest` / `delete`, and is only valid together with `storages`. ([Servers](https://developers.upcloud.com/1.3/8-servers/))
3. A standalone storage can be deleted with `DELETE /1.3/storage/{uuid}?backups=delete`. It must be `online` and detached. ([Storages](https://developers.upcloud.com/1.3/9-storages/))

There's no single "destroy now" call: deletion takes stop, poll, then delete. If world data must survive a Session, it has to be copied off the Node before step 2 (or the disk kept with `storages=0`, which bills per GB-hour).

## Create-to-boot time

- Vendor claim only: "launch new servers in under 45 seconds", described as deploy-to-login. ([Cloud Servers product page](https://upcloud.com/products/cloud-servers/), [Cloud Native plans](https://upcloud.com/cloud-native-plans)) There's no SLA or published API timing, and the time for cloud-init plus Docker install plus image pull comes on top of it. **Measure in a spike.**

## TypeScript / JS SDK vs raw HTTP

- `@upcloud/upcloud` on npm (repo [UpCloudLtd/upcloud-javascript-api](https://github.com/UpCloudLtd/upcloud-javascript-api)) is **archived (last push 2021-05)**, and its README says "This SDK has been deprecated and won't receive more fixes". It uses Basic auth.
- Maintained official SDKs: [Go](https://github.com/UpCloudLtd/upcloud-go-api), [Python](https://github.com/UpCloudLtd/upcloud-python-api), [PHP](https://github.com/UpCloudLtd/upcloud-php-api) (generated by Fern from an OpenAPI spec), and the CLI [upctl](https://github.com/UpCloudLtd/upcloud-cli). There's also [`@upcloud/pulumi-upcloud`](https://www.npmjs.com/package/@upcloud/pulumi-upcloud) (TS types, but it's IaC, not an imperative client).
- UpCloud publishes an **OpenAPI 3.1 spec** (`info.version` 0.0.105) at [`upcloud-php-api/generator/openapi/spec.json`](https://github.com/UpCloudLtd/upcloud-php-api/blob/main/generator/openapi/spec.json) and as a beta reference at [developers.upcloud.com/api](https://developers.upcloud.com/api/). It says it's "a work-in-progress preview … subject to change without notice, including backwards incompatible changes, for example for tooling such as code generators".
- Recommendation: a thin hand-written `fetch` client over the ~10 endpoints Nether needs (server create/get/stop/delete, firewall PUT, plan/price/zone/template list). Optionally generate types from a pinned copy of the spec (e.g. with `openapi-typescript`).

## Open questions (need an account to answer)

- Real create→`started`→cloud-init-done timings per zone and plan.
- Whether there's an undocumented rate limit, and how it shows up (429? 503?).
- Per-account resource quotas (servers, cores, IPs) for new accounts.
- Whether custom templates can be used from other zones, and their storage cost.
- Current EUR prices (pricing page blocked automated fetch; use `GET /1.3/price`).
