import {joinRoom} from 'trystero'

const APP_ID = 'Riyoway/PeerRoom'
const $ = id => document.getElementById(id)
const state = {room:null, roomId:'', peerId:null, chat:null, mic:null, screen:null,
  remoteScreen:null, audioNeedsGesture:false, busy:false, leaving:false}

const setText = (id,value) => { $(id).textContent = value }
const show = (id,yes) => $(id).classList.toggle('hidden',!yes)
function notice(message,error=false) {
  setText('notice',message)
  $('notice').className='notice'+(error?' error':'')+(message?'':' hidden')
}
function report(error) {
  console.error('PeerRoom',error)
  notice(error?.message||String(error),true)
}
function status(label,type='') {
  setText('connectionLabel',label)
  $('connectionDot').className='status-dot'+(type?' '+type:'')
  setText('sessionMode',!state.room?'No room':type==='live'?'Connected':'Waiting')
  setText('roomStatus',type==='live'?'Peer connected':'Waiting for peer…')
  setText('iceStatus',type==='live'?'P2P':'')
  setText('peerSidebarStatus',type==='live'?'Here':'Waiting')
  $('peerRow').classList.toggle('connected',type==='live')
  $('micButton').disabled=!state.room
  $('shareButton').disabled=!state.room
  $('audioButton').disabled=!state.peerId
  $('chatInput').disabled=!state.peerId
  $('chatSend').disabled=!state.peerId
}
function newId() {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24))))
    .replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')
}
function linkFor(id) {
  const u=new URL(location.href)
  u.search=''
  u.hash='r='+id
  return u.toString()
}
function idFromHash() {
  const match=/^#r=([A-Za-z0-9_-]{24,64})$/.exec(location.hash)
  return match?.[1]||null
}
async function copyLink() {
  const link=$('roomLink').value
  if (!link) return
  try {
    await navigator.clipboard.writeText(link)
    setText('copyLink','Copied')
    setTimeout(()=>setText('copyLink','Copy'),1400)
    notice('')
  } catch {
    $('roomLink').focus()
    $('roomLink').select()
    notice('Copy the selected link.',true)
  }
}
function createRoom() {
  if (state.room) return
  const id=newId()
  const link=linkFor(id)
  // Start clipboard write during the click's user activation.
  navigator.clipboard?.writeText(link).then(
    ()=>{setText('copyLink','Copied');setTimeout(()=>setText('copyLink','Copy'),1400)},
    ()=>{}
  )
  history.replaceState(null,'',link)
  enterRoom(id)
}
function addMessage(who,message,mine=false) {
  const log=$('chatLog')
  log.querySelector('.empty-chat')?.remove()
  const item=document.createElement('div')
  item.className='message'+(mine?' mine':'')
  const label=document.createElement('strong')
  label.textContent=who
  const body=document.createElement('span')
  body.textContent=String(message).slice(0,2000)
  item.append(label,body)
  log.append(item)
  log.scrollTop=log.scrollHeight
}
function clearChat() {
  $('chatLog').replaceChildren()
  const msg=document.createElement('div')
  msg.className='empty-chat'
  const icon=document.createElement('img')
  icon.src='./icons/messages-square.svg'
  icon.alt=''
  const label=document.createElement('strong')
  label.textContent='No messages yet'
  msg.append(icon,label)
  $('chatLog').append(msg)
}
function remoteScreenVisibility() {
  const track=state.remoteScreen?.getVideoTracks()[0]
  const visible=Boolean(track&&track.readyState==='live'&&!track.muted)
  show('remoteEmpty',!visible)
  $('fullScreen').disabled=!visible
}
function onRemoteStream(stream,context) {
  if (context.metadata?.kind==='screen'||stream.getVideoTracks().length) {
    state.remoteScreen=stream
    $('remoteVideo').srcObject=stream
    const video=stream.getVideoTracks()[0]
    if (video) ['mute','unmute','ended'].forEach(event=>video.addEventListener(event,remoteScreenVisibility))
    remoteScreenVisibility()
  } else {
    $('remoteAudio').srcObject=stream
  }
  playRemote()
}
async function playRemote() {
  let blocked=false
  for (const id of ['remoteAudio','remoteVideo']) {
    const element=$(id)
    if (!element.srcObject) continue
    try { await element.play() }
    catch {blocked=true}
  }
  state.audioNeedsGesture=blocked
  setText('audioButtonLabel',blocked?'Enable audio':$('remoteAudio').muted?'Unmute audio':'Mute audio')
  $('audioIcon').src='./icons/'+($('remoteAudio').muted?'volume-x':'volume-2')+'.svg'
}
function clearRemote() {
  state.remoteScreen=null
  state.audioNeedsGesture=false
  $('remoteAudio').srcObject=null
  $('remoteVideo').srcObject=null
  $('remoteAudio').muted=false
  $('remoteVideo').muted=false
  setText('audioButtonLabel','Mute audio')
  $('audioIcon').src='./icons/volume-2.svg'
  show('remoteEmpty',true)
  $('fullScreen').disabled=true
}
function sendStreamsTo(userId) {
  if (state.mic) state.room.addStream(state.mic,{target:userId,metadata:{kind:'mic'}}).catch(report)
  if (state.screen) state.room.addStream(state.screen,{target:userId,metadata:{kind:'screen'}}).catch(report)
}
function enterRoom(id) {
  if (state.room||state.busy) return
  state.busy=true
  state.roomId=id
  $('roomLink').value=linkFor(id)
  show('createPanel',false)
  show('roomPanel',true)
  notice('')
  try {
    const room=joinRoom({appId:APP_ID,identity:'none',maxUsers:2},id)
    state.room=room
    state.chat=room.makeAction('chat')
    state.chat.onMessage(message=>addMessage('Peer',message))
    room.onUserJoin(({userId})=>{
      if (state.room!==room||(state.peerId&&state.peerId!==userId)) return
      state.peerId=userId
      status('Connected','live')
      sendStreamsTo(userId)
      playRemote()
      notice('')
    })
    room.onUserLeave(({userId})=>{
      if (state.room!==room||state.peerId!==userId) return
      state.peerId=null
      clearRemote()
      status('Waiting for peer','working')
    })
    room.onPeerStream(onRemoteStream)
    room.onError(error=>{
      if (state.room!==room) return
      if (error?.code==='room-full') notice('Room is full.',true)
      else if (error?.code==='relay-failed') notice('Signaling relays unavailable.',true)
      else if (error?.code==='peer-connect-failed') notice('P2P connection failed on this network.',true)
      else report(error)
    })
    status('Waiting for peer','working')
  } catch(error) {
    state.room=null; state.roomId=''
    show('createPanel',true);show('roomPanel',false)
    status('Not connected')
    report(error)
  } finally {state.busy=false}
}
function micUI() {
  const track=state.mic?.getAudioTracks()[0]
  const live=Boolean(track&&track.readyState==='live')
  const on=live&&track.enabled
  setText('micButtonLabel',!live?'Start mic':on?'Mute mic':'Unmute mic')
  setText('micStatus',!live?'Mic off':on?'Mic on':'Mic muted')
  setText('micSidebarStatus',!live?'Idle':on?'Live':'Muted')
  $('micIcon').src='./icons/'+(on?'mic':'mic-off')+'.svg'
  $('micDot').classList.toggle('live',on)
  $('micButton').classList.toggle('active',on)
}
async function stopMic(room=state.room) {
  const stream=state.mic
  state.mic=null
  if (stream) {
    try {await room?.removeStream(stream)} catch(error){console.warn(error)}
    stream.getTracks().forEach(track=>{track.onended=null;track.stop()})
  }
  micUI()
}
async function startMic() {
  if (!navigator.mediaDevices?.getUserMedia) throw Error('Microphone requires HTTPS.')
  const music=$('musicMode').checked
  const audio={echoCancellation:!music,noiseSuppression:!music,autoGainControl:!music,
    channelCount:{ideal:music?2:1},sampleRate:{ideal:48000}}
  if ($('micDevice').value) audio.deviceId={exact:$('micDevice').value}
  const stream=await navigator.mediaDevices.getUserMedia({audio})
  state.mic=stream
  stream.getAudioTracks()[0].onended=()=>{if (state.mic===stream) stopMic().catch(report)}
  try {await state.room.addStream(stream,{metadata:{kind:'mic'}})}
  catch(error){stream.getTracks().forEach(track=>track.stop());state.mic=null;throw error}
  micUI()
  populateDevices()
}
async function toggleMic() {
  if (!state.room||state.busy) return
  const track=state.mic?.getAudioTracks()[0]
  if (track?.readyState==='live') {track.enabled=!track.enabled;micUI();return}
  state.busy=true
  try {await startMic()} catch(error){report(error)}
  finally {state.busy=false}
}
async function populateDevices() {
  try {
    const inputs=(await navigator.mediaDevices.enumerateDevices()).filter(d=>d.kind==='audioinput')
    const select=$('micDevice')
    const prior=select.value
    select.replaceChildren(new Option('System default',''))
    inputs.forEach((input,i)=>select.add(new Option(input.label||'Microphone '+(i+1),input.deviceId)))
    if ([...select.options].some(option=>option.value===prior)) select.value=prior
  } catch {}
}
function screenUI() {
  const track=state.screen?.getVideoTracks()[0]
  const live=Boolean(track&&track.readyState==='live')
  setText('shareButtonLabel',live?'Stop sharing':'Share screen')
  setText('screenStatus',live?'Sharing':'Not sharing')
  $('shareIcon').src='./icons/'+(live?'monitor-off':'monitor-up')+'.svg'
  $('shareButton').classList.toggle('active',live)
  $('screenDot').classList.toggle('live',live)
  show('localEmpty',!live)
  if (!live) $('localVideo').srcObject=null
}
async function stopScreen(room=state.room) {
  const stream=state.screen
  state.screen=null
  if (stream) {
    try {await room?.removeStream(stream)} catch(error){console.warn(error)}
    stream.getTracks().forEach(track=>track.stop())
  }
  screenUI()
}
async function toggleScreen() {
  if (!state.room||state.busy) return
  if (state.screen) {
    state.busy=true
    try {await stopScreen()}catch(error){report(error)}
    finally {state.busy=false}
    return
  }
  if (!navigator.mediaDevices?.getDisplayMedia) {notice('Screen sharing unavailable.',true);return}
  state.busy=true
  try {
    // Must be called directly in the click handler before other async operations.
    const stream=await navigator.mediaDevices.getDisplayMedia({
      video:{frameRate:{ideal:30,max:60}},
      audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false}
    })
    state.screen=stream
    const track=stream.getVideoTracks()[0]
    if (track) {
      track.contentHint='motion'
      track.addEventListener('ended',()=>{
        if (state.screen===stream) stopScreen().catch(report)
      },{once:true})
    }
    $('localVideo').srcObject=stream
    $('localVideo').play().catch(()=>{})
    await state.room.addStream(stream,{metadata:{kind:'screen'}})
    screenUI()
  } catch(error) {
    state.screen?.getTracks().forEach(track=>track.stop())
    state.screen=null
    screenUI()
    if (error?.name!=='NotAllowedError') report(error)
  } finally {state.busy=false}
}
async function toggleAudio() {
  if (!state.peerId) return
  if (state.audioNeedsGesture) {
    $('remoteAudio').muted=false
    $('remoteVideo').muted=false
    await playRemote()
    return
  }
  const muted=$('remoteAudio').muted&&$('remoteVideo').muted
  $('remoteAudio').muted=!muted
  $('remoteVideo').muted=!muted
  if (muted) await playRemote()
  else setText('audioButtonLabel','Unmute audio')
  $('audioIcon').src='./icons/'+(muted?'volume-2':'volume-x')+'.svg'
}
async function leaveRoom() {
  if (!state.room||state.leaving) return
  state.leaving=true
  const room=state.room
  state.room=null
  state.peerId=null
  state.chat=null
  await Promise.allSettled([stopMic(room),stopScreen(room)])
  try {await room.leave()} catch(error){console.warn(error)}
  state.roomId=''
  state.busy=false
  state.leaving=false
  clearRemote()
  clearChat()
  show('roomPanel',false)
  show('createPanel',true)
  history.replaceState(null,'',location.pathname+location.search)
  status('Not connected')
  notice('')
}
$('createButton').addEventListener('click',createRoom)
$('copyLink').addEventListener('click',copyLink)
$('leaveButton').addEventListener('click',leaveRoom)
$('micButton').addEventListener('click',toggleMic)
$('shareButton').addEventListener('click',toggleScreen)
$('audioButton').addEventListener('click',toggleAudio)
$('fullScreen').addEventListener('click',()=>{$('remoteVideo').requestFullscreen?.().catch(report)})
$('micDevice').addEventListener('change',async()=>{
  if (!state.mic) return
  try {await stopMic();await startMic()}catch(error){report(error)}
})
$('chatForm').addEventListener('submit',async event=>{
  event.preventDefault()
  const input=$('chatInput')
  const message=input.value.trim()
  if (!message||!state.peerId||!state.chat) return
  input.value=''
  try {await state.chat.send(message);addMessage('You',message,true)}
  catch(error){report(error)}
})
navigator.mediaDevices?.addEventListener?.('devicechange',populateDevices)
window.addEventListener('pagehide',()=>{
  state.mic?.getTracks().forEach(track=>track.stop())
  state.screen?.getTracks().forEach(track=>track.stop())
  state.room?.leave()
})
if (!window.isSecureContext) notice('Use HTTPS or localhost.',true)
if (idFromHash()) enterRoom(idFromHash())
else if (location.hash) notice('Invalid room link.',true)
populateDevices()
