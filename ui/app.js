/**
 * SwarmShare — app.js
 * Handles: upload, download SSE, chunk grid, network canvas animation, log panel
 */

const API = 'http://localhost:5050';

// ── Peer color palette ────────────────────────────────────────────────────────
const PEER_COLORS = [
  '#3b82f6', '#22c55e', '#f97316', '#a855f7',
  '#06b6d4', '#ec4899', '#eab308', '#f43f5e',
];

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  peerColorMap: {},      // peer addr → color
  peerColorIdx: 0,
  networkPeers: [],      // [{id, addr, x, y, vx, vy, active, chunkCount}]
  networkAnimId: null,
  chunkStates: [],       // 'pending' | 'downloading' | 'done' | 'error'
  chunkPeers: [],        // peer addr per chunk
  totalChunks: 0,
  doneChunks: 0,
  errorChunks: 0,
  downloadStartTime: 0,
  totalBytes: 0,
  peerChunkCounts: {},
  currentHash: null,
  downloadActive: false,
};

// ── Canvas setup ──────────────────────────────────────────────────────────────
const canvas = document.getElementById('network-canvas');
const ctx = canvas.getContext('2d');

function resizeCanvas() {
  const wrap = document.getElementById('network-wrap');
  canvas.width  = wrap.offsetWidth;
  canvas.height = wrap.offsetHeight;
}
resizeCanvas();
window.addEventListener('resize', () => { resizeCanvas(); });

// ── Network animation ─────────────────────────────────────────────────────────
const ME = { x: 0, y: 0, label: 'You' };

function layoutPeers() {
  const W = canvas.width, H = canvas.height;
  ME.x = W / 2; ME.y = H / 2;
  const n = state.networkPeers.length;
  state.networkPeers.forEach((p, i) => {
    const angle = (2 * Math.PI * i / n) - Math.PI / 2;
    const radius = Math.min(W, H) * 0.32;
    p.tx = ME.x + Math.cos(angle) * radius;
    p.ty = ME.y + Math.sin(angle) * radius;
    if (p.x === undefined) { p.x = ME.x; p.y = ME.y; }
  });
}

// Flowing packet along edge
const packets = [];

function spawnPacket(fromPeer) {
  packets.push({ peer: fromPeer, t: 0, speed: 0.012 + Math.random() * 0.012 });
}

function drawNetwork(ts) {
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  // Background grid (subtle)
  ctx.strokeStyle = 'rgba(255,255,255,0.02)';
  ctx.lineWidth = 1;
  for (let x = 0; x < W; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  for (let y = 0; y < H; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }

  // Ease peers to target
  state.networkPeers.forEach(p => {
    if (p.tx !== undefined) {
      p.x += (p.tx - p.x) * 0.06;
      p.y += (p.ty - p.y) * 0.06;
    }
  });

  // Draw edges + packets
  state.networkPeers.forEach(p => {
    const color = state.peerColorMap[p.addr] || '#3b82f6';
    const alpha = p.active ? 0.45 : 0.15;
    ctx.strokeStyle = hexToRgba(color, alpha);
    ctx.lineWidth = p.active ? 1.5 : 0.8;
    ctx.setLineDash(p.active ? [4, 4] : [2, 6]);
    ctx.lineDashOffset = -(ts / 60) % 8;
    ctx.beginPath();
    ctx.moveTo(ME.x, ME.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    ctx.setLineDash([]);
  });

  // Advance & draw packets
  for (let i = packets.length - 1; i >= 0; i--) {
    const pk = packets[i];
    pk.t += pk.speed;
    if (pk.t >= 1) { packets.splice(i, 1); continue; }
    const p = state.networkPeers.find(n => n === pk.peer);
    if (!p) { packets.splice(i, 1); continue; }
    const color = state.peerColorMap[p.addr] || '#3b82f6';
    // Lerp from peer → ME
    const x = p.x + (ME.x - p.x) * pk.t;
    const y = p.y + (ME.y - p.y) * pk.t;
    const grd = ctx.createRadialGradient(x, y, 0, x, y, 6);
    grd.addColorStop(0, hexToRgba(color, 0.95));
    grd.addColorStop(1, hexToRgba(color, 0));
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fillStyle = grd;
    ctx.fill();
  }

  // Draw peer nodes
  state.networkPeers.forEach(p => {
    const color = state.peerColorMap[p.addr] || '#3b82f6';
    const r = p.active ? 18 : 14;

    // Glow
    if (p.active) {
      const grd = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 2.2);
      grd.addColorStop(0, hexToRgba(color, 0.25));
      grd.addColorStop(1, 'transparent');
      ctx.beginPath();
      ctx.arc(p.x, p.y, r * 2.2, 0, Math.PI * 2);
      ctx.fillStyle = grd;
      ctx.fill();
    }

    // Node circle
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = hexToRgba(color, 0.18);
    ctx.fill();
    ctx.strokeStyle = hexToRgba(color, p.active ? 0.85 : 0.4);
    ctx.lineWidth = p.active ? 2 : 1;
    ctx.stroke();

    // Label
    ctx.fillStyle = p.active ? '#e2e8f0' : '#4a5568';
    ctx.font = '10px JetBrains Mono, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(shortAddr(p.addr), p.x, p.y + r + 13);
    if (p.chunkCount > 0) {
      ctx.fillStyle = color;
      ctx.font = '9px Inter, sans-serif';
      ctx.fillText(`${p.chunkCount} chunks`, p.x, p.y + r + 23);
    }
  });

  // Draw ME node
  const meR = 22;
  const meGrd = ctx.createRadialGradient(ME.x, ME.y, 0, ME.x, ME.y, meR * 2);
  meGrd.addColorStop(0, 'rgba(59,130,246,0.2)');
  meGrd.addColorStop(1, 'transparent');
  ctx.beginPath(); ctx.arc(ME.x, ME.y, meR * 2, 0, Math.PI * 2);
  ctx.fillStyle = meGrd; ctx.fill();

  ctx.beginPath(); ctx.arc(ME.x, ME.y, meR, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(59,130,246,0.15)'; ctx.fill();
  ctx.strokeStyle = 'rgba(59,130,246,0.8)'; ctx.lineWidth = 2; ctx.stroke();
  ctx.fillStyle = '#e2e8f0';
  ctx.font = '600 11px Inter, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('You', ME.x, ME.y + 4);

  state.networkAnimId = requestAnimationFrame(drawNetwork);
}

requestAnimationFrame(drawNetwork);

// ── Peer management ───────────────────────────────────────────────────────────
function getOrAssignColor(addr) {
  if (!state.peerColorMap[addr]) {
    state.peerColorMap[addr] = PEER_COLORS[state.peerColorIdx % PEER_COLORS.length];
    state.peerColorIdx++;
  }
  return state.peerColorMap[addr];
}

function ensurePeer(addr) {
  let p = state.networkPeers.find(n => n.addr === addr);
  if (!p) {
    p = { addr, x: undefined, y: undefined, tx: undefined, ty: undefined, active: false, chunkCount: 0 };
    state.networkPeers.push(p);
    getOrAssignColor(addr);
    layoutPeers();
    updatePeerCountBadge();
    renderPeerList();
  }
  return p;
}

function setPeerActive(addr, active) {
  const p = ensurePeer(addr);
  p.active = active;
  if (active) spawnPacket(p);
}

function incrementPeerChunk(addr) {
  const p = ensurePeer(addr);
  p.chunkCount = (p.chunkCount || 0) + 1;
  state.peerChunkCounts[addr] = (state.peerChunkCounts[addr] || 0) + 1;
}

function updatePeerCountBadge() {
  document.getElementById('peer-count-badge').textContent = state.networkPeers.length;
  document.getElementById('active-peers-count').textContent = state.networkPeers.filter(p => p.active).length;
}

// ── DHT Status check ──────────────────────────────────────────────────────────
async function checkDHTStatus() {
  try {
    const r = await fetch(`${API}/api/status`, { signal: AbortSignal.timeout(2000) });
    const j = await r.json();
    if (j.status === 'ok') {
      document.getElementById('dht-dot').className = 'dot green';
      document.getElementById('dht-label').textContent = 'DHT Connected';
    }
  } catch {
    document.getElementById('dht-dot').className = 'dot red';
    document.getElementById('dht-label').textContent = 'DHT Offline';
  }
}
checkDHTStatus();
setInterval(checkDHTStatus, 8000);

// ── Refresh files ─────────────────────────────────────────────────────────────
async function refreshFiles() {
  try {
    const r = await fetch(`${API}/api/files`);
    const files = await r.json();
    renderSharedFiles(files);
    log('INFO', `Found ${files.length} file(s) in network storage`);
  } catch {
    log('WARN', 'Could not reach bridge server');
  }
}

function renderSharedFiles(files) {
  const el = document.getElementById('shared-files-list');
  if (!files || files.length === 0) {
    el.innerHTML = '<div class="empty-state" style="height:80px"><div class="empty-label" style="font-size:11px;color:var(--text3)">No files yet — share one above</div></div>';
    return;
  }
  el.innerHTML = files.map(f => `
    <div class="shared-file-item" onclick="fillHash('${f.hash || ''}')" title="${f.path || ''}">
      <span style="font-size:16px">${fileEmoji(f.name)}</span>
      <span class="file-item-name">${f.name}</span>
      <span class="file-item-size">${fmtBytes(f.size)}</span>
      <span class="badge ${f.kind === 'shared' ? 'badge-shared' : 'badge-downloaded'}">${f.kind}</span>
    </div>
  `).join('');
}

function fillHash(hash) {
  if (hash) document.getElementById('download-hash-input').value = hash;
}

// ── File upload ───────────────────────────────────────────────────────────────
let selectedFile = null;

document.getElementById('file-input').addEventListener('change', e => {
  if (e.target.files[0]) handleFileSelect(e.target.files[0]);
});

const dropZone = document.getElementById('drop-zone');
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  if (e.dataTransfer.files[0]) handleFileSelect(e.dataTransfer.files[0]);
});

function handleFileSelect(file) {
  selectedFile = file;
  document.getElementById('preview-name').textContent = file.name;
  document.getElementById('preview-size').textContent = fmtBytes(file.size);
  document.getElementById('file-preview').style.display = 'block';
  document.getElementById('hash-result').style.display = 'none';
  log('INFO', `Selected: ${file.name} (${fmtBytes(file.size)})`);
}

function clearFile() {
  selectedFile = null;
  document.getElementById('file-input').value = '';
  document.getElementById('file-preview').style.display = 'none';
  document.getElementById('hash-result').style.display = 'none';
  document.getElementById('upload-progress-wrap').style.display = 'none';
}

async function uploadFile() {
  if (!selectedFile) { showToast('Select a file first', 'error'); return; }
  const peerIp = document.getElementById('peer-ip-input').value.trim() || '127.0.0.1:8888';

  const btn = document.getElementById('upload-btn');
  btn.disabled = true;
  btn.textContent = 'Sharing…';

  document.getElementById('upload-progress-wrap').style.display = 'block';
  document.getElementById('hash-result').style.display = 'none';

  log('INFO', `Uploading ${selectedFile.name} as peer ${peerIp}`);

  const fd = new FormData();
  fd.append('file', selectedFile);
  fd.append('peer_ip', peerIp);

  try {
    // Animate progress bar while uploading
    let fakeP = 0;
    const fakeInterval = setInterval(() => {
      fakeP = Math.min(fakeP + Math.random() * 12, 90);
      setUploadProgress(fakeP);
    }, 150);

    const r = await fetch(`${API}/api/upload`, { method: 'POST', body: fd });
    clearInterval(fakeInterval);

    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();

    setUploadProgress(100);
    document.getElementById('upload-progress-label').textContent = 'Registered in DHT ✓';

    document.getElementById('hash-display').textContent = data.hash;
    document.getElementById('hash-result').style.display = 'block';

    // Add peer to network
    ensurePeer(peerIp);
    setPeerActive(peerIp, false);
    renderPeerList();

    log('OK', `File shared! Hash: ${data.hash.slice(0,16)}…`);
    log('INFO', `${data.num_chunks} chunks × ${fmtBytes(262144)} registered for ${peerIp}`);
    showToast('File shared and registered in DHT ✓', 'success');

    refreshFiles();
  } catch (e) {
    log('ERROR', `Upload failed: ${e.message}`);
    showToast('Upload failed — is bridge.py running?', 'error');
    document.getElementById('upload-progress-label').textContent = 'Upload failed';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Share to Network';
  }
}

function setUploadProgress(pct) {
  document.getElementById('upload-bar').style.width = pct + '%';
  document.getElementById('upload-progress-pct').textContent = Math.round(pct) + '%';
}

function copyHash() {
  const h = document.getElementById('hash-display').textContent;
  navigator.clipboard.writeText(h).then(() => showToast('Hash copied!', 'success'));
}

// ── Download ──────────────────────────────────────────────────────────────────
async function startDownload() {
  const hash = document.getElementById('download-hash-input').value.trim();
  if (!hash) { showToast('Paste a file hash first', 'error'); return; }
  if (state.downloadActive) { showToast('Download already in progress', 'error'); return; }

  state.downloadActive = true;
  state.currentHash = hash;
  state.downloadStartTime = Date.now();
  state.doneChunks = 0;
  state.errorChunks = 0;
  state.peerChunkCounts = {};
  state.chunkStates = [];
  state.chunkPeers = [];

  // Reset UI
  document.getElementById('dl-empty').style.display = 'none';
  document.getElementById('dl-active').style.display = 'block';
  document.getElementById('dl-complete-banner').style.display = 'none';
  document.getElementById('dl-btn').disabled = true;
  document.getElementById('dl-btn').textContent = 'Downloading…';
  document.getElementById('chunk-grid').innerHTML = '';
  document.getElementById('peer-legend').innerHTML = '';
  document.getElementById('dl-progress-bar').style.width = '0%';

  log('EVT', `Starting download: ${hash.slice(0,16)}…`);
  log('INFO', `Querying DHT for peers…`);

  try {
    const r = await fetch(`${API}/api/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hash }),
    });

    if (!r.ok) {
      const err = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
      throw new Error(err.error || `HTTP ${r.status}`);
    }

    // SSE stream
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop();
      for (const part of parts) {
        const line = part.trim();
        if (!line.startsWith('data:')) continue;
        try {
          const evt = JSON.parse(line.slice(5).trim());
          handleDownloadEvent(evt);
        } catch { /* ignore */ }
      }
    }
  } catch (e) {
    log('ERROR', `Download error: ${e.message}`);
    showToast(`Download failed: ${e.message}`, 'error');
    resetDownload();
  }
}

function handleDownloadEvent(evt) {
  switch (evt.type) {
    case 'init':
      initChunkGrid(evt.num_chunks, evt.peers);
      document.getElementById('stat-total').textContent = evt.num_chunks;
      document.getElementById('stat-peers').textContent = evt.peers.length;
      log('INFO', `${evt.peers.length} peer(s): ${evt.peers.map(shortAddr).join(', ')}`);
      log('INFO', `Splitting into ${evt.num_chunks} chunks (${fmtBytes(evt.total_size)} total)`);
      evt.peers.forEach(p => { ensurePeer(p); });
      renderPeerList();
      break;

    case 'chunk_start':
      updateChunk(evt.chunk, 'downloading', evt.peer);
      setPeerActive(evt.peer, true);
      log('EVT', `↓ Chunk ${evt.chunk} from ${shortAddr(evt.peer)} [${fmtBytes(evt.end - evt.start + 1)}]`);
      break;

    case 'chunk_done':
      updateChunk(evt.chunk, 'done', evt.peer);
      setPeerActive(evt.peer, false);
      state.doneChunks++;
      state.totalBytes += evt.bytes || 0;
      incrementPeerChunk(evt.peer);
      updateDownloadStats();
      updatePeerLegend();
      renderPeerList();
      // Spawn packet on each done for visual richness
      spawnPacket(state.networkPeers.find(n => n.addr === evt.peer));
      log('OK', `✓ Chunk ${evt.chunk} done in ${evt.elapsed}s from ${shortAddr(evt.peer)}`);
      break;

    case 'chunk_error':
      updateChunk(evt.chunk, 'error', evt.peer);
      state.errorChunks++;
      log('ERROR', `✗ Chunk ${evt.chunk} failed (${evt.error?.slice(0,60)}…)`);
      break;

    case 'complete':
      downloadComplete(evt);
      break;

    case 'heartbeat':
      break;
  }
}

function initChunkGrid(n, peers) {
  state.totalChunks = n;
  state.chunkStates = new Array(n).fill('pending');
  state.chunkPeers  = new Array(n).fill(null);

  const grid = document.getElementById('chunk-grid');
  grid.innerHTML = '';
  for (let i = 0; i < n; i++) {
    const cell = document.createElement('div');
    cell.className = 'chunk-cell';
    cell.id = `chunk-${i}`;
    cell.title = `Chunk ${i}`;
    grid.appendChild(cell);
  }

  peers.forEach(p => {
    getOrAssignColor(p);
    ensurePeer(p);
  });
  updatePeerLegend();
}

function updateChunk(idx, newState, peerAddr) {
  if (idx < 0 || idx >= state.totalChunks) return;
  state.chunkStates[idx] = newState;
  state.chunkPeers[idx] = peerAddr;

  const cell = document.getElementById(`chunk-${idx}`);
  if (!cell) return;
  cell.className = 'chunk-cell ' + newState;

  if (newState === 'done') {
    const color = state.peerColorMap[peerAddr] || '#3b82f6';
    cell.style.background = color;
    cell.style.border = 'none';
    // Micro bounce
    cell.style.transform = 'scale(1.3)';
    setTimeout(() => { cell.style.transform = 'scale(1)'; }, 250);
  } else if (newState === 'downloading') {
    cell.style.background = '';
    cell.style.border = '';
  } else if (newState === 'error') {
    cell.style.background = '';
    cell.style.border = '';
  }
}

function updateDownloadStats() {
  const done = state.doneChunks;
  const total = state.totalChunks;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  document.getElementById('stat-done').textContent = done;
  document.getElementById('dl-progress-bar').style.width = pct + '%';
  document.getElementById('dl-progress-pct').textContent = pct + '%';
  document.getElementById('dl-progress-text').textContent = `Downloading… ${done}/${total} chunks`;

  const elapsed = (Date.now() - state.downloadStartTime) / 1000;
  if (elapsed > 0 && state.totalBytes > 0) {
    const speed = state.totalBytes / elapsed;
    document.getElementById('stat-speed').textContent = fmtSpeed(speed);
  }
}

function updatePeerLegend() {
  const legend = document.getElementById('peer-legend');
  legend.innerHTML = Object.entries(state.peerChunkCounts).map(([addr, count]) => {
    const color = state.peerColorMap[addr] || '#3b82f6';
    return `
      <div class="peer-legend-item">
        <div class="peer-legend-color" style="background:${color}"></div>
        <span class="peer-legend-name">${shortAddr(addr)}</span>
        <span class="peer-legend-chunks">${count} chunks</span>
      </div>`;
  }).join('');
}

function downloadComplete(evt) {
  state.downloadActive = false;
  const elapsed = ((Date.now() - state.downloadStartTime) / 1000).toFixed(1);
  const banner = document.getElementById('dl-complete-banner');
  banner.style.display = 'flex';
  document.getElementById('dl-complete-sub').textContent =
    `${evt.chunks} chunks from ${evt.peers?.length ?? '?'} peers in ${elapsed}s`;
  document.getElementById('dl-progress-bar').style.width = '100%';
  document.getElementById('dl-progress-text').textContent = 'Complete';
  document.getElementById('dl-progress-pct').textContent = '100%';

  // Freeze all chunks as done
  for (let i = 0; i < state.totalChunks; i++) {
    if (state.chunkStates[i] !== 'error') updateChunk(i, 'done', state.chunkPeers[i]);
  }

  // Celebration packets
  state.networkPeers.forEach(p => spawnPacket(p));
  setTimeout(() => state.networkPeers.forEach(p => spawnPacket(p)), 300);

  log('OK', `✓ Download complete! ${evt.chunks} chunks in ${elapsed}s`);
  showToast('Download complete! 🎉', 'success');
  resetDownload(false);
  refreshFiles();
}

function resetDownload(clearActive = true) {
  if (clearActive) state.downloadActive = false;
  document.getElementById('dl-btn').disabled = false;
  document.getElementById('dl-btn').textContent = 'Download';
  // De-activate all peers
  state.networkPeers.forEach(p => { p.active = false; });
  updatePeerCountBadge();
}

// ── Peer list (right sidebar) ─────────────────────────────────────────────────
function renderPeerList() {
  const el = document.getElementById('live-peers-list');
  if (state.networkPeers.length === 0) {
    el.innerHTML = '<div style="padding:8px 0;font-size:11px;color:var(--text3);text-align:center">No peers discovered yet</div>';
    return;
  }
  el.innerHTML = state.networkPeers.map(p => {
    const color = state.peerColorMap[p.addr] || '#3b82f6';
    const chunks = state.peerChunkCounts[p.addr] || 0;
    return `
      <div class="peer-item">
        <div class="peer-color-dot" style="background:${color};box-shadow:0 0 6px ${color}80"></div>
        <span class="peer-addr">${p.addr}</span>
        ${chunks > 0 ? `<span class="peer-chunks-count">${chunks}×</span>` : ''}
        <div class="dot ${p.active ? 'green' : ''}" style="${p.active ? '' : 'background:var(--text3)'}"></div>
      </div>`;
  }).join('');
  updatePeerCountBadge();
}

// ── Log panel ─────────────────────────────────────────────────────────────────
function log(level, msg) {
  const panel = document.getElementById('log-panel');
  const now = new Date().toLocaleTimeString('en-GB', { hour12: false });
  const line = document.createElement('div');
  line.className = `log-line log-${level}`;
  // Color-code level badge
  const levelColors = { INFO: '#8892a4', WARN: '#eab308', ERROR: '#ef4444', OK: '#22c55e', EVT: '#06b6d4' };
  const lc = levelColors[level] || '#8892a4';
  line.innerHTML = `<span class="log-time">${now}</span>  <span style="color:${lc};font-weight:500">${level.padEnd(5)}</span>  ${escHtml(msg)}`;
  panel.appendChild(line);
  panel.scrollTop = panel.scrollHeight;

  // Trim log to 200 lines
  while (panel.children.length > 200) panel.removeChild(panel.firstChild);
}

function clearLog() {
  document.getElementById('log-panel').innerHTML = '';
}

// ── Toast ─────────────────────────────────────────────────────────────────────
let toastTimer = null;
function showToast(msg, type = 'info') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, 3000);
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function fmtBytes(b) {
  if (!b || b === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(b) / Math.log(1024));
  return (b / Math.pow(1024, i)).toFixed(1) + ' ' + units[i];
}

function fmtSpeed(bps) {
  return fmtBytes(bps) + '/s';
}

function shortAddr(addr) {
  if (!addr) return '?';
  return addr.length > 18 ? addr.slice(0, 15) + '…' : addr;
}

function fileEmoji(name = '') {
  const ext = name.split('.').pop().toLowerCase();
  const map = { mp4: '🎬', mkv: '🎬', avi: '🎬', mov: '🎬', mp3: '🎵', wav: '🎵', flac: '🎵',
    jpg: '🖼', jpeg: '🖼', png: '🖼', gif: '🖼', svg: '🖼', pdf: '📄', doc: '📄', docx: '📄',
    txt: '📝', md: '📝', zip: '📦', tar: '📦', gz: '📦', rar: '📦', py: '🐍', js: '📜',
    html: '🌐', css: '🎨', hs: '⚡', json: '{}' };
  return map[ext] || '📄';
}

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1,3), 16);
  const g = parseInt(hex.slice(3,5), 16);
  const b = parseInt(hex.slice(5,7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Init ──────────────────────────────────────────────────────────────────────
log('INFO', 'SwarmShare UI initialized');
log('INFO', `Bridge: ${API}`);
refreshFiles();
