# QuestBoard Network Access Guide

QuestBoard uses Tailnet-only Web UI/API access by default. `npm run daemon` and `npm start` bind specifically to the machine's active Tailscale IPv4 address. Use the explicit `:local` scripts when localhost-only access is desired.

This is intentionally conservative because QuestBoard does not currently provide built-in authentication or TLS.

## Choose the access mode

| Goal | Recommended bind | Browser address |
| --- | --- | --- |
| Same machine only | `npm run daemon:local` | `http://127.0.0.1:4317` |
| Other devices on the same LAN | the host machine's LAN IP | `http://<LAN-IP>:4317` |
| Any local interface | `0.0.0.0` | `http://<LAN-IP>:4317` |
| Devices on the same Tailscale network | default Tailnet mode | `http://<TAILSCALE-IP>:4317` |
| Public Internet | **Do not expose port 4317 directly** | use an authenticated/TLS gateway instead |

## Same-LAN access

Prefer binding QuestBoard to the machine's actual private LAN address instead of `0.0.0.0`.

Example host address:

```text
192.168.0.20
```

macOS/Linux:

```bash
QUESTBOARD_HOST=192.168.0.20 QUESTBOARD_PORT=4317 npm run start:local
```

PowerShell:

```powershell
$env:QUESTBOARD_HOST = "192.168.0.20"
$env:QUESTBOARD_PORT = "4317"
npm run start:local
```

Then open this from another device on the same LAN:

```text
http://192.168.0.20:4317
```

`QUESTBOARD_HOST`, `QUESTBOARD_PORT`, `QUESTBOARD_DB_PATH`, and Tailnet settings belong to the single long-lived daemon. MCP sessions no longer start their own listener or open SQLite; they connect to that daemon through `QUESTBOARD_DAEMON_URL`.

Example daemon launch and MCP configuration:

```bash
QUESTBOARD_HOST=192.168.0.20 QUESTBOARD_PORT=4317 npm run daemon:local
```

```json
{
  "command": "node",
  "args": ["/absolute/path/to/QuestBoard/dist/src/adapters/mcp/main.js"],
  "env": {
    "QUESTBOARD_DAEMON_URL": "http://192.168.0.20:4317"
  }
}
```

When the daemon listens on `0.0.0.0`, same-machine MCP/CLI clients should normally keep using `http://127.0.0.1:4317`. When it is bound only to a specific LAN or Tailscale address, point `QUESTBOARD_DAEMON_URL` at that bound address.

### Binding all local interfaces

If the machine's LAN IP changes frequently, this also works:

```bash
QUESTBOARD_HOST=0.0.0.0 npm run start:local
```

`0.0.0.0` is a **bind address**, not the address to type into a browser. Connect using the machine's real LAN address, for example `http://192.168.0.20:4317`.

Binding to `0.0.0.0` exposes QuestBoard on every IPv4 interface available to the process, which can include Wi-Fi, Ethernet, VPN, VM, and container interfaces. Prefer a specific LAN IP when possible.

## Tailscale / Tailnet access

For access between devices that share a Tailscale network, use the canonical default:

```bash
npm run daemon
```

The explicit Tailnet aliases/environment form remain supported:

```text
QUESTBOARD_TAILNET=1 node dist/src/server/main.js
```

QuestBoard selects an active Tailscale IPv4 address in `100.64.0.0/10`. Tailnet mode takes precedence over `QUESTBOARD_HOST`.

Tailscale reachability is still not QuestBoard authentication. Anyone allowed to reach that machine and port by the surrounding network policy can interact with the HTTP API.

## ChatGPT2Codex / C2CT managed MCP

ChatGPT2Codex managed MCP processes run with a restricted environment. Environment variables are forwarded only when the managed MCP launch explicitly allows their names.

The managed MCP process is now only a stdio proxy. It normally needs the daemon endpoint forwarded into its environment:

```text
QUESTBOARD_DAEMON_URL
```

Run/configure the QuestBoard daemon separately with `QUESTBOARD_HOST`, `QUESTBOARD_PORT`, `QUESTBOARD_DB_PATH`, or Tailnet mode. The managed MCP host should not receive database ownership settings just to attach a session.

If `QUESTBOARD_DAEMON_URL` is not forwarded, the proxy auto-discovers the active Tailscale IPv4 and uses that address on the configured/default port. If no Tailscale IPv4 exists, it falls back to `http://127.0.0.1:<QUESTBOARD_PORT-or-4317>`.

After locating an endpoint, the proxy still performs a daemon identity handshake. The daemon database has a persistent UUID, and the local profile pins the expected UUID at `~/.local/state/questboard/daemon-identity.json` by default. A different database at the discovered address, or a legacy daemon without the identity handshake, is rejected. Use `QUESTBOARD_IDENTITY_PATH` only when intentionally maintaining a separate QuestBoard database/profile.

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
