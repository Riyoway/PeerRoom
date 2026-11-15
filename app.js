"use strict";

// A static-only WebRTC demo. No WebSocket, Firebase, hosted signaling,
// analytics or remote JavaScript. SDP and ICE candidates travel via copy/paste.
const $ = (id) => document.getElementById(id);
const state = {
  role: "host",
  pc: null,
  audioSender: null,
  videoSender: null,
  channel: null,
  micStream: null,
  displayStream: null,
  audioContext: null,
  audioDestination: null,
  audioSources: [],
  remoteVideoTrack: null,
  remoteAudioTrack: null,
  busy: false,
  playbackBlocked: false,
  started: false
};

function notice(message, kind = "") {
  const el = $("notice");
  el.textContent = message;
  el.className = "notice" + (kind ? " " + kind : "");
}
function setText(id, value) { $(id).textContent = value; }
function show(id, yes) { $(id).classList.toggle("hidden", !yes); }
function setBusy(value) {
  state.busy = value;
  $("offerButton").disabled = value || Boolean(state.pc);
  $("answerButton").disabled = value || Boolean(state.pc);
  $("acceptButton").disabled = value || !state.pc || state.pc.signalingState !== "have-local-offer";
  $("hostTab").disabled = value || Boolean(state.pc);
  $("guestTab").disabled = value || Boolean(state.pc);
  $("stunToggle").disabled = value || Boolean(state.pc);
}
function fail(error) {
  console.error(error);
  notice(error && error.message ? error.message : String(error), "error");
  setBusy(false);
}
async function guarded(fn) {
  if (state.busy) return;
  setBusy(true);
  try { await fn(); } catch (error) { fail(error); }
  finally { setBusy(false); }
}
function setRole(role) {
  if (state.pc || state.busy) return;
  state.role = role;
  const host = role === "host";
  $("hostTab").classList.toggle("selected", host);
  $("guestTab").classList.toggle("selected", !host);
  $("hostTab").setAttribute("aria-pressed", String(host));
  $("guestTab").setAttribute("aria-pressed", String(!host));
  show("hostActions", host);
  show("guestActions", !host);
  show("outgoingSection", false);
  show("hostReply", false);
  setText("stepHeading", host ? "Create a connection" : "Join a connection");
  setText("stepDescription", host
    ? "Send your offer to the other person."
    : "Paste an offer, then send back your answer.");
  notice(host ? "Ready to host." : "Paste an offer to join.");
}

// Codes are UTF-8 JSON + optional built-in gzip, encoded in copyable base64url.
// Both participants only exchange text, never contact a signaling endpoint.
async function encodeSignal(description) {
  let bytes = new TextEncoder().encode(JSON.stringify({
    version: 1, type: description.type, sdp: description.sdp
  }));
  let compression = "P";
  if (typeof CompressionStream !== "undefined") {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    compression = "G";
  }
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return "PR1" + compression + "." + btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function decodeSignal(code, expectedType) {
  const input = code.trim().replace(/\s+/g, "");
  const match = /^PR1([GP])\.([a-zA-Z0-9_-]+)$/.exec(input);
  if (!match || input.length > 300000) throw new Error("Invalid PeerRoom code. Copy the complete offer or answer.");
  const base64 = match[2].replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  let bytes = Uint8Array.from(binary, (letter) => letter.charCodeAt(0));
  if (match[1] === "G") {
    if (typeof DecompressionStream === "undefined") {
      throw new Error("This browser cannot decode compressed codes. Try a recent Chrome, Firefox or Edge.");
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  }
  const data = JSON.parse(new TextDecoder().decode(bytes));
  if (data.version !== 1 || data.type !== expectedType || typeof data.sdp !== "string" || !data.sdp.startsWith("v=0")) {
    throw new Error("Expected a valid " + expectedType + " code, but received something else.");
  }
  return { type: data.type, sdp: data.sdp };
}
async function waitForIceGathering(pc) {
  if (pc.iceGatheringState === "complete") return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error("ICE discovery timed out. Check your network, then press Reset and try again.")); }, 25000);
    function onState() { if (pc.iceGatheringState === "complete") { cleanup(); resolve(); } }
    function cleanup() { clearTimeout(timer); pc.removeEventListener("icegatheringstatechange", onState); }
    pc.addEventListener("icegatheringstatechange", onState);
    onState();
  });
}

async function ensurePeer() {
  if (state.pc) return state.pc;
  const iceServers = $("stunToggle").checked
    ? [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }]
    : [];
  const pc = new RTCPeerConnection({ iceServers, iceTransportPolicy: "all" });
  state.pc = pc;
  // The offerer creates the m-lines. The answerer MUST adopt the m-lines
  // from the received offer instead of pre-creating unmatched transceivers.
  if (state.role === "host") {
    state.audioSender = pc.addTransceiver("audio", { direction: "sendrecv" }).sender;
    state.videoSender = pc.addTransceiver("video", { direction: "sendrecv" }).sender;
  }
  pc.ontrack = handleRemoteTrack;
  pc.ondatachannel = (event) => attachChannel(event.channel);
  pc.onconnectionstatechange = updateConnectionState;
  pc.oniceconnectionstatechange = updateConnectionState;
  pc.onicegatheringstatechange = () => {
    if (pc.iceGatheringState === "gathering") setText("iceStatus", "Finding peer routes…");
  };
  await updateOutboundAudio();
  if (state.displayStream) await state.videoSender.replaceTrack(state.displayStream.getVideoTracks()[0]);
  updateConnectionState();
  return pc;
}
function updateConnectionState() {
  const pc = state.pc;
  const connection = pc ? pc.connectionState : "closed";
  const map = {
    new: ["Negotiating", "working"],
    connecting: ["Connecting…", "working"],
    connected: ["Connected · P2P", "live"],
    disconnected: ["Peer disconnected", "working"],
    failed: ["P2P failed", "failed"],
    closed: ["Not connected", ""]
  };
  const [label, className] = map[connection] || map.closed;
  setText("connectionLabel", label);
  $("connectionDot").className = "status-dot" + (className ? " " + className : "");
  setText("sessionMode", connection === "connected" ? "Direct session active" : label);
  if (!pc) setText("iceStatus", "Offline");
  else if (connection === "connected") setText("iceStatus", "P2P connected");
  else if (connection === "failed") setText("iceStatus", "Network blocked or no usable route");
  else if (connection === "disconnected") setText("iceStatus", "Peer lost · reset to reconnect");
  else if (connection === "connecting") setText("iceStatus", "Trying candidate routes…");
  if (connection === "connected" && !state.started) {
    state.started = true;
    notice("Connected.", "success");
    appendSystem("Peer connected");
  }
  if (connection === "failed") {
    notice("Direct P2P connection failed. This demo has no TURN relay; try another network, or disable VPN/firewall restrictions.", "error");
  }
  const canChat = Boolean(state.channel && state.channel.readyState === "open");
  $("chatInput").disabled = !canChat;
  $("chatSend").disabled = !canChat;
  $("chatInput").placeholder = canChat ? "Write a private message…" : "Connect to send a message…";
}
function handleRemoteTrack(event) {
  const track = event.track;
  const media = new MediaStream([track]);
  if (track.kind === "video") {
    state.remoteVideoTrack = track;
    $("remoteVideo").srcObject = media;
    const update = () => {
      const visible = track.readyState === "live" && !track.muted;
      $("remoteEmpty").classList.toggle("hidden", visible);
      $("fullScreen").disabled = !visible;
      if (visible) $("remoteVideo").play().catch(() => {});
    };
    track.addEventListener("unmute", update);
    track.addEventListener("mute", update);
    track.addEventListener("ended", update);
    update();
  } else if (track.kind === "audio") {
    state.remoteAudioTrack = track;
    $("remoteAudio").srcObject = media;
    tryPlayRemoteAudio();
  }
}
async function tryPlayRemoteAudio() {
  if (!state.remoteAudioTrack || $("remoteAudio").muted) return;
  try {
    await $("remoteAudio").play();
    state.playbackBlocked = false;
  } catch {
    state.playbackBlocked = true;
    notice("Your browser blocked autoplay. Click 'Enable audio' to hear the peer.");
  }
  updateAudioButton();
}
function updateAudioButton() {
  const muted = $("remoteAudio").muted;
  setText("audioButtonLabel", state.playbackBlocked ? "Enable audio" : muted ? "Unmute peer" : "Mute peer");
  $("audioButton").classList.toggle("active", !muted && !state.playbackBlocked);
}
function attachChannel(channel) {
  state.channel = channel;
  channel.onopen = () => { appendSystem("Chat channel ready"); updateConnectionState(); };
  channel.onclose = () => { appendSystem("Chat channel closed"); updateConnectionState(); };
  channel.onerror = (event) => console.warn("Data channel issue", event);
  channel.onmessage = (event) => appendMessage("Peer", String(event.data), false);
}
function appendSystem(message) {
  const item = document.createElement("div");
  item.className = "message system";
  item.textContent = message;
  addChatItem(item);
}
function appendMessage(author, message, mine) {
  const item = document.createElement("div");
  item.className = "message" + (mine ? " mine" : "");
  const strong = document.createElement("strong");
  strong.textContent = author;
  const span = document.createElement("span");
  span.textContent = message;
  item.append(strong, span);
  addChatItem(item);
}
function addChatItem(item) {
  const log = $("chatLog");
  const empty = log.querySelector(".empty-chat");
  if (empty) empty.remove();
  log.appendChild(item);
  log.scrollTop = log.scrollHeight;
}
async function createOffer() {
  const pc = await ensurePeer();
  const channel = pc.createDataChannel("peerroom-chat", { ordered: true });
  attachChannel(channel);
  notice("Generating offer and collecting ICE routes. This may take a few seconds.");
  await pc.setLocalDescription(await pc.createOffer());
  await waitForIceGathering(pc);
  $("outgoingSignal").value = await encodeSignal(pc.localDescription);
  setText("outgoingLabel", "Your offer");
  setText("outgoingType", "OFFER");
  setText("outgoingHelp", "Send this code to your peer.");
  show("outgoingSection", true);
  show("hostReply", true);
  setText("iceStatus", "Offer ready · waiting for answer");
  notice("Offer ready. Send the code to your peer.", "success");
}
async function createAnswer() {
  const offer = await decodeSignal($("incomingOffer").value, "offer");
  const pc = await ensurePeer();
  notice("Accepting offer and gathering a return route…");
  await pc.setRemoteDescription(offer);
  // Reuse the offered audio/video transceivers. Setting sendrecv before
  // answering allows both peers to start mic/screen later without renegotiation.
  for (const transceiver of pc.getTransceivers()) {
    const kind = transceiver.receiver.track.kind;
    if (kind === "audio" || kind === "video") {
      transceiver.direction = "sendrecv";
      if (kind === "audio") state.audioSender = transceiver.sender;
      if (kind === "video") state.videoSender = transceiver.sender;
    }
  }
  if (!state.audioSender || !state.videoSender) throw new Error("Offer did not include the expected audio/video tracks.");
  await updateOutboundAudio();
  if (state.displayStream) await state.videoSender.replaceTrack(state.displayStream.getVideoTracks()[0]);
  await pc.setLocalDescription(await pc.createAnswer());
  await waitForIceGathering(pc);
  $("outgoingSignal").value = await encodeSignal(pc.localDescription);
  setText("outgoingLabel", "Your answer");
  setText("outgoingType", "ANSWER");
  setText("outgoingHelp", "Send this code to the host.");
  show("outgoingSection", true);
  setText("iceStatus", "Answer ready · waiting for host");
  notice("Answer ready. Send it to the host.", "success");
}
async function acceptAnswer() {
  if (!state.pc || state.pc.signalingState !== "have-local-offer") {
    throw new Error("Create a host offer before applying an answer.");
  }
  const answer = await decodeSignal($("incomingAnswer").value, "answer");
  await state.pc.setRemoteDescription(answer);
  $("acceptButton").disabled = true;
  notice("Answer applied. Checking whether your browsers can connect directly…");
  updateConnectionState();
}

// Mix microphone + optional shared tab/system audio into one negotiated audio track.
// This preserves screen sound even while the microphone is muted.
function getAudioContext() {
  if (!state.audioContext) {
    state.audioContext = new AudioContext();
    state.audioDestination = state.audioContext.createMediaStreamDestination();
  }
  return state.audioContext;
}
async function updateOutboundAudio() {
  for (const source of state.audioSources) source.disconnect();
  state.audioSources = [];
  const tracks = [
    ...(state.micStream ? state.micStream.getAudioTracks() : []),
    ...(state.displayStream ? state.displayStream.getAudioTracks() : [])
  ].filter((track) => track.readyState === "live");
  if (tracks.length > 0) {
    const context = getAudioContext();
    if (context.state === "suspended") await context.resume();
    for (const track of tracks) {
      const source = context.createMediaStreamSource(new MediaStream([track]));
      source.connect(state.audioDestination);
      state.audioSources.push(source);
    }
  }
  if (state.audioSender) {
    await state.audioSender.replaceTrack(tracks.length ? state.audioDestination.stream.getAudioTracks()[0] : null);
  }
}
function updateMicUI() {
  const track = state.micStream && state.micStream.getAudioTracks()[0];
  const live = track && track.enabled && track.readyState === "live";
  setText("micButtonLabel", !track ? "Start mic" : live ? "Mute mic" : "Unmute mic");
  setText("micStatus", !track ? "Mic off" : live ? "Mic live" : "Mic muted");
  $("micDot").classList.toggle("live", Boolean(live));
  $("micButton").classList.toggle("active", Boolean(live));
}
async function toggleMicrophone() {
  const existing = state.micStream?.getAudioTracks()[0];
  if (existing && existing.readyState === "live") {
    existing.enabled = !existing.enabled;
    updateMicUI();
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("Microphone needs HTTPS or localhost and a compatible browser.");
  const music = $("musicMode").checked;
  const selected = $("micDevice")?.value || "";
  const audio = {
    echoCancellation: !music, noiseSuppression: !music, autoGainControl: !music,
    channelCount: { ideal: music ? 2 : 1 }, sampleRate: { ideal: 48000 }
  };
  if (selected) audio.deviceId = { exact: selected };
  state.micStream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
  state.micStream.getAudioTracks()[0].onended = () => { state.micStream = null; updateOutboundAudio().catch(fail); updateMicUI(); };
  await updateOutboundAudio();
  await populateAudioDevices();
  updateMicUI();
  notice("Microphone ready.", "success");
}
async function populateAudioDevices() {
  if (!navigator.mediaDevices?.enumerateDevices || !$("micDevice")) return;
  const select = $("micDevice"), chosen = select.value;
  try {
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput");
    select.replaceChildren(new Option("System default", ""));
    devices.forEach((d, i) => select.add(new Option(d.label || "Microphone " + (i + 1), d.deviceId)));
    if ([...select.options].some((opt) => opt.value === chosen)) select.value = chosen;
  } catch { /* Device enumeration may require media permission. */ }
}
async function switchMicrophoneDevice() {
  if (!state.micStream) return;
  const old = state.micStream;
  state.micStream = null;
  old.getTracks().forEach((track) => { track.onended = null; track.stop(); });
  await updateOutboundAudio();
  await toggleMicrophone();
}
function updateScreenUI() {
  const track = state.displayStream?.getVideoTracks()[0];
  const sharing = Boolean(track && track.readyState === "live");
  setText("shareButtonLabel", sharing ? "Stop sharing" : "Share screen");
  setText("screenStatus", sharing ? "Screen live" : "Not sharing");
  $("screenDot").classList.toggle("live", sharing);
  $("shareButton").classList.toggle("active", sharing);
  $("localEmpty").classList.toggle("hidden", sharing);
  if (!sharing) $("localVideo").srcObject = null;
}
async function toggleScreen() {
  if (state.displayStream) { await stopScreen(); return; }
  if (!navigator.mediaDevices?.getDisplayMedia) throw new Error("Screen sharing requires HTTPS and a browser with getDisplayMedia support.");
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { ideal: 30, max: 60 } },
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
  });
  const track = stream.getVideoTracks()[0];
  state.displayStream = stream;
  track.contentHint = "motion";
  track.addEventListener("ended", () => {
    if (state.displayStream === stream) stopScreen().catch(fail);
  }, { once: true });
  $("localVideo").srcObject = new MediaStream([track]);
  await $("localVideo").play().catch(() => {});
  if (state.videoSender) await state.videoSender.replaceTrack(track);
  await updateOutboundAudio();
  updateScreenUI();
  notice(stream.getAudioTracks().length
    ? "Screen and audio shared."
    : "Screen shared (without audio).", "success");
}
async function stopScreen() {
  const stream = state.displayStream;
  state.displayStream = null;
  if (state.videoSender) await state.videoSender.replaceTrack(null);
  if (stream) stream.getTracks().forEach((track) => track.stop());
  await updateOutboundAudio();
  updateScreenUI();
  notice("Screen sharing stopped.");
}
async function resetAll() {
  if (state.channel) { try { state.channel.close(); } catch {} }
  if (state.pc) { try { state.pc.close(); } catch {} }
  for (const stream of [state.micStream, state.displayStream]) {
    if (stream) stream.getTracks().forEach((track) => { track.onended = null; track.stop(); });
  }
  state.audioSources.forEach((source) => source.disconnect());
  if (state.audioContext) await state.audioContext.close().catch(() => {});
  Object.assign(state, {
    pc: null, audioSender: null, videoSender: null, channel: null,
    micStream: null, displayStream: null, audioContext: null,
    audioDestination: null, audioSources: [], remoteVideoTrack: null,
    remoteAudioTrack: null, playbackBlocked: false, started: false, busy: false
  });
  $("remoteVideo").srcObject = null;
  $("remoteAudio").srcObject = null;
  $("remoteAudio").muted = false;
  $("remoteEmpty").classList.remove("hidden");
  $("fullScreen").disabled = true;
  ["outgoingSignal", "incomingOffer", "incomingAnswer"].forEach((id) => { $(id).value = ""; });
  $("chatLog").replaceChildren();
  const empty = document.createElement("div");
  empty.className = "empty-chat";
  empty.textContent = "No messages";
  $("chatLog").append(empty);
  show("outgoingSection", false);
  show("hostReply", false);
  updateScreenUI();
  updateMicUI();
  updateAudioButton();
  updateConnectionState();
  setBusy(false);
  setRole(state.role);
  notice("Ready.", "success");
}

$("hostTab").addEventListener("click", () => setRole("host"));
$("guestTab").addEventListener("click", () => setRole("guest"));
$("offerButton").addEventListener("click", () => guarded(createOffer));
$("answerButton").addEventListener("click", () => guarded(createAnswer));
$("acceptButton").addEventListener("click", () => guarded(acceptAnswer));
$("micButton").addEventListener("click", () => guarded(toggleMicrophone));
$("shareButton").addEventListener("click", () => guarded(toggleScreen));
$("resetButton").addEventListener("click", () => guarded(resetAll));
$("copyButton").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("outgoingSignal").value);
    notice("Copied! Send the code to the other person.", "success");
    setText("copyButton", "Copied");
    setTimeout(() => setText("copyButton", "Copy code"), 1800);
  } catch {
    $("outgoingSignal").focus();
    $("outgoingSignal").select();
    notice("Clipboard access failed. The code is selected: press Ctrl+C to copy.");
  }
});
$("audioButton").addEventListener("click", async () => {
  if (state.playbackBlocked) { await tryPlayRemoteAudio(); return; }
  $("remoteAudio").muted = !$("remoteAudio").muted;
  updateAudioButton();
  if (!$("remoteAudio").muted) await tryPlayRemoteAudio();
});
$("fullScreen").addEventListener("click", () => {
  $("remoteVideo").requestFullscreen?.().catch((error) => fail(error));
});
$("chatForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const value = $("chatInput").value.trim();
  if (!value || state.channel?.readyState !== "open") return;
  try {
    state.channel.send(value);
    appendMessage("You", value, true);
    $("chatInput").value = "";
  } catch (error) { fail(error); }
});
$("micDevice")?.addEventListener("change", () => guarded(switchMicrophoneDevice));
navigator.mediaDevices?.addEventListener?.("devicechange", populateAudioDevices);
window.addEventListener("beforeunload", () => {
  state.channel?.close();
  state.pc?.close();
  state.micStream?.getTracks().forEach((track) => track.stop());
  state.displayStream?.getTracks().forEach((track) => track.stop());
});
if (!window.isSecureContext) {
  notice("This is not a secure context. Use HTTPS (GitHub Pages) or localhost to access the mic and screen.", "error");
}
populateAudioDevices();
updateMicUI();
updateScreenUI();
updateAudioButton();
