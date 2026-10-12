// Appels de groupe dans un canal (« huddles ») — WebRTC en maillage : chaque participant est relié
// directement à chacun des autres (8 personnes maximum). Chargé après app.js et call.js.
//
// - Le serveur tient la liste des participants de chaque canal et relaie les signaux ; il ne voit pas le son.
// - Celui qui arrive envoie une offre à chacun des présents ; les présents répondent. Pas de collision possible.
// - Les SDP sont chiffrés avec la clé du canal, et liés à l'appel, à l'expéditeur et au destinataire.
// - Celui qui démarre l'appel écrit « a démarré un appel » dans le canal ; le dernier à partir écrit la durée.
const Huddle = (() => {
  let rooms = {};  // canal -> salle telle que décrite par le serveur
  let h = null;    // appel en cours : { channel, roomId, startedAt, stream, muted, peers: Map(user -> { deviceId, pc, audio, speaking }) }
  let iceServers = null;

  const getIce = async () => (iceServers = iceServers || (await api('/api/ice')).iceServers);
  const post = (action, body) => api(`/api/huddle/${action}`, { method: 'POST', body: JSON.stringify({ deviceId: DEVICE_ID, ...body }) });
  const me = () => state.me;
  const roomOf = ch => rooms[ch] || null;
  const inRoom = (room, user, deviceId) => room?.members.some(m => m.user === user && (!deviceId || m.deviceId === deviceId));

  async function encSdp(desc, to) {
    return E2E.encryptPayload(await keyFor(h.channel), { type: desc.type, sdp: desc.sdp, roomId: h.roomId, from: me(), to }, h.channel);
  }
  async function decSdp(enc, from) {
    const p = await E2E.decryptPayload(await keyFor(h.channel), enc, h.channel);
    if (p.roomId !== h.roomId || p.from !== from || p.to !== me()) throw new Error('signal incohérent');
    return { type: p.type, sdp: p.sdp };
  }
  function waitIce(pc) {
    return new Promise(resolve => {
      if (pc.iceGatheringState === 'complete') return resolve();
      const t = setTimeout(resolve, 3000);
      pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); resolve(); } });
    });
  }

  // ---------- Connexions avec chaque participant ----------
  async function makePeer(user, deviceId) {
    closePeer(user);
    const peer = { deviceId, audio: new Audio(), speaking: false };
    peer.pc = new RTCPeerConnection({ iceServers: await getIce() });
    h.stream.getTracks().forEach(t => peer.pc.addTrack(t, h.stream));
    peer.pc.ontrack = e => {
      peer.audio.srcObject = e.streams[0];
      peer.audio.play().catch(() => {});
      watchLevel(peer, e.streams[0]);
    };
    peer.pc.onconnectionstatechange = () => {
      if (peer.pc.connectionState === 'failed' && h?.peers.get(user) === peer) {
        toast(`Connexion audio impossible avec ${user}`);
        closePeer(user);
      }
      render();
    };
    h.peers.set(user, peer);
    return peer;
  }
  function closePeer(user) {
    const peer = h?.peers.get(user);
    if (!peer) return;
    clearInterval(peer.levelTimer);
    peer.levelCtx?.close().catch(() => {});
    try { peer.pc.close(); } catch {}
    peer.audio.srcObject = null;
    h.peers.delete(user);
  }
  async function offerTo(user, deviceId) {
    const peer = await makePeer(user, deviceId);
    await peer.pc.setLocalDescription(await peer.pc.createOffer());
    await waitIce(peer.pc);
    if (h?.peers.get(user) !== peer) return;
    await post('signal', { channel: h.channel, to: user, toDevice: deviceId, kind: 'offer', enc: await encSdp(peer.pc.localDescription, user) });
  }

  // ---------- Rejoindre / quitter ----------
  async function join(channel) {
    if (h) return h.channel === channel ? null : toast(`Tu es déjà dans l'appel de #${h.channel}`);
    if (Call.active()) return toast('Termine d\'abord ton appel en cours');
    if (!window.RTCPeerConnection || !navigator.mediaDevices?.getUserMedia) return toast('Les appels ne sont pas pris en charge par ce navigateur.');
    await ensureChannelKey(channel).catch(() => {});
    if (!(await keyFor(channel))) return toast('La clé de chiffrement de ce canal n\'est pas encore arrivée.');
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); }
    catch { return toast('Accès au micro refusé : autorise-le via l\'icône à gauche de l\'adresse.'); }
    h = { channel, stream, muted: false, peers: new Map(), joining: true };
    render();
    try {
      const { room } = await post('join', { channel });
      rooms[channel] = room;
      Object.assign(h, { roomId: room.id, startedAt: room.startedAt, joining: false });
      blip(true);
      const others = room.members.filter(m => m.user !== me());
      if (!others.length && room.startedBy === me()) postTrace(channel, { kind: 'group', status: 'started' });
      for (const m of others) offerTo(m.user, m.deviceId).catch(() => toast(`Impossible de joindre ${m.user}`));
    } catch (err) {
      toast(err.message);
      teardown();
    }
    render();
    renderChannelUi();
  }
  async function leave() {
    if (!h) return;
    const { channel, startedAt } = h;
    const alone = (roomOf(channel)?.members || []).filter(m => m.user !== me()).length === 0;
    teardown();
    blip(false);
    try { await post('leave', { channel }); } catch {}
    if (alone && startedAt) postTrace(channel, { kind: 'group', status: 'ended', duration: Date.now() - startedAt });
  }
  function teardown() {
    if (!h) return;
    for (const user of [...h.peers.keys()]) closePeer(user);
    h.stream?.getTracks().forEach(t => t.stop());
    h = null;
    render();
    renderChannelUi();
  }
  function toggleMute() {
    if (!h?.stream) return;
    h.muted = !h.muted;
    h.stream.getAudioTracks().forEach(t => { t.enabled = !h.muted; });
    render();
  }
  async function postTrace(channel, call) {
    try {
      const enc = await E2E.encryptPayload(await keyFor(channel), { text: '', call }, channel);
      await api('/api/messages', { method: 'POST', body: JSON.stringify({ channel, enc }) });
    } catch {}
  }
  // Fermeture de l'onglet : le serveur nous retire de la salle à la coupure du flux ; on prévient quand même.
  window.addEventListener('pagehide', () => {
    if (!h) return;
    fetch('/api/huddle/leave', {
      method: 'POST', keepalive: true,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + state.token },
      body: JSON.stringify({ channel: h.channel, deviceId: DEVICE_ID }),
    }).catch(() => {});
  });

  // ---------- Événements serveur ----------
  function setRooms(list) {
    rooms = {};
    for (const r of list || []) if (r) rooms[r.channel] = r;
    if (h && !inRoom(rooms[h.channel], me(), DEVICE_ID)) teardown(); // reconnexion : la salle nous a oubliés
    renderChannelUi();
  }
  function onRoom({ channel, room }) {
    const before = rooms[channel];
    if (room) rooms[channel] = room; else delete rooms[channel];
    // Quelqu'un démarre un appel : on prévient (sans sonnerie)
    if (!before && room && room.startedBy !== me() && !h) {
      toast(`🔊 ${room.startedBy} a démarré un appel dans #${channel} — clique pour rejoindre`, () => { openChannel(channel); join(channel); });
      if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
        new Notification(`🔊 Appel de groupe dans #${channel}`, { body: `${room.startedBy} a démarré un appel`, tag: 'lanchat-huddle-' + channel }).onclick = () => { window.focus(); openChannel(channel); };
      }
    }
    if (h && h.channel === channel) {
      if (!inRoom(room, me(), DEVICE_ID)) { toast('Tu as quitté l\'appel (rejoint depuis un autre onglet ?)'); teardown(); return; }
      const present = new Map(room.members.map(m => [m.user, m.deviceId]));
      for (const [user, peer] of [...h.peers]) {
        if (present.get(user) !== peer.deviceId) { closePeer(user); blip(false); }
      }
      for (const m of room.members) if (m.user !== me() && !h.peers.has(m.user) && before && !inRoom(before, m.user)) blip(true);
      render();
    }
    renderChannelUi();
  }
  async function onSignal(d) {
    if (!h || d.channel !== h.channel || d.roomId !== h.roomId) return;
    try {
      const desc = await decSdp(d.enc, d.from);
      if (d.kind === 'offer') {
        const peer = await makePeer(d.from, d.fromDevice);
        await peer.pc.setRemoteDescription(desc);
        await peer.pc.setLocalDescription(await peer.pc.createAnswer());
        await waitIce(peer.pc);
        if (h?.peers.get(d.from) !== peer) return;
        await post('signal', { channel: h.channel, to: d.from, toDevice: d.fromDevice, kind: 'answer', enc: await encSdp(peer.pc.localDescription, d.from) });
      } else if (d.kind === 'answer') {
        const peer = h.peers.get(d.from);
        if (peer && peer.deviceId === d.fromDevice) await peer.pc.setRemoteDescription(desc);
      }
    } catch (err) { console.warn('Signal d\'appel de groupe ignoré :', err.message); }
    render();
  }

  // ---------- Qui parle ----------
  function watchLevel(peer, stream) {
    try {
      peer.levelCtx = new (window.AudioContext || window.webkitAudioContext)();
      const an = peer.levelCtx.createAnalyser();
      an.fftSize = 256;
      peer.levelCtx.createMediaStreamSource(stream).connect(an);
      const buf = new Uint8Array(an.fftSize);
      peer.levelTimer = setInterval(() => {
        an.getByteTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) { const x = (v - 128) / 128; sum += x * x; }
        const speaking = Math.sqrt(sum / buf.length) > 0.03;
        if (speaking !== peer.speaking) { peer.speaking = speaking; render(); }
      }, 150);
    } catch {}
  }
  function blip(up) {
    if (!state.sound) return;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const o = ctx.createOscillator(), g = ctx.createGain(), t = ctx.currentTime;
      o.frequency.setValueAtTime(up ? 520 : 780, t);
      o.frequency.exponentialRampToValueAtTime(up ? 780 : 520, t + 0.15);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.12, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
      o.connect(g).connect(ctx.destination);
      o.start(t); o.stop(t + 0.25);
      setTimeout(() => ctx.close(), 400);
    } catch {}
  }

  // ---------- Interface ----------
  const ui = document.createElement('div');
  ui.id = 'huddleUi';
  document.body.appendChild(ui);
  let clock;
  function render() {
    clearInterval(clock);
    if (!h) { ui.innerHTML = ''; ui.className = ''; return; }
    const people = [me(), ...h.peers.keys()];
    const avatars = people.map(u => {
      const peer = h.peers.get(u);
      const cls = (u === me() ? (h.muted ? ' muted' : '') : peer?.speaking ? ' speaking' : '') + (peer && peer.pc.connectionState !== 'connected' ? ' pending' : '');
      return `<span class="hu-av${cls}" style="background:${colorOf(u)}" title="${esc(u)}${u === me() ? ' (toi)' : ''}">${initial(u)}</span>`;
    }).join('');
    const status = h.joining ? 'Connexion…' : fmtDur(Date.now() - (h.startedAt || Date.now()));
    ui.className = 'call-bar huddle-bar active';
    ui.innerHTML = `<div class="hu-icon">🔊</div>
      <div class="call-info"><div class="call-name">#${esc(h.channel)}</div><div class="call-status">${status} · ${people.length} participant${people.length > 1 ? 's' : ''}</div></div>
      <div class="hu-avs">${avatars}</div>
      <button class="call-btn small${h.muted ? ' muted' : ''}" data-huddle="mute" title="${h.muted ? 'Réactiver le micro' : 'Couper le micro'}">${icon(h.muted ? 'mic-off' : 'mic')}</button>
      <button class="call-btn small decline" data-huddle="leave" title="Quitter l'appel">${icon('phone-off')}</button>`;
    if (!h.joining) clock = setInterval(() => { const s = ui.querySelector('.call-status'); if (s && h) s.textContent = `${fmtDur(Date.now() - h.startedAt)} · ${people.length} participant${people.length > 1 ? 's' : ''}`; }, 1000);
  }
  ui.addEventListener('click', e => {
    const b = e.target.closest('[data-huddle]');
    if (b) ({ mute: toggleMute, leave })[b.dataset.huddle]?.();
  });

  // Bandeau « appel en cours » en haut du canal affiché, et marque 🔊 dans la barre latérale
  function renderChannelUi() {
    const banner = $('#huddleBanner');
    const ch = state.current;
    const room = state.view === 'channel' && !isDm(ch) ? roomOf(ch) : null;
    if (!room) { banner.hidden = true; banner.innerHTML = ''; }
    else {
      const mine = h?.channel === ch;
      banner.hidden = false;
      banner.innerHTML = `<span class="hb-dot"></span><span class="hb-text"><b>Appel en cours</b> · ${room.members.length}/8</span>
        <span class="hb-avs">${room.members.map(m => `<span class="hu-av" style="background:${colorOf(m.user)}" title="${esc(m.user)}">${initial(m.user)}</span>`).join('')}</span>
        ${mine ? '<span class="hb-in">Tu es dans l\'appel</span>' : `<button class="btn-sm hb-join" data-huddle-join="${esc(ch)}">Rejoindre</button>`}`;
    }
    if (typeof renderSidebar === 'function' && state.me) renderSidebar();
    // Les traces « a démarré un appel » affichent « Rejoindre » seulement tant que l'appel existe
    document.querySelectorAll('.msg').forEach(el => { if (el._msg?.call?.kind === 'group' && el._msg.call.status === 'started') refreshMsg(el._msg); });
  }
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-huddle-join]');
    if (b) join(b.dataset.huddleJoin);
  });

  return {
    join, leave, setRooms, onRoom, onSignal, renderChannelUi,
    active: () => !!h,
    hasRoom: ch => !!rooms[ch],
    isIn: ch => h?.channel === ch,
  };
})();
