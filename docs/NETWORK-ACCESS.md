# QuestBoard Network Access Guide

QuestBoard keeps the Web UI/API local-only by default. The default bind address is `127.0.0.1`, so `http://127.0.0.1:4317` is reachable only from the machine that is running QuestBoard.

This is intentionally conservative because QuestBoard does not currently provide built-in authentication or TLS.

## Choose the access mode

| Goal | Recommended bind | Browser address |
| --- | --- | --- |
| Same machine only | default `127.0.0.1` | `http://127.0.0.1:4317` |
| Other devices on the same LAN | the host machine's LAN IP | `http://<LAN-IP>:4317` |
| Any local interface | `0.0.0.0` | `http://<LAN-IP>:4317` |
| Devices on the same Tailscale network | `QUESTBOARD_TAILNET=1` | `http://<TAILSCALE-IP>:4317` |
| Public Internet | **Do not expose port 4317 directly** | use an authenticated/TLS gateway instead |

## Same-LAN access

Prefer binding QuestBoard to the machine's actual private LAN address instead of `0.0.0.0`.

Example host address:

```text
192.168.0.20
```

macOS/Linux:

```bash
QUESTBOARD_HOST=192.168.0.20 QUESTBOARD_PORT=4317 npm start
```

PowerShell:

```powershell
$env:QUESTBOARD_HOST = "192.168.0.20"
$env:QUESTBOARD_PORT = "4317"
npm start
```

Then open this from another device on the same LAN:

```text
http://192.168.0.20:4317
```

The same variables apply when an MCP client launches QuestBoard. The stdio MCP server and Web UI/API remain one process and use the same SQLite database.

Example MCP configuration:

```json
{
  "command": "node",
  "args": ["/absolute/path/to/QuestBoard/dist/src/adapters/mcp/main.js"],
  "env": {
    "QUESTBOARD_DB_PATH": "/absolute/path/to/QuestBoard/.questboard/questboard.sqlite",
    "QUESTBOARD_HOST": "192.168.0.20",
    "QUESTBOARD_PORT": "4317"
  }
}
```

### Binding all local interfaces

If the machine's LAN IP changes frequently, this also works:

```bash
QUESTBOARD_HOST=0.0.0.0 npm start
```

`0.0.0.0` is a **bind address**, not the address to type into a browser. Connect using the machine's real LAN address, for example `http://192.168.0.20:4317`.

Binding to `0.0.0.0` exposes QuestBoard on every IPv4 interface available to the process, which can include Wi-Fi, Ethernet, VPN, VM, and container interfaces. Prefer a specific LAN IP when possible.

## Tailscale / Tailnet access

For access between devices that share a Tailscale network:

```bash
npm run start:tailnet
```

Or set this for an MCP launch:

```text
QUESTBOARD_TAILNET=1
```

QuestBoard selects an active Tailscale IPv4 address in `100.64.0.0/10`. Tailnet mode takes precedence over `QUESTBOARD_HOST`.

Tailscale reachability is still not QuestBoard authentication. Anyone allowed to reach that machine and port by the surrounding network policy can interact with the HTTP API.

## ChatGPT2Codex / C2CT managed MCP

ChatGPT2Codex managed MCP processes run with a restricted environment. Environment variables are forwarded only when the managed MCP launch explicitly allows their names.

If you want a C2CT-managed QuestBoard MCP to expose its bundled Web UI/API on the LAN, include these names in the managed launch's inherited environment configuration as needed:

```text
QUESTBOARD_HOST
QUESTBOARD_PORT
QUESTBOARD_DB_PATH
```

For example, `QUESTBOARD_HOST=192.168.0.20` keeps the listener on one LAN interface, while `QUESTBOARD_HOST=0.0.0.0` listens on all IPv4 interfaces. The values themselves must exist in the environment that launches the managed MCP host.

If no host setting is forwarded, QuestBoard safely falls back to `127.0.0.1`.

## Firewall and Wi-Fi checks

If another LAN device cannot connect even though QuestBoard is listening on the LAN IP, check these in order:

1. Confirm both devices are on the same LAN/subnet.
2. Open `http://<LAN-IP>:4317/health` from the second device.
3. Allow Node/QuestBoard or TCP port `4317` through the host firewall for the private/local network only.
4. Check whether the Wi-Fi uses client isolation, AP isolation, or a guest network that blocks device-to-device traffic.
5. If a VPN is active, check whether it changes local routing or blocks LAN access.
6. Do not browse to `0.0.0.0`; use the host machine's real LAN IP.

A successful health check returns:

```json
{"status":"ok"}
```

## Public Internet warning

QuestBoard currently has no built-in user authentication, authorization, HTTPS termination, or Internet-facing rate limiting. Do **not** port-forward `4317` directly from a router or expose it directly to the public Internet.

For remote access, prefer Tailscale. If Internet exposure is intentionally required, place QuestBoard behind a separately configured HTTPS reverse proxy or access gateway that provides authentication and restricts who can reach the service.
