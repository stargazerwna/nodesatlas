import http from 'node:http';
import dgram from 'node:dgram';
import net from 'node:net';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as dnsPromises } from 'node:dns';
import snmp from 'net-snmp';

// Resolve defaults relative to this file's own directory, not process.cwd() (which can be
// a temp extraction folder for packaged/portable builds and would otherwise break lookups).
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3001);
const CONFIG_PATH = process.env.NODES_CONFIG || path.join(moduleDir, 'nodes.local.json');
const SAMPLE_CONFIG_PATH = process.env.NODES_SAMPLE_CONFIG || path.join(moduleDir, 'nodes.example.json');
const LINKS_PATH = process.env.LINKS_CONFIG || path.join(moduleDir, 'links.local.json');
const SAMPLE_LINKS_PATH = process.env.LINKS_SAMPLE_CONFIG || path.join(moduleDir, 'links.example.json');
const WORKSPACE_PATH = process.env.WORKSPACE_CONFIG || path.join(moduleDir, 'workspace.local.json');
const OIDS = [
  '1.3.6.1.2.1.1.1.0', // sysDescr
  '1.3.6.1.2.1.1.5.0', // sysName
  '1.3.6.1.2.1.1.3.0', // sysUpTime
  '1.3.6.1.2.1.2.2.1.10.1', // ifInOctets.1
  '1.3.6.1.2.1.2.2.1.16.1', // ifOutOctets.1
];
const HEALTH_OIDS = [
  '1.3.6.1.4.1.2021.11.11.0', // ssCpuIdle (UCD-SNMP, used by net-snmp on OpenWrt/Linux)
  '1.3.6.1.4.1.2021.4.5.0', // memTotalReal
  '1.3.6.1.4.1.2021.4.6.0', // memAvailReal
];
// RouterOS does not implement UCD-SNMP; it exposes health via HOST-RESOURCES-MIB instead.
const MIKROTIK_CPU_OID = '1.3.6.1.2.1.25.3.3.1.2'; // hrProcessorLoad
const MIKROTIK_STORAGE_DESCR_OID = '1.3.6.1.2.1.25.2.3.1.3'; // hrStorageDescr
const MIKROTIK_STORAGE_SIZE_OID = '1.3.6.1.2.1.25.2.3.1.5'; // hrStorageSize
const MIKROTIK_STORAGE_USED_OID = '1.3.6.1.2.1.25.2.3.1.6'; // hrStorageUsed
// MTXR-MIB mtxrWifiRegistrationTable, indexed by client mac-address + interface index
const MIKROTIK_WIFI_REG_BASE_OID = '1.3.6.1.4.1.14988.1.1.1.21.4.1';
const MIKROTIK_WIFI_REG_SSID_OID = `${MIKROTIK_WIFI_REG_BASE_OID}.3`;
const MIKROTIK_WIFI_REG_UPTIME_OID = `${MIKROTIK_WIFI_REG_BASE_OID}.4`;
const MIKROTIK_WIFI_REG_SIGNAL_OID = `${MIKROTIK_WIFI_REG_BASE_OID}.6`;
const MIKROTIK_WIFI_REG_BAND_OID = `${MIKROTIK_WIFI_REG_BASE_OID}.8`;
const IF_DESCR_OID = '1.3.6.1.2.1.2.2.1.2';
const ARP_MAC_OID = '1.3.6.1.2.1.4.22.1.2'; // ipNetToMediaPhysAddress, indexed by ifIndex.ipAddress
const SNMP_SECURITY_LEVELS = Object.freeze({
  noAuthNoPriv: snmp.SecurityLevel.noAuthNoPriv,
  authNoPriv: snmp.SecurityLevel.authNoPriv,
  authPriv: snmp.SecurityLevel.authPriv,
});
const SNMP_AUTH_PROTOCOLS = Object.freeze({
  md5: snmp.AuthProtocols.md5,
  sha: snmp.AuthProtocols.sha,
  sha224: snmp.AuthProtocols.sha224,
  sha256: snmp.AuthProtocols.sha256,
  sha384: snmp.AuthProtocols.sha384,
  sha512: snmp.AuthProtocols.sha512,
});
const SNMP_PRIV_PROTOCOLS = Object.freeze({
  des: snmp.PrivProtocols.des,
  aes: snmp.PrivProtocols.aes,
  aes256b: snmp.PrivProtocols.aes256b,
  aes256r: snmp.PrivProtocols.aes256r,
});

let nodes = await loadNodes();
let snapshots = new Map();
let links = await loadLinks();
let workspace = await loadWorkspace();
const execFileAsync = promisify(execFile);

async function loadNodes() {
  if (hasLocalNodeConfig()) return JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
  if (hasLocalSavedWorkspace()) return [];
  return JSON.parse(await readFile(SAMPLE_CONFIG_PATH, 'utf8'));
}

async function loadLinks() {
  if (hasLocalLinksConfig()) return JSON.parse(await readFile(LINKS_PATH, 'utf8'));
  if (hasLocalSavedWorkspace()) return [];
  return existsSync(SAMPLE_LINKS_PATH) ? JSON.parse(await readFile(SAMPLE_LINKS_PATH, 'utf8')) : [];
}

async function loadWorkspace() {
  return existsSync(WORKSPACE_PATH) ? JSON.parse(await readFile(WORKSPACE_PATH, 'utf8')) : { name: 'myWorkspace' };
}

function hasLocalNodeConfig() {
  return existsSync(CONFIG_PATH);
}

function hasLocalLinksConfig() {
  return existsSync(LINKS_PATH);
}

function hasLocalWorkspaceConfig() {
  return existsSync(WORKSPACE_PATH);
}

function hasLocalSavedWorkspace() {
  return hasLocalNodeConfig() || hasLocalLinksConfig() || hasLocalWorkspaceConfig();
}

function getWorkspaceResponse() {
  const hasLocalNodes = hasLocalNodeConfig();
  const hasLocalLinks = hasLocalLinksConfig();
  const hasLocalWorkspace = hasLocalWorkspaceConfig();
  const hasLocalConfig = hasLocalNodes || hasLocalLinks || hasLocalWorkspace;
  return { ...workspace, hasLocalConfig, hasLocalNodes, hasLocalLinks, hasLocalWorkspace, hasLocalSavedWorkspace: hasLocalConfig, usingDemoWorkspace: !hasLocalConfig };
}

function formatUptime(ticks) {
  const totalMinutes = Math.floor(ticks / 6000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  return days ? `${days}d ${hours}h` : `${hours}h ${totalMinutes % 60}m`;
}

function getPlatformVersion(description) {
  const routerOs = description.match(/RouterOS\s+v?([\w.-]+)/i);
  if (routerOs) return `RouterOS ${routerOs[1]}`;
  const openWrt = description.match(/OpenWrt\s+([\w.-]+)/i);
  if (openWrt) return `OpenWrt ${openWrt[1]}`;
  return '';
}

async function saveNodes() {
  await writeFile(CONFIG_PATH, `${JSON.stringify(nodes, null, 2)}\n`);
}

async function saveLinks() {
  await writeFile(LINKS_PATH, `${JSON.stringify(links, null, 2)}\n`);
}

async function saveWorkspace() {
  await writeFile(WORKSPACE_PATH, `${JSON.stringify(workspace, null, 2)}\n`);
}

function getInterfaceOid(index, direction) {
  return `1.3.6.1.2.1.2.2.1.${direction === 'rx' ? 10 : 16}.${index}`;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function normalizeSnmpVersion(version) {
  const value = String(version || '2c').trim().toLowerCase();
  if (['2', '2c', 'v2c', 'snmpv2c'].includes(value)) return '2c';
  if (['3', 'v3', 'snmpv3'].includes(value)) return '3';
  return '';
}

function getSnmpVersion(node) {
  return normalizeSnmpVersion(node.snmpVersion) || '2c';
}

function getEffectiveCommunity(node) {
  return node.community || process.env.SNMP_COMMUNITY || 'public';
}

function getSnmpSecurityLevel(node) {
  return hasOwn(SNMP_SECURITY_LEVELS, node.securityLevel) ? node.securityLevel : 'authPriv';
}

function getSnmpAuthProtocol(node) {
  return hasOwn(SNMP_AUTH_PROTOCOLS, node.authProtocol) ? node.authProtocol : 'sha';
}

function getSnmpPrivProtocol(node) {
  return hasOwn(SNMP_PRIV_PROTOCOLS, node.privProtocol) ? node.privProtocol : 'aes';
}

function normalizeSnmpNodeConfig(node) {
  const normalized = { ...node, snmpVersion: getSnmpVersion(node) };
  ['community', 'snmpUser', 'securityLevel', 'authProtocol', 'authKey', 'privProtocol', 'privKey', 'context', 'apiUsername', 'apiPassword'].forEach((key) => {
    if (typeof normalized[key] === 'string') normalized[key] = normalized[key].trim();
  });
  if (!hasOwn(SNMP_SECURITY_LEVELS, normalized.securityLevel)) normalized.securityLevel = getSnmpSecurityLevel(normalized);
  if (!hasOwn(SNMP_AUTH_PROTOCOLS, normalized.authProtocol)) normalized.authProtocol = getSnmpAuthProtocol(normalized);
  if (!hasOwn(SNMP_PRIV_PROTOCOLS, normalized.privProtocol)) normalized.privProtocol = getSnmpPrivProtocol(normalized);
  return normalized;
}

function validateSnmpNodeConfig(node) {
  if (!normalizeSnmpVersion(node.snmpVersion)) return 'SNMP version must be v2c or v3.';
  if (getSnmpVersion(node) !== '3') return '';
  const securityLevel = getSnmpSecurityLevel(node);
  if (!hasOwn(SNMP_SECURITY_LEVELS, securityLevel)) return 'SNMPv3 security level is not supported.';
  if (!String(node.snmpUser || process.env.SNMPV3_USER || '').trim()) return 'SNMPv3 user is required.';
  if ((securityLevel === 'authNoPriv' || securityLevel === 'authPriv') && !String(node.authKey || process.env.SNMPV3_AUTH_KEY || '').trim()) return 'SNMPv3 authentication password is required.';
  if (securityLevel === 'authPriv' && !String(node.privKey || process.env.SNMPV3_PRIV_KEY || '').trim()) return 'SNMPv3 encryption password is required.';
  return '';
}

function getNodeResponse(node) {
  return normalizeSnmpNodeConfig({ ...node, community: getEffectiveCommunity(node) });
}

function createSnmpSession(node, options = {}) {
  const retries = options.retries === undefined ? Number(process.env.SNMP_RETRIES || 1) : options.retries;
  const sessionOptions = {
    port: Number(node.port || process.env.SNMP_PORT || 161),
    timeout: Number(process.env.SNMP_TIMEOUT || 2000),
    retries,
  };

  if (getSnmpVersion(node) !== '3') {
    const session = snmp.createSession(node.ip, getEffectiveCommunity(node), { ...sessionOptions, version: snmp.Version2c });
    session.on('error', () => {});
    return session;
  }

  const securityLevel = getSnmpSecurityLevel(node);
  const user = {
    name: node.snmpUser || process.env.SNMPV3_USER || '',
    level: SNMP_SECURITY_LEVELS[securityLevel],
  };

  if (securityLevel === 'authNoPriv' || securityLevel === 'authPriv') {
    user.authProtocol = SNMP_AUTH_PROTOCOLS[getSnmpAuthProtocol(node)];
    user.authKey = node.authKey || process.env.SNMPV3_AUTH_KEY || '';
  }
  if (securityLevel === 'authPriv') {
    user.privProtocol = SNMP_PRIV_PROTOCOLS[getSnmpPrivProtocol(node)];
    user.privKey = node.privKey || process.env.SNMPV3_PRIV_KEY || '';
  }

  const context = node.context || process.env.SNMPV3_CONTEXT || '';
  const session = snmp.createV3Session(node.ip, user, { ...sessionOptions, version: snmp.Version3, context });
  session.on('error', () => {});
  return session;
}

async function checkPing(target) {
  const startedAt = Date.now();
  try {
    const { stdout } = await execFileAsync('ping', ['-n', '1', '-w', '3000', target], { timeout: 4000, windowsHide: true });
    // ping.exe's wording is localized (e.g. "temps=", "tiempo="), so the "time=Xms" match can miss
    // on non-English Windows installs; fall back to the measured round-trip in that case.
    const match = stdout.match(/time[=<](\d+)\s*ms/i);
    return { reachable: true, latency: match ? Number(match[1]) : Date.now() - startedAt };
  } catch {
    return { reachable: false, latency: null };
  }
}

// e.g. "router.home [192.168.1.1]" -> { host: 'router.home', ip: '192.168.1.1' }
function splitTracertHost(raw) {
  const bracketed = raw.match(/^(.*?)\s*\[([^\]]+)\]$/);
  if (bracketed) return { host: bracketed[1].trim(), ip: bracketed[2] };
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(raw)) return { host: '', ip: raw };
  return { host: raw, ip: '' };
}

function parseTracertLine(line) {
  const match = line.match(/^\s*(\d+)\s+(.*)$/);
  if (!match) return null;
  const columns = match[2].trim().split(/\s{2,}/).filter(Boolean);
  if (columns.length < 4) return null;
  const rtts = columns.slice(0, 3).map((value) => (value === '*' ? null : Number(value.replace(/[^\d]/g, ''))));
  const { host, ip } = splitTracertHost(columns[3]);
  return { hop: Number(match[1]), host, ip, rtts, timedOut: rtts.every((value) => value === null) };
}

// Traceroute runs as a background process so the UI can poll for hops as they arrive instead
// of waiting for the whole (potentially 30-hop) trace to finish before showing anything.
const tracerouteSessions = new Map();
const TRACEROUTE_SESSION_TTL_MS = 60 * 1000;
let tracerouteSessionCounter = 0;

function startTracerouteSession(target, options = {}) {
  const id = `tr${Date.now()}-${++tracerouteSessionCounter}`;
  const maxHops = Math.min(64, Math.max(1, Number(options.maxHops) || 30));
  const timeoutMs = Math.min(5000, Math.max(200, Number(options.timeout) || 1000));
  const args = ['-h', String(maxHops), '-w', String(timeoutMs)];
  if (!options.useDns) args.push('-d');
  args.push(target);
  const session = { hops: [], done: false, error: '', buffer: '' };
  tracerouteSessions.set(id, session);
  let child;
  try {
    child = spawn('tracert', args, { windowsHide: true });
  } catch (error) {
    session.error = error.message || 'Traceroute failed.';
    session.done = true;
    return id;
  }
  session.child = child;
  // tracert lines end in "\r\n"; strip the trailing "\r" so the "$" anchor in parseTracertLine can match.
  const consumeLine = (line) => { const hop = parseTracertLine(line.replace(/\r$/, '')); if (hop) session.hops.push(hop); };
  child.stdout.on('data', (chunk) => {
    session.buffer += chunk.toString('utf8');
    let index;
    while ((index = session.buffer.indexOf('\n')) >= 0) {
      consumeLine(session.buffer.slice(0, index));
      session.buffer = session.buffer.slice(index + 1);
    }
  });
  child.on('error', (error) => { session.error = error.message || 'Traceroute failed.'; session.done = true; });
  child.on('close', () => {
    consumeLine(session.buffer);
    session.buffer = '';
    session.done = true;
    setTimeout(() => tracerouteSessions.delete(id), TRACEROUTE_SESSION_TTL_MS);
  });
  return id;
}

function stopTracerouteSession(id) {
  const session = tracerouteSessions.get(id);
  if (!session) return;
  try { session.child?.kill(); } catch { /* process may have already exited */ }
  tracerouteSessions.delete(id);
}

function getInterfaces(node) {
  return new Promise((resolve) => {
    let session;
    try {
      session = createSnmpSession(node);
    } catch {
      resolve([]);
      return;
    }
    const interfaces = [];
    session.subtree('1.3.6.1.2.1.2.2.1.2', 20, (varbinds) => {
      interfaces.push(...varbinds.filter((varbind) => !snmp.isVarbindError(varbind)).map((varbind) => ({ index: Number(varbind.oid.split('.').pop()), name: String(varbind.value) })));
      return false;
    }, () => {
      session.close();
      resolve(interfaces);
    });
  });
}

// Torch only needs interface names, not SNMP ifIndex numbers, so prefer the RouterOS API
// (many MikroTik devices don't expose IF-MIB cleanly over SNMP even when otherwise reachable).
async function getTorchInterfaces(node) {
  let apiError = '';
  if (node.platform === 'mikrotik' && node.apiUsername) {
    try {
      const rows = await runMikrotikApiCommand(node, ['/interface/print']);
      const names = rows.map((row) => row.name).filter(Boolean);
      if (names.length) return { interfaces: names, error: '' };
    } catch (error) {
      apiError = `RouterOS API connection failed: ${error.message}`;
    }
  }
  const snmpInterfaces = await getInterfaces(node);
  const names = snmpInterfaces.map((item) => item.name).filter(Boolean);
  // Only surface the API failure once SNMP also came up empty — either source succeeding is fine.
  return { interfaces: names, error: names.length ? '' : apiError };
}

function walkSnmp(node, oid) {
  return new Promise((resolve) => {
    let session;
    try {
      session = createSnmpSession(node, { retries: 0 });
    } catch {
      resolve([]);
      return;
    }
    const varbinds = [];
    session.subtree(oid, 20, (items) => {
      varbinds.push(...items.filter((item) => !snmp.isVarbindError(item)));
      return false;
    }, () => {
      session.close();
      resolve(varbinds);
    });
  });
}

function oidSuffix(oid, base) {
  return oid.startsWith(`${base}.`) ? oid.slice(base.length + 1).split('.').map(Number) : [];
}

function valueText(value) {
  return Buffer.isBuffer(value) ? value.toString('utf8').replace(/\0/g, '').trim() : String(value ?? '').trim();
}

function valueIp(value) {
  const text = valueText(value);
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(text)) return text;
  if (Buffer.isBuffer(value) && value.length === 4) return [...value].join('.');
  return '';
}

// RouterOS API word-length prefix: see https://help.mikrotik.com/docs/spaces/ROS/pages/47579227/API
function parseApiWordLength(buffer) {
  if (buffer.length < 1) return null;
  const first = buffer[0];
  if (first < 0x80) return { length: first, size: 1 };
  if ((first & 0xC0) === 0x80) {
    if (buffer.length < 2) return null;
    return { length: ((first & 0x3F) << 8) | buffer[1], size: 2 };
  }
  if ((first & 0xE0) === 0xC0) {
    if (buffer.length < 3) return null;
    return { length: ((first & 0x1F) << 16) | (buffer[1] << 8) | buffer[2], size: 3 };
  }
  if ((first & 0xF0) === 0xE0) {
    if (buffer.length < 4) return null;
    return { length: ((first & 0x0F) << 24) | (buffer[1] << 16) | (buffer[2] << 8) | buffer[3], size: 4 };
  }
  if (buffer.length < 5) return null;
  return { length: (buffer[1] << 24) | (buffer[2] << 16) | (buffer[3] << 8) | buffer[4], size: 5 };
}

function encodeApiWord(word) {
  const data = Buffer.from(word, 'utf8');
  const { length } = data;
  let prefix;
  if (length < 0x80) prefix = Buffer.from([length]);
  else if (length < 0x4000) prefix = Buffer.from([(length >> 8) | 0x80, length & 0xFF]);
  else if (length < 0x200000) prefix = Buffer.from([(length >> 16) | 0xC0, (length >> 8) & 0xFF, length & 0xFF]);
  else prefix = Buffer.from([(length >> 24) | 0xE0, (length >> 16) & 0xFF, (length >> 8) & 0xFF, length & 0xFF]);
  return Buffer.concat([prefix, data]);
}

function encodeApiSentence(words) {
  return Buffer.concat([...words.map(encodeApiWord), Buffer.from([0])]);
}

function apiSentenceAttrs(sentence) {
  const attrs = {};
  sentence.forEach((word) => {
    if (!word.startsWith('=')) return;
    const separator = word.indexOf('=', 1);
    if (separator > 0) attrs[word.slice(1, separator)] = word.slice(separator + 1);
  });
  return attrs;
}

// Talks the classic RouterOS API protocol (TCP, default port 8728) to run a single command
// after logging in with plain-text credentials, as supported since RouterOS 6.43+.
function runMikrotikApiCommand(node, commandWords) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: node.ip, port: Number(node.apiPort || 8728) });
    const results = [];
    let loggedIn = false;
    let settled = false;
    let pending = Buffer.alloc(0);
    let words = [];

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      error ? reject(error) : resolve(value);
    };

    const timer = setTimeout(() => finish(new Error('RouterOS API request timed out.')), 5000);

    const handleSentence = (sentence) => {
      const type = sentence[0];
      if (!loggedIn) {
        if (type === '!trap') return finish(new Error(apiSentenceAttrs(sentence).message || 'RouterOS API login failed.'));
        if (type === '!done') { loggedIn = true; socket.write(encodeApiSentence(commandWords)); }
        return;
      }
      if (type === '!trap') return finish(new Error(apiSentenceAttrs(sentence).message || 'RouterOS API command failed.'));
      if (type === '!re') results.push(apiSentenceAttrs(sentence));
      if (type === '!done') finish(null, results);
    };

    socket.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      let progress = true;
      while (progress) {
        progress = false;
        const info = parseApiWordLength(pending);
        if (!info || pending.length < info.size + info.length) break;
        const word = pending.subarray(info.size, info.size + info.length);
        pending = pending.subarray(info.size + info.length);
        progress = true;
        if (info.length === 0) { const sentence = words; words = []; handleSentence(sentence); }
        else words.push(word.toString('utf8'));
      }
    });
    socket.on('error', (error) => finish(error));
    socket.on('connect', () => {
      socket.write(encodeApiSentence(['/login', `=name=${node.apiUsername || ''}`, `=password=${node.apiPassword || ''}`]));
    });
  });
}

// Tracks the current step of an in-flight wireless-client lookup so the UI can poll for progress.
const wirelessClientStatus = new Map();

function setWirelessStatus(nodeId, stage, detail) {
  wirelessClientStatus.set(nodeId, { stage, detail, at: Date.now() });
}

async function getMikrotikDhcpLeases(node) {
  if (!node.apiUsername) return { leases: [], error: '' };
  setWirelessStatus(node.id, 'connecting-api', `Connecting to RouterOS API on ${node.ip}:${node.apiPort || 8728}…`);
  try {
    const leases = await runMikrotikApiCommand(node, ['/ip/dhcp-server/lease/print']);
    setWirelessStatus(node.id, 'connected-api', `Connected to RouterOS API on ${node.ip}.`);
    return { leases, error: '' };
  } catch (error) {
    const message = `RouterOS API connection failed: ${error.message}`;
    setWirelessStatus(node.id, 'api-failed', message);
    return { leases: [], error: message };
  }
}

// e.g. "-69dBm@6Mbps" -> -69
function parseMikrotikSignalStrength(text) {
  const match = String(text || '').match(/-?\d+/);
  return match ? Number(match[0]) : undefined;
}

// Covers wifi/wifiwave2 registrations that never show up in the legacy MTXR-WIRELESS-MIB SNMP OIDs.
async function getMikrotikApiRegistrationTable(node) {
  setWirelessStatus(node.id, 'connecting-api', `Connecting to RouterOS API on ${node.ip}:${node.apiPort || 8728}…`);
  const rows = await runMikrotikApiCommand(node, ['/interface/wireless/registration-table/print']);
  setWirelessStatus(node.id, 'connected-api', `Connected to RouterOS API on ${node.ip}.`);
  return rows.map((row) => ({
    mac: String(row['mac-address'] || '').toLowerCase(),
    interface: row['interface'] || '',
    ssid: row['ssid'] || '',
    uptime: row['uptime'] || '',
    signal: parseMikrotikSignalStrength(row['signal-strength']),
  }));
}

// Torch ("/tool/torch") is a live RouterOS command: after the initial request it keeps
// streaming per-flow traffic sentences until cancelled, so we keep one API socket per node
// open in the background and let the UI poll the latest snapshot instead of round-tripping.
const torchSessions = new Map();
const TORCH_IDLE_TIMEOUT_MS = 2 * 60 * 1000;
const TORCH_BATCH_GAP_MS = 300;
const TORCH_STALE_MS = 5000;

function stopMikrotikTorch(nodeId) {
  const session = torchSessions.get(nodeId);
  if (!session) return;
  clearTimeout(session.expiry);
  clearTimeout(session.batchTimer);
  try {
    if (session.loggedIn && !session.socket.destroyed) session.socket.write(encodeApiSentence(['/cancel', `=tag=${session.tag}`]));
  } catch { /* socket already gone, nothing to clean up */ }
  session.socket.destroy();
  torchSessions.delete(nodeId);
}

function startMikrotikTorch(node, iface) {
  stopMikrotikTorch(node.id);
  const tag = `torch${Date.now()}`;
  const session = { rows: [], batch: new Map(), error: '', loggedIn: false, pending: Buffer.alloc(0), words: [], tag, lastBatchAt: 0 };
  torchSessions.set(node.id, session);
  const socket = net.connect({ host: node.ip, port: Number(node.apiPort || 8728) });
  session.socket = socket;
  const resetExpiry = () => { clearTimeout(session.expiry); session.expiry = setTimeout(() => stopMikrotikTorch(node.id), TORCH_IDLE_TIMEOUT_MS); };
  resetExpiry();

  const flushBatch = () => { session.rows = [...session.batch.values()]; session.batch = new Map(); session.lastBatchAt = Date.now(); };

  const handleSentence = (sentence) => {
    const type = sentence[0];
    if (!session.loggedIn) {
      if (type === '!trap') { session.error = apiSentenceAttrs(sentence).message || 'RouterOS API login failed.'; return; }
      if (type === '!done') { session.loggedIn = true; socket.write(encodeApiSentence(['/tool/torch', `=interface=${iface}`, `.tag=${tag}`])); }
      return;
    }
    if (type === '!trap') { session.error = apiSentenceAttrs(sentence).message || 'Torch command failed.'; return; }
    if (type === '!re') {
      const attrs = apiSentenceAttrs(sentence);
      const key = [attrs['src-address'], attrs['dst-address'], attrs['protocol'], attrs['port'] || attrs['dst-port']].join('|');
      session.batch.set(key, attrs);
      clearTimeout(session.batchTimer);
      session.batchTimer = setTimeout(flushBatch, TORCH_BATCH_GAP_MS);
    }
  };

  socket.on('data', (chunk) => {
    session.pending = Buffer.concat([session.pending, chunk]);
    let progress = true;
    while (progress) {
      progress = false;
      const info = parseApiWordLength(session.pending);
      if (!info || session.pending.length < info.size + info.length) break;
      const word = session.pending.subarray(info.size, info.size + info.length);
      session.pending = session.pending.subarray(info.size + info.length);
      progress = true;
      if (info.length === 0) { const sentence = session.words; session.words = []; handleSentence(sentence); }
      else session.words.push(word.toString('utf8'));
    }
  });
  socket.on('error', (error) => { session.error = error.message; });
  socket.on('connect', () => {
    socket.write(encodeApiSentence(['/login', `=name=${node.apiUsername || ''}`, `=password=${node.apiPassword || ''}`]));
  });
  return session;
}

function readMikrotikTorch(nodeId) {
  const session = torchSessions.get(nodeId);
  if (!session) return { running: false, rows: [], error: '' };
  clearTimeout(session.expiry);
  session.expiry = setTimeout(() => stopMikrotikTorch(nodeId), TORCH_IDLE_TIMEOUT_MS);
  // No flows reported for a while means the interface has gone quiet — don't keep showing stale rows.
  if (session.lastBatchAt && Date.now() - session.lastBatchAt > TORCH_STALE_MS) session.rows = [];
  return { running: !session.error, rows: session.rows, error: session.error };
}

async function discoverSnmpNeighbors(node, protocol) {
  const candidates = [];
  if (protocol === 'lldp' || protocol === 'all') {
    const base = '1.0.8802.1.1.2.1.4.1.1';
    const [names, descriptions, ports] = await Promise.all([
      walkSnmp(node, `${base}.9`), walkSnmp(node, `${base}.10`), walkSnmp(node, `${base}.8`),
    ]);
    const byKey = new Map();
    names.forEach((item) => {
      const suffix = oidSuffix(item.oid, `${base}.9`); const key = suffix.slice(0, -1).join('.');
      byKey.set(key, { protocol: 'LLDP', remoteName: valueText(item.value), localInterfaceIndex: Number(suffix[1]) || 0 });
    });
    descriptions.forEach((item) => { const key = oidSuffix(item.oid, `${base}.10`).slice(0, -1).join('.'); if (byKey.has(key)) byKey.get(key).remotePlatform = valueText(item.value); });
    ports.forEach((item) => { const key = oidSuffix(item.oid, `${base}.8`).slice(0, -1).join('.'); if (byKey.has(key)) byKey.get(key).remotePort = valueText(item.value); });
    // Remote management addresses live in a separate table (lldpRemManAddrTable) whose index
    // embeds the address bytes directly, rather than in a plain value column.
    const addrBase = '1.0.8802.1.1.2.1.4.2.1.3';
    (await walkSnmp(node, addrBase)).forEach((item) => {
      const suffix = oidSuffix(item.oid, addrBase); // timeMark, localPort, remIndex, addrSubtype, addrLen, ...addrBytes
      const key = suffix.slice(0, 2).join('.');
      const [, , , addrSubtype, addrLen] = suffix;
      if (addrSubtype === 1 && addrLen === 4 && byKey.has(key)) byKey.get(key).remoteIp = suffix.slice(5, 9).join('.');
    });
    candidates.push(...byKey.values());
  }
  if (protocol === 'cdp' || protocol === 'all') {
    const base = '1.3.6.1.4.1.9.9.23.1.2.1.1';
    const [ids, platforms, ports, addresses] = await Promise.all([
      walkSnmp(node, `${base}.6`), walkSnmp(node, `${base}.8`), walkSnmp(node, `${base}.7`), walkSnmp(node, `${base}.4`),
    ]);
    const byKey = new Map();
    ids.forEach((item) => { const suffix = oidSuffix(item.oid, `${base}.6`); const key = suffix.slice(0, -1).join('.'); byKey.set(key, { protocol: 'CDP', remoteName: valueText(item.value), localInterfaceIndex: Number(suffix[0]) || 0 }); });
    platforms.forEach((item) => { const key = oidSuffix(item.oid, `${base}.8`).slice(0, -1).join('.'); if (byKey.has(key)) byKey.get(key).remotePlatform = valueText(item.value); });
    ports.forEach((item) => { const key = oidSuffix(item.oid, `${base}.7`).slice(0, -1).join('.'); if (byKey.has(key)) byKey.get(key).remotePort = valueText(item.value); });
    addresses.forEach((item) => { const key = oidSuffix(item.oid, `${base}.4`).slice(0, -1).join('.'); if (byKey.has(key)) byKey.get(key).remoteIp = valueIp(item.value); });
    candidates.push(...byKey.values());
  }
  return candidates;
}

function discoverMndpNeighbors() {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4'); const candidates = new Map();
    const finish = () => { clearTimeout(timer); try { socket.close(); } catch {} resolve([...candidates.values()]); };
    const timer = setTimeout(finish, 1800);
    socket.on('message', (message, remote) => {
      if (message.length < 4) return;
      let offset = 4; const fields = {};
      while (offset + 4 <= message.length) {
        const type = message.readUInt16LE(offset); const length = message.readUInt16LE(offset + 2); offset += 4;
        if (length < 4 || offset + length - 4 > message.length) break;
        const value = message.subarray(offset, offset + length - 4); offset += length - 4;
        fields[type] = value;
      }
      const remoteIp = valueIp(fields[11]) || remote.address;
      const remoteName = valueText(fields[2]) || remoteIp;
      candidates.set(`${remoteIp}:${remoteName}`, { protocol: 'MNDP', remoteName, remoteIp, remotePlatform: valueText(fields[4]), remotePort: valueText(fields[9]) });
    });
    socket.bind(0, () => { socket.setBroadcast(true); socket.send(Buffer.alloc(4), 0, 4, 5678, '255.255.255.255'); });
    socket.on('error', finish);
  });
}

function discoverWsDiscoveryNeighbors() {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    const candidates = new Map();
    const message = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery"><e:Header><w:MessageID>urn:uuid:${Date.now()}-${Math.random().toString(16).slice(2)}</w:MessageID><w:To>urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To><w:Action>http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action></e:Header><e:Body><d:Probe /></e:Body></e:Envelope>`);
    const finish = () => { clearTimeout(timer); try { socket.close(); } catch {} resolve([...candidates.values()]); };
    const timer = setTimeout(finish, 2200);
    socket.on('message', (response, remote) => {
      const text = response.toString('utf8');
      const xaddrs = [...text.matchAll(/<(?:[^:>]+:)?XAddrs[^>]*>([^<]+)</gi)].flatMap((match) => match[1].trim().split(/\s+/));
      const remoteIp = xaddrs.map((address) => address.match(/https?:\/\/\[?([^\]/:]+)|https?:\/\/([^/:\s]+)/i)).find(Boolean)?.slice(1).find(Boolean) || remote.address;
      const scopes = text.match(/<(?:[^:>]+:)?Scopes[^>]*>([^<]+)</i)?.[1] || '';
      const name = scopes.match(/(?:^|\s)(?:d:)?name=([^\s]+)/i)?.[1] || scopes.match(/(?:^|\s)(?:d:)?computer=([^\s]+)/i)?.[1] || remoteIp;
      const key = `${remoteIp}:${name}`;
      candidates.set(key, { protocol: 'WS-Discovery', remoteName: decodeURIComponent(name), remoteIp, remotePlatform: 'Windows / Web Services on Devices' });
    });
    socket.on('error', finish);
    socket.bind(0, () => {
      socket.setMulticastTTL(1);
      socket.send(message, 0, message.length, 3702, '239.255.255.250');
    });
  });
}

async function discoverNeighbors(node, protocol) {
  const normalizedProtocol = ['cdp', 'lldp', 'mndp', 'ws-discovery', 'all'].includes(protocol) ? protocol : 'all';
  const results = normalizedProtocol === 'mndp'
    ? await discoverMndpNeighbors()
    : normalizedProtocol === 'ws-discovery'
      ? await discoverWsDiscoveryNeighbors()
      : await discoverSnmpNeighbors(node, normalizedProtocol === 'all' ? 'all' : normalizedProtocol).then(async (items) => normalizedProtocol === 'all'
        ? [...items, ...await discoverMndpNeighbors(), ...await discoverWsDiscoveryNeighbors()]
        : items);
  const unique = new Map();
  results.forEach((candidate) => { const key = candidate.remoteIp || `${candidate.remoteName}:${candidate.remotePort || ''}`; if (!unique.has(key)) unique.set(key, candidate); });
  return [...unique.values()];
}

function pollLink(link) {
  const source = nodes.find((node) => node.id === link.sourceId);
  if (!source || !source.ip?.trim()) return Promise.resolve({ ...link, status: 'offline', rx: 0, tx: 0 });
  return new Promise((resolve) => {
    let session;
    try {
      session = createSnmpSession(source);
    } catch {
      resolve({ ...link, status: 'offline', rx: 0, tx: 0 });
      return;
    }
    session.get([getInterfaceOid(link.interfaceIndex, 'rx'), getInterfaceOid(link.interfaceIndex, 'tx')], (error, varbinds) => {
      session.close();
      if (error || varbinds.some(snmp.isVarbindError)) return resolve({ ...link, status: 'offline', rx: 0, tx: 0 });
      const now = Date.now();
      const previous = snapshots.get(`link:${link.id}`);
      const elapsed = previous ? (now - previous.at) / 1000 : 0;
      const rxOctets = Number(varbinds[0].value); const txOctets = Number(varbinds[1].value);
      snapshots.set(`link:${link.id}`, { at: now, rxOctets, txOctets });
      resolve({ ...link, status: 'healthy', rx: elapsed ? +Math.max(0, (rxOctets - previous.rxOctets) * 8 / elapsed).toFixed(0) : 0, tx: elapsed ? +Math.max(0, (txOctets - previous.txOctets) * 8 / elapsed).toFixed(0) : 0 });
    });
  });
}

async function pollMikrotikHealth(node) {
  const [cpuEntries, descrEntries, sizeEntries, usedEntries] = await Promise.all([
    walkSnmp(node, MIKROTIK_CPU_OID), walkSnmp(node, MIKROTIK_STORAGE_DESCR_OID), walkSnmp(node, MIKROTIK_STORAGE_SIZE_OID), walkSnmp(node, MIKROTIK_STORAGE_USED_OID),
  ]);
  const cpuLoads = cpuEntries.map((item) => Number(item.value)).filter((value) => Number.isFinite(value));
  const cpu = cpuLoads.length ? Math.round(cpuLoads.reduce((sum, value) => sum + value, 0) / cpuLoads.length) : undefined;
  const memoryEntry = descrEntries.find((item) => /memory|ram/i.test(valueText(item.value)));
  let memory;
  if (memoryEntry) {
    const index = oidSuffix(memoryEntry.oid, MIKROTIK_STORAGE_DESCR_OID).join('.');
    const size = sizeEntries.find((item) => oidSuffix(item.oid, MIKROTIK_STORAGE_SIZE_OID).join('.') === index);
    const used = usedEntries.find((item) => oidSuffix(item.oid, MIKROTIK_STORAGE_USED_OID).join('.') === index);
    if (size && used && Number(size.value) > 0) memory = Math.min(100, Math.max(0, Math.round((Number(used.value) / Number(size.value)) * 100)));
  }
  return { cpu, memory };
}

function formatMac(value) {
  if (Buffer.isBuffer(value)) return [...value].map((byte) => byte.toString(16).padStart(2, '0')).join(':');
  return valueText(value);
}

function macFromIndexSuffix(suffix) {
  return suffix.slice(0, 6).map((byte) => Number(byte).toString(16).padStart(2, '0')).join(':');
}

async function reverseDnsLookup(ip) {
  try {
    const hostnames = await Promise.race([
      dnsPromises.reverse(ip),
      new Promise((resolve) => setTimeout(() => resolve([]), 800)),
    ]);
    return hostnames?.[0] || '';
  } catch {
    return '';
  }
}

async function getMikrotikWirelessClients(node) {
  setWirelessStatus(node.id, 'querying', `Reading wireless registration table on ${node.ip}…`);
  const [ssidEntries, uptimeEntries, signalEntries, bandEntries, ifDescrEntries, arpEntries] = await Promise.all([
    walkSnmp(node, MIKROTIK_WIFI_REG_SSID_OID),
    walkSnmp(node, MIKROTIK_WIFI_REG_UPTIME_OID),
    walkSnmp(node, MIKROTIK_WIFI_REG_SIGNAL_OID),
    walkSnmp(node, MIKROTIK_WIFI_REG_BAND_OID),
    walkSnmp(node, IF_DESCR_OID),
    walkSnmp(node, ARP_MAC_OID),
  ]);

  const ifNames = new Map(ifDescrEntries.map((item) => [oidSuffix(item.oid, IF_DESCR_OID).join('.'), valueText(item.value)]));
  const arpByMac = new Map();
  arpEntries.forEach((item) => {
    const suffix = oidSuffix(item.oid, ARP_MAC_OID); // [ifIndex, ip1, ip2, ip3, ip4]
    const mac = formatMac(item.value);
    if (mac) arpByMac.set(mac, suffix.slice(1, 5).join('.'));
  });

  const clients = new Map();
  const keyFor = (suffix) => `${macFromIndexSuffix(suffix)}.${suffix[6]}`;
  ssidEntries.forEach((item) => {
    const suffix = oidSuffix(item.oid, MIKROTIK_WIFI_REG_SSID_OID);
    const mac = macFromIndexSuffix(suffix);
    clients.set(keyFor(suffix), { mac, interface: ifNames.get(String(suffix[6])) || '', ssid: valueText(item.value) });
  });
  uptimeEntries.forEach((item) => {
    const entry = clients.get(keyFor(oidSuffix(item.oid, MIKROTIK_WIFI_REG_UPTIME_OID)));
    if (entry) entry.uptime = formatUptime(Number(item.value));
  });
  signalEntries.forEach((item) => {
    const entry = clients.get(keyFor(oidSuffix(item.oid, MIKROTIK_WIFI_REG_SIGNAL_OID)));
    if (entry) entry.signal = Number(item.value);
  });
  bandEntries.forEach((item) => {
    const entry = clients.get(keyFor(oidSuffix(item.oid, MIKROTIK_WIFI_REG_BAND_OID)));
    if (entry) entry.band = valueText(item.value);
  });

  // The MTXR-WIRELESS-MIB OIDs above only cover the legacy "wireless" driver; newer wifi
  // packages (wifiwave2/wifi) don't populate them, so also ask the API for the same table.
  let apiError = '';
  if (node.apiUsername) {
    try {
      const macsFromSnmp = new Set([...clients.values()].map((entry) => entry.mac));
      const apiRows = await getMikrotikApiRegistrationTable(node);
      apiRows.forEach((row) => {
        if (!row.mac || macsFromSnmp.has(row.mac)) return;
        clients.set(`api-${row.mac}-${row.interface}`, row);
      });
    } catch (error) {
      apiError = `RouterOS API registration table failed: ${error.message}`;
    }
  }

  const results = [...clients.values()];
  // Skip the DHCP-lease API call if the registration-table one already failed against the
  // same API session — it would just fail again with the same underlying connection error.
  const { leases, error: leaseError } = node.platform === 'mikrotik' && !apiError ? await getMikrotikDhcpLeases(node) : { leases: [], error: '' };
  const combinedError = apiError || leaseError;
  // A failed lookup on an otherwise empty registration table usually means the API
  // credentials are wrong, not that there really are no wireless clients — surface that.
  if (combinedError && results.length === 0) throw new Error(combinedError);
  const leaseByMac = new Map();
  leases.forEach((lease) => {
    const mac = String(lease['mac-address'] || lease['active-mac-address'] || '').toLowerCase();
    if (mac) leaseByMac.set(mac, { hostname: lease['host-name'] || '', ip: lease['active-address'] || lease.address || '' });
  });
  results.forEach((entry) => {
    const lease = leaseByMac.get(entry.mac);
    entry.ip = lease?.ip || arpByMac.get(entry.mac) || '';
    entry.hostname = lease?.hostname || '';
  });
  setWirelessStatus(node.id, 'resolving', 'Resolving client hostnames…');
  await Promise.all(results.map(async (entry) => { if (!entry.hostname && entry.ip) entry.hostname = await reverseDnsLookup(entry.ip); }));
  const sorted = results.sort((a, b) => (b.signal ?? -999) - (a.signal ?? -999));
  sorted.warning = leaseError || '';
  return sorted;
}

// OpenWrt exposes wireless stations and DHCP leases through ubus (the same JSON-RPC
// interface LuCI itself uses), reachable over plain HTTP with a router login.
async function ubusCall(node, session, object, method, params = {}) {
  const url = `http://${node.ip}:${node.apiPort || 80}/ubus`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'call', params: [session, object, method, params] }),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error('Could not reach the OpenWrt ubus endpoint.');
  const payload = await response.json();
  const [status, result] = payload.result || [];
  if (status !== 0) throw new Error(`OpenWrt ubus call ${object}.${method} failed.`);
  return result || {};
}

async function ubusLogin(node) {
  setWirelessStatus(node.id, 'connecting-api', `Connecting to OpenWrt ubus on ${node.ip}…`);
  const result = await ubusCall(node, '00000000000000000000000000000000', 'session', 'login', {
    username: node.apiUsername || '',
    password: node.apiPassword || '',
  });
  if (!result.ubus_rpc_session) {
    setWirelessStatus(node.id, 'api-failed', 'OpenWrt login failed. Check the API username and password.');
    throw new Error('OpenWrt login failed. Check the API username and password.');
  }
  setWirelessStatus(node.id, 'connected-api', `Connected to OpenWrt ubus on ${node.ip}.`);
  return result.ubus_rpc_session;
}

function parseDhcpLeaseFile(text) {
  const leaseByMac = new Map();
  String(text || '').split('\n').forEach((line) => {
    const [, mac, ip, hostname] = line.trim().split(/\s+/);
    if (mac) leaseByMac.set(mac.toLowerCase(), { ip: ip || '', hostname: hostname && hostname !== '*' ? hostname : '' });
  });
  return leaseByMac;
}

async function getOpenwrtWirelessClients(node) {
  if (!node.apiUsername) return [];
  const session = await ubusLogin(node);
  setWirelessStatus(node.id, 'querying', `Reading wireless station list on ${node.ip}…`);
  const { devices = [] } = await ubusCall(node, session, 'iwinfo', 'devices', {});
  let leaseError = '';
  const [assocLists, infos, leaseFile] = await Promise.all([
    Promise.all(devices.map((device) => ubusCall(node, session, 'iwinfo', 'assoclist', { device }).catch(() => ({ results: [] })))),
    Promise.all(devices.map((device) => ubusCall(node, session, 'iwinfo', 'info', { device }).catch(() => ({})))),
    ubusCall(node, session, 'file', 'read', { path: '/tmp/dhcp.leases' }).catch((error) => { leaseError = `Could not read DHCP leases: ${error.message}`; return { data: '' }; }),
  ]);
  const leaseByMac = parseDhcpLeaseFile(leaseFile.data);

  const clients = [];
  devices.forEach((device, index) => {
    (assocLists[index]?.results || []).forEach((station) => {
      const mac = String(station.mac || '').toLowerCase();
      const lease = leaseByMac.get(mac);
      clients.push({
        mac,
        interface: device,
        ssid: infos[index]?.ssid || '',
        signal: Number.isFinite(station.signal) ? station.signal : undefined,
        ip: lease?.ip || '',
        hostname: lease?.hostname || '',
      });
    });
  });
  // A failed lease lookup on an otherwise empty station list usually means the router
  // rejected the session for that call, not that there really are no wireless clients.
  if (leaseError && clients.length === 0) throw new Error(leaseError);
  setWirelessStatus(node.id, 'resolving', 'Resolving client hostnames…');
  await Promise.all(clients.map(async (entry) => { if (!entry.hostname && entry.ip) entry.hostname = await reverseDnsLookup(entry.ip); }));
  const sorted = clients.sort((a, b) => (b.signal ?? -999) - (a.signal ?? -999));
  sorted.warning = leaseError || '';
  return sorted;
}

async function getWirelessClients(node) {
  const label = node.platform === 'openwrt' ? 'OpenWrt' : 'MikroTik';
  setWirelessStatus(node.id, 'connecting', `Connecting to ${label} device ${node.ip}…`);
  try {
    if (node.platform === 'openwrt') return await getOpenwrtWirelessClients(node);
    if (node.platform === 'mikrotik') return await getMikrotikWirelessClients(node);
    throw new Error('Wireless client listing is only supported for MikroTik and OpenWrt devices.');
  } catch (error) {
    setWirelessStatus(node.id, 'failed', error.message || 'Connection failed.');
    throw error;
  } finally {
    if (wirelessClientStatus.get(node.id)?.stage !== 'failed') setWirelessStatus(node.id, 'done', `Connected to ${label} device ${node.ip}.`);
  }
}

function pollHealth(node) {
  if (node.platform === 'mikrotik') return pollMikrotikHealth(node).catch(() => ({}));
  return new Promise((resolve) => {
    let session;
    try {
      session = createSnmpSession(node, { retries: 0 });
    } catch {
      resolve({});
      return;
    }
    session.get(HEALTH_OIDS, (error, varbinds) => {
      session.close();
      if (error || varbinds.some(snmp.isVarbindError)) return resolve({});
      const [idle, totalMemory, availableMemory] = varbinds.map((varbind) => Number(varbind.value));
      resolve({ cpu: Math.min(100, Math.max(0, Math.round(100 - idle))), memory: totalMemory ? Math.min(100, Math.max(0, Math.round((1 - availableMemory / totalMemory) * 100))) : null });
    });
  });
}

function poll(node) {
  return new Promise((resolve) => {
    if (!node.ip?.trim()) {
      resolve({ ...getNodeResponse(node), status: 'offline', latency: null, rx: 0, tx: 0, error: 'No SNMP address configured.' });
      return;
    }
    let session;
    try {
      session = createSnmpSession(node);
    } catch (error) {
      checkPing(node.ip).then((ping) => resolve({ ...getNodeResponse(node), status: 'offline', latency: null, rx: 0, tx: 0, ...ping, error: error?.message || 'SNMP session could not be created' }));
      return;
    }
    const startedAt = Date.now();
    session.get(OIDS, (error, varbinds) => {
      session.close();
      if (error || varbinds.some(snmp.isVarbindError)) {
        checkPing(node.ip).then((ping) => resolve({ ...getNodeResponse(node), status: 'offline', latency: null, rx: 0, tx: 0, ...ping, error: error?.message || 'SNMP request failed' }));
        return;
      }
      const [description, systemName, ticks, inOctets, outOctets] = varbinds.map((varbind) => varbind.value);
      const previous = snapshots.get(node.id);
      const now = Date.now();
      const elapsedSeconds = previous ? (now - previous.at) / 1000 : 0;
      const rx = elapsedSeconds ? Math.max(0, (Number(inOctets) - previous.inOctets) * 8 / elapsedSeconds / 1_000_000) : 0;
      const tx = elapsedSeconds ? Math.max(0, (Number(outOctets) - previous.outOctets) * 8 / elapsedSeconds / 1_000_000) : 0;
      snapshots.set(node.id, { at: now, inOctets: Number(inOctets), outOctets: Number(outOctets) });
      const systemDescription = String(description);
      pollHealth(node).then((health) => resolve({ ...getNodeResponse(node), ...health, status: 'healthy', latency: Date.now() - startedAt, rx: +rx.toFixed(2), tx: +tx.toFixed(2), systemName: String(systemName), description: systemDescription, platformVersion: getPlatformVersion(systemDescription), uptime: formatUptime(Number(ticks)), uptimeTicks: Number(ticks) }));
    });
  });
}

async function getMetrics() {
  return Promise.all(nodes.map(poll));
}

function send(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS' });
  response.end(JSON.stringify(body));
}

function decodeXml(value) {
  return value.replace(/&(?:amp|lt|gt|quot|apos);/g, (entity) => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" }[entity]));
}

function parseXmlAttributes(value) {
  const attributes = {};
  for (const match of value.matchAll(/([\w:-]+)\s*=\s*["']([^"']*)["']/g)) attributes[match[1]] = decodeXml(match[2]);
  return attributes;
}

function parseWindNodes(xml, baseUrl) {
  const nodesXml = xml.match(/<nodes\b[^>]*>([\s\S]*?)<\/nodes>/i)?.[1] || '';
  const imported = [];
  for (const match of nodesXml.matchAll(/<(?:selected|node|ap|unlinked|p2p-ap|client)\b([^>]*)\/?\s*>/gi)) {
    const attributes = parseXmlAttributes(match[1]);
    const latitude = Number(String(attributes.lat || '').replace(',', '.'));
    const longitude = Number(String(attributes.lon || '').replace(',', '.'));
    if (!attributes.id || !attributes.name || !Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
    imported.push({ id: `wind-${attributes.id}`, name: attributes.name, type: 'device', ip: '', community: 'Public', port: 161, latitude, longitude, x: longitude, y: latitude, status: 'offline', windId: String(attributes.id), windUrl: attributes.url ? new URL(attributes.url, baseUrl).href : '' });
  }
  if (!imported.length) return { nodes: [], links: [] };
  const longitudes = imported.map((node) => node.x);
  const latitudes = imported.map((node) => node.y);
  const minLongitude = Math.min(...longitudes);
  const maxLongitude = Math.max(...longitudes);
  const minLatitude = Math.min(...latitudes);
  const maxLatitude = Math.max(...latitudes);
  const nodes = imported.map((node) => ({ ...node, x: maxLongitude === minLongitude ? 50 : 8 + ((node.x - minLongitude) / (maxLongitude - minLongitude)) * 84, y: maxLatitude === minLatitude ? 50 : 8 + ((maxLatitude - node.y) / (maxLatitude - minLatitude)) * 84 }));
  const linksXml = xml.match(/<links\b[^>]*>([\s\S]*?)(?:<\/links>|$)/i)?.[1] || '';
  const byCoordinate = (latitude, longitude) => nodes.reduce((closest, node) => {
    const distance = (node.latitude - latitude) ** 2 + (node.longitude - longitude) ** 2;
    return !closest || distance < closest.distance ? { node, distance } : closest;
  }, null);
  const links = [];
  for (const match of linksXml.matchAll(/<link_(p2p|client)\b([\s\S]*?)(?=<link_|$)/gi)) {
    const attributes = parseXmlAttributes(match[2]);
    const latitude1 = Number(String(attributes.lat1 || '').replace(',', '.'));
    const longitude1 = Number(String(attributes.lon1 || '').replace(',', '.'));
    const latitude2 = Number(String(attributes.lat2 || '').replace(',', '.'));
    const longitude2 = Number(String(attributes.lon2 || '').replace(',', '.'));
    if (!attributes.id || ![latitude1, longitude1, latitude2, longitude2].every(Number.isFinite)) continue;
    const source = byCoordinate(latitude1, longitude1);
    const target = byCoordinate(latitude2, longitude2);
    if (!source || !target || source.distance > 0.000001 || target.distance > 0.000001 || source.node.id === target.node.id) continue;
    links.push({ id: `wind-link-${attributes.id}`, sourceId: source.node.id, targetId: target.node.id, interfaceIndex: 1, interfaceIp: '', windId: String(attributes.id), protocol: match[1].toUpperCase() });
  }
  return { nodes, links };
}

// Dude's own CSV export only quotes fields that contain commas (e.g. "Services Down"); handle both.
function parseCsvLine(line) {
  const cells = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') { current += '"'; i += 1; } else inQuotes = false;
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

function parseCsvTable(text) {
  const lines = String(text || '').split(/\r?\n/).filter((line) => line.trim() !== '');
  if (!lines.length) return [];
  const headers = parseCsvLine(lines[0]).map((header) => header.trim());
  return lines.slice(1).map((line) => {
    const cells = parseCsvLine(line);
    const row = {};
    headers.forEach((header, index) => { row[header] = (cells[index] || '').trim(); });
    return row;
  });
}

function mapDudeDeviceType(type) {
  const value = String(type || '').trim().toLowerCase();
  if (value === 'routeros' || value === 'router') return 'router';
  if (value === 'web server' || value === 'dns server') return 'server';
  return 'device';
}

// Dude's "Devices" list export repeats a device once per Network Map it belongs to; dedupe by IP.
function parseDudeDevices(devicesCsv) {
  const byIp = new Map();
  const order = [];
  for (const row of parseCsvTable(devicesCsv)) {
    const ip = String(row.Addresses || '').split(',').map((address) => address.trim()).filter(Boolean)[0];
    if (!ip) continue;
    const mapName = String(row.Maps || '').trim();
    if (byIp.has(ip)) {
      const existing = byIp.get(ip);
      if (mapName && !existing.dudeMaps.includes(mapName)) existing.dudeMaps.push(mapName);
      if (existing.name === ip && row.Name && row.Name.trim() !== ip) existing.name = row.Name.trim();
      continue;
    }
    const name = row.Name && row.Name.trim() && row.Name.trim() !== ip ? row.Name.trim() : ip;
    const mac = String(row.MAC || '').split(',').map((value) => value.trim()).filter(Boolean)[0] || '';
    const node = { id: `dude-${ip.replace(/[^a-z0-9]/gi, '-')}`, name, type: mapDudeDeviceType(row.Type), ip, port: 161, snmpVersion: '2c', community: 'public', x: 50, y: 50, mac, dudeMaps: mapName ? [mapName] : [] };
    byIp.set(ip, node);
    order.push(ip);
  }
  return order.map((ip) => byIp.get(ip));
}

// Dude's "Links" export lists one endpoint per row with no link id; each map's simple/SNMP-discovered
// links are always 2-ended, so consecutive rows sharing a Map are paired in file order.
function parseDudeLinks(linksCsv, importedNodes) {
  if (!String(linksCsv || '').trim()) return [];
  const byKey = new Map();
  importedNodes.forEach((node) => { byKey.set(node.name, node.id); byKey.set(node.ip, node.id); });
  const groups = new Map();
  for (const row of parseCsvTable(linksCsv)) {
    const mapName = String(row.Map || '').trim() || '__default__';
    if (!groups.has(mapName)) groups.set(mapName, []);
    groups.get(mapName).push(String(row.Device || '').trim());
  }
  const links = [];
  let linkIndex = 0;
  for (const deviceKeys of groups.values()) {
    for (let i = 0; i + 1 < deviceKeys.length; i += 2) {
      const sourceId = byKey.get(deviceKeys[i]);
      const targetId = byKey.get(deviceKeys[i + 1]);
      if (!sourceId || !targetId || sourceId === targetId) continue;
      linkIndex += 1;
      links.push({ id: `dude-link-${Date.now()}-${linkIndex}`, sourceId, targetId, interfaceIndex: 1, interfaceIp: '' });
    }
  }
  return links;
}

function parseDudeExport(devicesCsv, linksCsv) {
  const nodes = parseDudeDevices(devicesCsv);
  if (!nodes.length) return { nodes: [], links: [] };
  return { nodes, links: parseDudeLinks(linksCsv, nodes) };
}

function spreadWindNodes(importedNodes, existingNodes) {
  const occupied = existingNodes.map((node) => ({ x: Number(node.x || 50), y: Number(node.y || 50) }));
  return importedNodes.map((node) => {
    let x = node.x;
    let y = node.y;
    let attempt = 0;
    while (occupied.some((position) => Math.abs(position.x - x) < 7 && Math.abs(position.y - y) < 7) && attempt < 40) {
      const angle = attempt * 0.9;
      const radius = 8 + Math.floor(attempt / 8) * 5;
      x = Math.min(94, Math.max(6, node.x + Math.cos(angle) * radius));
      y = Math.min(91, Math.max(6, node.y + Math.sin(angle) * radius));
      attempt += 1;
    }
    occupied.push({ x, y });
    return { ...node, x, y };
  });
}

function getWindXmlUrl(domain) {
  const input = /^https?:\/\//i.test(domain) ? domain : `https://${domain}`;
  const baseUrl = new URL(input);
  if (!baseUrl.hostname || baseUrl.username || baseUrl.password) throw new Error('Enter a valid Wind domain.');
  baseUrl.search = '?page=gmap&subpage=xml&show_p2p=1&show_aps=1&show_clients=1&show_unlinked=1&show_links_p2p=1&show_links_client=1&show_links_vpn=1';
  baseUrl.hash = '';
  return baseUrl;
}

async function importWindNodes(domain) {
  const xmlUrl = getWindXmlUrl(domain);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const result = await fetch(xmlUrl, { headers: { Accept: 'application/xml, text/xml' }, signal: controller.signal });
    if (!result.ok) throw new Error(`Wind returned HTTP ${result.status}.`);
    const xml = await result.text();
    if (!/<wind\b/i.test(xml) || !/<nodes\b/i.test(xml)) throw new Error('The Wind domain did not return a node map.');
    return parseWindNodes(xml, xmlUrl);
  } finally {
    clearTimeout(timeout);
  }
}

const server = http.createServer(async (request, response) => {
  if (request.method === 'OPTIONS') return send(response, 204, {});
  if (request.method === 'GET' && request.url === '/api/nodes') return send(response, 200, await getMetrics());
  if (request.method === 'GET' && request.url?.startsWith('/api/nodes/') && request.url.endsWith('/interfaces')) {
    const id = request.url.split('/')[3];
    const node = nodes.find((item) => item.id === id);
    return send(response, node ? 200 : 404, node ? await getInterfaces(node) : { error: 'Node not found.' });
  }
  if (request.method === 'GET' && request.url?.startsWith('/api/nodes/') && request.url.endsWith('/wireless-clients/status')) {
    const id = request.url.split('/')[3];
    return send(response, 200, wirelessClientStatus.get(id) || { stage: 'idle', detail: '' });
  }
  if (request.method === 'GET' && request.url?.startsWith('/api/nodes/') && request.url.endsWith('/wireless-clients')) {
    const id = request.url.split('/')[3];
    const node = nodes.find((item) => item.id === id);
    if (!node) return send(response, 404, { error: 'Node not found.' });
    try {
      const clients = await getWirelessClients(node);
      return send(response, 200, { clients, warning: clients.warning || '' });
    } catch (error) {
      return send(response, 502, { error: error.message || 'Could not read the wireless registration table.' });
    } finally {
      wirelessClientStatus.delete(id);
    }
  }
  if (request.method === 'POST' && request.url === '/api/discover-neighbors') {
    let body = '';
    for await (const chunk of request) body += chunk;
    let protocol = 'ws-discovery';
    try { protocol = JSON.parse(body || '{}').protocol || 'ws-discovery'; } catch { return send(response, 400, { error: 'Invalid discovery request.' }); }
    if (!['all', 'ws-discovery'].includes(protocol)) return send(response, 400, { error: 'Local discovery only supports WS-Discovery.' });
    try {
      return send(response, 200, { sourceId: null, sourceName: 'this PC', protocol, candidates: await discoverWsDiscoveryNeighbors() });
    } catch (error) {
      return send(response, 502, { error: error.message || 'Local neighbor discovery failed.' });
    }
  }
  if (request.method === 'POST' && request.url?.startsWith('/api/nodes/') && request.url.endsWith('/discover-neighbors')) {
    const id = request.url.split('/')[3];
    const node = nodes.find((item) => item.id === id);
    if (!node) return send(response, 404, { error: 'Node not found.' });
    let body = '';
    for await (const chunk of request) body += chunk;
    let protocol = 'all';
    try { protocol = JSON.parse(body || '{}').protocol || 'all'; } catch { return send(response, 400, { error: 'Invalid discovery request.' }); }
    try {
      return send(response, 200, { sourceId: node.id, protocol, candidates: await discoverNeighbors(node, protocol) });
    } catch (error) {
      return send(response, 502, { error: error.message || 'Neighbor discovery failed.' });
    }
  }
  if (request.method === 'GET' && request.url === '/api/links') return send(response, 200, await Promise.all(links.map(pollLink)));
  if (request.method === 'GET' && request.url === '/api/workspace') return send(response, 200, getWorkspaceResponse());
  if (request.method === 'PUT' && request.url === '/api/workspace') {
    let body = '';
    for await (const chunk of request) body += chunk;
    const { name } = JSON.parse(body || '{}');
    if (typeof name !== 'string' || !name.trim()) return send(response, 400, { error: 'A workspace name is required.' });
    workspace = { ...workspace, name: name.trim() };
    await saveWorkspace();
    return send(response, 200, getWorkspaceResponse());
  }
  if (request.method === 'GET' && request.url === '/api/workspace/export') {
    return send(response, 200, { workspace, nodes, links });
  }
  if (request.method === 'POST' && request.url === '/api/integrations/wind/import') {
    let body = '';
    for await (const chunk of request) body += chunk;
    let domain;
    try { domain = JSON.parse(body || '{}').domain?.trim(); } catch { return send(response, 400, { error: 'Invalid Wind import request.' }); }
    if (!domain) return send(response, 400, { error: 'A Wind domain is required.' });
    try {
      const imported = await importWindNodes(domain);
      if (!imported.nodes.length) return send(response, 422, { error: 'No public nodes were found at that Wind domain.' });
      const existingIds = new Set(nodes.map((node) => node.id));
      const newNodes = spreadWindNodes(imported.nodes.filter((node) => !existingIds.has(node.id)), nodes);
      nodes.push(...newNodes);
      const existingLinkIds = new Set(links.map((link) => link.id));
      const newLinks = imported.links.filter((link) => !existingLinkIds.has(link.id) && nodes.some((node) => node.id === link.sourceId) && nodes.some((node) => node.id === link.targetId));
      links.push(...newLinks);
      snapshots = new Map();
      await Promise.all([saveNodes(), saveLinks()]);
      const newNodeIds = new Set(newNodes.map((node) => node.id));
      const monitoredNewNodes = (await getMetrics()).filter((node) => newNodeIds.has(node.id));
      return send(response, 200, { imported: newNodes.length, skipped: imported.nodes.length - newNodes.length, linked: newLinks.length, newNodes: monitoredNewNodes, newLinks: await Promise.all(newLinks.map(pollLink)) });
    } catch (error) {
      return send(response, 502, { error: error.name === 'AbortError' ? 'Wind request timed out.' : error.message || 'Wind import failed.' });
    }
  }
  if (request.method === 'POST' && request.url === '/api/integrations/dude/import') {
    let body = '';
    for await (const chunk of request) body += chunk;
    let payload;
    try { payload = JSON.parse(body || '{}'); } catch { return send(response, 400, { error: 'Invalid Dude import request.' }); }
    const devicesCsv = typeof payload.devicesCsv === 'string' ? payload.devicesCsv : '';
    const linksCsv = typeof payload.linksCsv === 'string' ? payload.linksCsv : '';
    if (!devicesCsv.trim()) return send(response, 400, { error: 'A Dude devices export (CSV) is required.' });
    try {
      const imported = parseDudeExport(devicesCsv, linksCsv);
      if (!imported.nodes.length) return send(response, 422, { error: 'No devices with an IP address were found in that Dude export.' });
      const existingIds = new Set(nodes.map((node) => node.id));
      const newNodes = spreadWindNodes(imported.nodes.filter((node) => !existingIds.has(node.id)), nodes);
      nodes.push(...newNodes);
      // Dude has no stable link id, so dedupe by endpoint pair (either direction) instead of by id.
      const existingLinkPairs = new Set(links.map((link) => [link.sourceId, link.targetId].sort().join('::')));
      const newLinks = imported.links.filter((link) => {
        const pairKey = [link.sourceId, link.targetId].sort().join('::');
        if (existingLinkPairs.has(pairKey)) return false;
        existingLinkPairs.add(pairKey);
        return nodes.some((node) => node.id === link.sourceId) && nodes.some((node) => node.id === link.targetId);
      });
      links.push(...newLinks);
      snapshots = new Map();
      await Promise.all([saveNodes(), saveLinks()]);
      const newNodeIds = new Set(newNodes.map((node) => node.id));
      const monitoredNewNodes = (await getMetrics()).filter((node) => newNodeIds.has(node.id));
      return send(response, 200, { imported: newNodes.length, skipped: imported.nodes.length - newNodes.length, linked: newLinks.length, newNodes: monitoredNewNodes, newLinks: await Promise.all(newLinks.map(pollLink)) });
    } catch (error) {
      return send(response, 502, { error: error.message || 'Dude import failed.' });
    }
  }
  if (request.method === 'POST' && request.url === '/api/workspace/import') {
    let body = '';
    for await (const chunk of request) body += chunk;
    let payload;
    try {
      payload = JSON.parse(body || '{}');
    } catch {
      return send(response, 400, { error: 'Invalid workspace file.' });
    }
    const importedNodes = Array.isArray(payload.nodes) ? payload.nodes : null;
    const importedLinks = Array.isArray(payload.links) ? payload.links : null;
    const importedName = typeof payload.workspace?.name === 'string' ? payload.workspace.name.trim() : '';
    if (!importedNodes || !importedLinks || !importedName) return send(response, 400, { error: 'Workspace file must include a name, nodes, and links.' });
    if (!importedNodes.every((node) => node && typeof node.id === 'string' && typeof node.name === 'string' && typeof node.ip === 'string')) return send(response, 400, { error: 'Every node needs an id, name, and ip.' });
    nodes = importedNodes;
    links = importedLinks;
    workspace = { ...workspace, name: importedName };
    snapshots = new Map();
    await Promise.all([saveNodes(), saveLinks(), saveWorkspace()]);
    return send(response, 200, { workspace: getWorkspaceResponse(), nodes: await getMetrics(), links: await Promise.all(links.map(pollLink)) });
  }
  if (request.method === 'POST' && request.url?.startsWith('/api/nodes/') && request.url.endsWith('/ping')) {
    const id = request.url.split('/')[3];
    const node = nodes.find((item) => item.id === id);
    if (!node) return send(response, 404, { error: 'Node not found.' });
    return send(response, 200, await checkPing(node.ip));
  }
  if (request.method === 'POST' && request.url === '/api/tools/ping') {
    let body = '';
    for await (const chunk of request) body += chunk;
    let payload;
    try { payload = JSON.parse(body || '{}'); } catch { return send(response, 400, { error: 'Invalid ping request.' }); }
    const target = String(payload.target || '').trim();
    if (!target) return send(response, 400, { error: 'A target address or hostname is required.' });
    return send(response, 200, { target, ...(await checkPing(target)) });
  }
  if (request.method === 'POST' && request.url === '/api/tools/traceroute/start') {
    let body = '';
    for await (const chunk of request) body += chunk;
    let payload;
    try { payload = JSON.parse(body || '{}'); } catch { return send(response, 400, { error: 'Invalid traceroute request.' }); }
    const target = String(payload.target || '').trim();
    if (!target) return send(response, 400, { error: 'A target address or hostname is required.' });
    return send(response, 200, { id: startTracerouteSession(target, payload) });
  }
  if (request.method === 'GET' && request.url?.startsWith('/api/tools/traceroute/')) {
    const id = request.url.split('/')[4];
    const session = tracerouteSessions.get(id);
    if (!session) return send(response, 404, { error: 'Traceroute session not found.' });
    return send(response, 200, { hops: session.hops, done: session.done, error: session.error });
  }
  if (request.method === 'POST' && request.url?.startsWith('/api/tools/traceroute/') && request.url.endsWith('/stop')) {
    const id = request.url.split('/')[4];
    stopTracerouteSession(id);
    return send(response, 200, {});
  }
  if (request.method === 'GET' && request.url?.startsWith('/api/nodes/') && request.url.endsWith('/torch-interfaces')) {
    const id = request.url.split('/')[3];
    const node = nodes.find((item) => item.id === id);
    if (!node) return send(response, 404, { error: 'Node not found.' });
    return send(response, 200, await getTorchInterfaces(node));
  }
  if (request.method === 'POST' && request.url?.startsWith('/api/nodes/') && request.url.endsWith('/torch/start')) {
    const id = request.url.split('/')[3];
    const node = nodes.find((item) => item.id === id);
    if (!node) return send(response, 404, { error: 'Node not found.' });
    if (node.platform !== 'mikrotik') return send(response, 400, { error: 'Torch is only supported for MikroTik devices.' });
    if (!node.apiUsername) return send(response, 400, { error: 'Set the API username/password on this device to use Torch.' });
    let body = '';
    for await (const chunk of request) body += chunk;
    let iface = '';
    try { iface = String(JSON.parse(body || '{}').interface || ''); } catch { return send(response, 400, { error: 'Invalid Torch request.' }); }
    if (!iface) return send(response, 400, { error: 'An interface is required.' });
    startMikrotikTorch(node, iface);
    return send(response, 200, {});
  }
  if (request.method === 'POST' && request.url?.startsWith('/api/nodes/') && request.url.endsWith('/torch/stop')) {
    const id = request.url.split('/')[3];
    stopMikrotikTorch(id);
    return send(response, 200, {});
  }
  if (request.method === 'GET' && request.url?.startsWith('/api/nodes/') && request.url.endsWith('/torch')) {
    const id = request.url.split('/')[3];
    return send(response, 200, readMikrotikTorch(id));
  }
  if (request.method === 'POST' && request.url?.startsWith('/api/nodes/') && request.url.endsWith('/duplicate')) {
    const id = request.url.split('/')[3];
    const source = nodes.find((item) => item.id === id);
    if (!source) return send(response, 404, { error: 'Node not found.' });
    const copy = { ...source, id: `${source.id}-copy-${Date.now()}`, name: `${source.name} copy`, x: Math.min(94, (source.x || 50) + 4), y: Math.min(91, (source.y || 50) + 4) };
    nodes.push(copy);
    await saveNodes();
    return send(response, 201, getNodeResponse(copy));
  }
  if (request.method === 'POST' && request.url === '/api/links') {
    let body = '';
    for await (const chunk of request) body += chunk;
    const link = JSON.parse(body || '{}');
    if (!nodes.some((node) => node.id === link.sourceId) || !nodes.some((node) => node.id === link.targetId) || !Number.isInteger(Number(link.interfaceIndex)) || Number(link.interfaceIndex) < 1) return send(response, 400, { error: 'Valid source, target, and interface index are required.' });
    const savedLink = { id: `link-${Date.now()}`, sourceId: link.sourceId, targetId: link.targetId, interfaceIndex: Number(link.interfaceIndex), interfaceIp: link.interfaceIp || '' };
    links.push(savedLink);
    await saveLinks();
    return send(response, 201, savedLink);
  }
  if (request.method === 'PUT' && request.url?.startsWith('/api/links/')) {
    const id = request.url.split('/').pop();
    let body = '';
    for await (const chunk of request) body += chunk;
    const { sourceId, targetId, interfaceIndex, interfaceIp } = JSON.parse(body || '{}');
    const link = links.find((item) => item.id === id);
    if (!link || !nodes.some((node) => node.id === sourceId) || !nodes.some((node) => node.id === targetId) || !Number.isInteger(Number(interfaceIndex)) || Number(interfaceIndex) < 1) return send(response, 400, { error: 'Valid source, target, and interface index are required.' });
    Object.assign(link, { sourceId, targetId, interfaceIndex: Number(interfaceIndex), interfaceIp: interfaceIp || '' });
    snapshots.delete(`link:${id}`);
    await saveLinks();
    return send(response, 200, link);
  }
  if (request.method === 'POST' && request.url === '/api/nodes') {
    let body = '';
    for await (const chunk of request) body += chunk;
    const node = normalizeSnmpNodeConfig(JSON.parse(body || '{}'));
    if (!node.id || !node.name || !node.type || !node.ip) return send(response, 400, { error: 'id, name, type, and ip are required.' });
    const snmpError = validateSnmpNodeConfig(node);
    if (snmpError) return send(response, 400, { error: snmpError });
    if (nodes.some((item) => item.id === node.id)) return send(response, 409, { error: 'Node already exists.' });
    nodes.push(node);
    await saveNodes();
    return send(response, 201, getNodeResponse(node));
  }
  if (request.method === 'PUT' && request.url?.startsWith('/api/nodes/')) {
    const id = request.url.split('/').pop();
    let body = '';
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body || '{}');
    const { name, ip, type, platform, port, guiPort, x, y } = payload;
    let node = nodes.find((item) => item.id === id);
    const hasPosition = Number.isFinite(Number(x)) && Number.isFinite(Number(y));
    if (!node && (!name || !ip)) return send(response, 400, { error: 'A node name and non-empty IP address are required.' });
    if (!hasPosition && (typeof name !== 'string' || !name.trim() || typeof ip !== 'string' || !ip.trim())) return send(response, 400, { error: 'A node name and non-empty IP address are required.' });
    if (port !== undefined && (!Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535)) return send(response, 400, { error: 'SNMP port must be between 1 and 65535.' });
    if (guiPort !== undefined && String(guiPort).trim() !== '' && (!Number.isInteger(Number(guiPort)) || Number(guiPort) < 1 || Number(guiPort) > 65535)) return send(response, 400, { error: 'GUI port must be between 1 and 65535.' });
    const nextNode = node ? { ...node } : { id, name: name.trim(), type: type || 'device', ip: ip.trim(), port: Number(port || 161) };
    if (name) nextNode.name = name.trim();
    if (ip) nextNode.ip = ip.trim();
    if (typeof type === 'string' && ['router', 'gateway', 'server', 'camera', 'device'].includes(type)) nextNode.type = type;
    if (typeof platform === 'string' && ['mikrotik', 'openwrt', 'other'].includes(platform)) nextNode.platform = platform;
    if (port !== undefined) nextNode.port = Number(port);
    if (guiPort !== undefined) nextNode.guiPort = String(guiPort).trim() === '' ? undefined : Number(guiPort);
    if (hasOwn(payload, 'guiSsl')) nextNode.guiSsl = Boolean(payload.guiSsl);
    if (payload.apiPort !== undefined) nextNode.apiPort = String(payload.apiPort).trim() === '' ? undefined : Number(payload.apiPort);
    ['snmpVersion', 'community', 'snmpUser', 'securityLevel', 'authProtocol', 'authKey', 'privProtocol', 'privKey', 'context', 'apiUsername', 'apiPassword'].forEach((key) => {
      if (hasOwn(payload, key)) nextNode[key] = payload[key];
    });
    if (hasPosition) {
      nextNode.x = Math.min(94, Math.max(6, Number(x)));
      nextNode.y = Math.min(91, Math.max(6, Number(y)));
    }
    const normalizedNode = normalizeSnmpNodeConfig(nextNode);
    const snmpError = !hasPosition ? validateSnmpNodeConfig(normalizedNode) : '';
    if (snmpError) return send(response, 400, { error: snmpError });
    if (node) {
      Object.assign(node, normalizedNode);
    } else {
      node = normalizedNode;
      nodes.push(node);
    }
    snapshots.delete(id);
    await saveNodes();
    return send(response, 200, getNodeResponse(node));
  }
  if (request.method === 'DELETE' && request.url === '/api/nodes') {
    nodes = [];
    links = [];
    snapshots = new Map();
    await Promise.all([saveNodes(), saveLinks()]);
    return send(response, 204, {});
  }
  if (request.method === 'POST' && request.url === '/api/nodes/delete-bulk') {
    let body = '';
    for await (const chunk of request) body += chunk;
    let ids;
    try { ids = JSON.parse(body || '{}').ids; } catch { return send(response, 400, { error: 'Invalid request.' }); }
    if (!Array.isArray(ids)) return send(response, 400, { error: 'ids must be an array.' });
    const idSet = new Set(ids);
    const before = nodes.length;
    nodes = nodes.filter((node) => !idSet.has(node.id));
    ids.forEach((id) => snapshots.delete(id));
    await saveNodes();
    return send(response, 200, { deleted: before - nodes.length });
  }
  if (request.method === 'DELETE' && request.url?.startsWith('/api/nodes/')) {
    const id = request.url.split('/').pop();
    const nodeIndex = nodes.findIndex((node) => node.id === id);
    if (nodeIndex === -1) return send(response, 404, { error: 'Node not found.' });
    nodes.splice(nodeIndex, 1);
    snapshots.delete(id);
    await saveNodes();
    return send(response, 204, {});
  }
  send(response, 404, { error: 'Not found' });
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Another instance of the monitor may already be running.`);
  } else {
    console.error('SNMP monitor API failed to start:', error);
  }
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(PORT, () => { console.log(`SNMP monitor API listening on http://127.0.0.1:${PORT}`); resolve(); });
});
