import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";

export function findTailscaleIpv4(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): string | undefined {
  const candidates = Object.values(interfaces)
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal && isTailscaleIpv4(entry.address))
    .map((entry) => entry.address)
    .sort();

  return candidates[0];
}

export function isTailscaleIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }

  const [first, second] = octets;
  return first === 100 && second !== undefined && second >= 64 && second <= 127;
}