import assert from "node:assert/strict";
import type { NetworkInterfaceInfo } from "node:os";
import test from "node:test";
import { findTailscaleIpv4, isTailscaleIpv4 } from "../src/server/network.js";

test("recognizes only the Tailscale CGNAT IPv4 range", () => {
  assert.equal(isTailscaleIpv4("100.64.0.1"), true);
  assert.equal(isTailscaleIpv4("100.127.255.254"), true);
  assert.equal(isTailscaleIpv4("100.63.255.255"), false);
  assert.equal(isTailscaleIpv4("100.128.0.1"), false);
  assert.equal(isTailscaleIpv4("192.168.0.10"), false);
});

test("selects an active Tailscale IPv4 interface", () => {
  const interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = {
    en0: [interfaceInfo("192.168.0.10")],
    utun4: [interfaceInfo("100.101.102.103")],
  };

  assert.equal(findTailscaleIpv4(interfaces), "100.101.102.103");
});

function interfaceInfo(address: string): NetworkInterfaceInfo {
  return {
    address,
    netmask: "255.255.255.255",
    family: "IPv4",
    mac: "00:00:00:00:00:00",
    internal: false,
    cidr: `${address}/32`,
  };
}