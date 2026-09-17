import './style.css';
import licenseText from '../LICENSE?raw';
import changelogText from '../CHANGELOG.md?raw';
import { version as appVersion } from '../package.json';
import { checkForRelease } from './releases.js';

let availableRelease = null;

function renderReleaseIndicator() {
  return availableRelease ? `<a class="release-indicator" href="${escapeHtml(availableRelease.url)}" target="_blank" rel="noopener noreferrer" title="Open GitHub to download the latest version">Update available: v${availableRelease.version} ↗</a>` : '';
}

async function refreshReleaseIndicator() {
  availableRelease = await checkForRelease(appVersion);
  const slot = document.querySelector('#release-indicator-slot');
  if (slot) slot.innerHTML = renderReleaseIndicator();
}

const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
let themePreference = 'system';
try {
  const savedTheme = localStorage.getItem('nodeatlas-theme');
  if (['light', 'dark', 'system'].includes(savedTheme)) themePreference = savedTheme;
} catch { /* Keep system appearance when storage is unavailable. */ }
function applyTheme() {
  const theme = themePreference === 'system' ? (systemTheme.matches ? 'dark' : 'light') : themePreference;
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}
applyTheme();
systemTheme.addEventListener('change', applyTheme);

// In the packaged desktop app the backend runs on its own port (see electron/main.js);
// the web app keeps hitting same-origin/proxied "/api" paths as before.
const apiPort = new URLSearchParams(window.location.search).get('apiPort');
if (apiPort) {
  const apiBase = `http://127.0.0.1:${apiPort}`;
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init) => (typeof input === 'string' && input.startsWith('/api') ? nativeFetch(apiBase + input, init) : nativeFetch(input, init));
}

const nodeTypes = {
  router: { icon: '◆', label: 'Router', className: 'router' },
  gateway: { icon: '↗', label: 'Gateway', className: 'gateway' },
  server: { icon: '▣', label: 'Server', className: 'server' },
  camera: { icon: '◉', label: 'Camera', className: 'camera' },
  device: { icon: '◇', label: 'Device', className: 'device' },
};
const defaultSnmpSettings = { snmpVersion: '2c', community: 'public', securityLevel: 'authPriv', authProtocol: 'sha', privProtocol: 'aes', guiSsl: true };
const snmpVersionOptions = [{ value: '2c', label: 'SNMP v2c' }, { value: '3', label: 'SNMP v3' }];
const snmpSecurityLevelOptions = [{ value: 'authPriv', label: 'Auth + encryption' }, { value: 'authNoPriv', label: 'Auth only' }, { value: 'noAuthNoPriv', label: 'No auth / no encryption' }];
const snmpAuthProtocolOptions = [{ value: 'sha', label: 'SHA' }, { value: 'sha224', label: 'SHA-224' }, { value: 'sha256', label: 'SHA-256' }, { value: 'sha384', label: 'SHA-384' }, { value: 'sha512', label: 'SHA-512' }, { value: 'md5', label: 'MD5' }];
const snmpPrivProtocolOptions = [{ value: 'aes', label: 'AES' }, { value: 'aes256b', label: 'AES-256' }, { value: 'aes256r', label: 'AES-256 Reeder' }, { value: 'des', label: 'DES' }];

const demoNodes = [
  { id: 'mikrotik', name: 'MikroTik Router', type: 'router', x: 50, y: 20, status: 'healthy', ip: '192.168.88.1', uptime: '99.99%', rx: 12.4, tx: 8.1 },
  { id: 'accesspoint', name: 'OpenWRT Access Point', type: 'router', x: 28, y: 68, status: 'healthy', ip: '192.168.1.1', uptime: '99.95%', rx: 6.2, tx: 3.4 },
  { id: 'dvr', name: 'DVR', type: 'camera', x: 72, y: 68, status: 'healthy', ip: '192.168.1.10', uptime: '99.90%', rx: 2.1, tx: 0.6 },
];

let nodes = [];
let links = [];
let selectedId = '';
let selectedNodeIds = new Set();
let licenseOpen = false;
let licenseTab = 'license';
let dragging = null;
let panning = null;
let selecting = null;
let settingsFeedback = '';
let actionsMenuOpen = false;
let editingSettings = false;
let settingsDraft = null;
let visiblePasswordFields = new Set();
let linking = null;
let selectedLinkId = '';
let contextMenu = null;
let wirelessClients = null;
let pingFeedback = '';
let refreshInFlight = false;
let interfaceOptions = [];
let interfaceRequestId = 0;
let editingLink = false;
let workspaceName = 'myWorkspace';
let workspaceMenuOpen = false;
let windImportOpen = false;
let windImportDomain = 'www.wna.gr/wind';
let dudeImportOpen = false;
let dudeImportFiles = { devices: null, links: null };
let editingWorkspaceName = false;
let workspaceFeedback = '';
let workspaces = [{ id: 'workspace-default', name: 'myWorkspace', nodes: [], links: [], source: 'server' }];
let activeWorkspaceId = 'workspace-default';
let zoom = 1;
let sidebarWidth = 224;
let inspectorWidth = 310;
let inspectorCollapsed = false;
let resizingPanel = null;
let resizingCanvas = null;
let discovery = null;
let startupState = 'checking';
let activeView = 'topology';
let traceroute = null;
let traceroutePollTimer = null;
let torch = null;
let torchPollTimer = null;
let quickPing = null;
let taskProgress = null;
const API_URL = '/api/nodes';
const electronIpcRenderer = getElectronIpcRenderer();
let notificationBaselineReady = false;
let notificationPermissionRequest = null;

const app = document.querySelector('#app');

document.addEventListener('contextmenu', (event) => event.preventDefault());

function statusLabel(status, pingReachable = false) {
  if (status === 'offline' && pingReachable) return 'Online (ping)';
  return status === 'healthy' ? 'Online' : status === 'warning' ? 'Degraded' : 'Offline';
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function normalizeSnmpVersion(version) {
  return ['3', 'v3', 'snmpv3'].includes(String(version || '').trim().toLowerCase()) ? '3' : '2c';
}

function renderSelectOptions(options, selectedValue) {
  return options.map((option) => `<option value="${escapeHtml(option.value)}" ${option.value === selectedValue ? 'selected' : ''}>${escapeHtml(option.label)}</option>`).join('');
}

function renderPasswordField(name, label, value, ariaLabel) {
  const visible = visiblePasswordFields.has(name);
  return `<label><span>${label}</span><div class="password-field"><input name="${name}" type="${visible ? 'text' : 'password'}" value="${escapeHtml(value)}" aria-label="${ariaLabel}" autocomplete="new-password" /><button type="button" class="password-toggle" data-field="${name}" title="${visible ? 'Hide password' : 'Show password'}" aria-label="${visible ? 'Hide password' : 'Show password'}" aria-pressed="${visible}">${visible ? '🙈' : '👁'}</button></div></label>`;
}

function getNodeSavePayload(node) {
  const keys = ['id', 'name', 'type', 'platform', 'ip', 'port', 'guiPort', 'guiSsl', 'x', 'y', 'snmpVersion', 'community', 'snmpUser', 'securityLevel', 'authProtocol', 'authKey', 'privProtocol', 'privKey', 'context', 'apiUsername', 'apiPassword', 'apiPort'];
  return Object.fromEntries(keys.filter((key) => node[key] !== undefined).map((key) => [key, node[key]]));
}

function hasEditableFocus(selector) {
  const active = document.activeElement;
  return !!active?.matches?.('input, select, textarea, [contenteditable="true"]') && !!active.closest(selector);
}

function isEditingLocked() {
  return windImportOpen || dudeImportOpen || editingSettings || editingLink || linking?.step === 'source' || selectedLinkId || editingWorkspaceName || torch || traceroute || quickPing || hasEditableFocus('#device-form, #link-form, #edit-link-form, #workspace-rename-form');
}

function getElectronIpcRenderer() {
  try {
    return window.require?.('electron')?.ipcRenderer || null;
  } catch {
    return null;
  }
}

async function ensureDesktopNotificationPermission() {
  if (electronIpcRenderer) return 'granted';
  if (!('Notification' in window)) return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission;
  if (!notificationPermissionRequest) {
    notificationPermissionRequest = Notification.requestPermission().finally(() => {
      notificationPermissionRequest = null;
    });
  }
  return notificationPermissionRequest;
}

async function showDeviceDownNotification(node) {
  const name = typeof node.name === 'string' && node.name.trim() ? node.name.trim() : 'Device';
  const ip = typeof node.ip === 'string' && node.ip.trim() ? node.ip.trim() : '';
  const payload = { id: node.id, name, ip };

  if (electronIpcRenderer) {
    try {
      if (await electronIpcRenderer.invoke('nodeatlas:device-down-notification', payload)) return;
    } catch {
      // Fall through to the browser notification API when the Electron bridge is unavailable.
    }
  }

  if (!('Notification' in window)) return;
  const permission = await ensureDesktopNotificationPermission();
  if (permission !== 'granted') return;

  const notification = new Notification(`${name} is offline`, {
    body: ip ? `${ip} stopped responding to SNMP.` : 'The device stopped responding to SNMP.',
    tag: `nodeatlas:${node.id}:down`,
    renotify: true,
  });
  notification.onclick = () => window.focus();
}

function notifyDevicesThatWentDown(previousStatusById, metrics) {
  if (!notificationBaselineReady) return;

  metrics
    .filter((metric) => metric.status === 'offline' && previousStatusById.get(metric.id) && previousStatusById.get(metric.id) !== 'offline')
    .forEach((metric) => {
      showDeviceDownNotification(metric).catch(() => {});
    });
}

function renderNotReadyView(view) {
  const title = view === 'events' ? 'Events' : 'Reports';
  const description = view === 'events'
    ? 'Device history and alert timelines will appear here.'
    : 'Uptime, traffic, and exportable network reports will appear here.';
  return `<div class="feature-landing"><div class="feature-landing-mark">${view === 'events' ? '◴' : '▥'}</div><p class="section-label">WORKSPACE / ${title.toUpperCase()}</p><h1>${title} are on the way</h1><p>${description}</p><span class="feature-landing-status">NOT READY YET</span><button class="primary-btn" id="return-to-topology">← <span>Back to topology</span></button></div>`;
}

function render() {
  const previousWrap = document.querySelector('#canvas-wrap');
  const scrollLeft = previousWrap?.scrollLeft || 0;
  const scrollTop = previousWrap?.scrollTop || 0;
  // Tool dialogs (Traceroute, Ping, Torch) poll and re-render every few hundred ms while open;
  // without this, retyping the innerHTML would blow away whatever the user is mid-typing.
  const activeField = document.activeElement;
  const preservedField = activeField?.matches?.('input, select, textarea') && activeField.closest('.tool-dialog-controls')
    ? { formId: activeField.closest('form')?.id, name: activeField.name, value: activeField.value, checked: activeField.checked, selectionStart: activeField.selectionStart, selectionEnd: activeField.selectionEnd }
    : null;
  const selected = nodes.find((node) => node.id === selectedId) || nodes[0] || null;
  if (selected && !nodeTypes[selected.type]) selected.type = 'device';
  const formValues = selected && settingsDraft?.id === selected.id ? settingsDraft : selected;
  const inspectorOpen = selected && !inspectorCollapsed;
  app.innerHTML = `
    <header class="topbar">
      <a class="brand" href="https://wna.gr/nodesatlas" target="_blank" rel="noreferrer"><span class="brand-mark">N</span><span>Nodes<span>Atlas</span></span></a>
      ${renderSiteSwitcher()}
      <span id="release-indicator-slot" role="status">${renderReleaseIndicator()}</span>
      <div class="top-actions"><label class="theme-control">Theme <select id="theme-select" aria-label="Color theme">${['system', 'light', 'dark'].map((theme) => `<option value="${theme}" ${themePreference === theme ? 'selected' : ''}>${theme[0].toUpperCase() + theme.slice(1)}</option>`).join('')}</select></label><span class="live"><i></i> LIVE</span><button class="icon-button" title="Notifications">♧<b>2</b></button><button class="avatar" title="Account">SA</button></div>
    </header>
    <main class="workspace" style="grid-template-columns:${sidebarWidth}px 6px minmax(400px,1fr) ${inspectorOpen ? `6px ${inspectorWidth}px` : '0px'}">
      <aside class="sidebar">
        <div class="nav-section"><span class="section-label">WORKSPACE</span><button class="nav-item ${activeView === 'topology' ? 'active' : ''}" data-view="topology">⌘ <span>Topology</span></button><button class="nav-item ${activeView === 'events' ? 'active' : ''}" data-view="events">◴ <span>Events</span><em>12</em></button><button class="nav-item ${activeView === 'reports' ? 'active' : ''}" data-view="reports">▥ <span>Reports</span></button></div>
        <div class="nav-section palette"><span class="section-label">ADD TO MAP</span>${Object.entries(nodeTypes).map(([key, item]) => `<button class="tool" draggable="true" data-type="${key}"><span class="tool-icon ${item.className}">${item.icon}</span>${item.label}<small>Drag</small></button>`).join('')}</div>
        <div class="sidebar-footer"><span>MONITORED HOSTS</span><strong>${nodes.length}</strong><div class="health-bar"><i></i><i></i><i></i><i class="down"></i></div><small>5 online · 1 degraded · 2 offline</small></div>
      </aside>
      <div class="resize-handle" id="sidebar-handle"></div>
      <section class="content">
        ${activeView === 'topology' ? `${renderWorkspaceTabs()}
          <div class="canvas-toolbar"><div><h1>Site topology</h1><p>Live infrastructure overview <span>Updated just now</span></p></div><div class="toolbar-actions">${selectedNodeIds.size ? `<button class="outline-btn delete-selection" id="delete-selection">× <span>Delete ${selectedNodeIds.size} device${selectedNodeIds.size === 1 ? '' : 's'}</span></button>` : ''}${selected && inspectorCollapsed ? '<button class="outline-btn" id="show-inspector" title="Show device details">▤</button>' : ''}<button class="outline-btn" id="fit-map">⊙</button><button class="outline-btn" id="discover-toolbar" title="Discover CDP, LLDP, or MNDP neighbors">⌕ <span>Discover</span></button><button class="outline-btn" id="ping-toolbar" title="Ping any address">⌁ <span>Ping</span></button><button class="outline-btn" id="traceroute-toolbar" title="Traceroute to any address">⇥ <span>Traceroute</span></button><button class="outline-btn ${linking ? 'selected-tool' : ''}" id="connect-mode">⌁ <span>${linking ? 'Select target' : 'Connect'}</span></button><button class="primary-btn" id="add-device">＋ <span>Device</span></button></div></div>
          <div class="canvas-wrap" id="canvas-wrap"><div class="canvas" id="canvas" style="width:${zoom * 100}%;height:${zoom * 100}%"><svg class="links" id="links" aria-label="Network links"></svg><div class="selection-marquee" id="selection-marquee" aria-hidden="true"></div>${renderCanvasContents()}</div></div>` : renderNotReadyView(activeView)}
      </section>
      ${activeView === 'topology' && inspectorOpen ? '<div class="resize-handle" id="inspector-handle"></div>' : ''}
      ${activeView === 'topology' && inspectorOpen ? `<aside class="inspector">
        <div class="inspector-heading"><span>DEVICE DETAILS</span><button class="close-inspector" title="Close inspector">×</button></div>
        <div class="device-hero"><div class="large-icon ${nodeTypes[selected.type].className}">${nodeTypes[selected.type].icon}</div><div><h2>${selected.name}</h2><p><span class="status-dot ${selected.pingReachable ? 'healthy' : selected.status}"></span>${statusLabel(selected.status, selected.pingReachable)}</p></div><div class="device-actions"><button class="more" id="device-actions" title="More device actions" aria-expanded="${actionsMenuOpen}">•••</button>${actionsMenuOpen ? '<button class="delete-device" id="delete-device">Delete device</button>' : ''}</div></div>
        <div class="snmp-identity"><span>SNMP SYSTEM NAME</span><strong>${selected.systemName || '--'}</strong>${selected.platformVersion ? `<small>${selected.platformVersion}</small>` : ''}</div>
        ${renderDeviceForm(formValues)}
        <div class="property-grid"><div><span>UPTIME</span><strong>${selected.uptime || '--'}</strong></div><div><span>LATENCY</span><strong>${selected.status === 'offline' ? '--' : `${selected.latency || 12} ms`}</strong></div><div><span>PACKET LOSS</span><strong>${selected.status === 'offline' ? '--' : selected.status === 'warning' ? '2.8%' : '0.0%'}</strong></div></div>
        <div class="metric"><div><span>CPU UTILIZATION</span><strong>${selected.cpu ?? '--'}${selected.cpu === undefined ? '' : '%'}</strong></div><div class="meter"><i style="width:${selected.cpu ?? 0}%"></i></div></div>
        <div class="metric"><div><span>MEMORY</span><strong>${selected.memory ?? '--'}${selected.memory === undefined ? '' : '%'}</strong></div><div class="meter teal"><i style="width:${selected.memory ?? 0}%"></i></div></div>
        <div class="traffic-title"><span>TRAFFIC</span><button>24H ⌄</button></div><div class="chart"><svg viewBox="0 0 280 100" preserveAspectRatio="none"><path d="M0 83 L12 77 L25 80 L38 58 L52 68 L66 42 L79 54 L93 27 L106 46 L120 39 L134 64 L148 45 L161 57 L175 31 L188 43 L202 25 L216 49 L229 40 L242 62 L255 53 L268 72 L280 58 V100 H0Z"></path><polyline points="0,83 12,77 25,80 38,58 52,68 66,42 79,54 93,27 106,46 120,39 134,64 148,45 161,57 175,31 188,43 202,25 216,49 229,40 242,62 255,53 268,72 280,58"></polyline></svg><div class="chart-labels"><span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>NOW</span></div></div>
        <button class="event-button">View device events <span>→</span></button>
      </aside>` : ''}
      ${linking?.step === 'source' ? renderLinkDialog() : ''}${renderLinkEditor()}${renderContextMenu()}${renderDiscoveryDialog()}${renderWirelessClientsDialog()}${renderTracerouteDialog()}${renderTorchDialog()}${renderQuickPingDialog()}${pingFeedback ? `<div class="ping-feedback">${pingFeedback}</div>` : ''}
    </main>
    <button class="copyright-link" id="open-license" title="View license">© 2026, nodesatlas.wna.gr</button>
    ${licenseOpen ? renderLicenseDialog() : ''}${windImportOpen ? renderWindImportDialog() : ''}${dudeImportOpen ? renderDudeImportDialog() : ''}${renderTaskProgress()}`;
  bindEvents();
  if (activeView === 'topology') drawLinks();
  const wrap = document.querySelector('#canvas-wrap');
  if (wrap) { wrap.scrollLeft = scrollLeft; wrap.scrollTop = scrollTop; }
  if (preservedField) {
    const form = preservedField.formId ? document.getElementById(preservedField.formId) : null;
    const field = form?.querySelector(`[name="${preservedField.name}"]`);
    if (field) {
      if (field.type === 'checkbox') field.checked = preservedField.checked;
      else field.value = preservedField.value;
      field.focus();
      if (typeof field.setSelectionRange === 'function' && preservedField.selectionStart != null) {
        try { field.setSelectionRange(preservedField.selectionStart, preservedField.selectionEnd); } catch { /* not a text-selectable input type */ }
      }
    }
  }
}

function renderCanvasContents() {
  const controls = '<div class="canvas-hint">Drag empty space to select <span>|</span> Middle-drag to pan <span>|</span> Press Delete to remove selected devices</div><div class="canvas-resize-handle" id="canvas-resize-handle" title="Resize canvas area"></div>';

  if (startupState !== 'ready') {
    const title = startupState === 'loading-local' ? 'Searching saved workspace...' : 'Checking local workspace...';
    return `<div class="canvas-loader" role="status" aria-live="polite"><span></span><strong>${title}</strong><small>Loading local topology</small></div>`;
  }

  if (!nodes.length) {
    return `<div class="canvas-empty"><strong>No devices saved</strong><small>Local workspace is empty.</small></div>${controls}`;
  }

  return `${nodes.map((node) => renderNode(node)).join('')}${controls}`;
}

function renderLicenseDialog() {
  const title = licenseTab === 'changelog' ? 'Changelog' : 'License';
  const content = licenseTab === 'changelog' ? changelogText : licenseText;
  return `<div class="license-dialog" role="dialog" aria-modal="true" aria-labelledby="license-title"><section data-dialog-key="license"><header><h2 id="license-title">${title}</h2><button id="close-license" title="Close license">×</button></header><div class="license-tabs" role="tablist"><button class="license-tab ${licenseTab === 'license' ? 'active' : ''}" data-license-tab="license" role="tab" aria-selected="${licenseTab === 'license'}">License</button><button class="license-tab ${licenseTab === 'changelog' ? 'active' : ''}" data-license-tab="changelog" role="tab" aria-selected="${licenseTab === 'changelog'}">Changelog</button></div><pre>${escapeHtml(content)}</pre></section></div>`;
}

function renderDeviceForm(formValues) {
  const values = { ...defaultSnmpSettings, ...formValues };
  const deviceType = nodeTypes[values.type] ? values.type : 'device';
  const platform = ['mikrotik', 'openwrt', 'other'].includes(values.platform) ? values.platform : 'other';
  const snmpVersion = normalizeSnmpVersion(values.snmpVersion);
  const securityLevel = snmpSecurityLevelOptions.some((option) => option.value === values.securityLevel) ? values.securityLevel : defaultSnmpSettings.securityLevel;
  const authProtocol = snmpAuthProtocolOptions.some((option) => option.value === values.authProtocol) ? values.authProtocol : defaultSnmpSettings.authProtocol;
  const privProtocol = snmpPrivProtocolOptions.some((option) => option.value === values.privProtocol) ? values.privProtocol : defaultSnmpSettings.privProtocol;
  const passwordFieldNames = ['authKey', 'privKey', ...(platform === 'mikrotik' || platform === 'openwrt' ? ['apiPassword'] : [])];
  return `<form class="device-settings" id="device-form">
    <label><span>DEVICE NAME</span><input name="name" value="${escapeHtml(values.name)}" aria-label="Device name" /></label>
    <label><span>DEVICE TYPE</span><select name="type" aria-label="Device type">${Object.entries(nodeTypes).map(([key, item]) => `<option value="${key}" ${deviceType === key ? 'selected' : ''}>${escapeHtml(item.label)}</option>`).join('')}</select></label>
    <label><span>ROUTER PLATFORM</span><select name="platform" aria-label="Router platform"><option value="other" ${platform === 'other' ? 'selected' : ''}>Other / standard SNMP</option><option value="mikrotik" ${platform === 'mikrotik' ? 'selected' : ''}>MikroTik RouterOS</option><option value="openwrt" ${platform === 'openwrt' ? 'selected' : ''}>OpenWRT</option></select></label>
    <label><span>IP ADDRESS</span><input name="ip" value="${escapeHtml(values.ip)}" aria-label="IP address" spellcheck="false" /></label>
    <label><span>GUI PORT (optional)</span><input name="guiPort" type="number" min="1" max="65535" placeholder="e.g. 8080" value="${escapeHtml(values.guiPort || '')}" aria-label="GUI port" /></label>
    <label class="checkbox-label"><input name="guiSsl" type="checkbox" ${values.guiSsl !== false ? 'checked' : ''} aria-label="Open GUI over HTTPS" /><span>USE SSL (https://)</span></label>
    <label><span>SNMP PORT</span><input name="port" type="number" min="1" max="65535" value="${escapeHtml(values.port || 161)}" aria-label="SNMP port" /></label>
    <label><span>SNMP VERSION</span><select name="snmpVersion" aria-label="SNMP version">${renderSelectOptions(snmpVersionOptions, snmpVersion)}</select></label>
    <label><span>SNMP COMMUNITY</span><input name="community" value="${escapeHtml(values.community)}" aria-label="SNMP community" spellcheck="false" autocomplete="off" /></label>
    <label><span>SNMPV3 USER</span><input name="snmpUser" value="${escapeHtml(values.snmpUser)}" aria-label="SNMPv3 user" spellcheck="false" autocomplete="off" /></label>
    <label><span>SNMPV3 SECURITY</span><select name="securityLevel" aria-label="SNMPv3 security">${renderSelectOptions(snmpSecurityLevelOptions, securityLevel)}</select></label>
    <label><span>AUTH PROTOCOL</span><select name="authProtocol" aria-label="SNMPv3 authentication protocol">${renderSelectOptions(snmpAuthProtocolOptions, authProtocol)}</select></label>
    ${renderPasswordField('authKey', 'AUTH PASSWORD', values.authKey, 'SNMPv3 authentication password')}
    <label><span>ENCRYPTION</span><select name="privProtocol" aria-label="SNMPv3 encryption protocol">${renderSelectOptions(snmpPrivProtocolOptions, privProtocol)}</select></label>
    ${renderPasswordField('privKey', 'ENCRYPTION PASSWORD', values.privKey, 'SNMPv3 encryption password')}
    ${platform === 'mikrotik' || platform === 'openwrt' ? `<label><span>${platform === 'mikrotik' ? 'API USERNAME (wireless clients)' : 'SSH USERNAME (wireless clients)'}</span><input name="apiUsername" value="${escapeHtml(values.apiUsername || '')}" aria-label="${platform === 'mikrotik' ? 'RouterOS API username' : 'OpenWrt SSH username'}" spellcheck="false" autocomplete="off" /></label>
    ${renderPasswordField('apiPassword', platform === 'mikrotik' ? 'API PASSWORD' : 'SSH PASSWORD', values.apiPassword || '', platform === 'mikrotik' ? 'RouterOS API password' : 'OpenWrt SSH password')}
    <label><span>API PORT</span><input name="apiPort" type="number" min="1" max="65535" placeholder="${platform === 'mikrotik' ? '8728' : '80'}" value="${escapeHtml(values.apiPort || '')}" aria-label="${platform === 'mikrotik' ? 'RouterOS API port' : 'OpenWrt ubus port'}" /></label>` : ''}
    <button type="button" class="toggle-all-passwords" id="toggle-all-passwords">${passwordFieldNames.every((name) => visiblePasswordFields.has(name)) ? '🙈 Hide all passwords' : '👁 Show all passwords'}</button>
    <button class="save-settings" type="submit">Save settings</button><p class="settings-feedback ${settingsFeedback.startsWith('Could not') || settingsFeedback.startsWith('SNMPv3') || settingsFeedback.startsWith('SNMP version') ? 'error' : ''}" aria-live="polite">${escapeHtml(settingsFeedback)}</p>
  </form>`;
}

function renderDialogHeader(title, closeTargetId) {
  return `<h2>${title}<button type="button" class="dialog-close-x" data-close-target="${closeTargetId}" aria-label="Close">×</button></h2>`;
}

function renderLinkDialog() {
  return `<div class="link-dialog"><form id="link-form" data-dialog-key="link-create">${renderDialogHeader('Create link', 'cancel-link')}<label>Source node<select name="sourceId" id="link-source">${nodes.map((node) => `<option value="${node.id}" ${node.id === linking.sourceId ? 'selected' : ''}>${node.name}</option>`).join('')}</select></label>${renderInterfaceSelect()}<label>Interface IP address<input name="interfaceIp" placeholder="Optional label" /></label><button class="primary-btn" type="submit">Select target</button><button class="cancel-link" type="button" id="cancel-link">Cancel</button></form></div>`;
}

function renderInterfaceSelect(selectedIndex) {
  if (!interfaceOptions.length) return `<label>SNMP interface index<input name="interfaceIndex" type="number" min="1" value="${escapeHtml(selectedIndex || 1)}" required /></label>`;
  return `<label>SNMP interface<select name="interfaceIndex">${interfaceOptions.map((item) => `<option value="${item.index}" ${Number(selectedIndex) === item.index ? 'selected' : ''}>${item.name} (index ${item.index})</option>`).join('')}</select></label>`;
}

function renderLinkEditor() {
  const link = links.find((item) => item.id === selectedLinkId);
  if (!link) return '';
  return `<div class="link-dialog"><form id="edit-link-form" data-dialog-key="link-edit">${renderDialogHeader('Edit link source', 'cancel-link')}<label>Source node<select name="sourceId" id="link-source">${nodes.map((node) => `<option value="${node.id}" ${node.id === link.sourceId ? 'selected' : ''}>${node.name}</option>`).join('')}</select></label><label>Target node<select name="targetId">${nodes.map((node) => `<option value="${node.id}" ${node.id === link.targetId ? 'selected' : ''}>${node.name}</option>`).join('')}</select></label>${renderInterfaceSelect(link.interfaceIndex)}<label>Interface IP address<input name="interfaceIp" value="${link.interfaceIp || ''}" /></label><button class="primary-btn" type="submit">Save link</button><button class="cancel-link" type="button" id="cancel-link">Cancel</button></form></div>`;
}

async function loadInterfaces(sourceId) {
  const requestId = ++interfaceRequestId;
  const form = document.querySelector('#link-form, #edit-link-form');
  const options = await fetch(`/api/nodes/${sourceId}/interfaces`)
    .then((response) => response.ok ? response.json() : [])
    .catch(() => []);
  // A previous source's response must not replace the current source's list.
  if (requestId !== interfaceRequestId || !form?.isConnected || form.elements.sourceId.value !== sourceId) return;
  interfaceOptions = options;
  const control = form.elements.interfaceIndex;
  const selectedIndex = control.value;
  control.closest('label').outerHTML = renderInterfaceSelect(selectedIndex);
}

function renderContextMenu() {
  if (!contextMenu) return '';
  const wirelessClientsButton = contextMenu.platform === 'mikrotik' || contextMenu.platform === 'openwrt' ? '<button id="wireless-clients-node">📶 <span>Wireless clients</span></button>' : '';
  const torchButton = contextMenu.platform === 'mikrotik' ? '<button id="torch-node">🔥 <span>Torch</span></button>' : '';
  return `<div class="node-menu" style="left:${contextMenu.x}px;top:${contextMenu.y}px"><button id="open-node-gui">↗ <span>Open GUI</span></button><button id="open-node-settings">⚙ <span>Settings</span></button><button id="duplicate-node">▣ <span>Duplicate</span></button><button id="ping-node">⌁ <span>Ping ${escapeHtml(contextMenu.name)}</span></button><button id="traceroute-node">⇥ <span>Traceroute</span></button><button id="discover-node">⌕ <span>Discover neighbors</span></button>${torchButton}${wirelessClientsButton}<hr /><button class="danger" id="delete-node-menu">× <span>Delete device</span></button></div>`;
}

function getNodeGuiUrl(ip, guiPort, guiSsl) {
  const address = String(ip || '').trim();
  if (!address) return '';
  const host = address.includes(':') && !address.startsWith('[') ? `[${address}]` : address;
  const port = Number(guiPort);
  return `${guiSsl !== false ? 'https' : 'http'}://${host}${port > 0 && port <= 65535 ? `:${port}` : ''}`;
}

function renderDiscoveryDialog() {
  if (!discovery) return '';
  const body = discovery.loading
    ? '<p class="discovery-status">Scanning for neighbors…</p>'
    : discovery.error
      ? `<p class="discovery-status error">${discovery.error}</p>`
      : discovery.candidates.length === 0
        ? '<p class="discovery-status">No neighbors found. Make sure LLDP/CDP or MikroTik neighbor discovery is enabled on the device.</p>'
        : `<ul class="discovery-list">${discovery.candidates.map((candidate, index) => `<li><label><input type="checkbox" data-index="${index}" ${candidate.remoteIp ? '' : 'disabled'} /><span class="discovery-info"><strong>${candidate.remoteName || candidate.remoteIp || 'Unknown device'}</strong><small>${candidate.protocol}${candidate.remoteIp ? ` · ${candidate.remoteIp}` : ' · no IP reported'}${candidate.remotePlatform ? ` · ${candidate.remotePlatform}` : ''}</small></span></label></li>`).join('')}</ul>`;
  const protocolOptions = discovery.local
    ? '<option value="ws-discovery" selected>WS-Discovery (this PC)</option>'
    : `<option value="all" ${discovery.protocol === 'all' ? 'selected' : ''}>CDP + LLDP + MNDP + WS-Discovery</option><option value="cdp" ${discovery.protocol === 'cdp' ? 'selected' : ''}>CDP</option><option value="lldp" ${discovery.protocol === 'lldp' ? 'selected' : ''}>LLDP</option><option value="mndp" ${discovery.protocol === 'mndp' ? 'selected' : ''}>MNDP</option><option value="ws-discovery" ${discovery.protocol === 'ws-discovery' ? 'selected' : ''}>WS-Discovery (Windows)</option>`;
  return `<div class="link-dialog"><form id="discovery-form" data-dialog-key="discovery">${renderDialogHeader(`Discover neighbors of ${discovery.sourceName}`, 'cancel-discovery')}<label>Protocol<select name="protocol">${protocolOptions}</select></label>${body}<button class="primary-btn" type="submit" ${discovery.loading || discovery.error || !discovery.candidates?.length ? 'disabled' : ''}>Add selected devices</button><button class="cancel-link" type="button" id="cancel-discovery">Close</button></form></div>`;
}

function renderWirelessClientsDialog() {
  if (!wirelessClients) return '';
  const warningBanner = !wirelessClients.loading && !wirelessClients.error && wirelessClients.warning
    ? `<p class="discovery-status error">${escapeHtml(wirelessClients.warning)}</p>`
    : '';
  const body = wirelessClients.loading
    ? `<p class="discovery-status">${escapeHtml(wirelessClients.stageMessage || 'Reading wireless registration table…')}</p>`
    : wirelessClients.error
      ? `<p class="discovery-status error">${escapeHtml(wirelessClients.error)}</p>`
      : wirelessClients.clients.length === 0
        ? '<p class="discovery-status">No wireless clients are currently registered.</p>'
        : `<table class="wireless-clients-table"><thead><tr><th>MAC</th><th>Hostname</th><th>IP</th><th>SSID</th><th>Signal</th><th></th></tr></thead><tbody>${wirelessClients.clients.map((client) => {
            const alreadyMonitored = client.ip && nodes.some((node) => node.ip === client.ip);
            const action = alreadyMonitored
              ? '<span class="wireless-added">Monitored</span>'
              : `<button type="button" class="wireless-add-btn" data-mac="${escapeHtml(client.mac)}" ${client.ip ? '' : 'disabled title="No IP address found for this client"'}>+ Monitor</button>`;
            return `<tr><td>${escapeHtml(client.mac)}</td><td>${escapeHtml(client.hostname || '—')}</td><td>${escapeHtml(client.ip || '—')}</td><td>${escapeHtml(client.ssid || '—')}</td><td>${client.signal !== undefined ? `${client.signal} dBm` : '—'}</td><td>${action}</td></tr>`;
          }).join('')}</tbody></table>`;
  return `<div class="link-dialog"><div class="wireless-clients-dialog" data-dialog-key="wireless-clients">${renderDialogHeader(`Wireless clients on ${escapeHtml(wirelessClients.sourceName)}`, 'cancel-wireless-clients')}${warningBanner}${body}<button class="cancel-link" type="button" id="cancel-wireless-clients">Close</button></div></div>`;
}

function renderTracerouteBody() {
  if (!traceroute) return '';
  const pausedNote = traceroute.paused ? '<p class="discovery-status">Paused. Press Resume to continue.</p>' : '';
  return pausedNote + (traceroute.loading
    ? '<p class="discovery-status">Tracing route to ' + escapeHtml(traceroute.target) + '…</p>'
    : traceroute.error
      ? `<p class="discovery-status error">${escapeHtml(traceroute.error)}</p>`
      : !traceroute.target
        ? '<p class="discovery-status">Enter a target address or hostname and press Start.</p>'
        : traceroute.hops.length === 0
          ? '<p class="discovery-status">No hops were reported.</p>'
          : `<table class="wireless-clients-table"><thead><tr><th>Hop</th><th>Host</th><th>Loss</th><th>1</th><th>2</th><th>3</th></tr></thead><tbody>${traceroute.hops.map((hop) => {
              const times = hop.rtts.map((value) => (value === null ? '*' : `${value} ms`));
              const lost = hop.rtts.filter((value) => value === null).length;
              const hostLabel = hop.host || hop.ip || (hop.timedOut ? 'Request timed out.' : '—');
              return `<tr><td>${hop.hop}</td><td>${escapeHtml(hostLabel)}${hop.host && hop.ip ? ` <small>(${escapeHtml(hop.ip)})</small>` : ''}</td><td>${lost}/3</td><td>${escapeHtml(times[0] ?? '—')}</td><td>${escapeHtml(times[1] ?? '—')}</td><td>${escapeHtml(times[2] ?? '—')}</td></tr>`;
            }).join('')}</tbody></table>`);
}

function renderTracerouteDialog() {
  if (!traceroute) return '';
  return `<div class="link-dialog"><div class="wireless-clients-dialog" data-dialog-key="traceroute">${renderDialogHeader(traceroute.target ? `Traceroute to ${escapeHtml(traceroute.target)}` : 'Traceroute', 'cancel-traceroute')}
    <form id="traceroute-form" class="tool-dialog-controls">
      <label>Traceroute to<input name="target" value="${escapeHtml(traceroute.target)}" placeholder="IPv4 address, IPv6 address, or hostname" spellcheck="false" autocomplete="off" required /></label>
      <label>Max hops<input name="maxHops" type="number" min="1" max="64" value="${traceroute.maxHops}" /></label>
      <label>Timeout (ms)<input name="timeout" type="number" min="200" max="5000" step="100" value="${traceroute.timeout}" /></label>
      <label class="checkbox-label"><input name="useDns" type="checkbox" ${traceroute.useDns ? 'checked' : ''} /><span>Use DNS</span></label>
      <button class="primary-btn" type="submit" ${traceroute.loading ? 'disabled' : ''}>${traceroute.loading ? 'Tracing…' : 'Start'}</button>
      <button class="outline-btn" type="button" id="pause-traceroute" ${traceroute.sessionId ? '' : 'hidden'}>${traceroute.paused ? '▶ Resume' : '⏸ Pause'}</button>
    </form>
    <div id="traceroute-body">${renderTracerouteBody()}</div><button class="cancel-link" type="button" id="cancel-traceroute">Close</button></div></div>`;
}

function renderQuickPingBody() {
  if (!quickPing) return '';
  if (quickPing.error) return `<p class="discovery-status error">${escapeHtml(quickPing.error)}</p>`;
  if (!quickPing.target) return '<p class="discovery-status">Enter a target address or hostname and press Ping.</p>';
  if (quickPing.sent === 0) return `<p class="discovery-status">Pinging ${escapeHtml(quickPing.target)}…</p>`;
  const lost = quickPing.sent - quickPing.received;
  const lossPercent = quickPing.sent ? Math.round((lost / quickPing.sent) * 100) : 0;
  const rtts = quickPing.rtts;
  const min = rtts.length ? Math.min(...rtts) : null;
  const max = rtts.length ? Math.max(...rtts) : null;
  const avg = rtts.length ? Math.round(rtts.reduce((sum, value) => sum + value, 0) / rtts.length) : null;
  const pausedNote = quickPing.paused ? '<p class="discovery-status">Paused. Press Resume to continue.</p>' : '';
  return `${pausedNote}<table class="wireless-clients-table"><thead><tr><th>Sent</th><th>Received</th><th>Lost</th><th>Last</th><th>Min</th><th>Avg</th><th>Max</th></tr></thead><tbody><tr><td>${quickPing.sent}</td><td>${quickPing.received}</td><td>${lost} (${lossPercent}%)</td><td>${quickPing.lastReachable === false ? 'timeout' : quickPing.lastLatency !== null ? `${quickPing.lastLatency} ms` : '—'}</td><td>${min !== null ? `${min} ms` : '—'}</td><td>${avg !== null ? `${avg} ms` : '—'}</td><td>${max !== null ? `${max} ms` : '—'}</td></tr></tbody></table>`;
}

function renderQuickPingDialog() {
  if (!quickPing) return '';
  return `<div class="link-dialog"><div class="wireless-clients-dialog" data-dialog-key="quick-ping">${renderDialogHeader('Ping', 'cancel-quick-ping')}
    <form id="quick-ping-form" class="tool-dialog-controls">
      <label>Ping<input name="target" value="${escapeHtml(quickPing.target)}" placeholder="IPv4 address, IPv6 address, or hostname" spellcheck="false" autocomplete="off" required /></label>
      <button class="primary-btn" type="submit">Start</button>
      <button class="outline-btn" type="button" id="pause-quick-ping" ${quickPing.target ? '' : 'hidden'}>${quickPing.paused ? '▶ Resume' : '⏸ Pause'}</button>
    </form>
    <div id="quick-ping-body">${renderQuickPingBody()}</div><button class="cancel-link" type="button" id="cancel-quick-ping">Close</button></div></div>`;
}

function renderTorchBody() {
  if (!torch) return '';
  const preferredOrder = ['src-address', 'dst-address', 'protocol', 'port', 'dst-port', 'tx-rate', 'rx-rate', 'tx-packets-rate', 'rx-packets-rate'];
  const seen = new Set();
  const extraKeys = [];
  torch.rows.forEach((row) => Object.keys(row).forEach((key) => { if (!seen.has(key)) { seen.add(key); if (!preferredOrder.includes(key)) extraKeys.push(key); } }));
  const columns = [...preferredOrder.filter((key) => seen.has(key)), ...extraKeys];
  const columnLabel = (key) => key.replace(/-/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
  return !torch.interface
    ? '<p class="discovery-status">Choose an interface and press Start to monitor live traffic.</p>'
    : torch.error
      ? `<p class="discovery-status error">${escapeHtml(torch.error)}</p>`
      : torch.rows.length === 0
        ? '<p class="discovery-status">No active traffic on this interface.</p>'
        : `<table class="wireless-clients-table"><thead><tr>${columns.map((key) => `<th>${escapeHtml(columnLabel(key))}</th>`).join('')}</tr></thead><tbody>${torch.rows.map((row) => `<tr>${columns.map((key) => `<td>${escapeHtml(row[key] ?? '—')}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

function renderTorchDialog() {
  if (!torch) return '';
  const interfacePicker = torch.loadingInterfaces
    ? '<select disabled><option>Loading…</option></select>'
    : !torch.interfaces?.length
      ? '<select disabled><option>No interfaces found</option></select>'
      : `<select name="interface">${torch.interfaces.map((name) => `<option value="${escapeHtml(name)}" ${name === torch.interface ? 'selected' : ''}>${escapeHtml(name)}</option>`).join('')}</select>`;
  return `<div class="link-dialog"><div class="wireless-clients-dialog" data-dialog-key="torch">${renderDialogHeader(`Torch on ${escapeHtml(torch.sourceName)}`, 'cancel-torch')}
    <form id="torch-form" class="tool-dialog-controls">
      <label>Interface${interfacePicker}</label>
      <button class="primary-btn" type="submit" ${torch.loadingInterfaces || !torch.interfaces?.length ? 'disabled' : ''}>${torch.interface ? 'Restart' : 'Start'}</button>
    </form>
    ${!torch.loadingInterfaces && !torch.interfaces?.length ? `<p class="discovery-status error">${torch.interfacesError ? escapeHtml(torch.interfacesError) : 'No interfaces were found on this device (checked the RouterOS API and SNMP). Set the API username/password on this device to use Torch.'}</p>` : ''}
    <div id="torch-body">${renderTorchBody()}</div><button class="cancel-link" type="button" id="cancel-torch">Close</button></div></div>`;
}

function renderSiteSwitcher() {
  if (editingWorkspaceName) {
    return `<form class="site-switcher editing" id="workspace-rename-form"><span class="pulse"></span><input id="workspace-name-input" value="${workspaceName.replace(/"/g, '&quot;')}" maxlength="60" autocomplete="off" /><button type="submit" class="workspace-save" title="Save name">✓</button><button type="button" class="workspace-cancel" id="cancel-workspace-rename" title="Cancel">×</button></form>`;
  }
  return `<div class="site-switcher"><button class="site-switcher-label" id="workspace-menu-toggle"><span class="pulse"></span> ${workspaceName} <span class="caret">⌄</span></button>${workspaceMenuOpen ? `<div class="workspace-menu"><button id="new-workspace">＋ <span>New workspace</span></button><button id="rename-workspace">✎ <span>Rename workspace</span></button><button id="export-workspace">⬇ <span>Export workspace</span></button><button id="import-workspace">⬆ <span>Import workspace</span></button><button id="import-wind">◎ <span>Import Wind nodes</span></button><button id="import-dude">◎ <span>Import Dude nodes</span></button><button class="danger" id="delete-all-nodes">× <span>Delete all nodes</span></button></div>` : ''}<input type="file" id="import-workspace-input" accept="application/json" hidden />${workspaceFeedback ? `<div class="workspace-feedback">${workspaceFeedback}</div>` : ''}</div>`;
}

function renderWorkspaceTabs() {
  return `<div class="workspace-tabs" role="tablist" aria-label="Workspaces">${workspaces.map((workspace) => `<div class="workspace-tab ${workspace.id === activeWorkspaceId ? 'active' : ''}" role="tab" aria-selected="${workspace.id === activeWorkspaceId}"><button class="workspace-tab-select" data-workspace-id="${workspace.id}">${escapeHtml(workspace.name)}</button><button class="workspace-tab-delete" data-delete-workspace-id="${workspace.id}" title="Delete ${escapeHtml(workspace.name)}" aria-label="Delete ${escapeHtml(workspace.name)}">×</button></div>`).join('')}<button class="workspace-tab-add" id="new-workspace-tab" title="Create new workspace" aria-label="Create new workspace">＋</button></div>`;
}

function snapshotActiveWorkspace() {
  const active = workspaces.find((workspace) => workspace.id === activeWorkspaceId);
  if (active) Object.assign(active, { name: workspaceName, nodes, links });
}

async function selectWorkspace(id) {
  if (id === activeWorkspaceId) return;
  snapshotActiveWorkspace();
  const next = workspaces.find((workspace) => workspace.id === id);
  if (!next) return;
  activeWorkspaceId = next.id;
  workspaceName = next.name;
  nodes = next.nodes;
  links = next.links;
  selectedId = nodes[0]?.id || '';
  const needsTopology = nodes.length === 0;
  startupState = needsTopology ? 'loading-local' : 'ready';
  workspaceMenuOpen = false;
  render();
  if (needsTopology) await refreshMetrics({ force: true, replaceNodes: true, workspaceId: activeWorkspaceId });
}

function createWorkspace() {
  snapshotActiveWorkspace();
  const number = workspaces.length + 1;
  const workspace = { id: `workspace-${Date.now()}`, name: `Workspace ${number}`, nodes: [], links: [], source: 'local' };
  workspaces.push(workspace);
  activeWorkspaceId = workspace.id;
  workspaceName = workspace.name;
  nodes = workspace.nodes;
  links = workspace.links;
  selectedId = '';
  startupState = 'ready';
  workspaceMenuOpen = false;
  render();
}

function deleteWorkspace(id) {
  if (workspaces.length === 1) {
    workspaceFeedback = 'Keep at least one workspace.';
    render();
    return;
  }
  const workspace = workspaces.find((item) => item.id === id);
  if (!workspace || !window.confirm(`Delete ${workspace.name}?`)) return;
  const index = workspaces.findIndex((item) => item.id === id);
  workspaces.splice(index, 1);
  if (id === activeWorkspaceId) {
    const next = workspaces[Math.max(0, index - 1)];
    activeWorkspaceId = next.id;
    workspaceName = next.name;
    nodes = next.nodes;
    links = next.links;
    selectedId = nodes[0]?.id || '';
    startupState = 'ready';
  }
  render();
}

function renderNode(node) {
  const type = nodeTypes[node.type];
  const traffic = `↓ ${node.rx} Mbps  ↑ ${node.tx} Mbps`;
  const detail = node.status === 'offline' ? (node.pingReachable ? `Ping ${node.pingLatency === null ? 'OK' : `${node.pingLatency} ms`}` : 'SNMP unavailable') : traffic;
  const stateClass = node.status === 'offline' && node.pingReachable ? 'ping-ok' : node.status;
  const hasHealth = node.status !== 'offline' && (node.cpu !== undefined || node.memory !== undefined);
  const health = hasHealth ? `<small class="node-health">${node.cpu !== undefined ? `CPU ${node.cpu}%` : ''}${node.cpu !== undefined && node.memory !== undefined ? ' · ' : ''}${node.memory !== undefined ? `MEM ${node.memory}%` : ''}</small>` : '';
  return `<button class="map-node ${stateClass} ${selectedNodeIds.has(node.id) ? 'is-selected' : ''}" data-id="${node.id}" style="left:${node.x}%;top:${node.y}%"><span class="node-icon ${type.className}">${type.icon}</span><span class="node-copy"><strong>${node.name}</strong><small>${detail}</small>${health}</span><span class="node-state"></span></button>`;
}

function getLinkTrafficClass(link) {
  const speed = Math.max(Number(link.rx) || 0, Number(link.tx) || 0);
  if (speed > 50_000_000) return 'link-traffic link-traffic-50';
  if (speed > 40_000_000) return 'link-traffic link-traffic-40';
  if (speed > 10_000_000) return 'link-traffic link-traffic-10';
  if (speed > 1_000_000) return 'link-traffic link-traffic-1';
  return '';
}

function drawLinks() {
  const svg = document.querySelector('#links');
  svg.innerHTML = links.map((link) => {
    const from = nodes.find((node) => node.id === link.sourceId);
    const to = nodes.find((node) => node.id === link.targetId);
    if (!from || !to) return '';
    const offline = from.status === 'offline' || to.status === 'offline';
    const label = `RX ${formatRate(link.rx)} | TX ${formatRate(link.tx)}`;
    return `<line class="${offline ? 'offline-link' : getLinkTrafficClass(link)}" data-link-id="${escapeHtml(link.id)}" x1="${from.x}%" y1="${from.y}%" x2="${to.x}%" y2="${to.y}%" /><svg class="link-badge-position" x="${(from.x + to.x) / 2}%" y="${(from.y + to.y) / 2}%" width="1" height="1"><g class="link-badge" data-link-id="${escapeHtml(link.id)}" role="button" tabindex="0" aria-label="Edit link from ${escapeHtml(from.name)} to ${escapeHtml(to.name)}"><title>Click to edit link settings</title><rect x="-100" y="-14" width="200" height="28" rx="4" /><text class="link-label" x="0" y="0">${label}</text></g></svg>`;
  }).join('');
  svg.querySelectorAll('.link-badge').forEach((badge) => {
    const width = Math.ceil(badge.querySelector('text').getBBox().width) + 24;
    const rect = badge.querySelector('rect');
    rect.setAttribute('x', -width / 2);
    rect.setAttribute('width', width);
  });
}

function formatRate(bits) {
  if (bits >= 1000000) return `${(bits / 1000000).toFixed(1)} Mbps`;
  if (bits >= 1000) return `${(bits / 1000).toFixed(1)} Kbps`;
  return `${Math.round(bits || 0)} bps`;
}

async function startDiscovery(node, protocol) {
  const local = !node;
  const sourceName = node?.name || 'this PC';
  discovery = { sourceId: node?.id || null, sourceName, local, protocol, candidates: [], loading: true, error: '' };
  render();
  try {
    const endpoint = local ? `${API_URL}/discover-neighbors` : `${API_URL}/${node.id}/discover-neighbors`;
    const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ protocol }) });
    if (!response.ok) throw new Error();
    const result = await response.json();
    discovery = { ...discovery, loading: false, candidates: result.candidates || [] };
  } catch {
    discovery = { ...discovery, loading: false, error: `Could not discover neighbors of ${sourceName}. Check the monitoring service.` };
  }
  render();
}

async function startWirelessClients(node) {
  if (!node) return;
  wirelessClients = { sourceId: node.id, sourceName: node.name, clients: [], loading: true, error: '', stageMessage: `Connecting to ${node.platform === 'openwrt' ? 'OpenWrt' : 'MikroTik'} device ${node.ip}…` };
  render();
  // Poll the server's stage tracker so the dialog can show connecting/connected/failed detail
  // while the single wireless-clients request is still in flight.
  const statusPoll = setInterval(async () => {
    if (!wirelessClients?.loading || wirelessClients.sourceId !== node.id) return;
    try {
      const status = await fetch(`${API_URL}/${node.id}/wireless-clients/status`).then((response) => response.ok ? response.json() : null);
      if (status?.detail && wirelessClients?.loading && wirelessClients.sourceId === node.id) { wirelessClients = { ...wirelessClients, stageMessage: status.detail }; render(); }
    } catch { /* transient poll failure, keep showing the last known stage */ }
  }, 400);
  try {
    const response = await fetch(`${API_URL}/${node.id}/wireless-clients`);
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `Could not read wireless clients on ${node.name}. Check the monitoring service.`);
    wirelessClients = { ...wirelessClients, loading: false, clients: result.clients || [], warning: result.warning || '' };
  } catch (error) {
    wirelessClients = { ...wirelessClients, loading: false, error: error.message };
  }
  clearInterval(statusPoll);
  render();
}

async function startTraceroute(initialTarget, overrides = {}) {
  const target = overrides.target ?? traceroute?.target ?? initialTarget ?? '';
  const maxHops = overrides.maxHops || traceroute?.maxHops || 30;
  const timeout = overrides.timeout || traceroute?.timeout || 1000;
  const useDns = overrides.useDns ?? traceroute?.useDns ?? false;
  clearInterval(traceroutePollTimer);
  const previousId = traceroute?.sessionId;
  traceroute = { target, maxHops, timeout, useDns, loading: !!target, paused: false, error: '', hops: [], sessionId: '' };
  render();
  if (previousId) fetch(`/api/tools/traceroute/${previousId}/stop`, { method: 'POST' }).catch(() => {});
  if (!target) return;
  try {
    const response = await fetch('/api/tools/traceroute/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target, maxHops, timeout, useDns }) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `Could not trace a route to ${target}.`);
    traceroute = { ...traceroute, sessionId: result.id };
  } catch (error) {
    traceroute = { ...traceroute, loading: false, error: error.message };
    render();
    return;
  }
  pollTracerouteSession(traceroute.sessionId);
}

// Traceroute streams hop by hop on the server; poll for progress until it reports done (or
// until paused, which just stops polling — the server-side trace keeps running in the background).
function pollTracerouteSession(sessionId) {
  clearInterval(traceroutePollTimer);
  traceroutePollTimer = setInterval(async () => {
    if (!traceroute || traceroute.sessionId !== sessionId || traceroute.paused) { clearInterval(traceroutePollTimer); return; }
    try {
      const snapshot = await fetch(`/api/tools/traceroute/${sessionId}`).then((response) => response.ok ? response.json() : null);
      if (!snapshot || !traceroute || traceroute.sessionId !== sessionId) return;
      traceroute = { ...traceroute, hops: snapshot.hops || [], error: snapshot.error || '', loading: !snapshot.done };
      patchTracerouteDialog();
      if (snapshot.done) clearInterval(traceroutePollTimer);
    } catch { /* transient poll failure, keep showing the last known hops */ }
  }, 400);
}

function pauseTraceroute() {
  if (!traceroute?.sessionId || traceroute.paused) return;
  clearInterval(traceroutePollTimer);
  traceroutePollTimer = null;
  traceroute = { ...traceroute, paused: true, loading: false };
  patchTracerouteDialog();
}

function resumeTraceroute() {
  if (!traceroute?.sessionId || !traceroute.paused) return;
  traceroute = { ...traceroute, paused: false, loading: true };
  patchTracerouteDialog();
  pollTracerouteSession(traceroute.sessionId);
}

// Patches just the results area and submit button in place instead of calling the full render(),
// which would recreate the form's <input>/<select> elements mid-poll and drop focus, in-progress
// typing, or an open dropdown (see the Torch/Traceroute "canvas keeps stealing my typing" reports).
function patchTracerouteDialog() {
  if (!traceroute) return;
  const bodyEl = document.querySelector('#traceroute-body');
  const submitBtn = document.querySelector('#traceroute-form button[type="submit"]');
  const pauseBtn = document.querySelector('#pause-traceroute');
  if (!bodyEl || !submitBtn) { render(); return; }
  bodyEl.innerHTML = renderTracerouteBody();
  submitBtn.disabled = traceroute.loading;
  submitBtn.textContent = traceroute.loading ? 'Tracing…' : 'Start';
  if (pauseBtn) pauseBtn.textContent = traceroute.paused ? '▶ Resume' : '⏸ Pause';
  if (pauseBtn) pauseBtn.hidden = !traceroute.sessionId;
}

function stopTraceroute() {
  clearInterval(traceroutePollTimer);
  traceroutePollTimer = null;
  const sessionId = traceroute?.sessionId;
  traceroute = null;
  render();
  if (sessionId) fetch(`/api/tools/traceroute/${sessionId}/stop`, { method: 'POST' }).catch(() => {});
}

async function startQuickPing(initialTarget, overrides = {}) {
  const target = overrides.target ?? quickPing?.target ?? initialTarget ?? '';
  quickPing = { target, loading: !!target, error: '', reachable: undefined, latency: null };
  render();
  if (!target) return;
  try {
    const response = await fetch('/api/tools/ping', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target }) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `Could not ping ${target}.`);
    quickPing = { ...quickPing, loading: false, reachable: result.reachable, latency: result.latency };
  } catch (error) {
    quickPing = { ...quickPing, loading: false, error: error.message };
  }
  render();
}

async function openTorch(node) {
  if (!node) return;
  torch = { sourceId: node.id, sourceName: node.name, interfaces: [], interface: '', rows: [], error: '', interfacesError: '', loadingInterfaces: true };
  render();
  try {
    const result = await fetch(`${API_URL}/${node.id}/torch-interfaces`).then((response) => response.ok ? response.json() : { interfaces: [] });
    torch = { ...torch, interfaces: Array.isArray(result.interfaces) ? result.interfaces : [], interfacesError: result.error || '', loadingInterfaces: false };
  } catch {
    torch = { ...torch, loadingInterfaces: false };
  }
  render();
}

async function startTorch(node, iface) {
  if (!node || !iface || !torch) return;
  torch = { ...torch, interface: iface, rows: [], error: '' };
  render();
  clearInterval(torchPollTimer);
  try {
    const response = await fetch(`${API_URL}/${node.id}/torch/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ interface: iface }) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) { torch = { ...torch, error: result.error || 'Could not start Torch.' }; render(); return; }
  } catch {
    torch = { ...torch, error: 'Could not start Torch.' };
    render();
    return;
  }
  // Torch keeps streaming on the server; poll for the latest snapshot while the dialog is open.
  torchPollTimer = setInterval(async () => {
    if (!torch || torch.sourceId !== node.id) { clearInterval(torchPollTimer); return; }
    try {
      const snapshot = await fetch(`${API_URL}/${node.id}/torch`).then((response) => response.ok ? response.json() : null);
      if (snapshot && torch && torch.sourceId === node.id) { torch = { ...torch, rows: snapshot.rows || [], error: snapshot.error || '' }; patchTorchDialog(); }
    } catch { /* transient poll failure, keep showing the last known snapshot */ }
  }, 1000);
}

// See patchTracerouteDialog(): avoids recreating the interface <select> mid-poll, which would
// otherwise close it if the user had it open.
function patchTorchDialog() {
  if (!torch) return;
  const bodyEl = document.querySelector('#torch-body');
  if (!bodyEl) { render(); return; }
  bodyEl.innerHTML = renderTorchBody();
}

function closeTorch() {
  clearInterval(torchPollTimer);
  torchPollTimer = null;
  const nodeId = torch?.sourceId;
  torch = null;
  render();
  if (nodeId) fetch(`${API_URL}/${nodeId}/torch/stop`, { method: 'POST' }).catch(() => {});
}

// FormData omits unchecked checkboxes entirely, so read their state explicitly.
function getDeviceFormValues(form) {
  return { ...Object.fromEntries(new FormData(form)), guiSsl: form.elements.guiSsl.checked };
}

function bindEvents() {
  document.querySelector('#theme-select').addEventListener('change', (event) => {
    themePreference = event.target.value;
    try { localStorage.setItem('nodeatlas-theme', themePreference); } catch {}
    applyTheme();
  });
  bindWorkspaceEvents();
  document.querySelectorAll('.nav-item').forEach((item) => item.addEventListener('click', () => {
    activeView = item.dataset.view;
    render();
  }));
  document.querySelector('#open-license').addEventListener('click', () => { licenseOpen = true; licenseTab = 'license'; render(); });
  const closeLicenseButton = document.querySelector('#close-license');
  if (closeLicenseButton) closeLicenseButton.addEventListener('click', () => { licenseOpen = false; render(); });
  document.querySelectorAll('.license-tab').forEach((tab) => tab.addEventListener('click', () => { licenseTab = tab.dataset.licenseTab; render(); }));
  const returnToTopologyButton = document.querySelector('#return-to-topology');
  if (returnToTopologyButton) returnToTopologyButton.addEventListener('click', () => { activeView = 'topology'; render(); });
  if (activeView !== 'topology') return;
  const canvas = document.querySelector('#canvas');
  const deleteSelectionButton = document.querySelector('#delete-selection');
  if (deleteSelectionButton) deleteSelectionButton.addEventListener('click', deleteSelectedNodes);
  const openLinkSettings = (event) => {
    const target = event.target.closest('[data-link-id]');
    if (!target) return;
    const link = links.find((item) => item.id === target.dataset.linkId);
    if (!link) return;
    event.preventDefault();
    selectedLinkId = link.id;
    interfaceOptions = [];
    render();
    loadInterfaces(link.sourceId);
  };
  document.querySelector('#links').addEventListener('click', openLinkSettings);
  document.querySelector('#links').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') openLinkSettings(event);
  });
  canvas.addEventListener('pointerdown', (event) => {
    // Link controls must not start a marquee that redraws the page on pointerup.
    if (event.target.closest('[data-link-id]')) return;
    if (event.target.closest('#canvas-resize-handle')) {
      resizingCanvas = { startX: event.clientX, startWidth: canvas.getBoundingClientRect().width, startZoom: zoom, nextZoom: zoom };
      return;
    }
    const nodeElement = event.target.closest('.map-node');
    if (!nodeElement) {
      if (linking || (event.button !== 0 && event.button !== 1)) return;
      if (event.button === 1) {
        const wrap = document.querySelector('#canvas-wrap');
        panning = { startX: event.clientX, startY: event.clientY, scrollLeft: wrap.scrollLeft, scrollTop: wrap.scrollTop };
        wrap.style.cursor = 'grabbing';
        return;
      }
      const bounds = canvas.getBoundingClientRect();
      selecting = { startX: event.clientX - bounds.left, startY: event.clientY - bounds.top, canvas };
      canvas.setPointerCapture(event.pointerId);
      return;
    }
    const node = nodes.find((item) => item.id === nodeElement.dataset.id);
    if (linking?.step === 'target') {
      if (node.id === linking.sourceId) return;
      const source = nodes.find((item) => item.id === linking.sourceId);
      Promise.all([source, node].map((endpoint) => fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(getNodeSavePayload(endpoint)) }).then((response) => response.ok || response.status === 409)))
        .then(() => fetch('/api/links', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...linking, targetId: node.id }) }))
        .then((response) => response.ok ? response.json() : Promise.reject())
        .then((link) => { links.push(link); linking = null; pingFeedback = 'Link created.'; render(); })
        .catch(() => { linking = null; pingFeedback = 'Could not create link. Check the monitoring service.'; render(); });
      return;
    }
    if (selectedId !== node.id) {
      editingSettings = false;
      settingsDraft = null;
      settingsFeedback = '';
    }
    selectedId = node.id;
    selectedNodeIds = new Set([node.id]);
    inspectorCollapsed = false;
    dragging = { id: node.id, startX: event.clientX, startY: event.clientY, x: node.x, y: node.y };
    nodeElement.setPointerCapture(event.pointerId);
    render();
  });
  canvas.addEventListener('contextmenu', (event) => {
    const nodeElement = event.target.closest('.map-node');
    if (!nodeElement) {
      if (contextMenu) {
        contextMenu = null;
        render();
      }
      return;
    }
    event.preventDefault();
    const node = nodes.find((item) => item.id === nodeElement.dataset.id);
    contextMenu = { id: node.id, name: node.name, ip: node.ip, guiPort: node.guiPort, guiSsl: node.guiSsl, platform: node.platform, x: event.clientX, y: event.clientY };
    render();
  });
  const openGuiButton = document.querySelector('#open-node-gui');
  if (openGuiButton) openGuiButton.addEventListener('click', () => {
    const url = getNodeGuiUrl(contextMenu.ip, contextMenu.guiPort, contextMenu.guiSsl);
    contextMenu = null;
    if (!url) {
      pingFeedback = 'This device has no IP address.';
      render();
      setTimeout(() => { pingFeedback = ''; render(); }, 4000);
      return;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
    render();
  });
  const pingButton = document.querySelector('#ping-node');
  if (pingButton) pingButton.addEventListener('click', async () => {
    const node = contextMenu;
    contextMenu = null;
    pingFeedback = `Pinging ${node.name}...`;
    render();
    try {
      const result = await fetch(`/api/nodes/${node.id}/ping`, { method: 'POST' }).then((response) => response.ok ? response.json() : Promise.reject());
      nodes = nodes.map((item) => item.id === node.id ? { ...item, pingReachable: result.reachable, pingLatency: result.latency } : item);
      pingFeedback = result.reachable ? `${node.name} replied${result.latency !== null ? ` in ${result.latency} ms` : ''}.` : `${node.name} did not reply.`;
    } catch {
      pingFeedback = `Could not ping ${node.name}.`;
    }
    render();
    setTimeout(() => { pingFeedback = ''; render(); }, 4000);
  });
  const settingsButton = document.querySelector('#open-node-settings');
  if (settingsButton) settingsButton.addEventListener('click', () => {
    selectedId = contextMenu.id;
    contextMenu = null;
    render();
  });
  const duplicateButton = document.querySelector('#duplicate-node');
  if (duplicateButton) duplicateButton.addEventListener('click', async () => {
    const node = contextMenu;
    contextMenu = null;
    try {
      const copy = await fetch(`${API_URL}/${node.id}/duplicate`, { method: 'POST' }).then((response) => response.ok ? response.json() : Promise.reject());
      nodes.push(copy);
      selectedId = copy.id;
      pingFeedback = `${copy.name} created.`;
    } catch {
      pingFeedback = `Could not duplicate ${node.name}.`;
    }
    render();
  });
  const deleteMenuButton = document.querySelector('#delete-node-menu');
  if (deleteMenuButton) deleteMenuButton.addEventListener('click', async () => {
    const node = contextMenu;
    contextMenu = null;
    if (!window.confirm(`Delete ${node.name}?`)) { render(); return; }
    const response = await fetch(`${API_URL}/${node.id}`, { method: 'DELETE' });
    if (response.ok) {
      nodes = nodes.filter((item) => item.id !== node.id);
      selectedId = nodes[0]?.id || '';
    } else pingFeedback = `Could not delete ${node.name}.`;
    render();
  });
  const discoverButton = document.querySelector('#discover-node');
  if (discoverButton) discoverButton.addEventListener('click', async () => {
    const node = contextMenu;
    contextMenu = null;
    startDiscovery(node, 'all');
  });
  const wirelessClientsButton = document.querySelector('#wireless-clients-node');
  if (wirelessClientsButton) wirelessClientsButton.addEventListener('click', () => {
    const node = contextMenu;
    contextMenu = null;
    startWirelessClients(node);
  });
  const cancelWirelessClients = document.querySelector('#cancel-wireless-clients');
  if (cancelWirelessClients) cancelWirelessClients.addEventListener('click', () => { wirelessClients = null; render(); });
  const tracerouteButton = document.querySelector('#traceroute-node');
  if (tracerouteButton) tracerouteButton.addEventListener('click', () => {
    const node = contextMenu;
    contextMenu = null;
    startTraceroute(node.ip);
  });
  const cancelTraceroute = document.querySelector('#cancel-traceroute');
  if (cancelTraceroute) cancelTraceroute.addEventListener('click', () => stopTraceroute());
  const tracerouteForm = document.querySelector('#traceroute-form');
  if (tracerouteForm) tracerouteForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const formData = new FormData(tracerouteForm);
    startTraceroute(traceroute?.target, {
      target: String(formData.get('target') || '').trim(),
      maxHops: Number(formData.get('maxHops')) || 30,
      timeout: Number(formData.get('timeout')) || 1000,
      useDns: formData.get('useDns') === 'on',
    });
  });
  const pauseTracerouteButton = document.querySelector('#pause-traceroute');
  if (pauseTracerouteButton) pauseTracerouteButton.addEventListener('click', () => (traceroute?.paused ? resumeTraceroute() : pauseTraceroute()));
  const torchButton = document.querySelector('#torch-node');
  if (torchButton) torchButton.addEventListener('click', () => {
    const node = contextMenu;
    contextMenu = null;
    openTorch(node);
  });
  const cancelTorch = document.querySelector('#cancel-torch');
  if (cancelTorch) cancelTorch.addEventListener('click', () => closeTorch());
  const torchForm = document.querySelector('#torch-form');
  if (torchForm) torchForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const node = nodes.find((item) => item.id === torch.sourceId);
    const iface = new FormData(torchForm).get('interface');
    if (node && iface) startTorch(node, iface);
  });
  document.querySelectorAll('.wireless-add-btn').forEach((button) => button.addEventListener('click', async () => {
    const client = wirelessClients?.clients.find((item) => item.mac === button.dataset.mac);
    if (!client || !client.ip) return;
    button.disabled = true;
    button.textContent = 'Adding…';
    const source = nodes.find((node) => node.id === wirelessClients.sourceId);
    const device = {
      ...defaultSnmpSettings,
      id: `wifi-${client.mac.replace(/:/g, '')}-${Date.now()}`,
      name: client.hostname || client.mac,
      type: 'device',
      platform: 'other',
      ip: client.ip,
      x: Math.min(94, Math.max(6, (source?.x || 50) + (Math.random() * 16 - 8))),
      y: Math.min(91, Math.max(6, (source?.y || 50) + 12)),
    };
    try {
      const saved = await fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(device) }).then((response) => response.ok ? response.json() : Promise.reject());
      nodes.push(saved);
      pingFeedback = `${saved.name} added for monitoring.`;
    } catch {
      pingFeedback = `Could not add ${client.hostname || client.mac} for monitoring.`;
    }
    render();
    setTimeout(() => { pingFeedback = ''; render(); }, 4000);
  }));
  const discoverToolbar = document.querySelector('#discover-toolbar');
  if (discoverToolbar) discoverToolbar.addEventListener('click', () => { const source = nodes.find((node) => node.id === selectedId); startDiscovery(source, source ? 'all' : 'ws-discovery'); });
  const tracerouteToolbar = document.querySelector('#traceroute-toolbar');
  if (tracerouteToolbar) tracerouteToolbar.addEventListener('click', () => startTraceroute(nodes.find((node) => node.id === selectedId)?.ip || ''));
  const pingToolbar = document.querySelector('#ping-toolbar');
  if (pingToolbar) pingToolbar.addEventListener('click', () => startQuickPing(nodes.find((node) => node.id === selectedId)?.ip || ''));
  const cancelQuickPing = document.querySelector('#cancel-quick-ping');
  if (cancelQuickPing) cancelQuickPing.addEventListener('click', () => { quickPing = null; render(); });
  const quickPingForm = document.querySelector('#quick-ping-form');
  if (quickPingForm) quickPingForm.addEventListener('submit', (event) => {
    event.preventDefault();
    startQuickPing(quickPing?.target, { target: String(new FormData(quickPingForm).get('target') || '').trim() });
  });
  const cancelDiscovery = document.querySelector('#cancel-discovery');
  if (cancelDiscovery) cancelDiscovery.addEventListener('click', () => { discovery = null; render(); });
  const discoveryForm = document.querySelector('#discovery-form');
  const discoveryProtocol = discoveryForm?.querySelector('select[name="protocol"]');
  if (discoveryProtocol) discoveryProtocol.addEventListener('change', () => startDiscovery(discovery.sourceId ? nodes.find((node) => node.id === discovery.sourceId) : null, discoveryProtocol.value));
  if (discoveryForm) discoveryForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const source = nodes.find((item) => item.id === discovery.sourceId);
    const chosen = [...discoveryForm.querySelectorAll('input[type="checkbox"]:checked')].map((input) => discovery.candidates[Number(input.dataset.index)]);
    if (!chosen.length) { discovery = null; render(); return; }
    let created = 0;
    for (const [index, candidate] of chosen.entries()) {
      if (nodes.some((node) => node.ip === candidate.remoteIp)) continue;
      const device = {
        ...defaultSnmpSettings,
        id: `neighbor-${Date.now()}-${index}`,
        name: candidate.remoteName || candidate.remoteIp,
        type: 'router',
        platform: /mikrotik|routeros/i.test(candidate.remotePlatform || '') ? 'mikrotik' : 'other',
        ip: candidate.remoteIp,
        x: Math.min(94, Math.max(6, (source?.x || 50) + (index % 2 === 0 ? 8 : -8))),
        y: Math.min(91, Math.max(6, (source?.y || 50) + (source ? 10 : 4) + index * 6)),
      };
      try {
        const saved = await fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(device) }).then((response) => response.ok ? response.json() : Promise.reject());
        nodes.push(saved);
        created += 1;
        if (source && candidate.localInterfaceIndex) {
          const link = await fetch('/api/links', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceId: source.id, targetId: saved.id, interfaceIndex: candidate.localInterfaceIndex }) }).then((response) => response.ok ? response.json() : null);
          if (link) links.push(link);
        }
      } catch {
        // Skip devices that failed to save (e.g. duplicate IP) and continue with the rest.
      }
    }
    pingFeedback = created ? `Added ${created} discovered device${created === 1 ? '' : 's'}.` : 'Could not add the selected devices.';
    discovery = null;
    render();
    setTimeout(() => { pingFeedback = ''; render(); }, 4000);
  });
  document.querySelectorAll('.tool').forEach((tool) => tool.addEventListener('dragstart', (event) => event.dataTransfer.setData('node-type', tool.dataset.type)));
  canvas.addEventListener('dragover', (event) => event.preventDefault());
  canvas.addEventListener('drop', (event) => {
    event.preventDefault();
    const type = event.dataTransfer.getData('node-type');
    if (!type) return;
    const bounds = canvas.getBoundingClientRect();
    const device = { ...defaultSnmpSettings, id: `device-${Date.now()}`, name: `New ${nodeTypes[type].label}`, type, x: ((event.clientX - bounds.left) / bounds.width) * 100, y: ((event.clientY - bounds.top) / bounds.height) * 100, status: 'healthy', ip: '192.168.88.200', uptime: '100%', rx: 0, tx: 0 };
    nodes.push(device); selectedId = device.id; startupState = 'ready'; fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(device) }).catch(() => {}); render();
  });
  document.querySelector('#add-device').addEventListener('click', () => {
    const device = { ...defaultSnmpSettings, id: `device-${Date.now()}`, name: 'New Device', type: 'device', x: 50, y: 55, status: 'healthy', ip: '192.168.88.200', uptime: '100%', rx: 0, tx: 0 };
    nodes.push(device); selectedId = device.id; startupState = 'ready'; fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(device) }).catch(() => {}); render();
  });
  document.querySelector('#fit-map').addEventListener('click', () => { zoom = 1; render(); });
  document.querySelector('#canvas-wrap').addEventListener('wheel', (event) => {
    event.preventDefault();
    zoom = Math.min(2.5, Math.max(0.5, +(zoom + (event.deltaY < 0 ? 0.1 : -0.1)).toFixed(2)));
    render();
  }, { passive: false });
  const closeInspector = document.querySelector('.close-inspector');
  if (closeInspector) closeInspector.addEventListener('click', () => { inspectorCollapsed = true; selectedId = ''; selectedNodeIds = new Set(); render(); });
  const showInspector = document.querySelector('#show-inspector');
  if (showInspector) showInspector.addEventListener('click', () => { inspectorCollapsed = false; render(); });
  const sidebarHandle = document.querySelector('#sidebar-handle');
  if (sidebarHandle) sidebarHandle.addEventListener('pointerdown', (event) => {
    resizingPanel = { panel: 'sidebar', startX: event.clientX, startWidth: sidebarWidth };
    sidebarHandle.classList.add('active');
  });
  const inspectorHandle = document.querySelector('#inspector-handle');
  if (inspectorHandle) inspectorHandle.addEventListener('pointerdown', (event) => {
    resizingPanel = { panel: 'inspector', startX: event.clientX, startWidth: inspectorWidth };
    inspectorHandle.classList.add('active');
  });
  document.querySelector('#connect-mode').addEventListener('click', () => {
    if (!nodes.length) return;
    if (linking) { linking = null; interfaceOptions = []; render(); return; }
    linking = { step: 'source', sourceId: selectedId || nodes[0]?.id };
    interfaceOptions = [];
    render();
    loadInterfaces(linking.sourceId);
  });
  const sourceSelect = document.querySelector('#link-source');
  if (sourceSelect) sourceSelect.addEventListener('change', (event) => {
    if (linking) linking.sourceId = event.target.value;
    loadInterfaces(event.target.value);
  });
  const linkForm = document.querySelector('#link-form');
  if (linkForm) {
    linkForm.addEventListener('focusin', () => { editingLink = true; });
    linkForm.addEventListener('submit', (event) => { event.preventDefault(); editingLink = false; linking = { ...Object.fromEntries(new FormData(event.currentTarget)), step: 'target' }; render(); });
  }
  const cancelLink = document.querySelector('#cancel-link');
  if (cancelLink) cancelLink.addEventListener('click', () => { editingLink = false; linking = null; selectedLinkId = ''; render(); });
  const editLinkForm = document.querySelector('#edit-link-form');
  if (editLinkForm) {
    editLinkForm.addEventListener('focusin', () => { editingLink = true; });
    editLinkForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const updated = Object.fromEntries(new FormData(event.currentTarget));
      const response = await fetch(`/api/links/${selectedLinkId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(updated) });
      if (response.ok) { const link = await response.json(); links = links.map((item) => item.id === link.id ? link : item); }
      editingLink = false;
      selectedLinkId = '';
      render();
    });
  }
  const deviceActions = document.querySelector('#device-actions');
  if (deviceActions) deviceActions.addEventListener('click', () => {
    actionsMenuOpen = !actionsMenuOpen;
    render();
  });
  const deleteButton = document.querySelector('#delete-device');
  if (deleteButton) deleteButton.addEventListener('click', async () => {
    if (!window.confirm(`Delete ${nodes.find((node) => node.id === selectedId).name}?`)) return;
    const response = await fetch(`${API_URL}/${selectedId}`, { method: 'DELETE' });
    if (!response.ok) {
      settingsFeedback = 'Could not delete device. Check the monitoring service.';
      actionsMenuOpen = false;
      render();
      return;
    }
    nodes = nodes.filter((node) => node.id !== selectedId);
    selectedId = nodes[0]?.id || '';
    actionsMenuOpen = false;
    render();
  });
  const deviceForm = document.querySelector('#device-form');
  if (deviceForm) {
    // Lock before the browser focuses the field, including during an in-flight poll.
    deviceForm.addEventListener('pointerdown', () => { editingSettings = true; });
    deviceForm.addEventListener('focusin', () => { editingSettings = true; });
  }
  if (deviceForm) deviceForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const settings = getDeviceFormValues(event.currentTarget);
    if (!settings.name.trim() || !settings.ip.trim()) {
      settingsFeedback = 'Name and IP address are required.';
      editingSettings = false;
      render();
      return;
    }
    settingsFeedback = 'Saving settings...';
    render();
    try {
      const response = await fetch(`${API_URL}/${selectedId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings) });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || 'Could not save settings. Check the monitoring service.');
      }
      const savedNode = await response.json();
      nodes = nodes.map((node) => node.id === selectedId ? { ...node, ...savedNode, type: settings.type } : node);
      settingsFeedback = 'Settings saved.';
    } catch (error) {
      settingsFeedback = error.message || 'Could not save settings. Check the monitoring service.';
    }
    settingsDraft = null;
    editingSettings = false;
    render();
  });
  document.querySelectorAll('#device-form input, #device-form select').forEach((control) => {
    control.addEventListener('focus', () => { editingSettings = true; });
    control.addEventListener('input', () => {
      settingsDraft = { id: selectedId, ...getDeviceFormValues(document.querySelector('#device-form')) };
    });
    control.addEventListener('change', () => {
      settingsDraft = { id: selectedId, ...getDeviceFormValues(document.querySelector('#device-form')) };
    });
    control.addEventListener('blur', () => {
      setTimeout(() => {
        if (!document.querySelector('#device-form :focus')) editingSettings = false;
      }, 0);
    });
  });
  document.querySelectorAll('#device-form .password-toggle').forEach((button) => button.addEventListener('click', () => {
    settingsDraft = { id: selectedId, ...getDeviceFormValues(document.querySelector('#device-form')) };
    const field = button.dataset.field;
    if (visiblePasswordFields.has(field)) visiblePasswordFields.delete(field); else visiblePasswordFields.add(field);
    render();
  }));
  const toggleAllPasswords = document.querySelector('#toggle-all-passwords');
  if (toggleAllPasswords) toggleAllPasswords.addEventListener('click', () => {
    settingsDraft = { id: selectedId, ...getDeviceFormValues(document.querySelector('#device-form')) };
    const fieldNames = [...document.querySelectorAll('#device-form .password-toggle')].map((button) => button.dataset.field);
    const allVisible = fieldNames.every((name) => visiblePasswordFields.has(name));
    fieldNames.forEach((name) => (allVisible ? visiblePasswordFields.delete(name) : visiblePasswordFields.add(name)));
    render();
  });
  document.querySelectorAll('.dialog-close-x').forEach((button) => button.addEventListener('click', () => {
    document.getElementById(button.dataset.closeTarget)?.click();
  }));
  enableDialogChrome();
}

// Popup dialogs are plain flex/grid-centered boxes tagged with [data-dialog-key]; this makes
// them draggable (by their h2/header) and remembers drag position + CSS resize across re-renders,
// since the box element itself gets recreated on every full render().
const dialogChrome = new Map();
function enableDialogChrome() {
  document.querySelectorAll('[data-dialog-key]').forEach((box) => {
    const key = box.dataset.dialogKey;
    let state = dialogChrome.get(key);
    if (!state) { state = { dx: 0, dy: 0, width: '', height: '' }; dialogChrome.set(key, state); }
    box.style.transform = `translate(${state.dx}px, ${state.dy}px)`;
    if (state.width) box.style.width = state.width;
    if (state.height) box.style.height = state.height;

    const handle = box.querySelector(':scope > h2, :scope > header');
    if (handle) {
      handle.classList.add('dialog-drag-handle');
      handle.addEventListener('mousedown', (event) => {
        if (event.target.closest('button')) return;
        event.preventDefault();
        const startX = event.clientX;
        const startY = event.clientY;
        const startDx = state.dx;
        const startDy = state.dy;
        const onMove = (moveEvent) => {
          state.dx = startDx + (moveEvent.clientX - startX);
          state.dy = startDy + (moveEvent.clientY - startY);
          box.style.transform = `translate(${state.dx}px, ${state.dy}px)`;
        };
        const onUp = () => {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    }

    new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      state.width = `${Math.round(entry.contentRect.width)}px`;
      state.height = `${Math.round(entry.contentRect.height)}px`;
    }).observe(box);
  });
}

function endPointerInteraction() {
  if (dragging) {
    const node = nodes.find((item) => item.id === dragging.id);
    fetch(`${API_URL}/${node.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ x: node.x, y: node.y }) }).catch(() => {});
  }
  dragging = null;
  if (selecting) {
    selecting = null;
    render();
  }
  if (panning) document.querySelector('#canvas-wrap').style.cursor = '';
  panning = null;
  if (resizingPanel) {
    document.querySelector(`#${resizingPanel.panel}-handle`)?.classList.remove('active');
    resizingPanel = null;
    render();
  }
  if (resizingCanvas) {
    zoom = resizingCanvas.nextZoom;
    resizingCanvas = null;
    render();
  }
}

function moveNode(event) {
  if (resizingCanvas) {
    const delta = event.clientX - resizingCanvas.startX;
    resizingCanvas.nextZoom = Math.min(2.5, Math.max(0.5, +(resizingCanvas.startZoom * ((resizingCanvas.startWidth + delta) / resizingCanvas.startWidth)).toFixed(2)));
    const canvas = document.querySelector('#canvas');
    canvas.style.width = `${resizingCanvas.nextZoom * 100}%`;
    canvas.style.height = `${resizingCanvas.nextZoom * 100}%`;
    return;
  }
  if (resizingPanel) {
    const delta = event.clientX - resizingPanel.startX;
    const workspace = document.querySelector('.workspace');
    if (resizingPanel.panel === 'sidebar') {
      sidebarWidth = Math.min(420, Math.max(180, resizingPanel.startWidth + delta));
    } else {
      inspectorWidth = Math.min(560, Math.max(240, resizingPanel.startWidth - delta));
    }
    workspace.style.gridTemplateColumns = `${sidebarWidth}px 6px minmax(400px,1fr) 6px ${inspectorWidth}px`;
    return;
  }
  if (selecting) {
    const bounds = selecting.canvas.getBoundingClientRect();
    const currentX = Math.min(Math.max(event.clientX - bounds.left, 0), bounds.width);
    const currentY = Math.min(Math.max(event.clientY - bounds.top, 0), bounds.height);
    const left = Math.min(selecting.startX, currentX);
    const top = Math.min(selecting.startY, currentY);
    const width = Math.abs(currentX - selecting.startX);
    const height = Math.abs(currentY - selecting.startY);
    const marquee = document.querySelector('#selection-marquee');
    marquee.style.left = `${left}px`;
    marquee.style.top = `${top}px`;
    marquee.style.width = `${width}px`;
    marquee.style.height = `${height}px`;
    marquee.classList.toggle('visible', width > 3 || height > 3);
    const marqueeBounds = marquee.getBoundingClientRect();
    selectedNodeIds = new Set(nodes.filter((node) => {
      const nodeBounds = document.querySelector(`[data-id="${node.id}"]`).getBoundingClientRect();
      return nodeBounds.left < marqueeBounds.right && nodeBounds.right > marqueeBounds.left && nodeBounds.top < marqueeBounds.bottom && nodeBounds.bottom > marqueeBounds.top;
    }).map((node) => node.id));
    if (selectedNodeIds.size) selectedId = [...selectedNodeIds][0];
    document.querySelectorAll('.map-node').forEach((node) => node.classList.toggle('is-selected', selectedNodeIds.has(node.dataset.id)));
    return;
  }
  if (panning) {
    const wrap = document.querySelector('#canvas-wrap');
    wrap.scrollLeft = panning.scrollLeft - (event.clientX - panning.startX);
    wrap.scrollTop = panning.scrollTop - (event.clientY - panning.startY);
    return;
  }
  if (!dragging) return;
  const canvas = document.querySelector('#canvas');
  const bounds = canvas.getBoundingClientRect();
  const node = nodes.find((item) => item.id === dragging.id);
  node.x = Math.min(94, Math.max(6, dragging.x + ((event.clientX - dragging.startX) / bounds.width) * 100));
  node.y = Math.min(91, Math.max(6, dragging.y + ((event.clientY - dragging.startY) / bounds.height) * 100));
  const element = document.querySelector(`[data-id="${node.id}"]`);
  element.style.left = `${node.x}%`; element.style.top = `${node.y}%`;
  drawLinks();
}

const DELETE_CHUNK_SIZE = 250;
const PROGRESS_THRESHOLD = 100;

async function deleteSelectedNodes() {
  const ids = [...selectedNodeIds];
  if (!ids.length) return;
  if (!window.confirm(`Delete ${ids.length} selected device${ids.length === 1 ? '' : 's'}?`)) {
    selectedNodeIds = new Set();
    render();
    return;
  }
  const showProgress = ids.length > PROGRESS_THRESHOLD;
  if (showProgress) { taskProgress = { title: `Deleting ${ids.length} devices…`, current: 0, total: ids.length }; render(); }
  const deletedIds = new Set();
  for (let offset = 0; offset < ids.length; offset += DELETE_CHUNK_SIZE) {
    const chunk = ids.slice(offset, offset + DELETE_CHUNK_SIZE);
    try {
      const response = await fetch(`${API_URL}/delete-bulk`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: chunk }) });
      if (response.ok) chunk.forEach((id) => deletedIds.add(id));
    } catch { /* leave undeleted ids in place, reported below */ }
    if (showProgress) { taskProgress = { ...taskProgress, current: Math.min(ids.length, offset + chunk.length) }; render(); }
  }
  nodes = nodes.filter((node) => !deletedIds.has(node.id));
  selectedNodeIds = new Set();
  selectedId = nodes[0]?.id || '';
  if (deletedIds.size !== ids.length) pingFeedback = `Could not delete ${ids.length - deletedIds.size} selected device${ids.length - deletedIds.size === 1 ? '' : 's'}.`;
  taskProgress = null;
  render();
}

async function deleteAllNodes() {
  if (!nodes.length) return;
  if (!window.confirm(`Delete all ${nodes.length} device${nodes.length === 1 ? '' : 's'} from ${workspaceName}? This cannot be undone.`)) return;
  const showProgress = nodes.length > PROGRESS_THRESHOLD;
  if (showProgress) { taskProgress = { title: `Deleting ${nodes.length} devices…`, indeterminate: true }; render(); }
  try {
    const response = await fetch(API_URL, { method: 'DELETE' });
    if (!response.ok) throw new Error();
    nodes = [];
    links = [];
    selectedNodeIds = new Set();
    selectedId = '';
    workspaceFeedback = 'All devices deleted.';
  } catch {
    workspaceFeedback = 'Could not delete all devices. Check the monitoring service.';
  }
  taskProgress = null;
  render();
  setTimeout(() => { workspaceFeedback = ''; render(); }, 4000);
}

function renderWindImportDialog() {
  return `<div class="link-dialog" role="dialog" aria-modal="true" aria-labelledby="wind-import-title"><form id="wind-import-form" data-dialog-key="wind-import">${renderDialogHeader('Import Wind nodes', 'cancel-wind-import')}<label>Wind domain name<input name="domain" value="${escapeHtml(windImportDomain)}" placeholder="www.wna.gr/wind" required /></label><button class="primary-btn" type="submit">Import</button><button class="cancel-link" type="button" id="cancel-wind-import">Cancel</button></form></div>`;
}

function renderDudeImportDialog() {
  return `<div class="link-dialog" role="dialog" aria-modal="true" aria-labelledby="dude-import-title"><form id="dude-import-form" data-dialog-key="dude-import">${renderDialogHeader('Import Dude nodes', 'cancel-dude-import')}<p class="discovery-status">In The Dude, open the Devices list, select all, and export/copy it to a CSV file. Optionally do the same for the Links list to import connections.</p><label>Devices CSV<input type="file" name="devices" accept=".csv,text/csv" />${dudeImportFiles.devices ? `<small>Selected: ${escapeHtml(dudeImportFiles.devices.name)}</small>` : ''}</label><label>Links CSV <small>(optional)</small><input type="file" name="links" accept=".csv,text/csv" />${dudeImportFiles.links ? `<small>Selected: ${escapeHtml(dudeImportFiles.links.name)}</small>` : ''}</label><button class="primary-btn" type="submit">Import</button><button class="cancel-link" type="button" id="cancel-dude-import">Cancel</button></form></div>`;
}

function renderTaskProgress() {
  if (!taskProgress) return '';
  const percent = taskProgress.total ? Math.min(100, Math.round((taskProgress.current / taskProgress.total) * 100)) : 0;
  return `<div class="link-dialog" role="dialog" aria-modal="true" aria-labelledby="task-progress-title"><div class="task-progress"><h2 id="task-progress-title">${escapeHtml(taskProgress.title)}</h2><div class="progress-bar ${taskProgress.indeterminate ? 'indeterminate' : ''}"><i style="width:${taskProgress.indeterminate ? 100 : percent}%"></i></div><p class="task-progress-status">${taskProgress.indeterminate ? 'Working…' : `${taskProgress.current} / ${taskProgress.total} (${percent}%)`}</p></div></div>`;
}

function bindWorkspaceEvents() {
  document.querySelectorAll('.workspace-tab-select').forEach((tab) => tab.addEventListener('click', () => selectWorkspace(tab.dataset.workspaceId)));
  document.querySelectorAll('.workspace-tab-delete').forEach((button) => button.addEventListener('click', (event) => {
    event.stopPropagation();
    deleteWorkspace(button.dataset.deleteWorkspaceId);
  }));
  const newWorkspaceTab = document.querySelector('#new-workspace-tab');
  if (newWorkspaceTab) newWorkspaceTab.addEventListener('click', createWorkspace);
  const menuToggle = document.querySelector('#workspace-menu-toggle');
  if (menuToggle) menuToggle.addEventListener('click', () => { workspaceMenuOpen = !workspaceMenuOpen; render(); });
  const newWorkspaceButton = document.querySelector('#new-workspace');
  if (newWorkspaceButton) newWorkspaceButton.addEventListener('click', createWorkspace);
  const renameButton = document.querySelector('#rename-workspace');
  if (renameButton) renameButton.addEventListener('click', () => { workspaceMenuOpen = false; editingWorkspaceName = true; render(); document.querySelector('#workspace-name-input')?.focus(); });
  const exportButton = document.querySelector('#export-workspace');
  if (exportButton) exportButton.addEventListener('click', async () => { workspaceMenuOpen = false; await exportWorkspace(); render(); });
  const importButton = document.querySelector('#import-workspace');
  const importInput = document.querySelector('#import-workspace-input');
  if (importButton && importInput) importButton.addEventListener('click', () => { workspaceMenuOpen = false; render(); document.querySelector('#import-workspace-input').click(); });
  const deleteAllButton = document.querySelector('#delete-all-nodes');
  if (deleteAllButton) deleteAllButton.addEventListener('click', () => { workspaceMenuOpen = false; deleteAllNodes(); });
  const windImportButton = document.querySelector('#import-wind');
  if (windImportButton) windImportButton.addEventListener('click', () => {
    workspaceMenuOpen = false;
    windImportOpen = true;
    render();
    document.querySelector('#wind-import-form input').focus();
  });
  const closeWindImport = () => { windImportOpen = false; render(); document.querySelector('#workspace-menu-toggle')?.focus(); };
  document.querySelector('#cancel-wind-import')?.addEventListener('click', closeWindImport);
  const windImportForm = document.querySelector('#wind-import-form');
  windImportForm?.addEventListener('input', () => { windImportDomain = windImportForm.elements.domain.value; });
  windImportForm?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); closeWindImport(); }
  });
  windImportForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const domain = windImportForm.elements.domain.value.trim();
    if (!domain) { windImportForm.elements.domain.focus(); return; }
    windImportDomain = domain;
    windImportOpen = false;
    taskProgress = { title: 'Importing Wind nodes…', indeterminate: true };
    render();
    try {
      const response = await fetch('/api/integrations/wind/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ domain: domain.trim() }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Wind import failed.');
      nodes = [...nodes, ...(result.newNodes || [])];
      links = [...links, ...(result.newLinks || [])];
      selectedId = nodes[0]?.id || '';
      workspaceFeedback = `Imported ${result.imported} Wind node${result.imported === 1 ? '' : 's'}${result.skipped ? `, skipped ${result.skipped} existing` : ''}; ${result.linked || 0} links added.`;
    } catch (error) {
      workspaceFeedback = error.message || 'Could not import Wind nodes.';
    }
    taskProgress = null;
    render();
    setTimeout(() => { workspaceFeedback = ''; render(); }, 5000);
  });
  if (importInput) importInput.addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (file) await importWorkspace(file);
    event.target.value = '';
  });
  const dudeImportButton = document.querySelector('#import-dude');
  if (dudeImportButton) dudeImportButton.addEventListener('click', () => {
    workspaceMenuOpen = false;
    dudeImportOpen = true;
    dudeImportFiles = { devices: null, links: null };
    render();
  });
  const closeDudeImport = () => { dudeImportOpen = false; render(); document.querySelector('#workspace-menu-toggle')?.focus(); };
  document.querySelector('#cancel-dude-import')?.addEventListener('click', closeDudeImport);
  const dudeImportForm = document.querySelector('#dude-import-form');
  dudeImportForm?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); closeDudeImport(); }
  });
  dudeImportForm?.elements.devices?.addEventListener('change', (event) => { dudeImportFiles.devices = event.target.files[0] || null; render(); document.querySelector('#dude-import-form')?.elements.devices?.focus(); });
  dudeImportForm?.elements.links?.addEventListener('change', (event) => { dudeImportFiles.links = event.target.files[0] || null; render(); document.querySelector('#dude-import-form')?.elements.links?.focus(); });
  dudeImportForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    // Re-rendering after each file pick recreates the <input>, clearing its FileList, so read from
    // dudeImportFiles (captured at selection time) instead of the form element's current files.
    const devicesFile = dudeImportFiles.devices;
    if (!devicesFile) return;
    const linksFile = dudeImportFiles.links;
    dudeImportOpen = false;
    taskProgress = { title: 'Importing Dude nodes…', indeterminate: true };
    render();
    try {
      const devicesCsv = await devicesFile.text();
      const linksCsv = linksFile ? await linksFile.text() : '';
      const response = await fetch('/api/integrations/dude/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ devicesCsv, linksCsv }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Dude import failed.');
      nodes = [...nodes, ...(result.newNodes || [])];
      links = [...links, ...(result.newLinks || [])];
      selectedId = nodes[0]?.id || '';
      workspaceFeedback = `Imported ${result.imported} Dude device${result.imported === 1 ? '' : 's'}${result.skipped ? `, skipped ${result.skipped} existing` : ''}; ${result.linked || 0} links added.`;
    } catch (error) {
      workspaceFeedback = error.message || 'Could not import Dude nodes.';
    }
    taskProgress = null;
    render();
    setTimeout(() => { workspaceFeedback = ''; render(); }, 5000);
  });  const renameForm = document.querySelector('#workspace-rename-form');
  if (renameForm) renameForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = document.querySelector('#workspace-name-input').value.trim();
    if (!name) { editingWorkspaceName = false; render(); return; }
    try {
      const response = await fetch('/api/workspace', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
      if (!response.ok) throw new Error();
      workspaceName = (await response.json()).name;
      snapshotActiveWorkspace();
    } catch {
      workspaceFeedback = 'Could not rename workspace.';
      setTimeout(() => { workspaceFeedback = ''; render(); }, 4000);
    }
    editingWorkspaceName = false;
    render();
  });
  const cancelRename = document.querySelector('#cancel-workspace-rename');
  if (cancelRename) cancelRename.addEventListener('click', () => { editingWorkspaceName = false; render(); });
}

function startDemoWorkspace() {
  nodes = demoNodes.map((node) => ({ ...defaultSnmpSettings, ...node }));
  links = [];
  selectedId = nodes[0]?.id || '';
  startupState = 'ready';
}

async function bootstrapWorkspace() {
  try {
    const workspace = await fetch('/api/workspace').then((response) => response.ok ? response.json() : Promise.reject());
    workspaceName = workspace.name || workspaceName;
    workspaces[0].name = workspaceName;
    if (workspace.hasLocalConfig || workspace.hasLocalWorkspace || workspace.hasLocalSavedWorkspace) {
      nodes = [];
      links = [];
      selectedId = '';
      startupState = 'loading-local';
      render();
      await refreshMetrics({ force: true, replaceNodes: true });
      return;
    }
  } catch {
    // Fall back to the demo topology when the local API is unavailable.
  }

  startDemoWorkspace();
  render();
  await refreshMetrics({ force: true });
}

async function exportWorkspace() {
  try {
    const bundle = await fetch('/api/workspace/export').then((response) => response.ok ? response.json() : Promise.reject());
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${bundle.workspace.name.replace(/[^a-z0-9-]+/gi, '-')}.json`;
    link.click();
    URL.revokeObjectURL(url);
  } catch {
    workspaceFeedback = 'Could not export workspace.';
    setTimeout(() => { workspaceFeedback = ''; render(); }, 4000);
  }
}

async function importWorkspace(file) {
  taskProgress = { title: 'Importing workspace…', indeterminate: true };
  render();
  try {
    const payload = JSON.parse(await file.text());
    const response = await fetch('/api/workspace/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!response.ok) throw new Error((await response.json()).error || 'Import failed.');
    const result = await response.json();
    workspaceName = result.workspace.name;
    nodes = result.nodes;
    links = result.links;
    snapshotActiveWorkspace();
    selectedId = nodes[0]?.id || '';
    startupState = 'ready';
    workspaceFeedback = 'Workspace imported.';
  } catch (error) {
    workspaceFeedback = error instanceof SyntaxError ? 'Invalid workspace file.' : 'Could not import workspace.';
  }
  taskProgress = null;
  render();
  setTimeout(() => { workspaceFeedback = ''; render(); }, 4000);
}

// The server ICMP-pings offline nodes on every poll; surface that as pingReachable/pingLatency
// so the "online (ping)" indicator stays live instead of only reflecting the last manual ping.
function withPingState(metric) {
  return { ...metric, pingReachable: metric.status === 'offline' ? metric.reachable ?? false : false, pingLatency: metric.status === 'offline' ? metric.latency ?? null : null };
}

async function refreshMetrics(options = {}) {
  const { force = false, replaceNodes = false, workspaceId = activeWorkspaceId } = options;
  if ((!force && startupState !== 'ready') || (!force && isEditingLocked()) || refreshInFlight) return;
  refreshInFlight = true;
  try {
    const metrics = await fetch(API_URL).then((response) => response.ok ? response.json() : Promise.reject());
    if (workspaceId !== activeWorkspaceId) return;
    if (isEditingLocked()) return;
    const previousStatusById = new Map(nodes.map((node) => [node.id, node.status]));
    const metricsById = new Map(metrics.map((metric) => [metric.id, metric]));
    if (replaceNodes) {
      nodes = metrics.map(withPingState);
    } else {
      nodes = nodes.flatMap((node) => {
        const metric = metricsById.get(node.id);
        return metric ? [{ ...node, ...withPingState(metric) }] : [];
      });
    }
    if (!selectedId || !nodes.some((node) => node.id === selectedId)) selectedId = nodes[0]?.id || '';
    const updatedLinks = await fetch('/api/links').then((response) => response.ok ? response.json() : Promise.reject());
    if (workspaceId !== activeWorkspaceId) return;
    const activeNodeIds = new Set(nodes.map((node) => node.id));
    links = updatedLinks.filter((link) => activeNodeIds.has(link.sourceId) && activeNodeIds.has(link.targetId));
    if (isEditingLocked()) return;
    notifyDevicesThatWentDown(previousStatusById, metrics);
    notificationBaselineReady = true;
    startupState = 'ready';
    render();
  } catch {
    if (force && !isEditingLocked()) {
      startupState = 'ready';
      render();
    }
  } finally {
    refreshInFlight = false;
  }
}

window.addEventListener('pointermove', moveNode);
window.addEventListener('pointerup', endPointerInteraction);
window.addEventListener('pointercancel', endPointerInteraction);

render();
bootstrapWorkspace();
refreshReleaseIndicator();
setInterval(refreshReleaseIndicator, 60 * 60 * 1000);
setInterval(refreshMetrics, 1000);

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Delete' || event.target.matches('input, select, textarea') || !selectedNodeIds.size) return;
  event.preventDefault();
  deleteSelectedNodes();
});
