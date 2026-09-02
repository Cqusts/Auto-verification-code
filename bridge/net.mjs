import os from 'node:os';

/** Adapters a phone can never reach: WSL, Hyper-V, Docker, VPN tunnels, ... */
export const VIRTUAL_ADAPTER_RE =
  /(wsl|vethernet|virtualbox|vmware|hyper-?v|docker|veth|utun|tap|tun\d|tailscale|zerotier|loopback|bluetooth|npcap)/i;

/**
 * Ranks this machine's IPv4 addresses by how likely a phone on the same Wi-Fi
 * can actually reach them.
 *
 * Taking the first address the OS happens to list is wrong on any developer
 * machine: WSL, Docker, Hyper-V and VirtualBox all add adapters, and printing
 * one of those sends people off configuring their phone with an address that
 * can never work — which surfaces as a request timeout, not a clear error.
 *
 * @param {object} [interfaces] os.networkInterfaces() shape; injectable for tests
 * @returns {{name:string, address:string, score:number, virtual:boolean}[]} best first
 */
export function rankAddresses(interfaces = os.networkInterfaces()) {
  const candidates = [];
  for (const [name, list] of Object.entries(interfaces)) {
    for (const net of list || []) {
      // Node >= 18 reports family as 'IPv4'; older builds used the number 4.
      const isV4 = net.family === 'IPv4' || net.family === 4;
      if (!isV4 || net.internal) continue;

      const address = net.address;
      let score = 0;

      // Real home/office LAN ranges, most common first.
      if (/^192\.168\./.test(address)) score += 30;
      else if (/^10\./.test(address)) score += 20;
      else if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) score += 10;
      else score -= 20;

      if (/^169\.254\./.test(address)) score -= 60; // link-local: DHCP never answered
      if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address)) score -= 40; // CGNAT / mesh VPN

      const virtual = VIRTUAL_ADAPTER_RE.test(name);
      if (virtual) score -= 50;
      if (/wi-?fi|wlan|wireless|无线/i.test(name)) score += 15;
      else if (/ethernet|以太网|^en\d|^eth\d/i.test(name)) score += 10;

      candidates.push({ name, address, score, virtual });
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.address.localeCompare(b.address));
  return candidates;
}
