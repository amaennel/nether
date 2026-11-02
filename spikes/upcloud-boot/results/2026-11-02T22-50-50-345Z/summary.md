# UpCloud spike 2026-11-02T22-50-50-345Z

## Custom template

```json
{
  "uuid": "012aa7e1-cd22-49a7-9e03-0ee91842866d",
  "zone": "de-fra1",
  "title": "nether-spike-template-2026-11-02T22-50-50-345Z",
  "sizeGb": 10,
  "sourceTemplate": "01000000-0000-4000-8000-000030240200",
  "timings": {
    "started": 74.6,
    "powered_off": 153.9,
    "template_online": 189.6
  }
}
```

## Account quotas

```json
{
  "cdns": 100,
  "cloud_server_dev_1xcpu_1gb_10gb_plans": 2,
  "cloud_server_dev_1xcpu_1gb_plans": 5,
  "cloud_server_starter_1xcpu_1gb_plans": 5,
  "cores": 100,
  "detached_floating_ips": 10,
  "detached_interfaces": 100,
  "file_storages": 50,
  "firewall_rules": null,
  "gpus": 1,
  "load_balancers": 50,
  "load_balancers_essentials": 5,
  "managed_container_registries": 5,
  "managed_databases": 50,
  "managed_databases_dev": 5,
  "managed_kubernetes": 50,
  "managed_object_storages": 20,
  "memory": 307200,
  "network_gateways": 50,
  "network_gateways_essentials": 5,
  "network_peerings": 100,
  "networks": 100,
  "ntp_excess_gib": 0,
  "public_ipv4": 20,
  "public_ipv6": 100,
  "routers": 100,
  "server_groups": 200,
  "storage_hdd": 10240,
  "storage_maxiops": 10240,
  "storage_ssd": 10240,
  "storage_standard": 10240,
  "storage_total": 30720,
  "tags": 200
}
```

## Starter plans (/plan)

| plan | cores | memory MB | storage GB | tier |
|---|---|---|---|---|
| STARTER-1xCPU-2GB | 1 | 2048 | 20 | standard |
| STARTER-1xCPU-4GB | 1 | 4096 | 30 | standard |
| STARTER-1xCPU-1GB | 1 | 1024 | 10 | standard |
| STARTER-2xCPU-4GB | 2 | 4096 | 30 | standard |
| STARTER-2xCPU-16GB | 2 | 16384 | 50 | standard |
| STARTER-2xCPU-8GB | 2 | 8192 | 40 | standard |
| STARTER-2xCPU-2GB | 2 | 2048 | 30 | standard |
| STARTER-4xCPU-8GB | 4 | 8192 | 40 | standard |
| STARTER-4xCPU-16GB | 4 | 16384 | 50 | standard |

Same RAM, different CPU: [["STARTER-1xCPU-2GB","STARTER-2xCPU-2GB"],["STARTER-1xCPU-4GB","STARTER-2xCPU-4GB"],["STARTER-2xCPU-16GB","STARTER-4xCPU-16GB"],["STARTER-2xCPU-8GB","STARTER-4xCPU-8GB"]]

## Tier plan prices per candidate zone (/price, raw: amount + price in account currency cents/hour)

```json
{
  "de-fra1": {
    "STARTER-2xCPU-4GB": {
      "amount": 1,
      "price": 1.7857
    },
    "STARTER-2xCPU-8GB": {
      "amount": 1,
      "price": 2.6785
    },
    "STARTER-4xCPU-8GB": {
      "amount": 1,
      "price": 2.9761
    },
    "STARTER-4xCPU-16GB": {
      "amount": 1,
      "price": 4.1666
    }
  },
  "fi-hel1": {
    "STARTER-2xCPU-4GB": {
      "amount": 1,
      "price": 1.7857
    },
    "STARTER-2xCPU-8GB": {
      "amount": 1,
      "price": 2.6785
    },
    "STARTER-4xCPU-8GB": {
      "amount": 1,
      "price": 2.9761
    },
    "STARTER-4xCPU-16GB": {
      "amount": 1,
      "price": 4.1666
    }
  }
}
```

## Rate-limit burst (60 × GET /zone, 10 concurrent)

```json
{
  "statuses": {
    "200": 60
  },
  "maxMs": 101,
  "sample": {
    "status": 200,
    "ms": 94
  }
}
```

Rate-limit-ish headers seen on any call: none
Non-2xx statuses: ["POST /server 409","GET /server/00771414-0a70-46c8-be7b-366d3243e49b 404","GET /storage/01416cc9-d0af-4ca0-aa3e-b1d034edbdb6 404","GET /ip_address/5.22.213.131 404","GET /server/0072a310-3293-420b-9af4-12cff8de3a2b 404","GET /storage/019b8f8e-452b-4a0f-9368-ff3fd5eefa56 404","GET /ip_address/85.9.206.201 404","GET /server/009f8931-9616-4e87-ae64-937448156e71 404","GET /storage/011ad313-567c-4c16-ae71-1c7ab8630492 404","GET /ip_address/94.237.112.73 404"]

## nether-spike-de-fra1-apt

zone de-fra1, variant apt, template 01000000-0000-4000-8000-000030240200, plan STARTER-2xCPU-4GB

Laptop-observed, seconds since POST /server (±1 s poll):

```json
{
  "api_accepted": 12.556,
  "state_started": 69.4,
  "ssh_banner": 84.2,
  "userdata_start": 86.3,
  "http_started": 86.3,
  "apt_update_start": 86.3,
  "apt_update_done": 97.9,
  "docker_installed": 109.6,
  "pull_start": 109.6,
  "image_pulled": 122.3,
  "container_started": 123.3,
  "userdata_end": 123.3,
  "cloud_init_done": 124.4,
  "ci_artifacts_done": 127.7,
  "mc_done": 179.3,
  "slp_ok": 180.5,
  "warm_stop_start": 210,
  "warm_stopped": 210,
  "warm_done": 249.2,
  "mc_artifacts_done": 249.2
}
```

Node-side durations (s):

```json
{
  "kernel boot → user_data start (uptime)": 13.44,
  "apt update": 12.1,
  "docker install (incl. apt update)": 24.2,
  "image pull": 11.9,
  "container start → Done (fresh world)": 56.7,
  "warm: docker stop": 0.8,
  "warm: start → Done (existing world)": 38.4,
  "user_data start → Done": 93.9,
  "boot → cloud-init done (uptime)": 51.73
}
```

Teardown: {"stoppedMs":17237,"deletedMs":17395}

## nether-spike-de-fra1-baked

zone de-fra1, variant baked, template 012aa7e1-cd22-49a7-9e03-0ee91842866d, plan STARTER-2xCPU-4GB

Laptop-observed, seconds since POST /server (±1 s poll):

```json
{
  "api_accepted": 16.512,
  "state_started": 66.3,
  "ssh_banner": 87.4,
  "early_unit_start": 90.6,
  "early_metadata_ok": 90.6,
  "early_docker_ready": 90.6,
  "userdata_start": 90.6,
  "http_started": 90.6,
  "docker_installed": 90.6,
  "container_started": 91.6,
  "userdata_end": 91.6,
  "cloud_init_done": 92.7,
  "ci_artifacts_done": 93.8,
  "mc_done": 121.2,
  "slp_ok": 121.3,
  "warm_stop_start": 150.9,
  "warm_stopped": 152,
  "warm_done": 168.9,
  "mc_artifacts_done": 168.9
}
```

Node-side durations (s):

```json
{
  "kernel boot → early unit (uptime, baked only)": 12.85,
  "kernel boot → metadata reachable (uptime, baked only)": 13.21,
  "kernel boot → docker ready (uptime, baked only)": 15.95,
  "kernel boot → user_data start (uptime)": 16.33,
  "docker install (incl. apt update)": 0.1,
  "container start → Done (fresh world)": 29.6,
  "warm: docker stop": 0.9,
  "warm: start → Done (existing world)": 17.2,
  "user_data start → Done": 30.3,
  "boot → cloud-init done (uptime)": 17.85
}
```

Teardown: {"stoppedMs":15121,"deletedMs":15285}

## nether-spike-fi-hel1-apt

zone fi-hel1, variant apt, template 01000000-0000-4000-8000-000030240200, plan STARTER-2xCPU-4GB

Laptop-observed, seconds since POST /server (±1 s poll):

```json
{
  "api_accepted": 15.078,
  "state_started": 79.4,
  "ssh_banner": 94.5,
  "userdata_start": 96.7,
  "http_started": 96.7,
  "apt_update_start": 96.7,
  "apt_update_done": 109,
  "docker_installed": 120.2,
  "pull_start": 120.2,
  "image_pulled": 132.3,
  "container_started": 133.5,
  "userdata_end": 133.5,
  "cloud_init_done": 134.6,
  "ci_artifacts_done": 135.8,
  "mc_done": 158.7,
  "slp_ok": 158.9,
  "warm_stop_start": 191.1,
  "warm_stopped": 191.1,
  "warm_done": 207,
  "mc_artifacts_done": 207
}
```

Node-side durations (s):

```json
{
  "kernel boot → user_data start (uptime)": 12.65,
  "apt update": 12.7,
  "docker install (incl. apt update)": 24.4,
  "image pull": 12.1,
  "container start → Done (fresh world)": 24.7,
  "warm: docker stop": 0.8,
  "warm: start → Done (existing world)": 17.9,
  "user_data start → Done": 62.4,
  "boot → cloud-init done (uptime)": 50.91
}
```

Teardown: {"stoppedMs":25121,"deletedMs":25370}

## nether-spike-fi-hel1-baked

zone fi-hel1, variant baked, template 012aa7e1-cd22-49a7-9e03-0ee91842866d, plan STARTER-2xCPU-4GB, **ERROR** create: Error: POST /server -> 409 {
   "error" : {
      "error_code" : "ZONE_MISMATCH",
      "error_message" : "Cannot find the storage 012aa7e1-cd22-49a7-9e03-0ee91842866d from the zone 'fi-hel1'."
   }
}


Laptop-observed, seconds since POST /server (±1 s poll):

```json
{}
```

Node-side durations (s):

```json
{}
```

Teardown: undefined

## Teardown verification

```json
{
  "nether-spike-de-fra1-apt": {
    "serverStatus": 404,
    "storages": [
      {
        "storage": "01416cc9-d0af-4ca0-aa3e-b1d034edbdb6",
        "status": 404
      }
    ],
    "ip": "5.22.213.131",
    "ipStatus": 404
  },
  "nether-spike-de-fra1-baked": {
    "serverStatus": 404,
    "storages": [
      {
        "storage": "019b8f8e-452b-4a0f-9368-ff3fd5eefa56",
        "status": 404
      }
    ],
    "ip": "85.9.206.201",
    "ipStatus": 404
  },
  "nether-spike-fi-hel1-apt": {
    "serverStatus": 404,
    "storages": [
      {
        "storage": "011ad313-567c-4c16-ae71-1c7ab8630492",
        "status": 404
      }
    ],
    "ip": "94.237.112.73",
    "ipStatus": 404
  },
  "labelledServersRemaining": [],
  "floatingIps": []
}
```
