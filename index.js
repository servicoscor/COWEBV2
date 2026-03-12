/* ===== BROADCAST CHANNEL + LOCALSTORAGE ===== */
const BC = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('cor_rio_alert') : null;
const LS_KEY = 'cor_rio_state';
const STAGE_MIN = 1;
const STAGE_MAX = 5;
const HEAT_MIN = 1;
const HEAT_MAX = 5;

function normalizeState(stage, heat){
  const s = Number.parseInt(stage, 10);
  const h = Number.parseInt(heat, 10);
  if(!Number.isInteger(s) || !Number.isInteger(h)) return null;
  return {
    stage: Math.min(STAGE_MAX, Math.max(STAGE_MIN, s)),
    heat: Math.min(HEAT_MAX, Math.max(HEAT_MIN, h))
  };
}

function saveState(stage, heat){
  const state = { stage, heat, ts: new Date().toLocaleString('pt-BR') };
  try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch(e){}
  if(BC) BC.postMessage(state);
  dbPut('/state', state);
}

function loadState(){
  try{
    const raw = localStorage.getItem(LS_KEY);
    if(!raw) return null;
    const parsed = JSON.parse(raw);
    return normalizeState(parsed.stage, parsed.heat);
  }catch(e){
    return null;
  }
}

async function hydrateStateFromDatabase(){
  const remote = await dbGet('/state');
  if(!remote) return;
  const normalized = normalizeState(remote.stage, remote.heat);
  if(!normalized) return;
  if(normalized.stage === curStage && normalized.heat === curHeat) return;
  curStage = normalized.stage;
  curHeat = normalized.heat;
  syncButtons();
  applyAlert({ persist:false });
}

/* ===== API SYNC =====
  Configure by one of:
  1) window.COWEB_API = { stageUrl, heatUrl, pollMs, timeoutMs, headers }
  2) query string: ?api_stage=...&api_heat=...&api_poll_ms=10000
  3) localStorage keys: cor_api_stage_url / cor_api_heat_url / cor_api_poll_ms
*/
const API_STAGE_KEYS = new Set([
  'stage','estagio','stage_level','estagio_level','nivel_estagio',
  'nivelestagio','current_stage','currentestagio','id_estagio','idstage','level','nivel'
]);
const API_HEAT_KEYS = new Set([
  'heat','calor','heat_level','calor_level','nivel_calor',
  'nivelcalor','current_heat','currentcalor','id_calor','idheat','level','nivel'
]);
const DEFAULT_STAGE_API_URL = 'https://aplicativo.cocr.com.br/estagio_api_app';
const DEFAULT_HEAT_API_URL = 'https://aplicativo.cocr.com.br/calor_api';

let apiSyncTimer = null;
let apiSyncInFlight = false;
let apiSyncStarted = false;

function safeGetLocalStorage(key){
  try{ return localStorage.getItem(key); }catch(e){ return null; }
}

/* ===== INTERNAL DB API ===== */
const DB_API_BASE = (() => {
  const params = new URLSearchParams(location.search);
  const fromQuery = params.get('db_api');
  const fromStorage = safeGetLocalStorage('cor_db_api_base');
  const fromGlobal = (window.COWEB_DB && typeof window.COWEB_DB === 'object') ? window.COWEB_DB.baseUrl : '';
  const fallback = `${location.protocol}//${location.hostname}:5050/api`;
  return String(fromQuery || fromStorage || fromGlobal || fallback).replace(/\/$/, '');
})();

let dbApiWarned = false;

function warnDbApiOnce(err){
  if(dbApiWarned) return;
  dbApiWarned = true;
  console.warn('[DB API] indisponivel:', err && err.message ? err.message : err);
}

async function dbRequest(path, options = {}){
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  const res = await fetch(`${DB_API_BASE}${path}`, { ...options, headers });
  if(!res.ok) throw new Error(`HTTP ${res.status}`);
  const ct = res.headers.get('content-type') || '';
  if(ct.includes('application/json')) return res.json();
  return res.text();
}

async function dbGet(path){
  try{
    return await dbRequest(path);
  }catch(err){
    warnDbApiOnce(err);
    return null;
  }
}

function dbPut(path, payload){
  return dbRequest(path, { method: 'PUT', body: JSON.stringify(payload) })
    .catch(err=>{ warnDbApiOnce(err); return null; });
}

async function dbGetCollection(name){
  const payload = await dbGet(`/collections/${name}`);
  if(!payload || !Array.isArray(payload.items)) return null;
  return payload.items;
}

function dbPutCollection(name, items){
  return dbPut(`/collections/${name}`, { items });
}

function readApiSyncConfig(){
  const params = new URLSearchParams(location.search);
  const g = (window.COWEB_API && typeof window.COWEB_API === 'object') ? window.COWEB_API : {};
  const stageUrl = params.get('api_stage') || safeGetLocalStorage('cor_api_stage_url') || g.stageUrl || DEFAULT_STAGE_API_URL;
  const heatUrl = params.get('api_heat') || safeGetLocalStorage('cor_api_heat_url') || g.heatUrl || DEFAULT_HEAT_API_URL;
  const pollRaw = params.get('api_poll_ms') || safeGetLocalStorage('cor_api_poll_ms') || g.pollMs;
  const timeoutRaw = params.get('api_timeout_ms') || safeGetLocalStorage('cor_api_timeout_ms') || g.timeoutMs;
  const pollMs = Number.parseInt(pollRaw, 10);
  const timeoutMs = Number.parseInt(timeoutRaw, 10);

  return {
    stageUrl: String(stageUrl || '').trim(),
    heatUrl: String(heatUrl || '').trim(),
    pollMs: Number.isInteger(pollMs) ? Math.max(0, pollMs) : 0,
    timeoutMs: Number.isInteger(timeoutMs) ? Math.max(1500, timeoutMs) : 6000,
    headers: (g.headers && typeof g.headers === 'object') ? g.headers : {}
  };
}

function parseLevelValue(value){
  if(typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if(typeof value !== 'string') return null;
  const m = value.trim().match(/-?\d+/);
  if(!m) return null;
  const parsed = Number.parseInt(m[0], 10);
  return Number.isInteger(parsed) ? parsed : null;
}

function extractLevelFromPayload(payload, keySet, seen = new WeakSet()){
  // Support APIs that return plain "3" / 3.
  if(typeof payload === 'string' || typeof payload === 'number'){
    return parseLevelValue(payload);
  }

  if(!payload || typeof payload !== 'object') return null;
  if(seen.has(payload)) return null;
  seen.add(payload);

  if(Array.isArray(payload)){
    for(const item of payload){
      const found = extractLevelFromPayload(item, keySet, seen);
      if(found !== null) return found;
    }
    return null;
  }

  for(const [rawKey, value] of Object.entries(payload)){
    const key = String(rawKey).toLowerCase();
    if(keySet.has(key)){
      const found = parseLevelValue(value);
      if(found !== null) return found;
    }
    if(value && typeof value === 'object'){
      const nested = extractLevelFromPayload(value, keySet, seen);
      if(nested !== null) return nested;
    }
  }
  return null;
}

async function fetchApiPayload(url, timeoutMs, headers){
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(), timeoutMs);
  try{
    const res = await fetch(url, {
      method: 'GET',
      cache: 'no-store',
      headers,
      signal: controller.signal
    });
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if(!text) return null;
    try{ return JSON.parse(text); }catch(e){ return text.trim(); }
  }finally{
    clearTimeout(timer);
  }
}

async function pollApiStateOnce(config){
  if(apiSyncInFlight) return;

  const cfg = config || readApiSyncConfig();
  if(!cfg.stageUrl && !cfg.heatUrl) return;

  apiSyncInFlight = true;
  try{
    const [stagePayload, heatPayload] = await Promise.all([
      cfg.stageUrl ? fetchApiPayload(cfg.stageUrl, cfg.timeoutMs, cfg.headers) : Promise.resolve(null),
      cfg.heatUrl ? fetchApiPayload(cfg.heatUrl, cfg.timeoutMs, cfg.headers) : Promise.resolve(null),
    ]);

    let apiStage = null;
    let apiHeat = null;

    if(stagePayload !== null){
      apiStage = extractLevelFromPayload(stagePayload, API_STAGE_KEYS);
      apiHeat = extractLevelFromPayload(stagePayload, API_HEAT_KEYS);
    }
    if(heatPayload !== null){
      if(apiHeat === null) apiHeat = extractLevelFromPayload(heatPayload, API_HEAT_KEYS);
      if(apiStage === null) apiStage = extractLevelFromPayload(heatPayload, API_STAGE_KEYS);
    }

    const normalized = normalizeState(
      apiStage === null ? curStage : apiStage,
      apiHeat === null ? curHeat : apiHeat
    );
    if(!normalized) return;
    if(normalized.stage === curStage && normalized.heat === curHeat) return;

    curStage = normalized.stage;
    curHeat = normalized.heat;
    syncButtons();
    applyAlert();
  }catch(err){
    console.warn('[API Sync]', err && err.message ? err.message : err);
  }finally{
    apiSyncInFlight = false;
  }
}

async function runApiSyncLoop(){
  if(!apiSyncStarted) return;
  const cfg = readApiSyncConfig();
  if(!cfg.stageUrl && !cfg.heatUrl){
    apiSyncTimer = setTimeout(runApiSyncLoop, 1000);
    return;
  }
  await pollApiStateOnce(cfg);
  apiSyncTimer = setTimeout(runApiSyncLoop, cfg.pollMs);
}

function startApiSync(){
  if(apiSyncStarted) return;
  apiSyncStarted = true;

  const cfg = readApiSyncConfig();
  if(!cfg.stageUrl && !cfg.heatUrl) return;
  runApiSyncLoop();
}

/* ===== CLOCK ===== */
function updateClock(){
  const now = new Date();
  const t = now.toLocaleTimeString('pt-BR',{hour12:false});
  const d = now.toLocaleDateString('pt-BR',{day:'2-digit',month:'short',year:'numeric'});
  const ct = document.getElementById('clk-time');
  const cd = document.getElementById('clk-date');
  if(ct) ct.textContent = t;
  if(cd) cd.textContent = d;
}
setInterval(updateClock,1000); updateClock();

/* ===== NAV ===== */
function switchSection(id){
  document.querySelectorAll('.section').forEach(s=>s.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b=>{
    b.classList.toggle('active', b.dataset.sec===id);
  });
  const section = document.getElementById(id);
  if(section) section.classList.add('active');
}

/* ===== S1: MONITOR DE SITES ===== */
const SYS_LS_KEY = 'cor_web_systems_v1';
const SYS_AUTO_RECHECK_MS = 60000;
let systems = [];
let currentFilter = 'all';
let currentSearch = '';
let editingSystemId = null;
let selectedSystemUrl = '';

function normalizeSiteUrl(raw){
  const trimmed = String(raw || '').trim();
  if(!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try{
    const parsed = new URL(withScheme);
    if(parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.href;
  }catch(e){
    return null;
  }
}

function escapeHtml(str){
  return String(str || '')
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;');
}

function getDefaultSystems(){
  return [
    { id:'api-estagio', name:'API Estagio', url:DEFAULT_STAGE_API_URL, status:'checking', message:'Aguardando teste', lastCheck:0 },
    { id:'api-calor', name:'API Calor', url:DEFAULT_HEAT_API_URL, status:'checking', message:'Aguardando teste', lastCheck:0 }
  ];
}

function loadSystemsRegistry(){
  try{
    const raw = localStorage.getItem(SYS_LS_KEY);
    if(!raw) return getDefaultSystems();
    const parsed = JSON.parse(raw);
    if(!Array.isArray(parsed)) return getDefaultSystems();
    return parsed.filter(x=>x && typeof x === 'object' && x.id && x.name && x.url);
  }catch(e){
    return getDefaultSystems();
  }
}

function saveSystemsRegistry(){
  try{ localStorage.setItem(SYS_LS_KEY, JSON.stringify(systems)); }catch(e){}
  dbPutCollection('systems', systems);
}

function normalizeSystemsPayload(items){
  if(!Array.isArray(items)) return [];
  return items
    .filter(x=>x && typeof x === 'object' && x.id && x.name && x.url)
    .map(x=>({
      id: String(x.id),
      name: String(x.name),
      url: String(x.url),
      status: String(x.status || 'checking'),
      message: typeof x.message === 'string' ? x.message : '',
      lastCheck: Number(x.lastCheck || 0)
    }));
}

async function hydrateSystemsFromDatabase(){
  const remote = await dbGetCollection('systems');
  if(!remote) return;
  const normalized = normalizeSystemsPayload(remote);
  if(!normalized.length){
    if(systems.length) dbPutCollection('systems', systems);
    return;
  }
  systems = normalized;
  try{ localStorage.setItem(SYS_LS_KEY, JSON.stringify(systems)); }catch(e){}
  renderSystemsRegistry();
}

function getStatusMeta(status){
  if(status === 'online') return { dot:'dot-on', text:'Online' };
  if(status === 'offline') return { dot:'dot-off', text:'Offline' };
  return { dot:'dot-warn', text:'Verificando...' };
}

function updateSystemsCounters(){
  const online = systems.filter(x=>x.status === 'online').length;
  const offline = systems.filter(x=>x.status === 'offline').length;
  const countOnline = document.getElementById('count-online');
  const countOffline = document.getElementById('count-offline');
  const expActive = document.getElementById('exp-active-count');
  const expInactive = document.getElementById('exp-inactive-count');
  const badge = document.getElementById('s1-badge-active');
  if(countOnline) countOnline.textContent = String(online);
  if(countOffline) countOffline.textContent = String(offline);
  if(expActive) expActive.textContent = String(online);
  if(expInactive) expInactive.textContent = String(offline);
  if(badge) badge.textContent = `${online} ativo${online===1?'':'s'}`;
}

function getVisibleSystems(){
  return systems.filter(sys=>{
    if(currentFilter === 'online' && sys.status !== 'online') return false;
    if(currentFilter === 'offline' && sys.status !== 'offline') return false;
    if(currentSearch){
      const hay = `${sys.name} ${sys.url}`.toLowerCase();
      if(!hay.includes(currentSearch)) return false;
    }
    return true;
  });
}

function renderSystemsRegistry(){
  const list = document.getElementById('sys-list');
  if(!list) return;
  const visible = getVisibleSystems();
  if(!visible.length){
    list.innerHTML = `<div class="sys-card"><div class="sys-status"><span class="dot dot-warn"></span>Nenhum sistema encontrado</div></div>`;
    updateSystemsCounters();
    return;
  }

  list.innerHTML = visible.map(sys=>{
    const meta = getStatusMeta(sys.status);
    const checkedAt = sys.lastCheck ? new Date(sys.lastCheck).toLocaleTimeString('pt-BR',{hour12:false}) : '--:--:--';
    return `
      <div class="sys-card" data-id="${escapeHtml(sys.id)}">
        <div class="sys-name">${escapeHtml(sys.name)}</div>
        <div class="sys-status"><span class="dot ${meta.dot}"></span>${meta.text} • ${escapeHtml(checkedAt)}</div>
        <div class="sys-acts">
          <button type="button" class="sys-acts-btn" data-act="check">Revalidar</button>
          <button type="button" class="sys-acts-btn" data-act="edit">Editar</button>
          <button type="button" class="sys-acts-btn" data-act="show">Exibir</button>
          <button type="button" class="sys-acts-btn" data-act="open">Abrir</button>
          <button type="button" class="sys-acts-btn danger" data-act="delete">Excluir</button>
        </div>
      </div>
    `;
  }).join('');
  updateSystemsCounters();
}

function setSystemFormMode(isEditing){
  const btnTest = document.getElementById('btn-test-conn');
  if(btnTest) btnTest.textContent = isEditing ? 'Salvar Edicao' : 'Testar Conexao';
}

function startEditingSystem(sys){
  const nameEl = document.getElementById('inp-sys-name');
  const urlEl = document.getElementById('inp-sys-url');
  if(!nameEl || !urlEl || !sys) return;
  editingSystemId = sys.id;
  nameEl.value = sys.name || '';
  urlEl.value = sys.url || '';
  setSystemFormMode(true);
  nameEl.focus();
}

function openSystemInfoModal(sys){
  if(!sys) return;
  const meta = getStatusMeta(sys.status);
  const checkedAt = sys.lastCheck ? new Date(sys.lastCheck).toLocaleString('pt-BR') : 'Nao verificado';
  setInfoModalLabels('Informacoes do Sistema', 'Nome', 'URL', 'Status', 'Ultima verificacao');
  fillInfoModal(sys.name || '-', sys.url || '-', meta.text, checkedAt);
  const normalized = normalizeSiteUrl(sys.url || '');
  selectedSystemUrl = normalized || '';
  setInfoModalOpenButton(selectedSystemUrl ? 'Abrir URL' : 'Sem URL', !selectedSystemUrl);
  showInfoModal();
}

function openInfraInfoModal(item){
  if(!item) return;
  const meta = getInfraStatusMeta(item.status);
  const checkedAt = item.updatedAt ? new Date(item.updatedAt).toLocaleString('pt-BR') : 'Nao atualizado';
  setInfoModalLabels('Informacoes de Infraestrutura', 'Recurso', 'Host / Endereco', 'Status / Tipo', 'Ultima atualizacao');
  fillInfoModal(item.name || '-', item.host || '-', `${meta.text} · ${item.type || 'Nao informado'}`, checkedAt);
  const normalized = normalizeSiteUrl(item.host || '');
  selectedSystemUrl = normalized || '';
  setInfoModalOpenButton(selectedSystemUrl ? 'Abrir Host' : 'Sem URL', !selectedSystemUrl);
  showInfoModal();
}

function setInfoModalLabels(title, nameLabel, urlLabel, statusLabel, lastCheckLabel){
  const elTitle = document.getElementById('sys-info-title');
  const elNameLabel = document.getElementById('sys-info-label-name');
  const elUrlLabel = document.getElementById('sys-info-label-url');
  const elStatusLabel = document.getElementById('sys-info-label-status');
  const elLastLabel = document.getElementById('sys-info-label-last-check');
  if(elTitle) elTitle.textContent = title;
  if(elNameLabel) elNameLabel.textContent = nameLabel;
  if(elUrlLabel) elUrlLabel.textContent = urlLabel;
  if(elStatusLabel) elStatusLabel.textContent = statusLabel;
  if(elLastLabel) elLastLabel.textContent = lastCheckLabel;
}

function fillInfoModal(name, url, status, lastCheck){
  const elName = document.getElementById('sys-info-name');
  const elUrl = document.getElementById('sys-info-url');
  const elStatus = document.getElementById('sys-info-status');
  const elLastCheck = document.getElementById('sys-info-last-check');
  if(elName) elName.textContent = name;
  if(elUrl) elUrl.textContent = url;
  if(elStatus) elStatus.textContent = status;
  if(elLastCheck) elLastCheck.textContent = lastCheck;
}

function setInfoModalOpenButton(text, disabled){
  const openBtn = document.getElementById('sys-info-open-url');
  if(!openBtn) return;
  openBtn.textContent = text;
  openBtn.disabled = !!disabled;
}

function showInfoModal(){
  const modal = document.getElementById('sys-info-modal');
  if(!modal) return;
  modal.classList.add('show');
  modal.setAttribute('aria-hidden', 'false');
}

function closeSystemInfoModal(){
  const modal = document.getElementById('sys-info-modal');
  if(!modal) return;
  selectedSystemUrl = '';
  modal.classList.remove('show');
  modal.setAttribute('aria-hidden', 'true');
}

function initSystemInfoModal(){
  const modal = document.getElementById('sys-info-modal');
  if(!modal) return;
  const closeX = document.getElementById('sys-info-close-x');
  const closeBtn = document.getElementById('sys-info-close-btn');
  const openBtn = document.getElementById('sys-info-open-url');

  if(closeX) closeX.addEventListener('click', closeSystemInfoModal);
  if(closeBtn) closeBtn.addEventListener('click', closeSystemInfoModal);
  if(openBtn){
    openBtn.addEventListener('click', ()=>{
      if(!selectedSystemUrl) return;
      window.open(selectedSystemUrl, '_blank', 'noopener');
    });
  }
  modal.addEventListener('click', (event)=>{
    if(event.target === modal) closeSystemInfoModal();
  });
  document.addEventListener('keydown', (event)=>{
    if(event.key === 'Escape') closeSystemInfoModal();
  });
}

function setFilterButton(filter){
  const all = document.getElementById('fbtn-all');
  const onl = document.getElementById('fbtn-online');
  const off = document.getElementById('fbtn-offline');
  if(all) all.classList.toggle('on', filter==='all');
  if(onl) onl.classList.toggle('on', filter==='online');
  if(off) off.classList.toggle('on', filter==='offline');
}

async function probeWebsite(url, timeoutMs = 7000){
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(), timeoutMs);
  const start = performance.now();
  try{
    await fetch(url, {
      method:'GET',
      mode:'no-cors',
      cache:'no-store',
      signal:controller.signal
    });
    return { online:true, latency:Math.max(1, Math.round(performance.now()-start)) };
  }catch(err){
    return {
      online:false,
      latency:Math.max(1, Math.round(performance.now()-start)),
      reason: err && err.name === 'AbortError' ? 'timeout' : 'erro'
    };
  }finally{
    clearTimeout(timer);
  }
}

async function validateSystemById(id){
  const sys = systems.find(x=>x.id===id);
  if(!sys) return;
  renderSystemsRegistry();

  const result = await probeWebsite(sys.url);
  sys.status = result.online ? 'online' : 'offline';
  sys.lastCheck = Date.now();
  saveSystemsRegistry();
  renderSystemsRegistry();
}

async function revalidateAllSystems(){
  for(const sys of systems){
    await validateSystemById(sys.id);
  }
}

function addSystemFromForm(){
  const nameEl = document.getElementById('inp-sys-name');
  const urlEl = document.getElementById('inp-sys-url');
  if(!urlEl) return;

  const normalizedUrl = normalizeSiteUrl(urlEl.value);
  if(!normalizedUrl){
    alert('URL invalida. Exemplo: https://exemplo.com');
    urlEl.focus();
    return;
  }

  const parsed = new URL(normalizedUrl);
  const fallbackName = parsed.hostname.replace(/^www\./i,'');
  const name = (nameEl && nameEl.value.trim()) ? nameEl.value.trim() : fallbackName;

  if(editingSystemId){
    const editingSys = systems.find(x=>x.id===editingSystemId);
    if(editingSys){
      editingSys.name = name;
      editingSys.url = normalizedUrl;
      editingSys.status = 'checking';
      editingSys.lastCheck = 0;
      saveSystemsRegistry();
      renderSystemsRegistry();
      validateSystemById(editingSys.id);
      editingSystemId = null;
      setSystemFormMode(false);
      if(nameEl) nameEl.value = '';
      urlEl.value = '';
      return;
    }
    editingSystemId = null;
    setSystemFormMode(false);
  }

  const existing = systems.find(x=>x.url===normalizedUrl);
  if(existing){
    existing.name = name;
    saveSystemsRegistry();
    renderSystemsRegistry();
    validateSystemById(existing.id);
  }else{
    const id = `sys-${Date.now()}-${Math.floor(Math.random()*1000)}`;
    systems.unshift({ id, name, url:normalizedUrl, status:'checking', lastCheck:0 });
    saveSystemsRegistry();
    renderSystemsRegistry();
    validateSystemById(id);
  }

  if(nameEl) nameEl.value = '';
  urlEl.value = '';
}

function clearSystemForm(){
  const nameEl = document.getElementById('inp-sys-name');
  const urlEl = document.getElementById('inp-sys-url');
  editingSystemId = null;
  setSystemFormMode(false);
  if(nameEl) nameEl.value = '';
  if(urlEl) urlEl.value = '';
}

function initSystemsMonitor(){
  systems = loadSystemsRegistry();
  editingSystemId = null;
  setSystemFormMode(false);
  renderSystemsRegistry();
  hydrateSystemsFromDatabase();
  revalidateAllSystems();
  setInterval(revalidateAllSystems, SYS_AUTO_RECHECK_MS);

  const btnTest = document.getElementById('btn-test-conn');
  const btnClear = document.getElementById('btn-clear-form');
  const btnRevalidate = document.getElementById('fbtn-revalidate');
  const btnAll = document.getElementById('fbtn-all');
  const btnOnline = document.getElementById('fbtn-online');
  const btnOffline = document.getElementById('fbtn-offline');
  const search = document.getElementById('s1-search');
  const urlInput = document.getElementById('inp-sys-url');
  const list = document.getElementById('sys-list');

  if(btnTest) btnTest.addEventListener('click', addSystemFromForm);
  if(btnClear) btnClear.addEventListener('click', clearSystemForm);
  if(btnRevalidate) btnRevalidate.addEventListener('click', revalidateAllSystems);
  if(btnAll) btnAll.addEventListener('click', ()=>{ currentFilter='all'; setFilterButton('all'); renderSystemsRegistry(); });
  if(btnOnline) btnOnline.addEventListener('click', ()=>{ currentFilter='online'; setFilterButton('online'); renderSystemsRegistry(); });
  if(btnOffline) btnOffline.addEventListener('click', ()=>{ currentFilter='offline'; setFilterButton('offline'); renderSystemsRegistry(); });

  if(search){
    search.addEventListener('input', ()=>{
      currentSearch = search.value.trim().toLowerCase();
      renderSystemsRegistry();
    });
  }
  if(urlInput){
    urlInput.addEventListener('keydown', (event)=>{
      if(event.key === 'Enter'){
        event.preventDefault();
        addSystemFromForm();
      }
    });
  }
  if(list){
    list.addEventListener('click', (event)=>{
      const actionEl = event.target.closest('[data-act]');
      if(!actionEl) return;
      const card = actionEl.closest('[data-id]');
      if(!card) return;
      const id = card.getAttribute('data-id');
      const action = actionEl.getAttribute('data-act');
      const sys = systems.find(x=>x.id===id);
      if(!sys) return;

      if(action === 'check'){
        validateSystemById(id);
        return;
      }
      if(action === 'show'){
        openSystemInfoModal(sys);
        return;
      }
      if(action === 'open'){
        window.open(sys.url, '_blank', 'noopener');
        return;
      }
      if(action === 'edit'){
        startEditingSystem(sys);
        return;
      }
      if(action === 'delete'){
        systems = systems.filter(x=>x.id!==id);
        if(editingSystemId === id){
          editingSystemId = null;
          setSystemFormMode(false);
        }
        saveSystemsRegistry();
        renderSystemsRegistry();
      }
    });
  }
}

/* ===== S2: CADASTRO ANYDESK ===== */
const AD_LS_KEY = 'cor_anydesk_registry_v1';
let anydeskMachines = [];
let anydeskFilter = 'all';
let anydeskSearch = '';
let anydeskDraftStatus = 'online';

function normalizeAnyDeskStatus(raw){
  if(raw === 'connected' || raw === 'offline') return raw;
  return 'online';
}

function normalizeAnyDeskId(raw){
  const compact = String(raw || '').trim().replace(/\s+/g, ' ');
  if(compact.length < 6) return null;
  return compact;
}

function getAnyDeskStatusMeta(status){
  if(status === 'connected'){
    return { badge:'on', dot:'dot-on', label:'Conectado' };
  }
  if(status === 'offline'){
    return { badge:'off', dot:'dot-off', label:'Offline' };
  }
  return { badge:'warn', dot:'dot-warn', label:'Online' };
}

function getAnyDeskNextStatus(status){
  if(status === 'connected') return 'offline';
  if(status === 'offline') return 'online';
  return 'connected';
}

function formatAnyDeskDate(ts){
  if(!ts) return '--';
  try{
    return new Date(ts).toLocaleString('pt-BR');
  }catch(e){
    return '--';
  }
}

function loadAnyDeskRegistry(){
  try{
    const raw = localStorage.getItem(AD_LS_KEY);
    if(!raw) return [];
    const parsed = JSON.parse(raw);
    if(!Array.isArray(parsed)) return [];
    return parsed
      .filter(x=>x && typeof x === 'object' && x.id && x.name && x.remoteId)
      .map(x=>({
        id: String(x.id),
        name: String(x.name),
        remoteId: String(x.remoteId),
        location: String(x.location || ''),
        status: normalizeAnyDeskStatus(x.status),
        createdAt: Number(x.createdAt || Date.now()),
        updatedAt: Number(x.updatedAt || Date.now())
      }));
  }catch(e){
    return [];
  }
}

function saveAnyDeskRegistry(){
  try{
    localStorage.setItem(AD_LS_KEY, JSON.stringify(anydeskMachines));
  }catch(e){}
  dbPutCollection('anydesk', anydeskMachines);
}

function normalizeAnyDeskPayload(items){
  if(!Array.isArray(items)) return [];
  return items
    .filter(x=>x && typeof x === 'object' && x.id && x.name && x.remoteId)
    .map(x=>({
      id: String(x.id),
      name: String(x.name),
      remoteId: String(x.remoteId),
      location: String(x.location || ''),
      status: normalizeAnyDeskStatus(x.status),
      createdAt: Number(x.createdAt || Date.now()),
      updatedAt: Number(x.updatedAt || Date.now())
    }));
}

async function hydrateAnyDeskFromDatabase(){
  const remote = await dbGetCollection('anydesk');
  if(!remote) return;
  const normalized = normalizeAnyDeskPayload(remote);
  if(!normalized.length){
    if(anydeskMachines.length) dbPutCollection('anydesk', anydeskMachines);
    return;
  }
  anydeskMachines = normalized;
  try{ localStorage.setItem(AD_LS_KEY, JSON.stringify(anydeskMachines)); }catch(e){}
  renderAnyDeskRegistry();
}

function setAnyDeskDraftStatus(status){
  anydeskDraftStatus = normalizeAnyDeskStatus(status);
  const btnOnline = document.getElementById('ad-status-online');
  const btnConnected = document.getElementById('ad-status-connected');
  const btnOffline = document.getElementById('ad-status-offline');
  if(btnOnline) btnOnline.classList.toggle('on', anydeskDraftStatus === 'online');
  if(btnConnected) btnConnected.classList.toggle('on', anydeskDraftStatus === 'connected');
  if(btnOffline) btnOffline.classList.toggle('on', anydeskDraftStatus === 'offline');
}

function setAnyDeskFilter(filter){
  anydeskFilter = filter;
  const btnAll = document.getElementById('ad-filter-all');
  const btnConnected = document.getElementById('ad-filter-connected');
  const btnOnline = document.getElementById('ad-filter-online');
  const btnOffline = document.getElementById('ad-filter-offline');
  if(btnAll) btnAll.classList.toggle('on', filter === 'all');
  if(btnConnected) btnConnected.classList.toggle('on', filter === 'connected');
  if(btnOnline) btnOnline.classList.toggle('on', filter === 'online');
  if(btnOffline) btnOffline.classList.toggle('on', filter === 'offline');
}

function getVisibleAnyDeskMachines(){
  return anydeskMachines.filter(machine=>{
    if(anydeskFilter !== 'all' && machine.status !== anydeskFilter) return false;
    if(anydeskSearch){
      const hay = `${machine.name} ${machine.remoteId} ${machine.location}`.toLowerCase();
      if(!hay.includes(anydeskSearch)) return false;
    }
    return true;
  });
}

function updateAnyDeskCounters(){
  const total = anydeskMachines.length;
  const connected = anydeskMachines.filter(x=>x.status === 'connected').length;
  const online = anydeskMachines.filter(x=>x.status === 'online').length;
  const offline = anydeskMachines.filter(x=>x.status === 'offline').length;

  const cTotal = document.getElementById('ad-count-total');
  const cConnected = document.getElementById('ad-count-connected');
  const cOnline = document.getElementById('ad-count-online');
  const cOffline = document.getElementById('ad-count-offline');
  const badge = document.getElementById('ad-badge-total');

  if(cTotal) cTotal.textContent = String(total);
  if(cConnected) cConnected.textContent = String(connected);
  if(cOnline) cOnline.textContent = String(online);
  if(cOffline) cOffline.textContent = String(offline);
  if(badge) badge.textContent = `${total} total`;
}

function renderAnyDeskRegistry(){
  const grid = document.getElementById('anydesk-grid');
  if(!grid) return;

  const visible = getVisibleAnyDeskMachines();
  updateAnyDeskCounters();

  if(!visible.length){
    grid.innerHTML = '<div class="top-empty">Sem dados cadastrados no momento.</div>';
    return;
  }

  grid.innerHTML = visible.map(machine=>{
    const meta = getAnyDeskStatusMeta(machine.status);
    const nextStatus = getAnyDeskNextStatus(machine.status);
    const nextLabel = getAnyDeskStatusMeta(nextStatus).label;
    return `
      <div class="ad-card ${machine.status === 'connected' ? 'connected' : ''}" data-id="${escapeHtml(machine.id)}">
        <div class="ad-header">
          <span class="ad-icon">PC</span>
          <span class="ad-status-badge ${meta.badge}"><span class="dot ${meta.dot}"></span>${meta.label}</span>
        </div>
        <div class="ad-name">${escapeHtml(machine.name)}</div>
        <div class="ad-id">ID: ${escapeHtml(machine.remoteId)}</div>
        <div class="ad-meta">Local: ${escapeHtml(machine.location || 'Nao informado')} · Atualizado: ${escapeHtml(formatAnyDeskDate(machine.updatedAt))}</div>
        <button class="ad-btn ad-btn-connect" data-act="copy-id">Copiar ID</button>
        <button class="ad-btn ad-btn-manage" data-act="cycle-status" style="margin-top:6px">Marcar ${nextLabel}</button>
        <button class="ad-btn ad-btn-manage" data-act="delete" style="margin-top:6px;background:rgba(80,20,20,0.4);color:#fca5a5;border-color:rgba(200,50,50,0.3)">Excluir</button>
      </div>
    `;
  }).join('');
}

function addAnyDeskFromForm(){
  const nameEl = document.getElementById('ad-name');
  const idEl = document.getElementById('ad-id');
  const localEl = document.getElementById('ad-local');
  if(!nameEl || !idEl || !localEl) return;

  const name = nameEl.value.trim();
  const remoteId = normalizeAnyDeskId(idEl.value);
  const location = localEl.value.trim();

  if(!name){
    alert('Informe o nome da maquina.');
    nameEl.focus();
    return;
  }
  if(!remoteId){
    alert('Informe um ID AnyDesk valido.');
    idEl.focus();
    return;
  }

  const now = Date.now();
  const existing = anydeskMachines.find(x=>x.remoteId.toLowerCase() === remoteId.toLowerCase());
  if(existing){
    existing.name = name;
    existing.location = location;
    existing.status = normalizeAnyDeskStatus(anydeskDraftStatus);
    existing.updatedAt = now;
  }else{
    anydeskMachines.unshift({
      id: `ad-${now}-${Math.floor(Math.random()*1000)}`,
      name,
      remoteId,
      location,
      status: normalizeAnyDeskStatus(anydeskDraftStatus),
      createdAt: now,
      updatedAt: now
    });
  }

  saveAnyDeskRegistry();
  renderAnyDeskRegistry();
  clearAnyDeskForm();
}

function clearAnyDeskForm(){
  const nameEl = document.getElementById('ad-name');
  const idEl = document.getElementById('ad-id');
  const localEl = document.getElementById('ad-local');
  if(nameEl) nameEl.value = '';
  if(idEl) idEl.value = '';
  if(localEl) localEl.value = '';
  setAnyDeskDraftStatus('online');
}

function initAnyDeskMonitor(){
  anydeskMachines = loadAnyDeskRegistry();
  setAnyDeskDraftStatus('online');
  setAnyDeskFilter('all');
  renderAnyDeskRegistry();
  hydrateAnyDeskFromDatabase();

  const btnAdd = document.getElementById('ad-add-btn');
  const btnClear = document.getElementById('ad-clear-btn');
  const btnStatusOnline = document.getElementById('ad-status-online');
  const btnStatusConnected = document.getElementById('ad-status-connected');
  const btnStatusOffline = document.getElementById('ad-status-offline');
  const btnFilterAll = document.getElementById('ad-filter-all');
  const btnFilterConnected = document.getElementById('ad-filter-connected');
  const btnFilterOnline = document.getElementById('ad-filter-online');
  const btnFilterOffline = document.getElementById('ad-filter-offline');
  const search = document.getElementById('ad-search');
  const idEl = document.getElementById('ad-id');
  const grid = document.getElementById('anydesk-grid');

  if(btnAdd) btnAdd.addEventListener('click', addAnyDeskFromForm);
  if(btnClear) btnClear.addEventListener('click', clearAnyDeskForm);
  if(btnStatusOnline) btnStatusOnline.addEventListener('click', ()=>setAnyDeskDraftStatus('online'));
  if(btnStatusConnected) btnStatusConnected.addEventListener('click', ()=>setAnyDeskDraftStatus('connected'));
  if(btnStatusOffline) btnStatusOffline.addEventListener('click', ()=>setAnyDeskDraftStatus('offline'));
  if(btnFilterAll) btnFilterAll.addEventListener('click', ()=>{ setAnyDeskFilter('all'); renderAnyDeskRegistry(); });
  if(btnFilterConnected) btnFilterConnected.addEventListener('click', ()=>{ setAnyDeskFilter('connected'); renderAnyDeskRegistry(); });
  if(btnFilterOnline) btnFilterOnline.addEventListener('click', ()=>{ setAnyDeskFilter('online'); renderAnyDeskRegistry(); });
  if(btnFilterOffline) btnFilterOffline.addEventListener('click', ()=>{ setAnyDeskFilter('offline'); renderAnyDeskRegistry(); });

  if(search){
    search.addEventListener('input', ()=>{
      anydeskSearch = search.value.trim().toLowerCase();
      renderAnyDeskRegistry();
    });
  }

  if(idEl){
    idEl.addEventListener('keydown', (event)=>{
      if(event.key === 'Enter'){
        event.preventDefault();
        addAnyDeskFromForm();
      }
    });
  }

  if(grid){
    grid.addEventListener('click', (event)=>{
      const actionEl = event.target.closest('[data-act]');
      if(!actionEl) return;
      const card = actionEl.closest('[data-id]');
      if(!card) return;
      const machineId = card.getAttribute('data-id');
      const action = actionEl.getAttribute('data-act');
      const machine = anydeskMachines.find(x=>x.id === machineId);
      if(!machine) return;

      if(action === 'copy-id'){
        navigator.clipboard.writeText(machine.remoteId).catch(()=>{
          prompt('Copie o ID:', machine.remoteId);
        });
        return;
      }

      if(action === 'cycle-status'){
        machine.status = getAnyDeskNextStatus(machine.status);
        machine.updatedAt = Date.now();
        saveAnyDeskRegistry();
        renderAnyDeskRegistry();
        return;
      }

      if(action === 'delete'){
        anydeskMachines = anydeskMachines.filter(x=>x.id !== machineId);
        saveAnyDeskRegistry();
        renderAnyDeskRegistry();
      }
    });
  }
}

/* ===== S3: INFRAESTRUTURA ===== */
const INFRA_LS_KEY = 'cor_infra_registry_v1';
let infraItems = [];
let infraFilter = 'all';
let infraSearch = '';
let infraDraftStatus = 'online';
let infraEditingId = null;

function normalizeInfraStatus(raw){
  if(raw === 'offline' || raw === 'warn') return raw;
  return 'online';
}

function getInfraStatusMeta(status){
  if(status === 'offline') return { dot:'dot-off', text:'Offline' };
  if(status === 'warn') return { dot:'dot-warn', text:'Instavel' };
  return { dot:'dot-on', text:'Online' };
}

function loadInfraRegistry(){
  try{
    const raw = localStorage.getItem(INFRA_LS_KEY);
    if(!raw) return [];
    const parsed = JSON.parse(raw);
    if(!Array.isArray(parsed)) return [];
    return parsed
      .filter(x=>x && typeof x === 'object' && x.id && x.name && x.host)
      .map(x=>({
        id: String(x.id),
        name: String(x.name),
        host: String(x.host),
        type: String(x.type || 'Servidor'),
        status: normalizeInfraStatus(x.status),
        updatedAt: Number(x.updatedAt || Date.now())
      }));
  }catch(e){
    return [];
  }
}

function saveInfraRegistry(){
  try{ localStorage.setItem(INFRA_LS_KEY, JSON.stringify(infraItems)); }catch(e){}
  dbPutCollection('infra', infraItems);
}

function normalizeInfraPayload(items){
  if(!Array.isArray(items)) return [];
  return items
    .filter(x=>x && typeof x === 'object' && x.id && x.name && x.host)
    .map(x=>({
      id: String(x.id),
      name: String(x.name),
      host: String(x.host),
      type: String(x.type || 'Servidor'),
      status: normalizeInfraStatus(x.status),
      updatedAt: Number(x.updatedAt || Date.now())
    }));
}

async function hydrateInfraFromDatabase(){
  const remote = await dbGetCollection('infra');
  if(!remote) return;
  const normalized = normalizeInfraPayload(remote);
  if(!normalized.length){
    if(infraItems.length) dbPutCollection('infra', infraItems);
    return;
  }
  infraItems = normalized;
  try{ localStorage.setItem(INFRA_LS_KEY, JSON.stringify(infraItems)); }catch(e){}
  renderInfraRegistry();
}

function formatInfraDate(ts){
  if(!ts) return '--';
  try{ return new Date(ts).toLocaleString('pt-BR'); }catch(e){ return '--'; }
}

function setInfraDraftStatus(status){
  infraDraftStatus = normalizeInfraStatus(status);
  const bOnline = document.getElementById('infra-status-online');
  const bWarn = document.getElementById('infra-status-warn');
  const bOffline = document.getElementById('infra-status-offline');
  if(bOnline) bOnline.classList.toggle('on', infraDraftStatus === 'online');
  if(bWarn) bWarn.classList.toggle('on', infraDraftStatus === 'warn');
  if(bOffline) bOffline.classList.toggle('on', infraDraftStatus === 'offline');
}

function setInfraFilter(filter){
  infraFilter = filter;
  const bAll = document.getElementById('infra-filter-all');
  const bOnline = document.getElementById('infra-filter-online');
  const bWarn = document.getElementById('infra-filter-warn');
  const bOffline = document.getElementById('infra-filter-offline');
  if(bAll) bAll.classList.toggle('on', infraFilter === 'all');
  if(bOnline) bOnline.classList.toggle('on', infraFilter === 'online');
  if(bWarn) bWarn.classList.toggle('on', infraFilter === 'warn');
  if(bOffline) bOffline.classList.toggle('on', infraFilter === 'offline');
}

function setInfraFormMode(isEditing){
  const btnAdd = document.getElementById('infra-add-btn');
  if(btnAdd) btnAdd.textContent = isEditing ? 'Salvar Edicao' : 'Cadastrar';
}

function getVisibleInfraItems(){
  return infraItems.filter(item=>{
    if(infraFilter !== 'all' && item.status !== infraFilter) return false;
    if(infraSearch){
      const hay = `${item.name} ${item.host} ${item.type}`.toLowerCase();
      if(!hay.includes(infraSearch)) return false;
    }
    return true;
  });
}

function updateInfraCounters(){
  const total = infraItems.length;
  const online = infraItems.filter(x=>x.status === 'online').length;
  const warn = infraItems.filter(x=>x.status === 'warn').length;
  const offline = infraItems.filter(x=>x.status === 'offline').length;

  const cTotal = document.getElementById('infra-count-total');
  const cOnline = document.getElementById('infra-count-online');
  const cWarn = document.getElementById('infra-count-warn');
  const cOffline = document.getElementById('infra-count-offline');
  const badge = document.getElementById('infra-badge-total');
  if(cTotal) cTotal.textContent = String(total);
  if(cOnline) cOnline.textContent = String(online);
  if(cWarn) cWarn.textContent = String(warn);
  if(cOffline) cOffline.textContent = String(offline);
  if(badge) badge.textContent = `${total} total`;
}

function renderInfraRegistry(){
  const list = document.getElementById('infra-list');
  if(!list) return;
  const visible = getVisibleInfraItems();
  updateInfraCounters();

  if(!visible.length){
    list.innerHTML = '<div class="top-empty">Sem dados de infraestrutura no momento.</div>';
    return;
  }

  list.innerHTML = visible.map(item=>{
    const meta = getInfraStatusMeta(item.status);
    return `
      <div class="sys-card" data-id="${escapeHtml(item.id)}">
        <div class="sys-name">${escapeHtml(item.name)}</div>
        <div class="sys-status"><span class="dot ${meta.dot}"></span>${meta.text} • ${escapeHtml(formatInfraDate(item.updatedAt))}</div>
        <div class="infra-meta">Host: ${escapeHtml(item.host)} • Tipo: ${escapeHtml(item.type || 'Servidor')}</div>
        <div class="sys-acts">
          <button type="button" class="sys-acts-btn" data-act="check">Verificar</button>
          <button type="button" class="sys-acts-btn" data-act="show">Exibir</button>
          <button type="button" class="sys-acts-btn" data-act="edit">Editar</button>
          <button type="button" class="sys-acts-btn danger" data-act="delete">Excluir</button>
        </div>
      </div>
    `;
  }).join('');
}

function clearInfraForm(){
  const nameEl = document.getElementById('infra-name');
  const hostEl = document.getElementById('infra-host');
  const typeEl = document.getElementById('infra-type');
  infraEditingId = null;
  setInfraFormMode(false);
  if(nameEl) nameEl.value = '';
  if(hostEl) hostEl.value = '';
  if(typeEl) typeEl.value = '';
  setInfraDraftStatus('online');
}

function startEditingInfraItem(item){
  const nameEl = document.getElementById('infra-name');
  const hostEl = document.getElementById('infra-host');
  const typeEl = document.getElementById('infra-type');
  if(!nameEl || !hostEl || !typeEl) return;
  infraEditingId = item.id;
  nameEl.value = item.name || '';
  hostEl.value = item.host || '';
  typeEl.value = item.type || '';
  setInfraDraftStatus(item.status || 'online');
  setInfraFormMode(true);
  nameEl.focus();
}

function addInfraFromForm(){
  const nameEl = document.getElementById('infra-name');
  const hostEl = document.getElementById('infra-host');
  const typeEl = document.getElementById('infra-type');
  if(!nameEl || !hostEl || !typeEl) return;

  const name = nameEl.value.trim();
  const host = hostEl.value.trim();
  const type = typeEl.value.trim() || 'Servidor';
  if(!name){
    alert('Informe o nome do recurso.');
    nameEl.focus();
    return;
  }
  if(!host){
    alert('Informe host, IP ou URL.');
    hostEl.focus();
    return;
  }

  const now = Date.now();
  if(infraEditingId){
    const editing = infraItems.find(x=>x.id === infraEditingId);
    if(editing){
      editing.name = name;
      editing.host = host;
      editing.type = type;
      editing.status = normalizeInfraStatus(infraDraftStatus);
      editing.updatedAt = now;
      saveInfraRegistry();
      renderInfraRegistry();
      clearInfraForm();
      return;
    }
    infraEditingId = null;
    setInfraFormMode(false);
  }

  infraItems.unshift({
    id: `infra-${now}-${Math.floor(Math.random()*1000)}`,
    name,
    host,
    type,
    status: normalizeInfraStatus(infraDraftStatus),
    updatedAt: now
  });
  saveInfraRegistry();
  renderInfraRegistry();
  clearInfraForm();
}

async function verifyInfraById(id){
  const item = infraItems.find(x=>x.id === id);
  if(!item) return;
  const target = normalizeSiteUrl(item.host);
  if(!target){
    item.status = 'warn';
    item.updatedAt = Date.now();
    saveInfraRegistry();
    renderInfraRegistry();
    return;
  }
  const result = await probeWebsite(target, 6000);
  item.status = result.online ? 'online' : 'offline';
  item.updatedAt = Date.now();
  saveInfraRegistry();
  renderInfraRegistry();
}

function initInfraMonitor(){
  infraItems = loadInfraRegistry();
  infraEditingId = null;
  setInfraDraftStatus('online');
  setInfraFilter('all');
  setInfraFormMode(false);
  renderInfraRegistry();
  hydrateInfraFromDatabase();

  const btnAdd = document.getElementById('infra-add-btn');
  const btnClear = document.getElementById('infra-clear-btn');
  const btnStatusOnline = document.getElementById('infra-status-online');
  const btnStatusWarn = document.getElementById('infra-status-warn');
  const btnStatusOffline = document.getElementById('infra-status-offline');
  const btnFilterAll = document.getElementById('infra-filter-all');
  const btnFilterOnline = document.getElementById('infra-filter-online');
  const btnFilterWarn = document.getElementById('infra-filter-warn');
  const btnFilterOffline = document.getElementById('infra-filter-offline');
  const search = document.getElementById('infra-search');
  const hostInput = document.getElementById('infra-host');
  const list = document.getElementById('infra-list');

  if(btnAdd) btnAdd.addEventListener('click', addInfraFromForm);
  if(btnClear) btnClear.addEventListener('click', clearInfraForm);
  if(btnStatusOnline) btnStatusOnline.addEventListener('click', ()=>setInfraDraftStatus('online'));
  if(btnStatusWarn) btnStatusWarn.addEventListener('click', ()=>setInfraDraftStatus('warn'));
  if(btnStatusOffline) btnStatusOffline.addEventListener('click', ()=>setInfraDraftStatus('offline'));
  if(btnFilterAll) btnFilterAll.addEventListener('click', ()=>{ setInfraFilter('all'); renderInfraRegistry(); });
  if(btnFilterOnline) btnFilterOnline.addEventListener('click', ()=>{ setInfraFilter('online'); renderInfraRegistry(); });
  if(btnFilterWarn) btnFilterWarn.addEventListener('click', ()=>{ setInfraFilter('warn'); renderInfraRegistry(); });
  if(btnFilterOffline) btnFilterOffline.addEventListener('click', ()=>{ setInfraFilter('offline'); renderInfraRegistry(); });

  if(search){
    search.addEventListener('input', ()=>{
      infraSearch = search.value.trim().toLowerCase();
      renderInfraRegistry();
    });
  }

  if(hostInput){
    hostInput.addEventListener('keydown', (event)=>{
      if(event.key === 'Enter'){
        event.preventDefault();
        addInfraFromForm();
      }
    });
  }

  if(list){
    list.addEventListener('click', (event)=>{
      const actionEl = event.target.closest('[data-act]');
      if(!actionEl) return;
      const card = actionEl.closest('[data-id]');
      if(!card) return;
      const id = card.getAttribute('data-id');
      const action = actionEl.getAttribute('data-act');
      const item = infraItems.find(x=>x.id === id);
      if(!item) return;

      if(action === 'check'){
        verifyInfraById(id);
        return;
      }
      if(action === 'show'){
        openInfraInfoModal(item);
        return;
      }
      if(action === 'edit'){
        startEditingInfraItem(item);
        return;
      }
      if(action === 'delete'){
        infraItems = infraItems.filter(x=>x.id !== id);
        if(infraEditingId === id){
          infraEditingId = null;
          setInfraFormMode(false);
        }
        saveInfraRegistry();
        renderInfraRegistry();
      }
    });
  }
}

/* ===== S4: ACESSO RAPIDO ===== */
const QUICK_LS_KEY = 'cor_quick_registry_v1';
let quickItems = [];
let quickFilter = 'all';
let quickSearch = '';
let quickDraftStatus = 'online';
let quickEditingId = null;

function normalizeQuickStatus(raw){
  if(raw === 'offline' || raw === 'warn') return raw;
  return 'online';
}

function getQuickStatusMeta(status){
  if(status === 'offline') return { dot:'dot-off', text:'Offline' };
  if(status === 'warn') return { dot:'dot-warn', text:'Instavel' };
  return { dot:'dot-on', text:'Online' };
}

function loadQuickRegistry(){
  try{
    const raw = localStorage.getItem(QUICK_LS_KEY);
    if(!raw) return [];
    const parsed = JSON.parse(raw);
    if(!Array.isArray(parsed)) return [];
    return parsed
      .filter(x=>x && typeof x === 'object' && x.id && x.name && x.url)
      .map(x=>({
        id: String(x.id),
        name: String(x.name),
        url: String(x.url),
        category: String(x.category || 'Geral'),
        status: normalizeQuickStatus(x.status),
        updatedAt: Number(x.updatedAt || Date.now())
      }));
  }catch(e){
    return [];
  }
}

function saveQuickRegistry(){
  try{ localStorage.setItem(QUICK_LS_KEY, JSON.stringify(quickItems)); }catch(e){}
  dbPutCollection('quick', quickItems);
}

function normalizeQuickPayload(items){
  if(!Array.isArray(items)) return [];
  return items
    .filter(x=>x && typeof x === 'object' && x.id && x.name && x.url)
    .map(x=>({
      id: String(x.id),
      name: String(x.name),
      url: String(x.url),
      category: String(x.category || 'Geral'),
      status: normalizeQuickStatus(x.status),
      updatedAt: Number(x.updatedAt || Date.now())
    }));
}

async function hydrateQuickFromDatabase(){
  const remote = await dbGetCollection('quick');
  if(!remote) return;
  const normalized = normalizeQuickPayload(remote);
  if(!normalized.length){
    if(quickItems.length) dbPutCollection('quick', quickItems);
    return;
  }
  quickItems = normalized;
  try{ localStorage.setItem(QUICK_LS_KEY, JSON.stringify(quickItems)); }catch(e){}
  renderQuickRegistry();
}

function formatQuickDate(ts){
  if(!ts) return '--';
  try{ return new Date(ts).toLocaleString('pt-BR'); }catch(e){ return '--'; }
}

function setQuickDraftStatus(status){
  quickDraftStatus = normalizeQuickStatus(status);
  const bOnline = document.getElementById('quick-status-online');
  const bWarn = document.getElementById('quick-status-warn');
  const bOffline = document.getElementById('quick-status-offline');
  if(bOnline) bOnline.classList.toggle('on', quickDraftStatus === 'online');
  if(bWarn) bWarn.classList.toggle('on', quickDraftStatus === 'warn');
  if(bOffline) bOffline.classList.toggle('on', quickDraftStatus === 'offline');
}

function setQuickFilter(filter){
  quickFilter = filter;
  const bAll = document.getElementById('quick-filter-all');
  const bOnline = document.getElementById('quick-filter-online');
  const bWarn = document.getElementById('quick-filter-warn');
  const bOffline = document.getElementById('quick-filter-offline');
  if(bAll) bAll.classList.toggle('on', quickFilter === 'all');
  if(bOnline) bOnline.classList.toggle('on', quickFilter === 'online');
  if(bWarn) bWarn.classList.toggle('on', quickFilter === 'warn');
  if(bOffline) bOffline.classList.toggle('on', quickFilter === 'offline');
}

function setQuickFormMode(isEditing){
  const btnAdd = document.getElementById('quick-add-btn');
  if(btnAdd) btnAdd.textContent = isEditing ? 'Salvar Edicao' : 'Cadastrar';
}

function getQuickCategoryBadge(category){
  const clean = String(category || 'WEB').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  if(!clean) return 'WEB';
  return clean.slice(0,3);
}

function getVisibleQuickItems(){
  return quickItems.filter(item=>{
    if(quickFilter !== 'all' && item.status !== quickFilter) return false;
    if(quickSearch){
      const hay = `${item.name} ${item.url} ${item.category}`.toLowerCase();
      if(!hay.includes(quickSearch)) return false;
    }
    return true;
  });
}

function updateQuickCounters(){
  const total = quickItems.length;
  const online = quickItems.filter(x=>x.status === 'online').length;
  const warn = quickItems.filter(x=>x.status === 'warn').length;
  const offline = quickItems.filter(x=>x.status === 'offline').length;

  const cTotal = document.getElementById('quick-count-total');
  const cOnline = document.getElementById('quick-count-online');
  const cWarn = document.getElementById('quick-count-warn');
  const cOffline = document.getElementById('quick-count-offline');
  const badge = document.getElementById('quick-badge-total');
  if(cTotal) cTotal.textContent = String(total);
  if(cOnline) cOnline.textContent = String(online);
  if(cWarn) cWarn.textContent = String(warn);
  if(cOffline) cOffline.textContent = String(offline);
  if(badge) badge.textContent = `${total} total`;
}

function renderQuickRegistry(){
  const list = document.getElementById('quick-list');
  if(!list) return;
  const visible = getVisibleQuickItems();
  updateQuickCounters();

  if(!visible.length){
    list.innerHTML = '<div class="top-empty">Sem acessos recentes registrados.</div>';
    return;
  }

  list.innerHTML = visible.map(item=>{
    const meta = getQuickStatusMeta(item.status);
    const category = item.category || 'Geral';
    const badge = getQuickCategoryBadge(category);
    return `
      <div class="qr-card quick-card" data-id="${escapeHtml(item.id)}">
        <div class="quick-head">
          <div class="quick-icon">${escapeHtml(badge)}</div>
          <div>
            <div class="qr-name">${escapeHtml(item.name)}</div>
            <div class="qr-type">${escapeHtml(category)}</div>
          </div>
        </div>
        <div class="sys-status"><span class="dot ${meta.dot}"></span>${meta.text} • ${escapeHtml(formatQuickDate(item.updatedAt))}</div>
        <div class="quick-url">${escapeHtml(item.url)}</div>
        <div class="quick-actions">
          <button type="button" class="sys-acts-btn" data-act="check">Verificar</button>
          <button type="button" class="sys-acts-btn" data-act="show">Exibir</button>
          <button type="button" class="sys-acts-btn" data-act="open">Abrir</button>
          <button type="button" class="sys-acts-btn" data-act="edit">Editar</button>
          <button type="button" class="sys-acts-btn danger" data-act="delete">Excluir</button>
        </div>
      </div>
    `;
  }).join('');
}

function clearQuickForm(){
  const nameEl = document.getElementById('quick-name');
  const urlEl = document.getElementById('quick-url');
  const catEl = document.getElementById('quick-category');
  quickEditingId = null;
  setQuickFormMode(false);
  if(nameEl) nameEl.value = '';
  if(urlEl) urlEl.value = '';
  if(catEl) catEl.value = '';
  setQuickDraftStatus('online');
}

function startEditingQuickItem(item){
  const nameEl = document.getElementById('quick-name');
  const urlEl = document.getElementById('quick-url');
  const catEl = document.getElementById('quick-category');
  if(!nameEl || !urlEl || !catEl) return;
  quickEditingId = item.id;
  nameEl.value = item.name || '';
  urlEl.value = item.url || '';
  catEl.value = item.category || '';
  setQuickDraftStatus(item.status || 'online');
  setQuickFormMode(true);
  nameEl.focus();
}

function addQuickFromForm(){
  const nameEl = document.getElementById('quick-name');
  const urlEl = document.getElementById('quick-url');
  const catEl = document.getElementById('quick-category');
  if(!nameEl || !urlEl || !catEl) return;

  const name = nameEl.value.trim();
  const normalizedUrl = normalizeSiteUrl(urlEl.value);
  const category = catEl.value.trim() || 'Geral';
  if(!name){
    alert('Informe o nome do atalho.');
    nameEl.focus();
    return;
  }
  if(!normalizedUrl){
    alert('Informe uma URL valida. Exemplo: https://site.com');
    urlEl.focus();
    return;
  }

  const now = Date.now();
  if(quickEditingId){
    const editing = quickItems.find(x=>x.id === quickEditingId);
    if(editing){
      editing.name = name;
      editing.url = normalizedUrl;
      editing.category = category;
      editing.status = normalizeQuickStatus(quickDraftStatus);
      editing.updatedAt = now;
      saveQuickRegistry();
      renderQuickRegistry();
      clearQuickForm();
      return;
    }
    quickEditingId = null;
    setQuickFormMode(false);
  }

  quickItems.unshift({
    id: `quick-${now}-${Math.floor(Math.random()*1000)}`,
    name,
    url: normalizedUrl,
    category,
    status: normalizeQuickStatus(quickDraftStatus),
    updatedAt: now
  });
  saveQuickRegistry();
  renderQuickRegistry();
  clearQuickForm();
}

async function verifyQuickById(id){
  const item = quickItems.find(x=>x.id === id);
  if(!item) return;
  const result = await probeWebsite(item.url, 6000);
  item.status = result.online ? 'online' : 'offline';
  item.updatedAt = Date.now();
  saveQuickRegistry();
  renderQuickRegistry();
}

function initQuickMonitor(){
  quickItems = loadQuickRegistry();
  quickEditingId = null;
  setQuickDraftStatus('online');
  setQuickFilter('all');
  setQuickFormMode(false);
  renderQuickRegistry();
  hydrateQuickFromDatabase();

  const btnAdd = document.getElementById('quick-add-btn');
  const btnClear = document.getElementById('quick-clear-btn');
  const btnStatusOnline = document.getElementById('quick-status-online');
  const btnStatusWarn = document.getElementById('quick-status-warn');
  const btnStatusOffline = document.getElementById('quick-status-offline');
  const btnFilterAll = document.getElementById('quick-filter-all');
  const btnFilterOnline = document.getElementById('quick-filter-online');
  const btnFilterWarn = document.getElementById('quick-filter-warn');
  const btnFilterOffline = document.getElementById('quick-filter-offline');
  const search = document.getElementById('quick-search');
  const urlInput = document.getElementById('quick-url');
  const list = document.getElementById('quick-list');

  if(btnAdd) btnAdd.addEventListener('click', addQuickFromForm);
  if(btnClear) btnClear.addEventListener('click', clearQuickForm);
  if(btnStatusOnline) btnStatusOnline.addEventListener('click', ()=>setQuickDraftStatus('online'));
  if(btnStatusWarn) btnStatusWarn.addEventListener('click', ()=>setQuickDraftStatus('warn'));
  if(btnStatusOffline) btnStatusOffline.addEventListener('click', ()=>setQuickDraftStatus('offline'));
  if(btnFilterAll) btnFilterAll.addEventListener('click', ()=>{ setQuickFilter('all'); renderQuickRegistry(); });
  if(btnFilterOnline) btnFilterOnline.addEventListener('click', ()=>{ setQuickFilter('online'); renderQuickRegistry(); });
  if(btnFilterWarn) btnFilterWarn.addEventListener('click', ()=>{ setQuickFilter('warn'); renderQuickRegistry(); });
  if(btnFilterOffline) btnFilterOffline.addEventListener('click', ()=>{ setQuickFilter('offline'); renderQuickRegistry(); });

  if(search){
    search.addEventListener('input', ()=>{
      quickSearch = search.value.trim().toLowerCase();
      renderQuickRegistry();
    });
  }

  if(urlInput){
    urlInput.addEventListener('keydown', (event)=>{
      if(event.key === 'Enter'){
        event.preventDefault();
        addQuickFromForm();
      }
    });
  }

  if(list){
    list.addEventListener('click', (event)=>{
      const actionEl = event.target.closest('[data-act]');
      if(!actionEl) return;
      const card = actionEl.closest('[data-id]');
      if(!card) return;
      const id = card.getAttribute('data-id');
      const action = actionEl.getAttribute('data-act');
      const item = quickItems.find(x=>x.id === id);
      if(!item) return;

      if(action === 'check'){
        verifyQuickById(id);
        return;
      }
      if(action === 'show'){
        openInfraInfoModal({
          name: item.name,
          host: item.url,
          type: item.category,
          status: item.status,
          updatedAt: item.updatedAt
        });
        return;
      }
      if(action === 'open'){
        window.open(item.url, '_blank', 'noopener');
        return;
      }
      if(action === 'edit'){
        startEditingQuickItem(item);
        return;
      }
      if(action === 'delete'){
        quickItems = quickItems.filter(x=>x.id !== id);
        if(quickEditingId === id){
          quickEditingId = null;
          setQuickFormMode(false);
        }
        saveQuickRegistry();
        renderQuickRegistry();
      }
    });
  }
}

/* ===== STAGE ===== */
function getStageImage(level){
  return `Nivel%20estagio/estagio${level}.jpg`;
}
function getHeatImage(level){
  return `Nivel%20calor/calor${level}.jpg`;
}

const stageMeta = {
  1:{ cls:'lvl1', icon:'🟢', title:'Cidade em Estágio 1', sub:'Monitoramento de rotina. Equipes em operação normal.',    hdBg:'#217021', img:getStageImage(1) },
  2:{ cls:'lvl1', icon:'🟡', title:'Cidade em Estágio 2', sub:'Monitoramento reforçado. Equipes em pré-alerta.',         hdBg:'#3d5c10', img:getStageImage(2) },
  3:{ cls:'lvl2', icon:'🟠', title:'Cidade em Estágio 3', sub:'Risco moderado. Mobilização de equipes de campo.',        hdBg:'#6b4010', img:getStageImage(3) },
  4:{ cls:'lvl3', icon:'🔴', title:'Cidade em Estágio 4', sub:'Acionamento de planos de contingência municipal.',        hdBg:'#6b1010', img:getStageImage(4) },
  5:{ cls:'lvl4', icon:'🚨', title:'Cidade em ESTÁGIO 5', sub:'MÁXIMO ALERTA. Todas as equipes mobilizadas.',            hdBg:'#4d0000', img:getStageImage(5) },
};
let curStage=1, curHeat=1;

function setStage(n,el){
  const parsed = Number.parseInt(n, 10);
  if(!Number.isInteger(parsed) || !stageMeta[parsed]) return;
  curStage = parsed;
  syncButtons();
}

const heatMeta = {
  1:{ label:'CALOR 1', bg:'#1258b8', img:getHeatImage(1) },
  2:{ label:'CALOR 2', bg:'#7a4010', img:getHeatImage(2) },
  3:{ label:'CALOR 3', bg:'#8c2a10', img:getHeatImage(3) },
  4:{ label:'CALOR 4', bg:'#8c1010', img:getHeatImage(4) },
  5:{ label:'CALOR 5', bg:'#6b0000', img:getHeatImage(5) },
};

function setHeat(n,el){
  const parsed = Number.parseInt(n, 10);
  if(!Number.isInteger(parsed) || !heatMeta[parsed]) return;
  curHeat = parsed;
  syncButtons();
}

function syncButtons(){
  document.querySelectorAll('.stage-btn').forEach((b, i)=>{
    const selected = (i + 1) === curStage;
    b.classList.toggle('sel', selected);
    b.classList.toggle('red', selected && curStage >= 4);
  });
  document.querySelectorAll('.heat-btn').forEach((b, i)=>{
    const selected = (i + 1) === curHeat;
    b.classList.toggle('sel', selected);
    b.classList.toggle('hot', selected && curHeat >= 2);
  });
}

function applyIncomingState(state){
  const incoming = normalizeState(state?.stage, state?.heat);
  if(!incoming) return;
  if(incoming.stage === curStage && incoming.heat === curHeat) return;
  curStage = incoming.stage;
  curHeat = incoming.heat;
  syncButtons();
  applyAlert({ persist:false });
}

function applyAlert(options = {}){
  const persist = options.persist !== false;
  const sm = stageMeta[curStage];
  const hm = heatMeta[curHeat];
  const banner = document.getElementById('stage-banner');
  if(!sm || !hm || !banner) return;
  banner.className = 'alert-banner '+sm.cls;
  banner.style.backgroundImage = '';
  banner.style.backgroundSize = '';
  banner.style.backgroundPosition = '';
  document.getElementById('stage-banner-icon').textContent = sm.icon;
  document.getElementById('stage-banner-title').textContent = sm.title;
  document.getElementById('stage-banner-sub').textContent = sm.sub;
  document.getElementById('hdr-estagio-num').textContent = curStage;
  document.getElementById('hdr-estagio-txt').textContent = curStage;
  document.getElementById('hdr-calor-txt').textContent = hm.label;
  const hdrE = document.querySelector('.h-estagio');
  hdrE.style.background = `url('${sm.img}') center/100% 100% no-repeat`;
  const hdrC = document.querySelector('.h-calor');
  hdrC.style.background = `url('${hm.img}') center/cover no-repeat`;
  banner.style.outline = '2px solid rgba(255,255,255,0.4)';
  setTimeout(()=>{ banner.style.outline=''; },600);
  if(persist) saveState(curStage, curHeat);
}

function resetAlert(){
  curStage = 1;
  curHeat = 1;
  syncButtons();
  applyAlert();
}

/* ===== LINKS DAS TELAS PUBLICAS ===== */
function buildTelaUrl(type){
  const base = location.href.substring(0, location.href.lastIndexOf('/') + 1);
  if(type === 'heat') return base + 'cor_rio_telao_calor.html';
  return base + 'cor_rio_telao_estagio.html';
}

function copyTelaLink(type){
  const view = type === 'heat' ? 'heat' : 'stage';
  const url = buildTelaUrl(view);
  const btnId = view === 'heat' ? 'btn-copy-link-heat' : 'btn-copy-link-stage';
  const btn = document.getElementById(btnId);
  const defaultLabel = view === 'heat' ? 'Copiar Link Calor' : 'Copiar Link Estagio';

  navigator.clipboard.writeText(url).then(()=>{
    if(!btn) return;
    btn.classList.add('copied');
    btn.textContent = 'Link Copiado!';
    setTimeout(()=>{
      btn.classList.remove('copied');
      btn.textContent = defaultLabel;
    },2500);
  }).catch(()=>{
    prompt('Copie o link abaixo:', url);
  });
}
// Show URL in box
window.addEventListener('DOMContentLoaded',()=>{
  const elStage = document.getElementById('tela-url-stage');
  const elHeat = document.getElementById('tela-url-heat');
  if(elStage) elStage.textContent = buildTelaUrl('stage');
  if(elHeat) elHeat.textContent = buildTelaUrl('heat');
  const hdrCalor = document.querySelector('.h-calor');
  if(hdrCalor){
    hdrCalor.setAttribute('role', 'button');
    hdrCalor.setAttribute('tabindex', '0');
    hdrCalor.setAttribute('aria-label', 'Abrir painel de alertas');
    hdrCalor.addEventListener('keydown', (event)=>{
      if(event.key === 'Enter' || event.key === ' '){
        event.preventDefault();
        switchSection('s5');
      }
    });
  }
  initSystemsMonitor();
  initSystemInfoModal();
  initAnyDeskMonitor();
  initInfraMonitor();
  initQuickMonitor();
  // Restore saved state if exists
  const saved = loadState();
  if(saved){
    curStage = saved.stage;
    curHeat  = saved.heat;
    syncButtons();
    applyAlert({ persist:false });
  }else{
    syncButtons();
    applyAlert({ persist:false });
  }
  hydrateStateFromDatabase();
  startApiSync();
});

if(BC){
  BC.addEventListener('message', (event)=>{
    applyIncomingState(event.data);
  });
}
window.addEventListener('storage', (event)=>{
  if(event.key !== LS_KEY || !event.newValue) return;
  try{
    applyIncomingState(JSON.parse(event.newValue));
  }catch(e){}
});

/* Simulacao de dados removida. */
