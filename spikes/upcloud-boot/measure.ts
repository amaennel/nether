// Throwaway spike for "Task: measure UpCloud Node boot-to-ready and verify
// zone plans/prices" (amaennel/nether#18). Not Nether code. Node >= 23, no deps.
//
//   node measure.ts                 inventory + boot timing (4 Nodes) + teardown
//   node measure.ts --inventory     read-only: plans, prices, quotas, rate-limit burst
//   node measure.ts --billing-probe one small Node for ~75 min, polling account credits
//   node measure.ts --custom-image  bake a custom template (if results/template.json is
//                                   missing), then boot stock vs baked Nodes per zone
//   node measure.ts --delete-template  delete the template in results/template.json
//   node measure.ts --cleanup       tear down anything left with the nether-spike label
//
// Auth: UPCLOUD_TOKEN (ucat_…) or UPCLOUD_USERNAME + UPCLOUD_PASSWORD.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const API = "https://api.upcloud.com/1.3";
const ZONES = (process.env.ZONES ?? "de-fra1,fi-hel1").split(",");
const PLAN = process.env.PLAN ?? "STARTER-2xCPU-4GB";
type Variant = "apt" | "getdocker" | "baked";
const TIER_PLANS = ["STARTER-2xCPU-4GB", "STARTER-2xCPU-8GB", "STARTER-4xCPU-8GB", "STARTER-4xCPU-16GB"];
const LABEL = "nether-spike";
const NODE_TIMEOUT_MS = 25 * 60_000;

const runId = new Date().toISOString().replace(/[:.]/g, "-");
const OUT = join(HERE, "results", runId);
mkdirSync(OUT, { recursive: true });
const STATE_FILE = join(HERE, "results", "live-nodes.json");
const TEMPLATE_FILE = join(HERE, "results", "template.json");
const BUILD_DISK_GB = Number(process.env.BUILD_DISK_GB ?? 10);

const authHeader = process.env.UPCLOUD_TOKEN
  ? `Bearer ${process.env.UPCLOUD_TOKEN}`
  : process.env.UPCLOUD_USERNAME && process.env.UPCLOUD_PASSWORD
    ? `Basic ${Buffer.from(`${process.env.UPCLOUD_USERNAME}:${process.env.UPCLOUD_PASSWORD}`).toString("base64")}`
    : undefined;
if (!authHeader) {
  console.error("Set UPCLOUD_TOKEN, or UPCLOUD_USERNAME and UPCLOUD_PASSWORD.");
  process.exit(1);
}

const log = (...a: unknown[]) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const save = (name: string, data: unknown) =>
  writeFileSync(join(OUT, name), typeof data === "string" ? data : JSON.stringify(data, null, 2));

// ---------------------------------------------------------------- API client

type ApiCall = { at: string; method: string; path: string; status: number; ms: number; headers?: Record<string, string> };
const apiCalls: ApiCall[] = [];
const interestingHeader = (h: string) => /rate|limit|retry|quota|throttl/i.test(h);

async function api<T = any>(method: string, path: string, body?: unknown, okStatuses = [200, 201, 202, 204]): Promise<{ status: number; data: T }> {
  for (let attempt = 0; ; attempt++) {
    const started = Date.now();
    const res = await fetch(API + path, {
      method,
      headers: { Authorization: authHeader!, "Content-Type": "application/json", Accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => interestingHeader(k) && (headers[k] = v));
    apiCalls.push({ at: new Date(started).toISOString(), method, path, status: res.status, ms: Date.now() - started, ...(Object.keys(headers).length ? { headers } : {}) });
    const text = await res.text();
    const data = text ? JSON.parse(text) : undefined;
    if ((res.status === 429 || res.status >= 500) && attempt < 5) {
      log(`  ${method} ${path} -> ${res.status}, backing off`, headers);
      await sleep(2 ** attempt * 1000);
      continue;
    }
    if (!okStatuses.includes(res.status)) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
    return { status: res.status, data };
  }
}

// ---------------------------------------------------------------- inventory

async function inventory() {
  log("Inventory: account, zones, plans, prices, templates");
  const [{ data: account }, { data: zones }, { data: plans }, { data: prices }] = await Promise.all([
    api("GET", "/account"),
    api("GET", "/zone"),
    api("GET", "/plan"),
    api("GET", "/price"),
  ]);
  // Keep quotas and balance; drop the username.
  const acct = { credits: account.account.credits, resource_limits: account.account.resource_limits };
  save("account.json", acct);
  save("zones.json", zones);
  save("plans.json", plans);
  save("prices.json", prices);

  const starter = (plans.plans.plan as any[]).filter((p) => p.name.startsWith("STARTER-"));
  const byMem = new Map<number, string[]>();
  for (const p of starter) byMem.set(p.memory_amount, [...(byMem.get(p.memory_amount) ?? []), p.name]);
  const sameRamPairs = [...byMem.values()].filter((names) => names.length > 1);

  const zonePrices = Object.fromEntries(
    (prices.prices.zone as any[]).map((z) => [
      z.name,
      Object.fromEntries(
        Object.entries(z).filter(([k]) => k.includes("STARTER") || k === "ipv4_address" || k.startsWith("storage_standard")),
      ),
    ]),
  );

  const perZone = Object.fromEntries(
    ZONES.map((zone) => [
      zone,
      Object.fromEntries(
        TIER_PLANS.map((plan) => [plan, zonePrices[zone]?.[`server_plan_${plan}`] ?? null]),
      ),
    ]),
  );

  const { data: templates } = await api("GET", "/storage/template");
  const ubuntu = (templates.storages.storage as any[]).filter((s) => /ubuntu/i.test(s.title));
  save("templates-ubuntu.json", ubuntu);

  const inv = { account: acct, zones: zones.zones.zone, starterPlans: starter, sameRamPairs, perZone, zonePrices, ubuntuTemplates: ubuntu.map((t) => ({ uuid: t.uuid, title: t.title, template_type: t.template_type })) };
  save("inventory.json", inv);
  return inv;
}

async function rateLimitBurst() {
  log("Rate-limit probe: 60 GET /zone, 10 at a time");
  const results: { status: number; ms: number }[] = [];
  for (let batch = 0; batch < 6; batch++) {
    await Promise.all(
      Array.from({ length: 10 }, async () => {
        const started = Date.now();
        const res = await fetch(`${API}/zone`, { headers: { Authorization: authHeader! } });
        await res.arrayBuffer();
        const headers: Record<string, string> = {};
        res.headers.forEach((v, k) => interestingHeader(k) && (headers[k] = v));
        results.push({ status: res.status, ms: Date.now() - started, ...(Object.keys(headers).length ? { headers } : {}) });
      }),
    );
  }
  const statuses = results.reduce<Record<number, number>>((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {});
  const burst = { statuses, maxMs: Math.max(...results.map((r) => r.ms)), sample: results.find((r) => "headers" in r) ?? results[0] };
  save("rate-limit-burst.json", { burst, results });
  return burst;
}

// ---------------------------------------------------------------- probes from the laptop

function sshBanner(ip: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: ip, port: 22, timeout: 3000 });
    s.once("data", (d) => { s.destroy(); resolve(d.toString().startsWith("SSH-")); });
    s.once("timeout", () => { s.destroy(); resolve(false); });
    s.once("error", () => resolve(false));
  });
}

const varint = (n: number) => {
  const out: number[] = [];
  do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n);
  return Buffer.from(out);
};
const packet = (...parts: Buffer[]) => { const body = Buffer.concat(parts); return Buffer.concat([varint(body.length), body]); };

// Minecraft Server List Ping: handshake (next state 1) + status request.
function serverListPing(ip: string): Promise<any | null> {
  return new Promise((resolve) => {
    const s = net.connect({ host: ip, port: 25565, timeout: 3000 });
    let buf = Buffer.alloc(0);
    s.once("connect", () => {
      const host = Buffer.from(ip);
      const port = Buffer.alloc(2); port.writeUInt16BE(25565);
      s.write(packet(varint(0), varint(767), varint(host.length), host, port, varint(1)));
      s.write(packet(varint(0)));
    });
    s.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      const start = buf.indexOf("{");
      const end = buf.lastIndexOf("}");
      if (start >= 0 && end > start) {
        try { const j = JSON.parse(buf.subarray(start, end + 1).toString()); s.destroy(); resolve(j); } catch { /* wait for more */ }
      }
    });
    s.once("timeout", () => { s.destroy(); resolve(null); });
    s.once("error", () => resolve(null));
    s.once("close", () => resolve(null));
  });
}

async function fetchNodeFile(ip: string, name: string): Promise<string | null> {
  try {
    const res = await fetch(`http://${ip}:8080/${name}`, { signal: AbortSignal.timeout(3000) });
    return res.ok ? await res.text() : null;
  } catch { return null; }
}

// ---------------------------------------------------------------- Node lifecycle

type Live = { uuid: string; zone: string; title: string; ip?: string; storages: string[] };

const readLive = (): Live[] => { try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch { return []; } };
const writeLive = (nodes: Live[]) => writeFileSync(STATE_FILE, JSON.stringify(nodes, null, 2));
const addLive = (n: Live) => writeLive([...readLive().filter((x) => x.uuid !== n.uuid), n]);
const dropLive = (uuid: string) => writeLive(readLive().filter((x) => x.uuid !== uuid));

function sshKey() {
  const keyPath = join(OUT, "spike_ed25519");
  execFileSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-q", "-f", keyPath, "-C", "nether-spike"]);
  return { keyPath, pub: readFileSync(`${keyPath}.pub`, "utf8").trim() };
}

async function createNode(opts: { zone: string; plan: string; template: string; title: string; pub: string; userData?: string; storageSize: number; storageTier: string }) {
  const body = {
    server: {
      zone: opts.zone,
      title: opts.title,
      hostname: opts.title,
      plan: opts.plan,
      metadata: "yes",
      labels: { label: [{ key: LABEL, value: runId }] },
      login_user: { username: "spike", create_password: "no", ssh_keys: { ssh_key: [opts.pub] } },
      ...(opts.userData ? { user_data: opts.userData } : {}),
      networking: { interfaces: { interface: [{ index: 1, type: "public", ip_addresses: { ip_address: [{ family: "IPv4" }] } }] } },
      storage_devices: {
        storage_device: [{ action: "clone", storage: opts.template, title: `${opts.title}-disk`, size: opts.storageSize, tier: opts.storageTier }],
      },
    },
  };
  const t0 = Date.now();
  const { data } = await api("POST", "/server", body);
  const server = data.server;
  const ip = (server.ip_addresses?.ip_address as any[] | undefined)?.find((a) => a.access === "public" && a.family === "IPv4")?.address;
  const storages = (server.storage_devices?.storage_device as any[] | undefined)?.map((s) => s.storage) ?? [];
  const live: Live = { uuid: server.uuid, zone: opts.zone, title: opts.title, ip, storages };
  addLive(live);
  save(`create-${opts.title}.json`, { ...server, user_data: undefined });
  return { live, t0, apiAcceptedMs: Date.now() - t0 };
}

async function teardown(n: Live) {
  const t: Record<string, number> = {};
  const t0 = Date.now();
  const { data } = await api("GET", `/server/${n.uuid}`, undefined, [200, 404]);
  if (!data) { dropLive(n.uuid); return { alreadyGone: true }; }
  if (data.server.state !== "stopped") {
    await api("POST", `/server/${n.uuid}/stop`, { stop_server: { stop_type: "hard" } }, [200, 202, 409]);
    for (;;) {
      const { data: d } = await api("GET", `/server/${n.uuid}`);
      if (d.server.state === "stopped") break;
      await sleep(2000);
    }
  }
  t.stoppedMs = Date.now() - t0;
  await api("DELETE", `/server/${n.uuid}?storages=1&backups=delete`);
  t.deletedMs = Date.now() - t0;
  dropLive(n.uuid);
  return t;
}

async function verifyGone(nodes: Live[]) {
  await sleep(10_000);
  const out: Record<string, unknown> = {};
  for (const n of nodes) {
    const server = await api("GET", `/server/${n.uuid}`, undefined, [200, 404]);
    const storages = await Promise.all(n.storages.map((s) => api("GET", `/storage/${s}`, undefined, [200, 404]).then((r) => ({ storage: s, status: r.status, state: r.data?.storage?.state }))));
    const ip = n.ip ? await api("GET", `/ip_address/${n.ip}`, undefined, [200, 404]) : undefined;
    out[n.title] = {
      serverStatus: server.status,
      storages,
      ip: n.ip,
      ipStatus: ip?.status,
      ipLeftover: ip?.status === 200 ? ip.data.ip_address : undefined,
    };
  }
  const { data: allServers } = await api("GET", "/server");
  out.labelledServersRemaining = ((allServers.servers.server as any[]) ?? []).filter((s) => s.title?.startsWith("nether-spike")).map((s) => s.uuid);
  const { data: allIps } = await api("GET", "/ip_address");
  out.floatingIps = ((allIps.ip_addresses?.ip_address as any[]) ?? []).filter((a) => a.floating === "yes").map((a) => a.address);
  return out;
}

// ---------------------------------------------------------------- boot timing

type Milestones = Record<string, number>;

async function measureNode(opts: { zone: string; variant: Variant; template: string; pub: string; storageSize: number; storageTier: string; userDataTemplate: string }) {
  const title = `nether-spike-${opts.zone}-${opts.variant}`;
  const laptop: Milestones = {};
  const since = (t0: number) => Math.round((Date.now() - t0) / 100) / 10;
  log(`${title}: creating from ${opts.template}`);
  let created;
  try {
    created = await createNode({ ...opts, plan: PLAN, title, userData: opts.userDataTemplate.replaceAll("__VARIANT__", opts.variant) });
  } catch (e) {
    log(`${title}: CREATE FAILED ${e}`);
    return { title, zone: opts.zone, variant: opts.variant, plan: PLAN, template: opts.template, laptop, error: `create: ${e}` };
  }
  const { live, t0, apiAcceptedMs } = created;
  laptop.api_accepted = apiAcceptedMs / 1000;
  const result: any = { title, zone: opts.zone, variant: opts.variant, plan: PLAN, template: opts.template, uuid: live.uuid, ip: live.ip, laptop };
  try {
    const deadline = t0 + NODE_TIMEOUT_MS;
    let nodeLog = "";
    while (Date.now() < deadline) {
      if (!laptop.state_started) {
        const { data } = await api("GET", `/server/${live.uuid}`);
        if (data.server.state === "started") { laptop.state_started = since(t0); log(`${title}: started (${laptop.state_started}s)`); }
        if (!live.ip) {
          live.ip = (data.server.ip_addresses?.ip_address as any[])?.find((a) => a.access === "public" && a.family === "IPv4")?.address;
          if (live.ip) { result.ip = live.ip; addLive(live); }
        }
      }
      if (live.ip && !laptop.ssh_banner && (await sshBanner(live.ip))) { laptop.ssh_banner = since(t0); log(`${title}: ssh banner (${laptop.ssh_banner}s)`); }
      if (live.ip) {
        const text = await fetchNodeFile(live.ip, "timings.log");
        if (text) {
          nodeLog = text;
          for (const line of text.trim().split("\n")) {
            const name = line.split(" ")[2];
            if (name && laptop[name] === undefined) { laptop[name] = since(t0); log(`${title}: ${name} (${laptop[name]}s)`); }
          }
        }
        if (laptop.container_started !== undefined && laptop.slp_ok === undefined) {
          const status = await serverListPing(live.ip);
          if (status) { laptop.slp_ok = since(t0); result.slp = status; log(`${title}: Server List Ping OK (${laptop.slp_ok}s)`); }
        }
      }
      if (laptop.mc_artifacts_done !== undefined && laptop.ci_artifacts_done !== undefined && laptop.slp_ok !== undefined) break;
      await sleep(1000);
    }
    if (Date.now() >= deadline) result.timedOut = true;

    // Node-side clock: durations between milestones, plus uptime at each one.
    result.node = Object.fromEntries(
      nodeLog.trim().split("\n").filter(Boolean).map((l) => { const [epoch, uptime, name] = l.split(" "); return [name, { epoch: Number(epoch), uptime: Number(uptime) }]; }),
    );
    if (live.ip) {
      const dir = join(OUT, title);
      mkdirSync(dir, { recursive: true });
      for (const f of ["timings.log", "apt-procs-at-start.txt", "apt-update.log", "docker-install.log", "docker-version.txt", "pull.log", "image-size.txt", "run.log", "df.txt", "mc-dir-size.txt", "mc.log", "cloud-init-analyze.txt", "cloud-init-blame.txt", "systemd-analyze.txt", "systemd-blame.txt", "cloud-init-output.log"]) {
        const text = await fetchNodeFile(live.ip, f);
        if (text !== null) writeFileSync(join(dir, f), text);
      }
    }
  } catch (e) {
    result.error = String(e);
    log(`${title}: ERROR ${e}`);
  } finally {
    log(`${title}: tearing down`);
    try { result.teardown = await teardown(live); } catch (e) { result.teardownError = String(e); log(`${title}: TEARDOWN FAILED ${e} — run with --cleanup`); }
  }
  result.live = live;
  return result;
}

function nodeDurations(node: Record<string, { epoch: number; uptime: number }>) {
  const d = (a: string, b: string) => (node[a] && node[b] ? Math.round((node[b].epoch - node[a].epoch) * 10) / 10 : undefined);
  return {
    "kernel boot → early unit (uptime, baked only)": node.early_unit_start?.uptime,
    "kernel boot → metadata reachable (uptime, baked only)": node.early_metadata_ok?.uptime,
    "kernel boot → docker ready (uptime, baked only)": node.early_docker_ready?.uptime,
    "kernel boot → user_data start (uptime)": node.userdata_start?.uptime,
    "apt update": d("apt_update_start", "apt_update_done"),
    "docker install (incl. apt update)": d("http_started", "docker_installed"),
    "image pull": d("pull_start", "image_pulled"),
    "container start → Done (fresh world)": d("container_started", "mc_done"),
    "warm: docker stop": d("warm_stop_start", "warm_stopped"),
    "warm: start → Done (existing world)": d("warm_stopped", "warm_done"),
    "user_data start → Done": d("userdata_start", "mc_done"),
    "boot → cloud-init done (uptime)": node.cloud_init_done?.uptime,
  };
}

// ---------------------------------------------------------------- billing probe

async function billingProbe() {
  const inv = await inventory();
  const plan = process.env.PROBE_PLAN ?? "STARTER-1xCPU-1GB";
  const zone = ZONES[0];
  const planInfo = inv.starterPlans.find((p: any) => p.name === plan);
  const template = pickTemplate(inv.ubuntuTemplates);
  const { pub } = sshKey();
  const samples: { at: string; credits: number }[] = [];
  const sample = async () => {
    const { data } = await api("GET", "/account");
    const credits = data.account.credits;
    if (samples.at(-1)?.credits !== credits) log(`credits ${credits}`);
    samples.push({ at: new Date().toISOString(), credits });
    save("billing-probe.json", { plan, zone, samples, createdAt, deletedAt });
  };
  let createdAt: string | undefined;
  let deletedAt: string | undefined;
  log(`Billing probe: sampling credits for 5 min before create`);
  for (let i = 0; i < 10; i++) { await sample(); await sleep(30_000); }
  const { live } = await createNode({ zone, plan, template, title: `nether-spike-billing-${zone}`, pub, storageSize: planInfo.storage_size, storageTier: planInfo.storage_tier });
  createdAt = new Date().toISOString();
  log(`Created ${live.uuid} at ${createdAt}; sampling for 75 min`);
  try {
    for (let i = 0; i < 150; i++) { await sample(); await sleep(30_000); }
  } finally {
    await teardown(live);
    deletedAt = new Date().toISOString();
  }
  log(`Deleted at ${deletedAt}; sampling 15 more min`);
  for (let i = 0; i < 30; i++) { await sample(); await sleep(30_000); }
  save("billing-probe.json", { plan, zone, samples, createdAt, deletedAt, verify: await verifyGone([live]) });
}

// ---------------------------------------------------------------- custom template

type Template = { uuid: string; zone: string; title: string; sizeGb: number; sourceTemplate: string; timings: Record<string, number> };

// Builder Node: stock template + bake-userdata.sh (Docker, image pulled, slow
// boot services off, early-boot marker unit), which powers itself off. Its disk
// is then templatized and the builder deleted.
async function ensureTemplate(opts: { stockTemplate: string; planInfo: any; pub: string }): Promise<Template> {
  if (process.env.TEMPLATE) return { uuid: process.env.TEMPLATE, zone: "?", title: "from TEMPLATE env", sizeGb: 0, sourceTemplate: "?", timings: {} };
  try {
    const t = JSON.parse(readFileSync(TEMPLATE_FILE, "utf8"));
    if (t.pending) throw new Error(`template ${t.uuid} never came online; delete it with --delete-template`);
    log(`Reusing template ${t.uuid} from results/template.json`);
    return t;
  } catch (e) {
    if (String(e).includes("never came online")) throw e;
  }

  const zone = ZONES[0];
  const title = `nether-spike-builder-${zone}`;
  const timings: Record<string, number> = {};
  const t0 = Date.now();
  const since = () => Math.round((Date.now() - t0) / 100) / 10;
  const userData = readFileSync(join(HERE, "bake-userdata.sh"), "utf8");
  log(`Building template in ${zone} on a ${BUILD_DISK_GB} GB disk`);
  let created;
  try {
    created = await createNode({ zone, plan: PLAN, template: opts.stockTemplate, title, pub: opts.pub, userData, storageSize: BUILD_DISK_GB, storageTier: opts.planInfo.storage_tier });
  } catch (e) {
    log(`Builder with ${BUILD_DISK_GB} GB disk refused (${e}); retrying with the plan's ${opts.planInfo.storage_size} GB`);
    created = await createNode({ zone, plan: PLAN, template: opts.stockTemplate, title, pub: opts.pub, userData, storageSize: opts.planInfo.storage_size, storageTier: opts.planInfo.storage_tier });
  }
  const { live } = created;
  try {
    const deadline = Date.now() + NODE_TIMEOUT_MS;
    let bakeLog = "";
    for (;;) {
      if (Date.now() > deadline) throw new Error("builder did not power off in time");
      const { data } = await api("GET", `/server/${live.uuid}`);
      if (!live.ip) live.ip = (data.server.ip_addresses?.ip_address as any[])?.find((a) => a.access === "public" && a.family === "IPv4")?.address;
      if (data.server.state === "started" && !timings.started) timings.started = since();
      if (live.ip) {
        const text = await fetchNodeFile(live.ip, "bake.log");
        if (text && text !== bakeLog) { bakeLog = text; log(`builder: ${text.trim().split("\n").at(-1)}`); }
      }
      if (data.server.state === "stopped" && timings.started) break;
      await sleep(3000);
    }
    timings.powered_off = since();
    save("bake.log", bakeLog);
    if (!bakeLog.includes("bake_done")) throw new Error("builder stopped without bake_done; see bake.log");

    const storage = live.storages[0];
    const { data } = await api("POST", `/storage/${storage}/templatize`, { storage: { title: `nether-spike-template-${runId}` } });
    const uuid = data.storage.uuid;
    writeFileSync(TEMPLATE_FILE, JSON.stringify({ uuid, pending: true }));
    for (;;) {
      const { data: d } = await api("GET", `/storage/${uuid}`);
      if (d.storage.state === "online") { timings.template_online = since(); break; }
      await sleep(3000);
    }
    const tpl: Template = { uuid, zone, title: `nether-spike-template-${runId}`, sizeGb: (await api("GET", `/storage/${uuid}`)).data.storage.size, sourceTemplate: opts.stockTemplate, timings };
    writeFileSync(TEMPLATE_FILE, JSON.stringify(tpl, null, 2));
    log(`Template ${uuid} online after ${timings.template_online}s`);
    return tpl;
  } finally {
    await teardown(live);
  }
}

async function deleteTemplate() {
  const t = JSON.parse(readFileSync(TEMPLATE_FILE, "utf8"));
  await api("DELETE", `/storage/${t.uuid}`, undefined, [204, 404]);
  writeFileSync(TEMPLATE_FILE.replace(".json", `.deleted-${runId}.json`), JSON.stringify(t, null, 2));
  writeFileSync(TEMPLATE_FILE, "");
  log(`Deleted template ${t.uuid}`);
}

// ---------------------------------------------------------------- main

function pickTemplate(templates: { uuid: string; title: string; template_type: string }[]) {
  const plain = templates.filter((t) => t.template_type === "cloud-init" && !/nvidia|cuda|gpu/i.test(t.title));
  const t = plain.find((t) => /24\.04/.test(t.title)) ?? plain[0];
  if (!t) throw new Error("No Ubuntu cloud-init template found; see templates-ubuntu.json");
  log(`Template: ${t.title} (${t.uuid})`);
  return t.uuid;
}

async function cleanup() {
  const tracked = readLive();
  const { data } = await api("GET", "/server");
  const untracked = ((data.servers.server as any[]) ?? [])
    .filter((s) => s.title?.startsWith("nether-spike") && !tracked.some((t) => t.uuid === s.uuid))
    .map((s) => ({ uuid: s.uuid, zone: s.zone, title: s.title, storages: [] }));
  const all = [...tracked, ...untracked];
  log(`Cleanup: ${all.length} Node(s)`);
  for (const n of all) log(n.title, await teardown(n));
  log("Verify:", JSON.stringify(await verifyGone(all), null, 2));
}

async function main() {
  const mode = process.argv[2];
  if (mode === "--cleanup") return cleanup();
  if (mode === "--billing-probe") return billingProbe();
  if (mode === "--delete-template") return deleteTemplate();

  const inv = await inventory();
  const burst = await rateLimitBurst();
  if (mode === "--inventory") return writeSummary(inv, burst, []);

  const stockTemplate = pickTemplate(inv.ubuntuTemplates);
  const planInfo = inv.starterPlans.find((p: any) => p.name === PLAN);
  if (!planInfo) throw new Error(`${PLAN} not in /plan`);
  const { keyPath, pub } = sshKey();
  log(`SSH (for debugging while Nodes run): ssh -i ${keyPath} -o StrictHostKeyChecking=no spike@<ip>`);
  const userDataTemplate = readFileSync(join(HERE, "node-userdata.sh"), "utf8");
  const onSignal = async () => {
    log("Interrupted: tearing down");
    for (const n of readLive()) { try { await teardown(n); } catch (e) { log(`teardown ${n.title} failed: ${e}`); } }
    process.exit(130);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const bakedTemplate = mode === "--custom-image" ? await ensureTemplate({ stockTemplate, planInfo, pub }) : undefined;
  const runs: { zone: string; variant: Variant; template: string }[] = ZONES.flatMap((zone) =>
    bakedTemplate
      ? [{ zone, variant: "apt" as const, template: stockTemplate }, { zone, variant: "baked" as const, template: bakedTemplate.uuid }]
      : (["apt", "getdocker"] as const).map((variant) => ({ zone, variant, template: stockTemplate })),
  );

  const results = await Promise.all(
    runs.map((r) => measureNode({ ...r, pub, storageSize: planInfo.storage_size, storageTier: planInfo.storage_tier, userDataTemplate })),
  );
  const nodes: Live[] = results.map((r) => r.live).filter(Boolean);
  const verify = await verifyGone(nodes);
  save("verify-teardown.json", verify);
  writeSummary(inv, burst, results, verify, bakedTemplate);
  if (bakedTemplate) log(`Template ${bakedTemplate.uuid} is kept (billed as storage). Delete it with --delete-template.`);
}

function writeSummary(inv: any, burst: any, results: any[], verify?: unknown, template?: unknown) {
  const lines: string[] = [`# UpCloud spike ${runId}`, ""];
  if (template) lines.push("## Custom template", "", "```json", JSON.stringify(template, null, 2), "```", "");
  lines.push("## Account quotas", "", "```json", JSON.stringify(inv.account.resource_limits, null, 2), "```", "");
  lines.push("## Starter plans (/plan)", "", "| plan | cores | memory MB | storage GB | tier |", "|---|---|---|---|---|");
  for (const p of inv.starterPlans) lines.push(`| ${p.name} | ${p.core_number} | ${p.memory_amount} | ${p.storage_size} | ${p.storage_tier} |`);
  lines.push("", `Same RAM, different CPU: ${JSON.stringify(inv.sameRamPairs)}`, "");
  lines.push("## Tier plan prices per candidate zone (/price, raw: amount + price in account currency cents/hour)", "", "```json", JSON.stringify(inv.perZone, null, 2), "```", "");
  lines.push("## Rate-limit burst (60 × GET /zone, 10 concurrent)", "", "```json", JSON.stringify(burst, null, 2), "```", "");
  const seenHeaders = apiCalls.filter((c) => c.headers);
  lines.push(`Rate-limit-ish headers seen on any call: ${seenHeaders.length ? JSON.stringify(seenHeaders[0].headers) : "none"}`, `Non-2xx statuses: ${JSON.stringify(apiCalls.filter((c) => c.status >= 300).map((c) => `${c.method} ${c.path} ${c.status}`))}`, "");
  for (const r of results) {
    lines.push(`## ${r.title}`, "", `zone ${r.zone}, variant ${r.variant}, template ${r.template}, plan ${r.plan}${r.timedOut ? ", **TIMED OUT**" : ""}${r.error ? `, **ERROR** ${r.error}` : ""}`, "");
    lines.push("Laptop-observed, seconds since POST /server (±1 s poll):", "", "```json", JSON.stringify(r.laptop, null, 2), "```", "");
    lines.push("Node-side durations (s):", "", "```json", JSON.stringify(nodeDurations(r.node ?? {}), null, 2), "```", "");
    lines.push(`Teardown: ${JSON.stringify(r.teardown ?? r.teardownError)}`, "");
  }
  if (verify) lines.push("## Teardown verification", "", "```json", JSON.stringify(verify, null, 2), "```", "");
  save("api-calls.json", apiCalls);
  save("results.json", results);
  save("summary.md", lines.join("\n"));
  log(`Done. Summary: ${join(OUT, "summary.md")}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
