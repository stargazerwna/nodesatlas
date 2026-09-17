# Changelog

All notable changes to nodesAtlas are documented in this file.
## [1.5.0] - 2026-09-17

### Added

- Add a "Torch" right-click option for MikroTik devices, showing a live per-flow traffic table (source/destination, protocol, rates) for a chosen interface, streamed from the RouterOS API.
- Add a "Traceroute" tool (right-click on a device, or from the toolbar for any address) showing hops, per-hop loss, and round-trip times live as they arrive, instead of waiting for the whole trace to finish.
- Add a "Ping" tool to the toolbar for pinging any address, not just monitored devices.
- Add a "Changelog" tab to the License dialog.
- Make popup dialogs (link, discovery, wireless clients, Torch, Traceroute, Ping, import dialogs, license) draggable by their title bar, resizable, and closable with a top-right × button.
- Fall back to the RouterOS API for MikroTik wireless registration table and interface listing when SNMP doesn't expose them, instead of silently showing "no devices"/"no interfaces".

### Fixed

- Surface real MikroTik/OpenWrt API errors (login failures, permission errors, connection issues) in the wireless clients, Torch, and Traceroute dialogs instead of silently showing an empty result.
- Stop live-polling dialogs (Torch, Traceroute) from resetting in-progress typing or collapsing an open dropdown by patching only their results area instead of re-rendering the whole dialog.
- Deselect the device on the canvas when closing the inspector panel.
- Label OpenWrt credential fields as SSH username/password instead of API username/password.

## [1.4.0] - 2026-09-16

### Added

- Add "Import Dude nodes" to import devices and links from MikroTik Dude Devices/Links CSV exports, deduping devices by IP across maps and pairing link rows per map.

### Fixed

- Keep the Dude/Wind import dialogs open during live metric refreshes so the file picker selection isn't lost.
- Show the selected file name in the Dude import dialog and read the chosen files reliably after re-render.
- Dedupe re-imported Dude links by endpoint pair instead of a generated id, so re-importing the same export doesn't create duplicate links.
## [1.3.1] - 2026-09-16

### Added

- Add a workspace import flow for The Dude, accepting exported Devices and optional Links CSV files and reconstructing the topology with duplicate detection.

## [1.3.0] - 2026-09-15

### Added

- Add a "Wireless clients" right-click option for MikroTik and OpenWRT devices, listing wirelessly registered devices (MAC, hostname, IP, SSID, signal) with a one-click action to add any of them for monitoring.
- Add optional RouterOS API credentials (username, password, port) per MikroTik node, and OpenWrt ubus credentials per OpenWRT node, so wireless client hostnames come from the router's DHCP lease table instead of relying on reverse DNS.
- Add per-field eye-icon toggles and a "show/hide all" toggle to reveal password fields (SNMPv3 auth/encryption keys, RouterOS/OpenWrt API password) in device settings.

## [1.2.3] - 2026-09-08

### Fixed

- Exclude saved local network and workspace configuration from portable downloads.
- Fix "Import Wind nodes" doing nothing in the desktop app by replacing the unsupported browser prompt with an in-app domain form.
- Preserve the Wind domain while live metrics refresh, and support cancelling the import form.

## [1.2.2] - 2026-09-07

### Added

- Show a clickable version indicator when a newer stable GitHub release is available, checking at startup and hourly.

## [1.2.1] - 2026-09-06

### Added

- Add drag-to-select support for multiple topology nodes and bulk deletion with confirmation.
- Add a lower-left copyright link that opens the bundled MIT license.

### Fixed

- Keep Wind imports and live metric refreshes scoped to the active workspace tab.
- Load topology immediately when selecting an empty workspace tab.

## [1.2.0] - 2026-09-04

### Added

- Display CPU and memory utilization on canvas nodes.
- Add LLDP, CDP, and MikroTik neighbor discovery with selectable map import.
- Add canvas panning, wheel zoom, scrollbars, and a corner resize handle.
- Add resizable and collapsible sidebar and inspector panels.
- Add SNMPv3 authentication and encryption support for polling, links, interfaces, and discovery.
- Add SNMP credential controls in the inspector, including visible SNMP v2c community, v3 user, auth protocol, and encryption protocol.
- Add a node right-click menu action to open the device GUI at `http://<node-ip>`.
- Add traffic-aware link styling for links above 1 Mbps, 10 Mbps, 40 Mbps, and 50 Mbps.

### Fixed

- Use HOST-RESOURCES-MIB CPU and memory OIDs for MikroTik RouterOS.
- Correct discovery checkbox styling in the dialog.
- Keep the inspector stable while device settings are focused or being edited during live refreshes.
- Prevent browser text selection while interacting with the topology canvas.
- Show a startup loader while local workspace files are checked, and only show demo nodes when no local workspace exists.
