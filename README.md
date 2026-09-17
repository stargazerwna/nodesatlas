# nodesAtlas
( https://wna.gr/nodeatlas )
## Run

Install dependencies, then start the API and UI in separate terminals:

```powershell
npm install
npm run server
npm run dev
```

The UI runs at `http://127.0.0.1:5173` and its `/api` requests are proxied to the SNMP service at `http://127.0.0.1:3001`. Once the service responds, its configured nodes become the topology shown in the canvas.

## Configure Nodes

Copy `nodes.example.json` to `nodes.local.json`, then set each device's `ip` and SNMP credentials. `nodes.local.json` is ignored by Git so credentials are not committed. In the UI, select a node and use the inspector's settings form to change its name, device type, router platform, IP address, SNMP port, SNMP version, v2c community, or SNMPv3 authentication/encryption settings. The saved SNMP community is shown directly in the form.

```powershell
Copy-Item nodes.example.json nodes.local.json
```

To import public nodes from a WiND database, open the workspace menu, choose **Import Wind nodes**, and enter the Wind domain (for example, `www.wna.gr/wind`). The importer reads the public map XML, places nodes using their geographic coordinates, merges duplicates by Wind node ID, defaults their SNMP community to `Public`, and saves them to `nodes.local.json`. WiND's public map does not include SNMP addresses, so imported nodes appear offline until an IP address is configured in the inspector.

To import devices from The Dude, open the workspace menu and choose **Import Dude nodes**. Select the exported Devices CSV and optionally the Links CSV from a Dude topology export, then the app merges each discovered device into the current workspace and recreates the map's link pairs when possible. Existing nodes are skipped and the imported list is saved to `nodes.local.json`.

The service queries `sysDescr`, `sysUpTime`, and interface receive/transmit byte counters. It also queries UCD-SNMP CPU idle and real-memory counters when a device exposes them. If a device does not support those optional health OIDs, CPU and memory display as unavailable while uptime and traffic continue to work.

The desktop app shows an OS notification when a monitored device changes from online/degraded to offline. Existing offline devices are treated as the startup baseline, so notifications only fire for new down events after the first successful metrics refresh.

At startup and hourly, the app checks GitHub for a newer stable release. When available, an **Update available: v…** link appears in the top bar and opens the release page for download (in your default browser on desktop). Offline or failed checks leave the indicator hidden.

No database is needed for a single local site: `nodes.local.json` persists node configuration and IP address edits. Use a database when deploying for multiple users/sites, retaining historical metrics, or needing authentication and audit trails.

To delete a node, select it, open the three-dots menu in the device inspector, then choose **Delete device** and confirm. The removal is saved to `nodes.local.json`.

Right-click a node and select **Duplicate** to create a persisted copy, offset slightly from the original.

Dragging a node to a new position saves its canvas coordinates to `nodes.local.json` when you release it.

Use `SNMP_COMMUNITY`, `SNMP_PORT`, `SNMP_TIMEOUT`, `SNMP_RETRIES`, `SNMPV3_USER`, `SNMPV3_AUTH_KEY`, `SNMPV3_PRIV_KEY`, `SNMPV3_CONTEXT`, or `NODES_CONFIG` environment variables to override defaults. Nodes which do not answer within the configured timeout are returned as offline.
