# UpCloud spike 2026-11-02T22-41-55-013Z

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
| STARTER-2xCPU-2GB | 2 | 2048 | 30 | standard |
| STARTER-2xCPU-16GB | 2 | 16384 | 50 | standard |
| STARTER-2xCPU-8GB | 2 | 8192 | 40 | standard |
| STARTER-2xCPU-4GB | 2 | 4096 | 30 | standard |
| STARTER-4xCPU-16GB | 4 | 16384 | 50 | standard |
| STARTER-4xCPU-8GB | 4 | 8192 | 40 | standard |

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
  "maxMs": 116,
  "sample": {
    "status": 200,
    "ms": 73
  }
}
```

Rate-limit-ish headers seen on any call: none
Non-2xx statuses: ["GET /server/00805b8e-a233-4244-a1ee-1b20e797687d 404","GET /storage/016b6d72-3961-4f54-9596-036bc6904e32 404","GET /ip_address/85.9.204.71 404","GET /server/00ec183e-05c7-422c-bf06-8222371e3e89 404","GET /storage/010d37ad-e5ac-4413-a431-5f38aa836073 404","GET /ip_address/85.9.200.240 404","GET /server/00548d21-2d58-4908-8670-37f61d3495f8 404","GET /storage/012cf7f6-4d46-458d-bf71-627a8a19fcd9 404","GET /ip_address/94.237.117.128 404","GET /server/00e8774f-9434-41bb-97b7-9e40a71438aa 404","GET /storage/013ff6a3-d9fb-489f-ba8d-bff3c0d18dde 404","GET /ip_address/94.237.115.145 404"]

## nether-spike-de-fra1-apt

zone de-fra1, variant apt, plan STARTER-2xCPU-4GB

Laptop-observed, seconds since POST /server (±1 s poll):

```json
{
  "api_accepted": 15.198,
  "state_started": 100.7,
  "ssh_banner": 111.6,
  "userdata_start": 114.8,
  "http_started": 114.8,
  "apt_update_start": 114.8,
  "apt_update_done": 126.4,
  "docker_installed": 128.5,
  "pull_start": 128.5,
  "image_pulled": 140.1,
  "container_started": 142.3,
  "userdata_end": 142.3,
  "cloud_init_done": 142.3,
  "ci_artifacts_done": 144.4,
  "mc_done": 174.9,
  "slp_ok": 175,
  "warm_stop_start": 204.5,
  "warm_stopped": 204.5,
  "warm_done": 226.5,
  "mc_artifacts_done": 226.5
}
```

Node-side durations (s):

```json
{
  "kernel boot → user_data start (uptime)": 15.78,
  "apt update": 11.8,
  "docker install (incl. apt update)": 13.2,
  "image pull": 12.3,
  "container start → Done (fresh world)": 32.2,
  "warm: docker stop": 0.7,
  "warm: start → Done (existing world)": 21.5,
  "user_data start → Done": 59.1,
  "boot → cloud-init done (uptime)": 43.45
}
```

Teardown: {"stoppedMs":19190,"deletedMs":19360}

## nether-spike-de-fra1-getdocker

zone de-fra1, variant getdocker, plan STARTER-2xCPU-4GB

Laptop-observed, seconds since POST /server (±1 s poll):

```json
{
  "api_accepted": 8.329,
  "state_started": 79.4,
  "ssh_banner": 87.3,
  "userdata_start": 90.5,
  "http_started": 90.5,
  "docker_installed": 148.5,
  "pull_start": 148.5,
  "image_pulled": 159.9,
  "container_started": 160.9,
  "userdata_end": 160.9,
  "cloud_init_done": 162,
  "ci_artifacts_done": 163.1,
  "mc_done": 187.5,
  "slp_ok": 187.6,
  "warm_stop_start": 218.2,
  "warm_stopped": 218.2,
  "warm_done": 236.1,
  "mc_artifacts_done": 236.1
}
```

Node-side durations (s):

```json
{
  "kernel boot → user_data start (uptime)": 13.07,
  "docker install (incl. apt update)": 58.1,
  "image pull": 11.1,
  "container start → Done (fresh world)": 27.1,
  "warm: docker stop": 0.8,
  "warm: start → Done (existing world)": 17.5,
  "user_data start → Done": 97.6,
  "boot → cloud-init done (uptime)": 84.23
}
```

Teardown: {"stoppedMs":21047,"deletedMs":21214}

## nether-spike-fi-hel1-apt

zone fi-hel1, variant apt, plan STARTER-2xCPU-4GB

Laptop-observed, seconds since POST /server (±1 s poll):

```json
{
  "api_accepted": 11.975,
  "state_started": 111.7,
  "ssh_banner": 124.8,
  "userdata_start": 128.2,
  "http_started": 128.2,
  "apt_update_start": 128.2,
  "apt_update_done": 139.3,
  "docker_installed": 140.4,
  "pull_start": 140.4,
  "image_pulled": 152.8,
  "container_started": 155,
  "userdata_end": 155,
  "cloud_init_done": 155,
  "ci_artifacts_done": 157.3,
  "mc_done": 181.5,
  "slp_ok": 181.9,
  "warm_stop_start": 211.1,
  "warm_stopped": 212.2,
  "warm_done": 232.1,
  "mc_artifacts_done": 232.1
}
```

Node-side durations (s):

```json
{
  "kernel boot → user_data start (uptime)": 16.18,
  "apt update": 11.1,
  "docker install (incl. apt update)": 12.4,
  "image pull": 12.8,
  "container start → Done (fresh world)": 26.5,
  "warm: docker stop": 0.8,
  "warm: start → Done (existing world)": 19.9,
  "user_data start → Done": 53.3,
  "boot → cloud-init done (uptime)": 43.48
}
```

Teardown: {"stoppedMs":21255,"deletedMs":21455}

## nether-spike-fi-hel1-getdocker

zone fi-hel1, variant getdocker, plan STARTER-2xCPU-4GB

Laptop-observed, seconds since POST /server (±1 s poll):

```json
{
  "api_accepted": 10.625,
  "state_started": 110.6,
  "ssh_banner": 121.6,
  "userdata_start": 125,
  "http_started": 125,
  "docker_installed": 185.9,
  "pull_start": 185.9,
  "image_pulled": 199.8,
  "container_started": 199.8,
  "userdata_end": 199.8,
  "cloud_init_done": 199.8,
  "ci_artifacts_done": 201,
  "mc_done": 224.2,
  "slp_ok": 224.4,
  "warm_stop_start": 253.5,
  "warm_stopped": 254.6,
  "warm_done": 273.3,
  "mc_artifacts_done": 273.3
}
```

Node-side durations (s):

```json
{
  "kernel boot → user_data start (uptime)": 15.88,
  "docker install (incl. apt update)": 61,
  "image pull": 11.6,
  "container start → Done (fresh world)": 25.2,
  "warm: docker stop": 0.8,
  "warm: start → Done (existing world)": 18.3,
  "user_data start → Done": 99,
  "boot → cloud-init done (uptime)": 90.42
}
```

Teardown: {"stoppedMs":24371,"deletedMs":24556}

## Teardown verification

```json
{
  "nether-spike-de-fra1-apt": {
    "serverStatus": 404,
    "storages": [
      {
        "storage": "016b6d72-3961-4f54-9596-036bc6904e32",
        "status": 404
      }
    ],
    "ip": "85.9.204.71",
    "ipStatus": 404
  },
  "nether-spike-de-fra1-getdocker": {
    "serverStatus": 404,
    "storages": [
      {
        "storage": "010d37ad-e5ac-4413-a431-5f38aa836073",
        "status": 404
      }
    ],
    "ip": "85.9.200.240",
    "ipStatus": 404
  },
  "nether-spike-fi-hel1-apt": {
    "serverStatus": 404,
    "storages": [
      {
        "storage": "012cf7f6-4d46-458d-bf71-627a8a19fcd9",
        "status": 404
      }
    ],
    "ip": "94.237.117.128",
    "ipStatus": 404
  },
  "nether-spike-fi-hel1-getdocker": {
    "serverStatus": 404,
    "storages": [
      {
        "storage": "013ff6a3-d9fb-489f-ba8d-bff3c0d18dde",
        "status": 404
      }
    ],
    "ip": "94.237.115.145",
    "ipStatus": 404
  },
  "labelledServersRemaining": [],
  "floatingIps": []
}
```
