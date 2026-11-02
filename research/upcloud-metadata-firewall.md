# UpCloud metadata service and Node firewall

Research for [amaennel/nether#20](https://github.com/amaennel/nether/issues/20), which [Node security hardening](https://github.com/amaennel/nether/issues/21) is waiting on. Gathered 2026-11-03 from UpCloud's API reference (v1.3), UpCloud's product docs and guides, the OpenAPI spec UpCloud publishes, cloud-init's docs and source, and Docker's docs. No UpCloud account was available, so nothing here was tried on a live Node. Claims that rest only on inference, or that the docs leave open, are marked **Unverified**.

Builds on [UpCloud API capabilities for ephemeral Nodes](https://github.com/amaennel/nether/blob/research/upcloud-api/research/upcloud-api.md) (#5) and the user_data design in [Node bootstrap and Runtime delivery](https://github.com/amaennel/nether/issues/11).

## TL;DR

- **The metadata service has no authentication.** `curl http://169.254.169.254/metadata/v1.json` returns everything, `user_data` included, with no token or header. UpCloud says it's reachable "only from within the server itself" but "through all networks: public, Utility and SDN Private Networks". Whatever we put in `user_data`, including the bootstrap token and the GHCR pull token, is readable by any process on the Node that can open a TCP connection to `169.254.169.254:80`.
- **A Docker container on the default bridge almost certainly reaches it.** Docker masquerades bridge traffic out through the host, so the request looks like it came from the Node itself. **Unverified**: no doc says this about UpCloud specifically. It takes one `docker run … curl` on a real Node to confirm. Docker's documented place to block it is the `DOCKER-USER` iptables chain.
- **It can't be turned off at create on our template.** `metadata: "no"` with a cloud-init template fails with `409 METADATA_DISABLED_ON_CLOUD-INIT`. The stock Ubuntu 24.04 template's cloud-init UpCloud datasource reads only that HTTP endpoint, with no config drive or other fallback. The modify-server call does accept `metadata: yes/no` and documents no matching error, so turning it off after boot may work. **Unverified.**
- **`user_data` stays readable for the Node's whole life.** It's "immutable during the server's lifetime, and can be removed by deleting the server", and the metadata service keeps serving it. On disk, cloud-init keeps copies under `/var/lib/cloud/instances/<id>/`, all root-only (mode 0600/0400). Non-root users get it redacted from `/run/cloud-init/instance-data.json`.
- **The UpCloud firewall is free, stateless and can't be set in the create call.** `POST /server` takes only `firewall: on|off` (default `on`). Rules come after create with `PUT /server/{uuid}/firewall_rule`, and changes take 1–2 minutes to apply. Because it's stateless, every reply needs its own inbound rule (DNS, NTP, and maybe TCP). The default policy on a new Node's public firewall isn't documented.
- **What a hardened Node must still reach:** DHCP on its interfaces, UpCloud DNS resolvers `94.237.127.9` / `94.237.40.9` (IPv6 `2a04:3540:53::1` / `2a04:3544:53::1`, the same in every zone), NTP (UpCloud's Ubuntu 24.04 example syncs to the public `0.ubuntu.pool.ntp.org`, and UpCloud documents no NTP server of its own), and the metadata service itself if cloud-init has to run.

## Metadata service

### What it serves and to whom

- "Metadata is available per server basis when enabled at server creation or if enabled at a later time by modifying the server, and only from within the server itself. The server can query the metadata HTTP API available at the IP address 169.254.169.254 to list either the full information in JSON or per single metadata field available as a directory tree." ([Servers: Metadata service](https://developers.upcloud.com/1.3/8-servers/))
- Fields at `/metadata/v1/`: `cloud_name`, `instance_id`, `hostname`, `platform`, `subplatform`, `public_keys`, `region`, `network/`, `storage/`, `tags`, `user_data` and `vendor_data`. The example `v1.json` returns `"user_data": "apt-get update && apt-get -y upgrade"` verbatim. ([Servers: Metadata service](https://developers.upcloud.com/1.3/8-servers/))
- "Metadata is available to be queried through all networks: public, Utility and SDN Private Networks." Every example is a plain `curl` with no header or token. ([Using the UpCloud Metadata service](https://upcloud.com/docs/guides/upcloud-metadata-service/))
- cloud-init: "This instance metadata service serves information about the running server via HTTP over the address 169.254.169.254", which is "available in every DHCP-configured interface". ([cloud-init UpCloud datasource](https://docs.cloud-init.io/en/latest/reference/datasources/upcloud.html))
- I found **no authentication or session-token mechanism** (nothing like AWS IMDSv2's PUT-for-token) in the API reference, the metadata guide or the cloud-init datasource. cloud-init itself fetches with a plain GET on `http://169.254.169.254/metadata/v1.json` ([`DataSourceUpCloud.py`](https://github.com/canonical/cloud-init/blob/main/cloudinit/sources/DataSourceUpCloud.py)).

**So:** any process on the Node that can reach `169.254.169.254:80` can read `user_data`, which holds the bootstrap token and the GHCR PAT (#11). Being root isn't required.

### From inside a Docker container

- Docker's bridge driver "uses masquerading to give containers external network access", and `com.docker.network.bridge.enable_ip_masquerade` defaults to `true`. ([Docker: Bridge network driver](https://docs.docker.com/engine/network/drivers/bridge/))
- Container traffic that leaves the host goes through the `FORWARD` chain. Docker adds rules there that "unconditionally jump to the `DOCKER-USER`, `DOCKER-FORWARD` and `DOCKER-INGRESS` chains". `DOCKER-USER` is "a placeholder for user-defined rules that will be processed before rules in the `DOCKER-FORWARD` and `DOCKER` chains". Docker's docs say filtering of Docker-handled packets belongs there. ([Docker: iptables](https://docs.docker.com/engine/network/firewall-iptables/))
- Docker's nat rules divert container traffic "before it reaches the `INPUT` and `OUTPUT` chains", and **ufw is effectively bypassed** for published container ports: "Packets are routed before the firewall rules can be applied, effectively ignoring your firewall configuration." ([Docker: Packet filtering and firewalls](https://docs.docker.com/engine/network/packet-filtering-firewalls/))
- **Inference, unverified on UpCloud:** a default-bridge container's request to `169.254.169.254` is routed out the Node's interface and masqueraded to the Node's address. UpCloud only distinguishes "from within the server", so it should answer. A container with `--network host` shares the host's stack and reaches it regardless. One command on a live Node settles it: `docker run --rm curlimages/curl -s http://169.254.169.254/metadata/v1/user_data`. If it is reachable, these host-only Linux mechanisms can block it: an iptables/nftables rule in `DOCKER-USER` that drops traffic to `169.254.169.254`, or a `--internal`/no-masquerade network. Neither depends on UpCloud's firewall. Whether UpCloud's own firewall filters link-local metadata traffic at all isn't documented (see below).

### Can it be turned off?

- The `metadata` attribute is `yes`/`no`, default `no`, on both create and modify. ([Servers](https://developers.upcloud.com/1.3/8-servers/); `createServer` and `modifyServer` schemas in the [OpenAPI spec](https://github.com/UpCloudLtd/upcloud-php-api/blob/main/generator/openapi/spec.json))
- At create on a cloud-init template: `409 METADATA_DISABLED_ON_CLOUD-INIT`, "Metadata cannot be disabled when creating a server from a cloud-init template." The public Ubuntu templates are cloud-init type (#5). ([Servers](https://developers.upcloud.com/1.3/8-servers/))
- After create: "Cloud Servers deployed without the service can enable it at any point without the need to restart the server." ([Metadata guide](https://upcloud.com/docs/guides/upcloud-metadata-service/)) The modify-server error list has **no** metadata-related code, and changing `metadata` isn't among the changes that require `stopped`. A `PUT /1.3/server/{uuid}` with `metadata: "no"` after cloud-init has finished is therefore *documented as an accepted attribute*. **Unverified** whether UpCloud accepts it on a server cloned from a cloud-init template, and how quickly the endpoint stops answering.

### What cloud-init does without it

- The UpCloud datasource's only source is `metadata_url` = `http://169.254.169.254/metadata/v1.json`, retried 30 × 2 s (about one minute). If that fails, `_get_data` returns `False` and the datasource isn't used. The datasource has **no config drive or other fallback**, and neither UpCloud's docs nor cloud-init's UpCloud page mention a config drive. ([`DataSourceUpCloud.py`](https://github.com/canonical/cloud-init/blob/main/cloudinit/sources/DataSourceUpCloud.py), [cloud-init UpCloud datasource](https://docs.cloud-init.io/en/latest/reference/datasources/upcloud.html)) So on first boot, metadata off means no user_data, no SSH keys and no network config from UpCloud, and the create call blocks that case anyway.
- **On later boots** (from cloud-init source, unverified on UpCloud): `check_instance_id` compares the cached instance ID with the DMI system UUID. If they match, cloud-init restores the cached datasource (`obj.pkl`) instead of re-fetching. Network config is regenerated only on a new instance (`default_update_events` = `BOOT_NEW_INSTANCE`). A Node rebooted after metadata was turned off should therefore boot from cache. ([`DataSourceUpCloud.py`](https://github.com/canonical/cloud-init/blob/main/cloudinit/sources/DataSourceUpCloud.py), [`sources/__init__.py`](https://github.com/canonical/cloud-init/blob/main/cloudinit/sources/__init__.py), [`stages.py`](https://github.com/canonical/cloud-init/blob/main/cloudinit/stages.py))

## user_data persistence

### Through the metadata service

- "User-data is immutable during the server's lifetime, and can be removed by deleting the server." ([cloud-init UpCloud datasource](https://docs.cloud-init.io/en/latest/reference/datasources/upcloud.html)) The modify-server schema has no `user_data` field ([OpenAPI spec](https://github.com/UpCloudLtd/upcloud-php-api/blob/main/generator/openapi/spec.json)). The service therefore keeps returning the original `user_data` for as long as it's on, including on a Parked Node.

### On disk

The paths and modes below come from cloud-init source, so they apply to any cloud-init version close to `main`. Ubuntu 24.04 ships a recent cloud-init, but I haven't checked its exact version.

| Location | Contents | Mode |
|---|---|---|
| `/var/lib/cloud/instances/<instance-id>/user-data.txt` (via the `/var/lib/cloud/instance` symlink) | raw `user_data` | 0600 ([`stages.py` `_store_rawdata`](https://github.com/canonical/cloud-init/blob/main/cloudinit/stages.py)) |
| `…/user-data.txt.i` | processed MIME of `user_data` | 0600 (`_store_processeddata`) |
| `…/obj.pkl` | pickled datasource, which includes `userdata_raw` and the full metadata | 0400 ([`sources/__init__.py` `pkl_store`](https://github.com/canonical/cloud-init/blob/main/cloudinit/sources/__init__.py)) |
| `/run/cloud-init/instance-data-sensitive.json` | instance data including user data | 0600 (`stages.py`) |
| `/run/cloud-init/instance-data.json` | same, with `userdata`/`user_data`/`user-data` keys redacted (`sensitive_metadata_keys`) | world-readable ([Instance data](https://docs.cloud-init.io/en/latest/explanation/instancedata.html)) |
| anything `write_files` writes, e.g. `/etc/nether/runtime.env` (#11) | the tokens themselves | whatever the cloud-config sets |

- "Cloud-init separates this sensitive data such that is it only readable by root. Non-root users referencing `userdata` or `vendordata` keys will see only redacted values." ([Instance data](https://docs.cloud-init.io/en/latest/explanation/instancedata.html))
- The directory layout (`instances/<id>/user-data.txt`, `obj.pkl`, `scripts/`, `sem/`) is documented in [Directory layout (23.2.1)](https://docs.cloud-init.io/en/23.2.1/development/dir_layout.html).
- **So:** on disk the copies need root, or a bind mount of `/var/lib/cloud` or `/run/cloud-init`, to read. Over HTTP the metadata service needs neither.

## UpCloud firewall (Public & Utility)

### API semantics

- Per-server rule chain at `/1.3/server/{uuid}/firewall_rule`: `GET` lists, `GET …/{index}` gets one, `POST` creates one, `PUT` replaces the whole chain, and `DELETE …/{index}` removes one (positions renumber after a delete). Max 1000 rules. "Please allow 1-2 minutes for the firewall changes to take effect." "The firewall is enabled on all network interfaces except ones attached to private virtual networks." Rules are matched "in numerical order starting from the first rule". The final rule holds only `direction`/`action`, "corresponds to Default Rule set through Control Panel", and acts as the default policy. ([Firewall API](https://developers.upcloud.com/1.3/11-firewall/))
- Rule fields: `direction` (in/out), `action` (accept/drop), `position` 1–1000, `family` (IPv4/IPv6), `protocol` (tcp/udp/icmp), `icmp_type`, `source_address_start/end`, `source_port_start/end`, `destination_address_start/end`, `destination_port_start/end` and `comment`. ([Firewall API](https://developers.upcloud.com/1.3/11-firewall/))
- **Can it go in `POST /server`?** No. The create schema has only `firewall: on|off` (default `on`, and `FIREWALL_INVALID` on a bad value). There's no rules array and no default-action field. Rules can only go on after create. ([Servers](https://developers.upcloud.com/1.3/8-servers/), `createServer` in the [OpenAPI spec](https://github.com/UpCloudLtd/upcloud-php-api/blob/main/generator/openapi/spec.json))
- The OpenAPI spec (but not the v1.3 HTML reference) lists `firewall_public_default_incoming_action` / `firewall_public_default_outgoing_action` (`accept|drop`) on **modify** server and server details only. ([OpenAPI spec](https://github.com/UpCloudLtd/upcloud-php-api/blob/main/generator/openapi/spec.json))

### Stateless

- "As a stateless firewall, users must configure rules to allow both incoming and outgoing traffic explicitly." The SDN (private network) firewall is the stateful one. ([Firewall](https://upcloud.com/docs/products/networking/firewall/))
- "Note that the UpCloud firewall is stateless and does not keep track of connections. Make sure to configure rules to allow both incoming and outgoing traffic." ([How to use the UpCloud firewall](https://upcloud.com/docs/guides/managing-firewall/))
- In practice: DNS replies need inbound UDP and TCP **from source port 53** of the resolvers ([DNS servers guide](https://upcloud.com/docs/guides/dns-servers/)). NTP replies need inbound UDP **from source port 123** ("Set port 123 as the source port of the rules, not the destination port") ([Time zones and synchronisation](https://upcloud.com/docs/guides/time-zones-and-synchronisation/)). The Control Panel has an "Auto-add DNS rules" toggle.
- **Ambiguity on TCP:** UpCloud's multi-tier reference architecture says "This firewall does not keep track of **UDP** traffic", and its admin host gets only outgoing-accept, SSH-in, DNS-reply and NTP-reply rules plus a final inbound drop, with no rule for TCP replies. ([Multi-tier application](https://upcloud.com/docs/reference-architectures/multi-tier-application/)) That suggests replies to outbound TCP (the Runtime's `wss://` to the Orchestrator, HTTPS to GHCR/apt/the Archive) might pass. The firewall and DNS guides, however, say all traffic is stateless and recommend a TCP source-port-53 rule. **Unverified.** Test on a live Node before relying on either reading.

### Default policy

- Not documented for the Public & Utility firewall on a server created through the API. The API default is `firewall: "on"` ([Servers](https://developers.upcloud.com/1.3/8-servers/)). The Control Panel guide says "When you first open your firewall settings, the rules list will be empty and the firewall itself is disabled" ([guide](https://upcloud.com/docs/guides/managing-firewall/)). What an `on` firewall with an empty chain does is **unverified**. The prior research's reading (#5) was that the Node runs under the account/server defaults until rules are applied.
- For comparison, the SDN firewall's documented defaults on a new server are drop incoming and accept outgoing ([Firewall](https://upcloud.com/docs/products/networking/firewall/)).
- Outbound SMTP port 25 "is closed on all new accounts … This block appears in the Cloud Server's UpCloud firewall settings and cannot be modified directly." ([Firewall](https://upcloud.com/docs/products/networking/firewall/))
- **Free trial accounts** only allow inbound 22, 80, 443, 3389 and 33434–33534, and outbound 53, 80, 123, 443, 8080 and 33434–33534. Inbound TCP 25565 is therefore blocked until the trial is over. ([Firewall: Trial limitations](https://upcloud.com/docs/products/networking/firewall/))

### Cost

- "All firewall features are included at no additional cost." ([Firewall](https://upcloud.com/docs/products/networking/firewall/)) "The firewall is configured per server and is included at no additional cost." ([guide](https://upcloud.com/docs/guides/managing-firewall/))

### What it can't see

- Private (SDN) network interfaces are excluded ([Firewall API](https://developers.upcloud.com/1.3/11-firewall/)). The firewall does cover the public interface and the **Utility network**, which "connects every Cloud Server in your account". Without a firewall, a server can reach another server's utility address "on any port". ([Multi-tier application](https://upcloud.com/docs/reference-architectures/multi-tier-application/)) A Node created without a `utility` interface isn't on that network, which follows from the interface list in `POST /server` (#5).
- Whether it filters traffic to `169.254.169.254` or DHCP isn't documented anywhere I found. **Unverified.** Being a hypervisor-side service, the metadata endpoint may sit inside the firewall boundary, so host-level (in-Node) filtering is the only control the docs support for keeping containers off it.

## Other endpoints a Node talks to

| Endpoint | What | Source |
|---|---|---|
| `169.254.169.254:80` (HTTP) | metadata service, which cloud-init needs on first boot | [Servers](https://developers.upcloud.com/1.3/8-servers/) |
| DHCP on the public (and utility, if attached) interfaces | addresses come from DHCP (`"dhcp": true` in metadata), and cloud-init's local stage does an ephemeral DHCPv4 before reading metadata | [Servers](https://developers.upcloud.com/1.3/8-servers/), [`DataSourceUpCloud.py`](https://github.com/canonical/cloud-init/blob/main/cloudinit/sources/DataSourceUpCloud.py) |
| `94.237.127.9`, `94.237.40.9` (IPv6 `2a04:3540:53::1`, `2a04:3544:53::1`), port 53 UDP+TCP | UpCloud DNS resolvers, delivered via DHCP. "All DNS resolvers at UpCloud have the same IP addresses regardless of the location." | [DNS servers guide](https://upcloud.com/docs/guides/dns-servers/) |
| NTP, UDP 123 | UpCloud documents no NTP server of its own. Its Ubuntu 24.04 example syncs via systemd-timesyncd to `0.ubuntu.pool.ntp.org`, so this is public internet, not link-local | [Time zones and synchronisation](https://upcloud.com/docs/guides/time-zones-and-synchronisation/) |
| `169.254.169.254:1688` | Windows KMS only, not relevant to Linux Nodes | [Windows licensing](https://upcloud.com/docs/products/cloud-servers/windows-licensing/) (search snippet) |
| Utility network (`10.x`) | only if the Node has a `utility` interface; shared by every server in the account | [Multi-tier application](https://upcloud.com/docs/reference-architectures/multi-tier-application/) |

`169.254.0.0/16` can't be used for private networks, so it never collides with an SDN range (SDN docs, search snippet).

## Open questions (need a live Node)

1. Does `docker run --rm curlimages/curl http://169.254.169.254/metadata/v1/user_data` on the default bridge return the user_data? (Expected yes.)
2. Does `PUT /1.3/server/{uuid}` with `metadata: "no"` succeed on a cloud-init-template Node after boot, how fast does the endpoint stop answering, and does a reboot afterwards still come up cleanly from the cloud-init cache?
3. Does the UpCloud firewall filter `169.254.169.254` and DHCP traffic at all?
4. With an inbound default of drop and no reply rules, do replies to outbound TCP (HTTPS, `wss://`) get through, as the multi-tier architecture implies, or not, as the "stateless" wording implies?
5. On a server created through the API with `firewall: "on"` and no rules, what's the effective default action in each direction?
6. Does the stock Ubuntu 24.04 template attach anything beyond what `POST /server` asks for (e.g. a utility interface or IPv6)? This decides which of the endpoints above apply.
