This folder contains the Electron wrapper for the local desktop app.

Run locally:

```
npm install
npm run electron
```

Build Windows portable app:

```
npm run package:win
```

The packaged build will create a portable executable under dist-electron.

Build a Linux Flatpak bundle:

```
npm run package:linux
```

The bundle is created under dist-electron and can be installed with `flatpak install --user ./dist-electron/nodesAtlas-<version>-x86_64.flatpak`.
