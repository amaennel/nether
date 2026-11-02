# Research: Cloudflare DNS for per-Game-Server hostnames

Ticket: amaennel/nether#6. Researched 2026-11-02.

**Question.** How should each Game Server get a stable hostname through the Cloudflare DNS API when every Session runs on a fresh Node with a new public IP? The ticket covers A-record create/update, TTL minimums, proxied vs DNS-only, SRV for non-default ports, API token scoping, rate limits, and how DNS caching affects whether clients pick up a new IP.

## TL;DR

- Give each Game Server one **DNS-only (grey-cloud) A record**, for example `survival.mc.example.com`. At Session start, **PATCH** its `content` to the new Node's IP and set `ttl: 60`, the lowest TTL Cloudflare allows below Enterprise.
- **The normal Cloudflare proxy can't carry Minecraft.** It only handles HTTP/HTTPS on a fixed set of ports. Spectrum can proxy Minecraft, but it's a paid add-on and Pro/Business allow only one Minecraft app. Clients therefore connect to the Node's real IP.
- **Use SRV only for a non-default port.** The Java client looks up `_minecraft._tcp.<name>` and has done since 1.3.1. Point the SRV record at the per-Game-Server A record and leave it unchanged; each Session then updates only the A record.
- **A changed IP should reach clients within about 60–90 s.** Cloudflare serves a 60 s TTL, and the JVM caches successful lookups for 30 s by default (OpenJDK). SRV lookups go through JNDI, which has no documented cache.
- **Use one API token** with `Zone → DNS → Edit` permission, scoped to the single zone and optionally limited to an IP range. The rate limit of 1,200 requests per 5 min per token is far above what we'd use.

## 1. Creating and updating A records

| Operation | Endpoint | Notes |
|---|---|---|
| Find existing record | `GET /zones/{zone_id}/dns_records?name.exact=<fqdn>&type=A` | Name filter is case-insensitive. Needs DNS Read or DNS Write. [list] |
| Create | `POST /zones/{zone_id}/dns_records` | `name` is the full FQDN in Punycode. [create] |
| Update IP | `PATCH /zones/{zone_id}/dns_records/{dns_record_id}` | All body fields optional: `content` (IPv4 for A), `ttl`, `proxied`, `comment`, `tags`. Needs DNS Write. [edit] |

Auth uses `Authorization: Bearer <api token>`. The docs advise against the legacy Global API Key. [edit]

Suggested lifecycle (my synthesis, not Cloudflare guidance):

- When the Game Server is created, create the A record and store its `dns_record_id`. `comment`/`tags` can carry the Game Server id, and they have no effect on DNS answers. [edit]
- At Session start, once the Node has its public IP, PATCH `content`.
- At Session end, either leave the stale IP in place or PATCH it to a sentinel. Caution: UpCloud may hand the old IP to another customer, so a stale record could send players to someone else's machine. Repointing or deleting the record at Session end avoids that.

## 2. TTL

- DNS-only records accept a TTL from **60 s (non-Enterprise) or 30 s (Enterprise)** up to 1 day. "Auto" means 300 s. [ttl]
- In the API, `ttl: 1` means "automatic". Otherwise the value must be 60–86400 (minimum 30 on Enterprise). [edit]
- Proxied records are fixed at Auto (300 s) and the TTL can't be edited. [ttl]
- Nether should therefore use **`ttl: 60`** on its DNS-only A records.

## 3. Proxied vs DNS-only

- Only A, AAAA and CNAME records can be proxied, so SRV is always DNS-only. [proxied]
- The proxy carries HTTP/HTTPS only. Cloudflare lists "non-HTTP services" as a case for DNS-only records. [proxied] [proxy-status]
- Default proxied ports are HTTP 80, 8080, 8880, 2052, 2082, 2086, 2095 and HTTPS 443, 2053, 2083, 2087, 2096, 8443. **25565 is not on the list.** Other ports need either a grey-clouded record or Spectrum. [ports]
- **Spectrum** supports Minecraft. On Pro and Business it's a paid add-on limited to one Minecraft app. Custom TCP/UDP requires Enterprise. [spectrum] [spectrum-plans]
  - With one app per zone, this doesn't fit many Game Servers. It's only worth revisiting if hiding the origin IP or DDoS protection becomes a requirement.
- What DNS-only costs: the Node's IP is visible to anyone who resolves the name. Cloudflare notes this "removes a layer of protection against targeted attacks." [proxied] Ephemeral Nodes reduce that risk somewhat.

## 4. SRV records for non-default ports (Minecraft Java)

- Java Edition has supported SRV since **1.3.1**. The client only looks for SRV records at **`_minecraft._tcp.<domain>`**. The record value is priority, weight, port and target, with the target being a hostname that has an A record. Example: `0 5 25565 mc.example.com`. [mcwiki-java]
- Cloudflare's API takes SRV fields in a `data` object: `priority`, `weight`, `port` (0–65535) and `target` (a hostname). `content` is read-only and derived from those fields. [create]
- The client resolves SRV through the JDK's JNDI DNS provider (`com.sun.jndi.dns.DnsContextFactory`, provider URL `dns:`), as the OpenJDK bug reports filed from Minecraft show. [jdk-8272996] [mc-31433]
  - Some JDKs had a bug where SRV lookups failed on hosts with IPv6 DNS servers. In that case the client silently falls back to the plain A record on port 25565. The bug was fixed in JDK 17.0.3 and 18.0.1. [jdk-8272996] [jdk-8272997]
- **Suggested approach** (synthesis):
  - **If Nodes listen on 25565**, which is natural with one Game Server per Node, no SRV record is needed and the A record is enough.
  - **If a non-default port is ever used**, create one static SRV record, `_minecraft._tcp.<gs>.<zone>` → port P, target `<gs>.<zone>`. Only the A record then changes per Session.
- I found no primary source confirming that **Bedrock Edition** supports SRV, so treat it as unsupported until checked.

## 5. API token scoping

- Create a custom API token with permission **Zone → DNS → Edit** ("DNS Write"). Zone permissions have scope `com.cloudflare.api.account.zone`. [perms]
- Limit the token's zone resources to the one zone. Requests to other zones then fail. [create-token]
- Optional extra restrictions:
  - **Client IP address filtering**, for example to the controller's egress IP.
  - A token **TTL** (start/end validity). [create-token]
- One Nether-wide token covers every Game Server. Cloudflare can't scope a token to individual records.

## 6. Rate limits

- Each user or account token gets **1,200 requests per 5 minutes**, plus 200 requests per second per IP. Going over returns HTTP 429 and blocks all calls for the next 5 minutes. [limits]
- Nether makes roughly one GET (or a cached record id) and one PATCH per Session start, so this limit doesn't matter.

## 7. Will clients pick up a changed IP promptly?

Players see a new IP after the following caches expire:

1. **Recursive resolvers** such as the ISP's or 1.1.1.1 cache the answer for up to the record TTL. That's 60 s if Nether sets `ttl: 60`. [ttl]
2. **JVM `InetAddress` cache.** By default OpenJDK keeps successful lookups for **30 s** (`DEFAULT_POSITIVE = 30`) and doesn't cache failed lookups. [jdk-cachepolicy]
   - Oracle documents the default as "implementation-specific" when no security manager is installed, and as forever when one is. The client doesn't install a security manager. [oracle-net]
   - This is controlled by the `networkaddress.cache.ttl` security property. [oracle-net]
3. **JNDI DNS (SRV) lookups.** The JNDI DNS provider docs describe only timeouts (1 s initial, 4 retries) and say nothing about caching. [jndi-dns]
4. **Minecraft's own caching.** I found no first-party documentation. The game's source isn't published, so I couldn't check whether the client caches resolved addresses beyond the JVM.
   - In practice, a player who has the client open before the Session starts and clicks a server entry triggers a fresh resolve. The worst case is still bounded by points 1 and 2.

**Expected staleness:** about 60 s, worst case about 90 s, if `ttl: 60` is set before players try to connect.

- Typical flow: the Session starts → the Node gets its IP → DNS is PATCHed → players are notified.
- Players who tried while the Node was booting may briefly get the old IP. Repointing or deleting the record at Session end means they get a failure instead of someone else's machine.
- Resolvers that ignore TTLs and enforce higher minimums are outside our control.

## Inputs for the "Connect hostname scheme" decision (#16)

1. Use DNS-only A records, one per Game Server, in a Nether-managed (sub)zone, with `ttl: 60`.
2. PATCH the A record on Session start. Repoint or delete it on Session end to avoid stale IPs reaching recycled addresses.
3. Run on port 25565 so no SRV record is needed. If a custom port is ever used, add a static SRV record targeting the A record.
4. Use one zone-scoped token with DNS Edit permission, optionally IP-restricted.
5. Expect clients to see the new IP within about 1–1.5 min. Notify players only after the PATCH succeeds.

## Sources

- [ttl] Cloudflare, Time to Live (TTL): https://developers.cloudflare.com/dns/manage-dns-records/reference/ttl/
- [edit] Cloudflare API, Edit DNS record: https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/edit/
- [create] Cloudflare API, Create DNS record: https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/create/
- [list] Cloudflare API, List DNS records: https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/list/
- [proxied] Cloudflare, Proxied DNS records: https://developers.cloudflare.com/dns/manage-dns-records/reference/proxied-dns-records/
- [proxy-status] Cloudflare, Proxy status: https://developers.cloudflare.com/dns/proxy-status/
- [ports] Cloudflare, Network ports: https://developers.cloudflare.com/fundamentals/reference/network-ports/
- [spectrum] Cloudflare Spectrum: https://developers.cloudflare.com/spectrum/
- [spectrum-plans] Cloudflare Spectrum, Protocols per plan: https://developers.cloudflare.com/spectrum/protocols-per-plan/
- [perms] Cloudflare, API token permissions: https://developers.cloudflare.com/fundamentals/api/reference/permissions/
- [create-token] Cloudflare, Create API token: https://developers.cloudflare.com/fundamentals/api/get-started/create-token/
- [limits] Cloudflare, API rate limits: https://developers.cloudflare.com/fundamentals/api/reference/limits/
- [mcwiki-java] Minecraft Wiki, Tutorial: Setting up a Java Edition server (SRV section): https://minecraft.wiki/w/Tutorial:Setting_up_a_Java_Edition_server
- [jdk-8272996] OpenJDK bug JDK-8272996 (SRV lookup via JNDI from Minecraft, IPv6): https://bugs.openjdk.org/browse/JDK-8272996
- [jdk-8272997] OpenJDK bug JDK-8272997: https://bugs.openjdk.org/browse/JDK-8272997
- [mc-31433] Mojang bug MC-31433 (SRV not resolved with IPv6 resolver): https://bugs-legacy.mojang.com/browse/MC-31433
- [jdk-cachepolicy] OpenJDK source, `sun/net/InetAddressCachePolicy.java`: https://github.com/openjdk/jdk/blob/master/src/java.base/share/classes/sun/net/InetAddressCachePolicy.java
- [oracle-net] Oracle, Java SE 21 Networking properties: https://docs.oracle.com/en/java/javase/21/core/java-networking.html
- [jndi-dns] Oracle, `jdk.naming.dns` module (JNDI DNS provider): https://docs.oracle.com/en/java/javase/21/docs/api/jdk.naming.dns/module-summary.html
