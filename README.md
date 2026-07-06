# FallPod

**One unified store for every estate tool.**

FallPod is a sovereign data pod, inspired by [Solid](https://solidproject.org). Instead of every tool keeping its own private silo of localStorage / IndexedDB, they all read from and write to one shared, path-based store — living on your device, keyed to your identity.

- **Path-based namespace** like a filesystem: `/bloom/current`, `/mirror/sessions/2026-07-06`, `/signatures/…`
- **FallID-owned** — encryption keys derive from your DID
- **Per-app grants** — tools request access to specific patterns, you approve/revoke
- **OPFS + IDB** — large blobs on Origin Private File System (Chrome/Edge), everything else on IndexedDB (universal)
- **AES-GCM at rest** — encryption by default
- **Optional signing** — via FallID
- **Change subscriptions** — tools react to writes in other paths

Runs entirely in the browser. No server. No account. No rental.

## Try it

Live dashboard: **https://sjgant80-hub.github.io/fallpod/**

## Library usage

```js
import { openPod } from 'https://sjgant80-hub.github.io/fallpod/fallpod.js';

const pod = await openPod({ ownerDid: myFallID.did });

// write
await pod.put('/bloom/current', { streak: 47, last: Date.now() });
await pod.put('/notes/today', 'Journal entry text.', { encrypt: true, sign: true });

// read
const cur = await pod.get('/bloom/current');

// list
const journalKeys = await pod.list('/notes/');

// exists / delete
await pod.exists('/bloom/current');   // true
await pod.delete('/notes/today');

// per-app grants
await pod.grant('fallmirror', ['/mirror/**', '/shared/journal/*']);
await pod.revoke('fallmirror');

// subscribe to changes anywhere under a prefix
const unsub = pod.subscribe('/bloom/', evt => console.log('bloom changed', evt));

// export / import
const snap = await pod.export();
await pod.import(snap, { mode: 'merge' });   // or 'replace'
```

## Requesting access from a third-party app

```js
const pod = await openPod({ ownerDid });
const granted = await pod.requestAccess(
  ['/mirror/**'],
  'FallMirror needs to save your reflection sessions.',
  'fallmirror'
);
// user sees a permission modal in the FallPod dashboard
```

## Namespace convention

| Path | Purpose |
|---|---|
| `/` | Root |
| `/.grants/<appId>` | Per-app access grants |
| `/.meta/` | Pod metadata |
| `/apps/<appId>/…` | Default per-app sandbox (no grant needed) |
| `/bloom/…`, `/mirror/…`, `/brief/…` | Shared estate data by tool |
| `/signatures/…` | FallID-signed payloads |
| `/shared/…` | Cross-tool shared state |

## Estate primitives it uses

- [FallID](https://sjgant80-hub.github.io/fallid/) — owner identity + optional signing
- [FallStore](https://sjgant80-hub.github.io/fallstore/) — optional content-addressed blob backing

## License

MIT · AI-Native Solutions · 2026
