# PeerRoom

Minimal browser-based voice chat and screen sharing over WebRTC.

**Live:** https://riyoway.github.io/PeerRoom/

## Use

1. Open the site and click **Create room**.
2. Send the invite link to someone. It is copied automatically when browser permissions allow.
3. They open the link and the browsers connect automatically. Use **Start mic** or **Share screen**.

No accounts, offer/answer codes, or app installation required.

## Features

- One-link room invites and automatic peer discovery
- One-to-one WebRTC voice calls and screen sharing
- Browser tab/system audio sharing when supported
- Microphone selection and an optional music input mode
- P2P chat, mute controls, and leave/rejoin
- Static site, deployed on GitHub Pages

## Architecture

The **app is hosted entirely on GitHub Pages**. Peer discovery and WebRTC signaling use public Nostr relays via [Trystero](https://trystero.dev/); there is no application server or relay that you need to host or pay for.

Once connected, media and chat are end-to-end encrypted and transmitted directly between browsers. Public signaling relays can see limited connection metadata, but they do not carry the call's media. Invite tokens are generated randomly and stored in the URL fragment (the part starting with #r=), which is not included in HTTP requests.

The app does **not** operate without any external services: automatic signaling depends on public Nostr relays, and direct P2P connectivity commonly uses public STUN servers. No TURN relay is configured, so connections can fail behind restrictive networks. Public relays may be unavailable or slow; this is a demonstration, not a high-availability calling platform.

The app does not record or upload call audio/video. Rooms have a best-effort two-user limit; anyone with the invite link may attempt to join. Share links privately.

## Development

The generated app.js is committed so GitHub Pages needs **no build step**.

To modify the client source:

    npm ci
    npm run build

The source code is src/app.js, with bundled browser output in app.js. Deploy the repository's root directory from the main branch in **Settings → Pages**.

## Browser requirements

Modern desktop browsers with WebRTC, HTTPS for microphone and screen capture, and access to the public signaling relays. System audio capture depends on OS/browser support. Mobile screen capture may be unavailable.

Third-party code: Trystero (MIT) and bundled dependencies. See package-lock.json for exact development dependency versions.
