// Appels audio en tête-à-tête — WebRTC, aucune dépendance. Chargé après app.js (utilise state, api, keyFor, E2E…).
//
// Déroulé : l'appelant envoie une « offre » (description de session SDP), l'appelé répond par une « réponse ».
// Le son circule ensuite directement entre les deux navigateurs, chiffré par WebRTC (DTLS-SRTP).
// Les SDP passent par le serveur mais sont chiffrés avec la clé de la conversation privée : le serveur ne peut
// pas remplacer les empreintes DTLS pour s'intercaler dans l'appel. L'identifiant d'appel est inclus dans le
// chiffré pour qu'une ancienne offre ne puisse pas être rejouée.
// Seul l'appelant écrit la trace de l'appel dans la conversation (« Appel audio · 3 min », « Appel manqué »).
const Call = (() => {
  const deviceId = crypto.randomUUID();
  const RING_TIMEOUT = 45000;
  let call = null; // { id, peer, role: 'caller'|'callee', state: 'calling'|'ringing'|'connecting'|'active'|'reconnecting', pc, stream, remoteAudio, startedAt, muted, … }
  let iceServers = null;

  const channelWith = peer => '@' + [state.me, peer].sort().join('|');
  const signal = (to, kind, callId, enc = null) =>
    api('/api/call', { method: 'POST', body: JSON.stringify({ to, kind, callId, deviceId, enc }) });
  async function getIce() {
    if (!iceServers) iceServers = (await api('/api/ice')).iceServers;
    return iceServers;
  }
  async function encSdp(peer, desc, callId) {
    const ch = channelWith(peer);
    return E2E.encryptPayload(await keyFor(ch), { type: desc.type, sdp: desc.sdp, callId }, ch);
  }
  async function decSdp(peer, enc, callId) {
    const ch = channelWith(peer);
    const p = await E2E.decryptPayload(await keyFor(ch), enc, ch);
    if (p.callId !== callId) throw new Error('signal d\'appel incohérent');
    return { type: p.type, sdp: p.sdp };
  }
  // On envoie le SDP complet (candidats réseau inclus) plutôt qu'au fil de l'eau : plus simple, ~1 s de plus.
  function waitIce(pc) {
    return new Promise(resolve => {
      if (pc.iceGatheringState === 'complete') return resolve();
      const timer = setTimeout(resolve, 3000);
      pc.addEventListener('icegatheringstatechange', () => {
        if (pc.iceGatheringState === 'complete') { clearTimeout(timer); resolve(); }
      });
    });
  }
  const getMic = () => navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });

  async function makePc(c) {
    const pc = new RTCPeerConnection({ iceServers: await getIce() });
    pc.ontrack = e => {
      c.remoteAudio.srcObject = e.streams[0];
      c.remoteAudio.play().catch(() => {});
      watchLevel(c, e.streams[0]);
    };
    pc.onconnectionstatechange = () => {
      if (call !== c) return;
      const st = pc.connectionState;
      clearTimeout(c.dropTimer);
      if (st === 'connected') {
        if (!c.startedAt) c.startedAt = Date.now();
        c.state = 'active';
      } else if (st === 'disconnected') {
        // Coupure réseau passagère : WebRTC tente de se rétablir seul ; au-delà de 15 s on raccroche proprement.
        c.state = 'reconnecting';
        c.dropTimer = setTimeout(() => {
          if (call !== c || pc.connectionState === 'connected') return;
          toast('Appel interrompu : connexion perdue.');
          signal(c.peer, 'hangup', c.id).catch(() => {});
          end('ended');
        }, 15000);
      }
      else if (st === 'failed') {
        toast('Connexion audio impossible : le réseau bloque l\'appel (un relais TURN serait nécessaire).');
        signal(c.peer, 'hangup', c.id).catch(() => {});
        return end(c.startedAt ? 'ended' : 'failed');
      }
      render();
    };
    return pc;
  }

  // ---------- Appeler ----------
  async function start(peer) {
    if (call || Huddle.active()) return toast('Un appel est déjà en cours');
    if (!window.RTCPeerConnection || !navigator.mediaDevices?.getUserMedia) return toast('Les appels ne sont pas pris en charge par ce navigateur.');
    if (!state.users.has(peer)) return toast(`${peer} n'a pas de compte`);
    if (!state.online.includes(peer)) return toast(`${peer} est hors ligne : impossible de l'appeler pour l'instant.`);
    const c = call = { id: crypto.randomUUID(), peer, role: 'caller', state: 'calling', remoteAudio: new Audio() };
    c.remoteAudio.play().catch(() => {}); // débloque la lecture audio pendant le clic
    render();
    try {
      c.stream = await getMic();
      if (call !== c) return c.stream.getTracks().forEach(t => t.stop());
      c.pc = await makePc(c);
      c.stream.getTracks().forEach(t => c.pc.addTrack(t, c.stream));
      await c.pc.setLocalDescription(await c.pc.createOffer());
      await waitIce(c.pc);
      if (call !== c) return;
      const { delivered } = await signal(peer, 'offer', c.id, await encSdp(peer, c.pc.localDescription, c.id));
      if (call !== c) return;
      if (!delivered) { toast(`${peer} vient de se déconnecter.`); return end('missed'); }
      Tones.ringback();
      c.timeout = setTimeout(() => { if (call === c && c.state === 'calling') { signal(peer, 'cancel', c.id).catch(() => {}); end('missed'); } }, RING_TIMEOUT);
    } catch (err) {
      toast(err.name === 'NotAllowedError' ? 'Accès au micro refusé : autorise-le via l\'icône à gauche de l\'adresse.' : 'Appel impossible : ' + err.message);
      if (call === c) cleanup();
    }
  }

  // ---------- Recevoir ----------
  async function accept() {
    const c = call;
    if (!c || c.role !== 'callee' || c.state !== 'ringing') return;
    Tones.stop();
    stopTitleFlash();
    clearTimeout(c.timeout);
    c.state = 'connecting';
    c.remoteAudio.play().catch(() => {});
    render();
    try {
      c.stream = await getMic();
      c.pc = await makePc(c);
      c.stream.getTracks().forEach(t => c.pc.addTrack(t, c.stream));
      await c.pc.setRemoteDescription(await decSdp(c.peer, c.offerEnc, c.id));
      await c.pc.setLocalDescription(await c.pc.createAnswer());
      await waitIce(c.pc);
      if (call !== c) return;
      await signal(c.peer, 'answer', c.id, await encSdp(c.peer, c.pc.localDescription, c.id));
    } catch (err) {
      toast(err.name === 'NotAllowedError' ? 'Accès au micro refusé : autorise-le via l\'icône à gauche de l\'adresse.' : 'Impossible de décrocher : ' + err.message);
      signal(c.peer, 'decline', c.id).catch(() => {});
      if (call === c) cleanup();
    }
  }
  function decline() {
    const c = call;
    if (!c || c.role !== 'callee') return;
    signal(c.peer, 'decline', c.id).catch(() => {});
    cleanup();
  }
  function hangup() {
    const c = call;
    if (!c) return;
    if (c.role === 'callee' && c.state === 'ringing') return decline();
    if (c.role === 'caller' && c.state === 'calling') { signal(c.peer, 'cancel', c.id).catch(() => {}); return end('missed'); }
    signal(c.peer, 'hangup', c.id).catch(() => {});
    end('ended');
  }
  function toggleMute() {
    const c = call;
    if (!c?.stream) return;
    c.muted = !c.muted;
    c.stream.getAudioTracks().forEach(t => { t.enabled = !c.muted; });
    render();
  }

  // Signaux reçus via le flux temps réel (événement « call »)
  async function onSignal(d) {
    if (d.deviceId === deviceId) return;
    // Copie d'une réponse/d'un refus fait sur un autre de mes onglets : on arrête de sonner ici.
    if (d.from === state.me) {
      if (call && call.id === d.callId && call.role === 'callee' && call.state === 'ringing') {
        cleanup();
        toast(d.kind === 'answer' ? 'Appel pris sur un autre appareil' : 'Appel refusé');
      }
      return;
    }
    const mine = call && call.id === d.callId && call.peer === d.from;
    switch (d.kind) {
      case 'offer':
        if (call || Huddle.active()) return signal(d.from, 'busy', d.callId).catch(() => {});
        call = { id: d.callId, peer: d.from, role: 'callee', state: 'ringing', offerEnc: d.enc, remoteAudio: new Audio() };
        Tones.ring();
        render();
        notifyIncoming(d.from);
        call.timeout = setTimeout(() => { if (call?.id === d.callId && call.state === 'ringing') cleanup(); }, RING_TIMEOUT + 5000);
        break;
      case 'answer':
        if (!mine || call.role !== 'caller') return;
        Tones.stop();
        clearTimeout(call.timeout);
        call.state = 'connecting';
        render();
        try { await call.pc.setRemoteDescription(await decSdp(d.from, d.enc, d.callId)); }
        catch (err) { toast('Appel impossible : ' + err.message); signal(d.from, 'hangup', d.callId).catch(() => {}); end('failed'); }
        break;
      case 'decline':
        if (!mine) return;
        toast(`${d.from} a refusé l'appel`);
        end('declined');
        break;
      case 'busy':
        if (!mine) return;
        toast(`${d.from} est déjà en ligne`);
        end('busy');
        break;
      case 'cancel':
        if (mine && call.role === 'callee') cleanup();
        break;
      case 'hangup':
        if (mine) end('ended');
        break;
    }
  }

  // ---------- Fin d'appel ----------
  function end(status) {
    const c = call;
    if (!c) return;
    if (c.role === 'caller' && status) postLog(c, status);
    cleanup();
  }
  async function postLog(c, status) {
    try {
      const ch = channelWith(c.peer);
      const enc = await E2E.encryptPayload(await keyFor(ch), { text: '', call: { status, duration: c.startedAt ? Date.now() - c.startedAt : 0 } }, ch);
      await api('/api/messages', { method: 'POST', body: JSON.stringify({ channel: ch, enc }) });
    } catch {}
  }
  function cleanup() {
    const c = call;
    call = null;
    Tones.stop();
    if (!c) return render();
    clearTimeout(c.timeout);
    clearTimeout(c.dropTimer);
    clearInterval(c.levelTimer);
    c.levelCtx?.close().catch(() => {});
    c.stream?.getTracks().forEach(t => t.stop());
    try { c.pc?.close(); } catch {}
    c.remoteAudio.srcObject = null;
    stopTitleFlash();
    render();
  }
  // Fermeture de l'onglet pendant un appel : on prévient l'autre (fetch keepalive survit au déchargement).
  window.addEventListener('pagehide', () => {
    const c = call;
    if (!c) return;
    const kind = c.role === 'callee' && c.state === 'ringing' ? 'decline' : c.role === 'caller' && c.state === 'calling' ? 'cancel' : 'hangup';
    fetch('/api/call', {
      method: 'POST', keepalive: true,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + state.token },
      body: JSON.stringify({ to: c.peer, kind, callId: c.id, deviceId }),
    }).catch(() => {});
  });

  // ---------- Niveau sonore de l'autre (halo quand il parle) ----------
  function watchLevel(c, stream) {
    try {
      c.levelCtx = new (window.AudioContext || window.webkitAudioContext)();
      const an = c.levelCtx.createAnalyser();
      an.fftSize = 256;
      c.levelCtx.createMediaStreamSource(stream).connect(an);
      const buf = new Uint8Array(an.fftSize);
      c.levelTimer = setInterval(() => {
        an.getByteTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) { const x = (v - 128) / 128; sum += x * x; }
        document.querySelector('#callUi .call-avatar')?.classList.toggle('speaking', Math.sqrt(sum / buf.length) > 0.03);
      }, 150);
    } catch {}
  }

  // ---------- Sonneries (générées, aucun fichier audio) ----------
  const Tones = (() => {
    let ctx, timer;
    const beep = (freqs, dur, vol) => {
      ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
      ctx.resume().catch(() => {});
      const t = ctx.currentTime;
      for (const f of freqs) {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(vol, t + 0.02);
        g.gain.setValueAtTime(vol, t + dur - 0.05);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        o.connect(g).connect(ctx.destination);
        o.start(t); o.stop(t + dur + 0.05);
      }
    };
    function loop(fn, every) { stop(); fn(); timer = setInterval(fn, every); }
    function stop() { clearInterval(timer); timer = null; }
    return {
      ring: () => loop(() => { beep([880, 1320], 0.18, 0.2); setTimeout(() => beep([880, 1320], 0.18, 0.2), 260); }, 2000),
      ringback: () => loop(() => beep([440, 480], 1, 0.05), 4000),
      stop,
    };
  })();

  // ---------- Notification d'appel entrant ----------
  let titleTimer = null, titleBefore = '';
  function notifyIncoming(from) {
    stopTitleFlash();
    titleBefore = document.title;
    let on = false;
    titleTimer = setInterval(() => { on = !on; document.title = on ? `📞 Appel de ${from}` : titleBefore; }, 1000);
    if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
      const n = new Notification(`📞 Appel audio de ${from}`, { body: 'Clique pour répondre', tag: 'lanchat-call', requireInteraction: true });
      n.onclick = () => { window.focus(); n.close(); };
    }
  }
  function stopTitleFlash() {
    if (!titleTimer) return;
    clearInterval(titleTimer);
    titleTimer = null;
    document.title = titleBefore;
    renderSidebar(); // recalcule le titre avec le nombre de non-lus
  }

  // ---------- Interface ----------
  const ui = document.createElement('div');
  ui.id = 'callUi';
  document.body.appendChild(ui);
  let clock;
  function render() {
    clearInterval(clock);
    const c = call;
    if (!c) { ui.innerHTML = ''; ui.className = ''; return; }
    const avatar = `<div class="call-avatar" style="background:${colorOf(c.peer)}">${initial(c.peer)}</div>`;
    if (c.role === 'callee' && c.state === 'ringing') {
      ui.className = 'call-incoming';
      ui.innerHTML = `<div class="call-card">
        ${avatar}<div class="call-kind">Appel audio entrant</div><div class="call-name">${esc(c.peer)}</div>
        <div class="call-actions">
          <button class="call-btn decline" data-call="decline" title="Refuser">${icon('phone-off')}</button>
          <button class="call-btn accept" data-call="accept" title="Accepter">${icon('phone')}</button>
        </div><div class="call-note">🔒 Chiffré de bout en bout</div></div>`;
      return;
    }
    const status = {
      calling: 'Sonnerie…', ringing: 'Sonnerie…', connecting: 'Connexion…', reconnecting: 'Reconnexion…',
      active: fmtDur(Date.now() - (c.startedAt || Date.now())),
    }[c.state];
    ui.className = 'call-bar' + (c.state === 'active' ? ' active' : '');
    ui.innerHTML = `${avatar}
      <div class="call-info"><div class="call-name">${esc(c.peer)}</div><div class="call-status">${status}</div></div>
      <button class="call-btn small${c.muted ? ' muted' : ''}" data-call="mute" title="${c.muted ? 'Réactiver le micro' : 'Couper le micro'}" ${c.stream ? '' : 'disabled'}>${icon(c.muted ? 'mic-off' : 'mic')}</button>
      <button class="call-btn small decline" data-call="hangup" title="Raccrocher">${icon('phone-off')}</button>`;
    if (c.state === 'active') clock = setInterval(() => { const s = ui.querySelector('.call-status'); if (s && call === c) s.textContent = fmtDur(Date.now() - c.startedAt); }, 1000);
  }
  ui.addEventListener('click', e => {
    const b = e.target.closest('[data-call]');
    if (!b) return;
    ({ accept, decline, hangup, mute: toggleMute })[b.dataset.call]?.();
  });

  return { start, onSignal, active: () => !!call };
})();
