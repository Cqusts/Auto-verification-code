#!/usr/bin/env node
/**
 * The address the banner prints is what people paste into their phone, so
 * picking a virtual adapter costs them a debugging session with nothing but a
 * request timeout to go on.
 */
import { rankAddresses } from '../bridge/net.mjs';

let pass = 0;
let fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); }
};

const v4 = (address, internal = false) => [{ family: 'IPv4', address, internal }];
const best = (interfaces) => rankAddresses(interfaces)[0]?.address;

// A very ordinary Windows dev machine: WSL and VirtualBox both add adapters,
// and the OS often lists them before the real Wi-Fi one.
check('picks Wi-Fi over WSL and VirtualBox', best({
  'vEthernet (WSL)': v4('172.28.144.1'),
  'VirtualBox Host-Only Network': v4('192.168.56.1'),
  WLAN: v4('192.168.1.23'),
  'Loopback Pseudo-Interface 1': v4('127.0.0.1', true),
}) === '192.168.1.23');

check('picks Ethernet over Hyper-V', best({
  'vEthernet (Default Switch)': v4('172.20.1.1'),
  '以太网': v4('192.168.0.5'),
}) === '192.168.0.5');

check('picks a real LAN over Docker', best({
  docker0: v4('172.17.0.1'),
  eth0: v4('10.0.0.8'),
}) === '10.0.0.8');

check('picks DHCP over link-local', best({
  'Wi-Fi': v4('169.254.10.2'),
  Ethernet: v4('192.168.2.7'),
}) === '192.168.2.7');

check('picks LAN over a Tailscale tunnel', best({
  tailscale0: v4('100.101.102.103'),
  wlan0: v4('192.168.31.44'),
}) === '192.168.31.44');

check('skips loopback and internal adapters', rankAddresses({
  lo: v4('127.0.0.1', true),
  eth0: v4('192.168.1.9'),
}).length === 1);

check('handles the numeric family of older Node', rankAddresses({
  eth0: [{ family: 4, address: '192.168.1.9', internal: false }],
}).length === 1);

check('marks virtual adapters so the banner can label them',
  rankAddresses({ 'vEthernet (WSL)': v4('172.28.144.1') })[0].virtual === true);

check('returns empty when there is no usable adapter',
  rankAddresses({ lo: v4('127.0.0.1', true) }).length === 0);

// A machine with only a virtual adapter still has to offer something.
check('still returns virtual adapters as a last resort',
  best({ 'vEthernet (WSL)': v4('172.28.144.1') }) === '172.28.144.1');

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
