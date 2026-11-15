# PeerRoom

Minimal, browser-based peer-to-peer voice chat and screen sharing. Runs on GitHub Pages with no application backend or build step.

## Features

- One-to-one voice calls and screen sharing via WebRTC
- Optional tab/system audio sharing (browser and OS dependent)
- Microphone selection and mute controls
- Music input mode (disables echo cancellation, noise suppression, and auto gain)
- Peer-to-peer text chat over a WebRTC data channel
- Static HTML, CSS, and JavaScript; no external runtime dependencies

## Connect

1. Open the site in two browsers.
2. **Host:** Select **Host**, generate an offer, and send its code to the other person.
3. **Join:** Select **Join**, paste the offer, generate an answer, and send the answer code back.
4. **Host:** Paste the answer and select **Connect**.
5. Once connected, start your microphone or screen share.

The offer and answer must be exchanged manually (for example, in a private messenger). This avoids the need for a signaling service.

## Deploy to GitHub Pages

This repository can be deployed directly from the root of the `main` branch using **Settings → Pages → Deploy from a branch**. No install, build, or server configuration is required.

For local testing, use a secure context such as `http://localhost`. GitHub Pages uses HTTPS automatically.

## Limitations

- **No TURN relay.** Direct P2P connection may fail behind restrictive NATs, VPNs, firewalls, or some mobile networks.
- **Public STUN by default.** Google STUN servers are used for connectivity discovery, not media relay. Disable STUN for local-only experiments.
- **Manual signaling.** There are no room links, automatic matchmaking, or hosted connection servers.
- **One-to-one only.** Multi-user rooms are not implemented.
- **Screen/system audio support varies.** Browser and OS restrictions apply; mobile browsers may not support screen capture.
- **Connection codes may expose network information.** Share them privately.

Media is encrypted in transit by WebRTC. This app does not record, upload, or store calls. Users connect directly whenever the network permits.

## Files

- `index.html` — UI
- `style.css` — styles
- `app.js` — WebRTC, audio, signaling, and chat
