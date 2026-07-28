/* =========================================================================
   Educa Bondinho — Monitor Comercial
   Logica principal: estado, filtros, mapa, leads, follow-up (kanban), rejeitados
   ========================================================================= */

const STORAGE_KEY = 'eb_leads_state_v1';

const STAGES = ['novo', 'em_negociacao', 'visita_agendada', 'visitado'];
const STAGE_LABELS = {
  novo: 'Novo Lead / 1º Contato',
  em_negociacao: 'Em Negociação',
  visita_agendada: 'Visita Agendada',
  visitado: 'Visita Realizada',
};
const TERMINAL_LABELS = { rejeitado: 'Rejeitado', nao_respondeu: 'Não Respondeu' };
const CONCLUDED_STAGE = 'concluido';
const CONCLUDED_LABEL = 'Concluído';
const EXTRA_LABELS = { 'sem_followup': 'Removido do funil (sem follow-up)', 'reativado -> novo': 'Reativado', 'reativado -> visitado': 'Reativado (voltou para Visita Realizada)', 'reagendado': 'Data de visita reagendada' };
// lookup unico usado em qualquer lugar que precise exibir o rotulo de uma etapa/estagio
const ALL_LABELS = { ...STAGE_LABELS, ...TERMINAL_LABELS, [CONCLUDED_STAGE]: CONCLUDED_LABEL, ...EXTRA_LABELS };

// Lista fechada de motivos de rejeicao, validada com o time comercial.
// Usada apenas quando a escola REJEITA explicitamente (nao se aplica a "Nao Respondeu",
// ja que nesse caso nao ha um motivo declarado).
const REJECTION_REASONS = [
  'Parceria com a C2Rio',
  'Parceria com outro concorrente/atração',
  'Sem orçamento ou verba não aprovada',
  'Não é do perfil pedagógico da escola (não realiza esse tipo de passeio)',
  'Já visitou o Bondinho recentemente',
  'Logística inviável (transporte/distância)',
  'Direção ou coordenação pedagógica não aprovou',
  'Outro',
];

const ZONA_COLORS = {
  'Centro': '#8e44ad',
  'Zona Sul': '#2980b9',
  'Zona Norte': '#27ae60',
  'Zona Oeste': '#e67e22',
  'Zona Sudoeste': '#c0392b',
  'Não aplicável — fora do município do Rio de Janeiro': '#999999',
};

const REGIAO_COLORS = {
  'Região Metropolitana': '#ff6600',
  'Região Norte Fluminense': '#1f77b4',
  'Região Serrana': '#2ca02c',
  'Região das Baixadas Litorâneas': '#9467bd',
  'Região do Médio Paraíba': '#d62728',
  'Região Noroeste Fluminense': '#8c564b',
  'Região da Costa Verde': '#17becf',
  'Região Centro-Sul Fluminense': '#e377c2',
};

const CONTACTED_COLOR = '#adb5bd';

function hashColor(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
  const h = Math.abs(hash) % 360;
  return `hsl(${h}, 62%, 45%)`;
}

/* ------------------------------------------------------------------------
   ESTADO — Firestore (tempo real) com fallback local (localStorage)
   ------------------------------------------------------------------------ */

const COLLECTION_NAME = 'leads_state';
let db = null;
let firestoreReady = false;
let firebaseConfigured = typeof FIREBASE_CONFIG !== 'undefined'
  && FIREBASE_CONFIG.apiKey && !String(FIREBASE_CONFIG.apiKey).startsWith('SUA_');

function loadLocalState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    console.error('Erro ao ler localStorage', e);
    return {};
  }
}

let LEADS_STATE = loadLocalState();

function saveLocalState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(LEADS_STATE));
}

function setSyncStatus(status) {
  // status: 'local' | 'conectando' | 'sincronizado' | 'erro'
  const el = document.getElementById('sync-status');
  if (!el) return;
  const labels = { local: '● modo local', conectando: '● conectando...', sincronizado: '● sincronizado', erro: '● erro de conexão' };
  el.textContent = labels[status] || status;
  el.classList.toggle('synced', status === 'sincronizado');
}

function initFirebase() {
  if (!firebaseConfigured || typeof firebase === 'undefined') {
    setSyncStatus('local');
    return;
  }
  try {
    firebase.initializeApp(FIREBASE_CONFIG);
    db = firebase.firestore();
    db.enablePersistence({ synchronizeTabs: true }).catch(() => { /* ok se ja habilitado em outra aba */ });
    setSyncStatus('conectando');
    firebase.auth().onAuthStateChanged(user => {
      if (user) {
        firestoreReady = true;
        listenToLeadsState();
      }
    });
    firebase.auth().signInAnonymously().catch(err => {
      console.error('Erro no login anônimo do Firebase', err);
      setSyncStatus('erro');
    });
  } catch (e) {
    console.error('Erro ao inicializar Firebase', e);
    setSyncStatus('erro');
  }
}

let leadsListenerAttached = false;

function listenToLeadsState() {
  // onAuthStateChanged pode disparar mais de uma vez na mesma sessão (ex: restauração
  // de sessão anônima persistida + confirmação do signInAnonymously); sem essa trava,
  // cada disparo extra anexa um novo listener do Firestore, duplicando o processamento
  // e o re-render a cada mudança remota.
  if (leadsListenerAttached) return;
  leadsListenerAttached = true;
  db.collection(COLLECTION_NAME).onSnapshot(snapshot => {
    snapshot.docChanges().forEach(change => {
      const id = change.doc.id;
      if (change.type === 'removed') delete LEADS_STATE[id];
      else LEADS_STATE[id] = change.doc.data();
    });
    setSyncStatus('sincronizado');
    refreshAll();
  }, err => {
    console.error('Erro ao ouvir Firestore', err);
    setSyncStatus('erro');
  });
}

function getState(id) {
  return LEADS_STATE[id] || {
    contacted: false, followup_stage: null, followup_history: [],
    rejection_category: null, rejection_notes: '',
    valor_pago: null, conclusion_notes: '',
    data_visita_agendada: null, data_visita_realizada: null,
    notes: '',
  };
}

function writeRemote(id, patch) {
  if (!firestoreReady || !db) return;
  db.collection(COLLECTION_NAME).doc(String(id)).set(patch, { merge: true }).catch(e => {
    console.error('Erro ao gravar no Firestore', e);
    setSyncStatus('erro');
  });
}

function setState(id, patch) {
  const cur = getState(id);
  LEADS_STATE[id] = { ...cur, ...patch, last_updated_by: currentUserName || cur.last_updated_by || null, updated_at: new Date().toISOString() };
  if (firestoreReady) {
    writeRemote(id, { ...patch, last_updated_by: currentUserName || null, updated_at: new Date().toISOString() });
  } else {
    saveLocalState();
  }
}

function pushHistory(id, stage) {
  const entry = { stage, ts: new Date().toISOString(), by: currentUserName || 'Não identificado' };
  const cur = getState(id);
  const hist = cur.followup_history ? [...cur.followup_history, entry] : [entry];
  LEADS_STATE[id] = { ...cur, followup_history: hist };
  if (firestoreReady) {
    db.collection(COLLECTION_NAME).doc(String(id)).set({
      followup_history: firebase.firestore.FieldValue.arrayUnion(entry),
    }, { merge: true }).catch(e => console.error('Erro ao gravar histórico', e));
  } else {
    saveLocalState();
  }
}

function markContacted(id, value) {
  const cur = getState(id);
  const patch = { contacted: value };
  if (value && !cur.followup_stage) {
    patch.followup_stage = 'novo';
    setState(id, patch);
    pushHistory(id, 'novo');
  } else {
    setState(id, patch);
  }
  refreshAll();
}

function moveStage(id, stage) {
  setState(id, { followup_stage: stage });
  pushHistory(id, stage);
  refreshAll();
}

// Move para (ou mantém) "Visita Agendada" registrando a data planejada da visita.
// Se a escola já estava em "Visita Agendada", isso é um reagendamento (a etapa não
// muda, só a data) e o histórico registra 'reagendado' em vez de duplicar a entrada
// de transição de etapa.
function scheduleVisit(id, date) {
  const wasAlreadyScheduled = getState(id).followup_stage === 'visita_agendada';
  setState(id, { followup_stage: 'visita_agendada', data_visita_agendada: date });
  pushHistory(id, wasAlreadyScheduled ? 'reagendado' : 'visita_agendada');
  refreshAll();
}

function rejectSchool(id, stage, category, notes) {
  // "category" (motivo fixo da lista) só se aplica a rejeição explícita;
  // em "não respondeu" não existe motivo declarado, só fica a observação livre.
  setState(id, {
    followup_stage: stage,
    rejection_category: stage === 'rejeitado' ? (category || null) : null,
    rejection_notes: notes || '',
    contacted: true,
  });
  pushHistory(id, stage);
  refreshAll();
}

function reactivateSchool(id) {
  setState(id, { followup_stage: 'novo', rejection_category: null, rejection_notes: '' });
  pushHistory(id, 'reativado -> novo');
  refreshAll();
}

function completeSchool(id, valor, notes, dataVisita) {
  setState(id, {
    followup_stage: CONCLUDED_STAGE,
    valor_pago: valor,
    conclusion_notes: notes || '',
    data_visita_realizada: dataVisita || null,
    contacted: true,
  });
  pushHistory(id, CONCLUDED_STAGE);
  refreshAll();
}

function revertConclusion(id) {
  // volta pra "Visita Realizada" (não pra "Novo"), já que a visita de fato aconteceu
  setState(id, { followup_stage: 'visitado', valor_pago: null, conclusion_notes: '', data_visita_realizada: null });
  pushHistory(id, 'reativado -> visitado');
  refreshAll();
}

function clearFollowup(id) {
  setState(id, {
    followup_stage: null, contacted: false,
    rejection_category: null, rejection_notes: '',
    valor_pago: null, conclusion_notes: '',
  });
  pushHistory(id, 'sem_followup');
  refreshAll();
}

function deleteHistoryEntry(id, index) {
  const cur = getState(id);
  const hist = (cur.followup_history || []).slice();
  if (index < 0 || index >= hist.length) return;
  const target = hist[index];

  if (firestoreReady && db) {
    // usa uma transação lendo o array direto do servidor: pushHistory grava via
    // arrayUnion, então se alguém adicionar uma entrada nova bem no instante em que
    // esta exclusão está sendo salva, um merge ingênuo (ler estado local -> sobrescrever
    // array inteiro) apagaria essa entrada nova junto sem querer. A transação evita isso.
    const ref = db.collection(COLLECTION_NAME).doc(String(id));
    db.runTransaction(tx => tx.get(ref).then(doc => {
      const remoteHist = (doc.exists && doc.data().followup_history) || [];
      const newHist = remoteHist.filter(h => h.ts !== target.ts);
      tx.set(ref, {
        followup_history: newHist,
        last_updated_by: currentUserName || null,
        updated_at: new Date().toISOString(),
      }, { merge: true });
    })).catch(e => console.error('Erro ao excluir entrada do histórico', e));
  }

  // atualização otimista local pra refletir na hora; se estiver sincronizado, o
  // onSnapshot confirma (ou corrige) o resultado assim que a transação terminar
  hist.splice(index, 1);
  LEADS_STATE[id] = { ...cur, followup_history: hist };
  if (!firestoreReady) saveLocalState();
  refreshAll();
}

/* ------------------------------------------------------------------------
   IDENTIFICAÇÃO DO USUÁRIO (aparece no histórico de follow-up)
   ------------------------------------------------------------------------ */

const USER_NAME_KEY = 'eb_user_name';
let currentUserName = localStorage.getItem(USER_NAME_KEY) || null;

const OUTRO_VALUE = '__outro__';

function renderUserBadge() {
  const badge = document.getElementById('current-user-badge');
  if (!badge) return;
  badge.textContent = currentUserName ? `👤 ${currentUserName}` : '👤 Definir nome';
}

function openNameModal() {
  const overlay = document.getElementById('name-modal-overlay');
  const select = document.getElementById('name-modal-select');
  const input = document.getElementById('name-modal-input');
  const skipBtn = document.getElementById('name-modal-skip');

  // reseta o select pra evitar duplicar as opções toda vez que o modal reabre
  select.innerHTML = '<option value="">Selecione seu nome...</option>';
  input.hidden = true;
  input.value = '';

  // no primeiro acesso (sem nome ainda) a identificação é obrigatória — sem atalho pra fechar.
  // só quando já existe um nome salvo (reabertura pelo badge) aparece "Cancelar", pra manter o nome atual.
  skipBtn.hidden = !currentUserName;
  skipBtn.textContent = 'Cancelar';

  const roster = (typeof TEAM_MEMBERS !== 'undefined' && TEAM_MEMBERS.length) ? TEAM_MEMBERS : [];
  roster.forEach(name => {
    const opt = document.createElement('option');
    opt.value = name; opt.textContent = name;
    select.appendChild(opt);
  });
  const outroOpt = document.createElement('option');
  outroOpt.value = OUTRO_VALUE;
  outroOpt.textContent = 'Meu nome não está na lista...';
  select.appendChild(outroOpt);

  overlay.classList.add('open');
}

function initNameModal() {
  const overlay = document.getElementById('name-modal-overlay');
  const select = document.getElementById('name-modal-select');
  const input = document.getElementById('name-modal-input');

  function confirmName() {
    let val = '';
    if (select.value === OUTRO_VALUE) {
      val = input.value.trim();
    } else {
      val = select.value;
    }
    if (!val) {
      // sem nome escolhido: não fecha o modal, só sinaliza o que falta preencher
      select.style.borderColor = '#d63b3b';
      if (select.value === OUTRO_VALUE) input.focus(); else select.focus();
      return;
    }
    currentUserName = val;
    localStorage.setItem(USER_NAME_KEY, val);
    renderUserBadge();
    select.style.borderColor = '';
    overlay.classList.remove('open');
  }

  select.addEventListener('change', () => {
    input.hidden = select.value !== OUTRO_VALUE;
    if (!input.hidden) input.focus();
  });
  document.getElementById('name-modal-confirm').addEventListener('click', confirmName);
  document.getElementById('name-modal-skip').addEventListener('click', () => {
    overlay.classList.remove('open');
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') confirmName(); });
  document.getElementById('current-user-badge').addEventListener('click', openNameModal);

  renderUserBadge();
  if (!currentUserName) openNameModal();
}

/* ------------------------------------------------------------------------
   DADOS
   ------------------------------------------------------------------------ */

const SCHOOLS = ESCOLAS_DATA; // vem de data/escolas.js
const SCHOOLS_BY_ID = {};
SCHOOLS.forEach(s => { SCHOOLS_BY_ID[s.codigo_inep] = s; });

const ALL_ETAPAS = Array.from(new Set(SCHOOLS.flatMap(s => s.etapas))).sort();
const ALL_REGIOES = Array.from(new Set(SCHOOLS.map(s => s.regiao_estado))).sort();
const ALL_ZONAS = Array.from(new Set(SCHOOLS.filter(s => s.municipio === 'Rio de Janeiro').map(s => s.zona_rio))).sort();
const METRO_MUNICIPIOS = Array.from(new Set(SCHOOLS.filter(s => s.regiao_estado === 'Região Metropolitana').map(s => s.municipio))).sort();

/* Selecoes correntes de modalidade (compartilhadas entre abas, mas com sets independentes) */
const selectedEtapasMapa = new Set();
const selectedEtapasLeads = new Set();

/* ------------------------------------------------------------------------
   MULTISELECT (modalidade de ensino)
   ------------------------------------------------------------------------ */

function buildMultiselect(containerId, selectedSet, onChange) {
  const container = document.getElementById(containerId);
  const toggle = container.querySelector('.multiselect-toggle');
  const panel = container.querySelector('.multiselect-panel');

  ALL_ETAPAS.forEach(etapa => {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = etapa;
    cb.addEventListener('change', () => {
      if (cb.checked) selectedSet.add(etapa); else selectedSet.delete(etapa);
      updateToggleLabel();
      onChange();
    });
    label.appendChild(cb);
    label.appendChild(document.createTextNode(etapa));
    panel.appendChild(label);
  });

  function updateToggleLabel() {
    if (selectedSet.size === 0) toggle.textContent = 'Todas as modalidades ▾';
    else if (selectedSet.size === 1) toggle.textContent = [...selectedSet][0] + ' ▾';
    else toggle.textContent = selectedSet.size + ' modalidades selecionadas ▾';
  }

  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    document.querySelectorAll('.multiselect.open').forEach(el => { if (el !== container) el.classList.remove('open'); });
    container.classList.toggle('open');
  });
  document.addEventListener('click', (e) => {
    if (!container.contains(e.target)) container.classList.remove('open');
  });
}

/* ------------------------------------------------------------------------
   FILTROS
   ------------------------------------------------------------------------ */

let currentLevel = 'municipio'; // municipio | metropolitana | estado
let currentSubFilter = '';

const SUBFILTER_CONFIG = {
  municipio: { label: 'Zona', field: 'zona_rio', options: ALL_ZONAS },
  metropolitana: { label: 'Município', field: 'municipio', options: METRO_MUNICIPIOS },
  estado: { label: 'Região do Estado', field: 'regiao_estado', options: ALL_REGIOES },
};

function matchesEtapas(school, selectedSet) {
  if (selectedSet.size === 0) return true;
  return school.etapas.some(e => selectedSet.has(e));
}

function schoolsForLevel(level) {
  if (level === 'municipio') return SCHOOLS.filter(s => s.municipio === 'Rio de Janeiro');
  if (level === 'metropolitana') return SCHOOLS.filter(s => s.regiao_estado === 'Região Metropolitana');
  return SCHOOLS;
}

function populateSubFilter(level) {
  const cfg = SUBFILTER_CONFIG[level];
  document.getElementById('subfilter-label').textContent = cfg.label;
  const sel = document.getElementById('mapa-subfilter');
  sel.innerHTML = '<option value="">Todas</option>';
  cfg.options.forEach(opt => {
    const o = document.createElement('option');
    o.value = opt; o.textContent = opt;
    sel.appendChild(o);
  });
  currentSubFilter = '';
  sel.value = '';
}

function colorFor(school, level) {
  if (level === 'municipio') return ZONA_COLORS[school.zona_rio] || '#999';
  if (level === 'metropolitana') return hashColor(school.municipio);
  return REGIAO_COLORS[school.regiao_estado] || hashColor(school.regiao_estado);
}

function categoryLabelFor(school, level) {
  if (level === 'municipio') return school.zona_rio;
  if (level === 'metropolitana') return school.municipio;
  return school.regiao_estado;
}

/* ==========================================================================
   MAPA
   ========================================================================== */

let map, clusterGroup;

function initMap() {
  map = L.map('map', { zoomControl: true }).setView([-22.9068, -43.1729], 11);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 19,
    subdomains: 'abcd',
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
  }).addTo(map);
  clusterGroup = L.markerClusterGroup({
    iconCreateFunction: function (cluster) {
      const count = cluster.getChildCount();
      let size = 30;
      if (count > 20) size = 36;
      if (count > 60) size = 42;
      if (count > 150) size = 48;
      return L.divIcon({
        html: `<div class="eb-cluster" style="background:${CLUSTER_COLOR};width:${size}px;height:${size}px;font-size:${size / 3.1}px;">${count}</div>`,
        className: '',
        iconSize: [size, size],
      });
    },
    spiderfyOnMaxZoom: true,
    showCoverageOnHover: false,
    maxClusterRadius: 45,
  });
  map.addLayer(clusterGroup);
}

const CLUSTER_COLOR = '#ff8533';

function markerIcon(color, contacted) {
  const c = contacted ? CONTACTED_COLOR : color;
  const op = contacted ? 0.5 : 0.92;
  return L.divIcon({
    className: '',
    html: `<div class="eb-marker" style="opacity:${op};background:${c};width:11px;height:11px;"></div>`,
    iconSize: [11, 11],
    iconAnchor: [5, 5],
    popupAnchor: [0, -6],
  });
}

function popupHtml(school) {
  const st = getState(school.codigo_inep);
  const badges = school.etapas.map(e => `<span class="badge">${e}</span>`).join('');
  const geoNote = (school.geo_source !== 'exato' && school.geo_source !== 'geocodificado')
    ? `<div class="geo-note">📍 Localização aproximada (${school.geo_source === 'aproximado_bairro' ? 'nível bairro' : school.geo_source === 'aproximado_zona' ? 'nível zona/região' : 'nível município'})</div>`
    : '';
  return `
    <div class="school-popup" data-id="${school.codigo_inep}">
      <h4>${school.nome}</h4>
      <div class="badges">${badges}</div>
      <div class="phone">📞 ${school.telefone ? `<a href="tel:${school.telefone}">${school.telefone}</a>` : '<em>não informado</em>'}</div>
      ${geoNote}
      <label class="check-row">
        <input type="checkbox" class="popup-check" ${st.contacted ? 'checked' : ''}> Marcar como contactada
      </label>
    </div>`;
}

function filteredMapa() {
  const contactedFilter = document.getElementById('contacted-filter-mapa').value;
  let list = schoolsForLevel(currentLevel).filter(s => matchesEtapas(s, selectedEtapasMapa));
  if (currentSubFilter) {
    const field = SUBFILTER_CONFIG[currentLevel].field;
    list = list.filter(s => s[field] === currentSubFilter);
  }
  if (contactedFilter === 'ocultar') list = list.filter(s => !getState(s.codigo_inep).contacted);
  else if (contactedFilter === 'somente') list = list.filter(s => getState(s.codigo_inep).contacted);
  return list;
}

function renderMap() {
  clusterGroup.clearLayers();
  const list = filteredMapa();

  list.forEach(s => {
    if (s.lat == null || s.lon == null) return;
    const st = getState(s.codigo_inep);
    const color = colorFor(s, currentLevel);
    const marker = L.marker([s.lat, s.lon], { icon: markerIcon(color, st.contacted) });
    marker.bindPopup(popupHtml(s));
    marker.on('popupopen', (e) => {
      const el = e.popup.getElement();
      const cb = el.querySelector('.popup-check');
      cb.addEventListener('change', () => markContacted(s.codigo_inep, cb.checked));
    });
    clusterGroup.addLayer(marker);
  });

  document.getElementById('mapa-stats').innerHTML = `<b>${list.length}</b> escolas privadas nesta visualização`;
  renderLegend(list);
}

function renderLegend(list) {
  const el = document.getElementById('map-legend');
  const cats = {};
  list.forEach(s => {
    const label = categoryLabelFor(s, currentLevel);
    cats[label] = (cats[label] || 0) + 1;
  });
  const entries = Object.entries(cats).sort((a, b) => b[1] - a[1]).slice(0, 10);
  let html = '<h4>Legenda</h4>';
  entries.forEach(([label, count]) => {
    const color = currentLevel === 'municipio' ? (ZONA_COLORS[label] || '#999')
      : currentLevel === 'metropolitana' ? hashColor(label)
        : (REGIAO_COLORS[label] || hashColor(label));
    html += `<div class="legend-item"><span class="legend-dot" style="background:${color}"></span> ${label} (${count})</div>`;
  });
  html += `<div class="legend-item" style="margin-top:6px;"><span class="legend-dot" style="background:${CONTACTED_COLOR}"></span> Já contactada</div>`;
  el.innerHTML = html;
}

function setLevel(level) {
  currentLevel = level;
  document.querySelectorAll('#level-selector .seg-btn').forEach(b => b.classList.toggle('active', b.dataset.level === level));
  populateSubFilter(level);
  const center = level === 'municipio' ? [-22.9068, -43.1729] : level === 'metropolitana' ? [-22.75, -43.4] : [-22.0, -42.3];
  const zoom = level === 'municipio' ? 11 : level === 'metropolitana' ? 10 : 8;
  map.setView(center, zoom);
  renderMap();
}

/* ==========================================================================
   LEADS
   ========================================================================== */

function populateLeadsSelects() {
  const regiaoSel = document.getElementById('filter-regiao-estado');
  ALL_REGIOES.forEach(r => {
    const opt = document.createElement('option'); opt.value = r; opt.textContent = r; regiaoSel.appendChild(opt);
  });
  const zonaSel = document.getElementById('filter-zona');
  ALL_ZONAS.forEach(z => {
    const opt = document.createElement('option'); opt.value = z; opt.textContent = z; zonaSel.appendChild(opt);
  });
}

function filteredLeads() {
  const term = document.getElementById('search-leads').value.trim().toLowerCase();
  const regiao = document.getElementById('filter-regiao-estado').value;
  const zona = document.getElementById('filter-zona').value;
  const contactedFilter = document.getElementById('contacted-filter-leads').value;

  return SCHOOLS.filter(s => {
    if (term && !s.nome.toLowerCase().includes(term)) return false;
    if (regiao && s.regiao_estado !== regiao) return false;
    if (zona && s.zona_rio !== zona) return false;
    if (!matchesEtapas(s, selectedEtapasLeads)) return false;
    const contacted = getState(s.codigo_inep).contacted;
    if (contactedFilter === 'ocultar' && contacted) return false;
    if (contactedFilter === 'somente' && !contacted) return false;
    return true;
  });
}

function statusPill(school) {
  const st = getState(school.codigo_inep);
  if (!st.followup_stage) return '<span class="status-pill sem-status">Sem contato</span>';
  if (ALL_LABELS[st.followup_stage]) return `<span class="status-pill ${st.followup_stage}">${ALL_LABELS[st.followup_stage]}</span>`;
  return '';
}

function renderLeads() {
  const tbody = document.getElementById('leads-tbody');
  const list = filteredLeads();
  tbody.innerHTML = '';
  list.forEach(s => {
    const st = getState(s.codigo_inep);
    const tr = document.createElement('tr');
    if (st.contacted) tr.classList.add('contacted');
    tr.innerHTML = `
      <td class="check-col"><input type="checkbox" ${st.contacted ? 'checked' : ''} data-id="${s.codigo_inep}" class="leads-check"></td>
      <td>${s.nome}</td>
      <td>${s.municipio}</td>
      <td>${s.etapas.join(', ')}</td>
      <td>${s.telefone || '—'}</td>
      <td>${statusPill(s)}</td>
    `;
    tr.addEventListener('click', (e) => {
      if (e.target.classList.contains('leads-check')) return;
      openSidebar(s.codigo_inep);
    });
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll('.leads-check').forEach(cb => {
    cb.addEventListener('click', (e) => e.stopPropagation());
    cb.addEventListener('change', () => markContacted(Number(cb.dataset.id), cb.checked));
  });
  document.getElementById('leads-stats').innerHTML = `<b>${list.length}</b> escolas encontradas`;
}

/* ==========================================================================
   FOLLOW UP (KANBAN)
   ========================================================================== */

function schoolsInFollowup() {
  const term = document.getElementById('search-followup').value.trim().toLowerCase();
  return SCHOOLS.filter(s => {
    const st = getState(s.codigo_inep);
    if (!STAGES.includes(st.followup_stage)) return false;
    if (term && !s.nome.toLowerCase().includes(term)) return false;
    return true;
  });
}

function renderKanban() {
  const board = document.getElementById('kanban-board');
  board.innerHTML = '';
  const list = schoolsInFollowup();

  STAGES.forEach(stage => {
    const col = document.createElement('div');
    col.className = 'kanban-col';
    const inStage = list.filter(s => getState(s.codigo_inep).followup_stage === stage);
    col.innerHTML = `<div class="kanban-col-header">${STAGE_LABELS[stage]} <span class="count">${inStage.length}</span></div>
      <div class="kanban-col-body" data-stage="${stage}"></div>`;
    board.appendChild(col);

    const body = col.querySelector('.kanban-col-body');
    if (inStage.length === 0) {
      body.innerHTML = '<div class="kanban-empty">Nenhuma escola nesta etapa</div>';
    }
    inStage.forEach(s => body.appendChild(kanbanCard(s, stage)));

    body.addEventListener('dragover', (e) => { e.preventDefault(); body.classList.add('drag-over'); });
    body.addEventListener('dragleave', () => body.classList.remove('drag-over'));
    body.addEventListener('drop', (e) => {
      e.preventDefault();
      body.classList.remove('drag-over');
      const id = Number(e.dataTransfer.getData('text/plain'));
      moveStage(id, stage);
    });
  });
}

function renderHistoryList(history, options = {}) {
  const { deletable = false, schoolId = null } = options;
  const hist = history || [];
  const items = hist.slice().reverse();
  if (items.length === 0) return '<div class="history-item">Nenhuma interação registrada ainda.</div>';
  return items.map((h, revIdx) => {
    const originalIndex = (hist.length - 1) - revIdx;
    const label = ALL_LABELS[h.stage] || h.stage;
    const author = h.by ? ` <strong>· ${h.by}</strong>` : '';
    const delBtn = deletable
      ? `<button class="history-delete" type="button" data-school-id="${schoolId}" data-index="${originalIndex}" title="Excluir esta entrada do histórico">✕</button>`
      : '';
    return `<div class="history-item"><span class="history-text">${new Date(h.ts).toLocaleString('pt-BR')} — ${label}${author}</span>${delBtn}</div>`;
  }).join('');
}

function kanbanCard(school, stage) {
  const card = document.createElement('div');
  card.className = 'kanban-card';
  card.draggable = true;
  card.dataset.id = school.codigo_inep;
  const st = getState(school.codigo_inep);
  const hist = st.followup_history || [];
  const responsavel = st.last_updated_by ? ` · resp.: ${st.last_updated_by}` : '';
  const scheduledBlock = stage === 'visita_agendada' ? `
    <div class="kc-scheduled">
      <span>📅 ${formatDateOnlyBR(st.data_visita_agendada)}</span>
      <button class="kc-reschedule" type="button">reagendar</button>
    </div>
  ` : '';
  card.innerHTML = `
    <h5>${school.nome}</h5>
    <div class="kc-meta">${school.municipio} · ${school.telefone || 'sem telefone'}${responsavel}</div>
    ${scheduledBlock}
    <div class="kc-actions">
      <select class="stage-move">
        <option value="">Sem follow-up iniciado</option>
        ${STAGES.map(s => `<option value="${s}" ${s === stage ? 'selected' : ''}>${STAGE_LABELS[s]}</option>`).join('')}
      </select>
      <div class="kc-buttons">
        <button class="kc-reject" title="Marcar como rejeitado ou sem resposta">✕ Rejeitar</button>
        ${stage === 'visitado' ? '<button class="kc-complete" title="Marcar como concluída (visita + pagamento)">✓ Concluir</button>' : ''}
      </div>
    </div>
    <button class="kc-history-toggle" type="button">🕒 Histórico (${hist.length})</button>
    <div class="kc-history" hidden>${renderHistoryList(hist)}</div>
  `;
  card.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', String(school.codigo_inep)); });
  card.addEventListener('click', (e) => {
    if (e.target.tagName === 'SELECT' || e.target.tagName === 'BUTTON') return;
    openSidebar(school.codigo_inep);
  });
  card.querySelector('.kc-history-toggle').addEventListener('click', (e) => {
    e.stopPropagation();
    const box = card.querySelector('.kc-history');
    box.hidden = !box.hidden;
  });
  const rescheduleBtn = card.querySelector('.kc-reschedule');
  if (rescheduleBtn) {
    rescheduleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openScheduleModal(school.codigo_inep);
    });
  }
  card.querySelector('.stage-move').addEventListener('change', (e) => {
    const val = e.target.value;
    if (!val) {
      const ok = confirm(`Remover "${school.nome}" do funil de follow-up? Ela volta a aparecer como "Sem contato" no Mapa e em Leads.`);
      if (ok) clearFollowup(school.codigo_inep);
      else renderKanban(); // desfaz a troca visual do select se cancelar
    } else if (val === 'visita_agendada') {
      openScheduleModal(school.codigo_inep);
    } else {
      moveStage(school.codigo_inep, val);
    }
  });
  card.querySelector('.kc-reject').addEventListener('click', (e) => {
    e.stopPropagation();
    openRejectModal(school.codigo_inep);
  });
  const completeBtn = card.querySelector('.kc-complete');
  if (completeBtn) {
    completeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openCompleteModal(school.codigo_inep);
    });
  }
  return card;
}

/* ------------------------------------------------------------------------
   MODAL: REJEITAR / SEM RESPOSTA
   ------------------------------------------------------------------------ */

let rejectModalTargetId = null;

function initRejectModal() {
  const overlay = document.getElementById('reject-modal-overlay');
  const choiceBox = document.getElementById('reject-modal-choice');
  const reasonField = document.getElementById('reject-reason-field');
  const reasonSelect = document.getElementById('reject-reason-select');
  const notesInput = document.getElementById('reject-notes-input');

  REJECTION_REASONS.forEach(r => {
    const opt = document.createElement('option');
    opt.value = r; opt.textContent = r;
    reasonSelect.appendChild(opt);
  });

  choiceBox.querySelectorAll('input[name="reject-type"]').forEach(r => {
    r.addEventListener('change', () => {
      reasonField.hidden = r.value !== 'rejeitado' || !r.checked;
      choiceBox.style.outline = '';
    });
  });

  document.getElementById('reject-modal-cancel').addEventListener('click', () => {
    overlay.classList.remove('open');
    rejectModalTargetId = null;
    refreshSidebarIfOpen(); // desfaz a troca visual do select do sidebar, se aberto
  });

  document.getElementById('reject-modal-confirm').addEventListener('click', () => {
    const checked = choiceBox.querySelector('input[name="reject-type"]:checked');
    if (!checked) {
      choiceBox.style.outline = '1px solid #d63b3b';
      return;
    }
    const stage = checked.value;
    if (stage === 'rejeitado' && !reasonSelect.value) {
      reasonSelect.style.borderColor = '#d63b3b';
      reasonSelect.focus();
      return;
    }
    const category = stage === 'rejeitado' ? reasonSelect.value : null;
    const notes = notesInput.value.trim();
    const id = rejectModalTargetId;
    overlay.classList.remove('open');
    rejectModalTargetId = null;
    if (id != null) rejectSchool(id, stage, category, notes);
  });
}

function openRejectModal(id, presetStage) {
  const overlay = document.getElementById('reject-modal-overlay');
  const choiceBox = document.getElementById('reject-modal-choice');
  const reasonField = document.getElementById('reject-reason-field');
  const reasonSelect = document.getElementById('reject-reason-select');
  const notesInput = document.getElementById('reject-notes-input');
  const st = getState(id);

  rejectModalTargetId = id;
  choiceBox.style.outline = '';
  reasonSelect.style.borderColor = '';
  notesInput.value = st.rejection_notes || '';

  if (presetStage) {
    choiceBox.hidden = true;
    choiceBox.querySelectorAll('input[name="reject-type"]').forEach(r => { r.checked = r.value === presetStage; });
    reasonField.hidden = presetStage !== 'rejeitado';
    reasonSelect.value = presetStage === 'rejeitado' ? (st.rejection_category || '') : '';
  } else {
    choiceBox.hidden = false;
    choiceBox.querySelectorAll('input[name="reject-type"]').forEach(r => { r.checked = false; });
    reasonField.hidden = true;
    reasonSelect.value = '';
  }

  overlay.classList.add('open');
}

/* ------------------------------------------------------------------------
   MODAL: MARCAR COMO CONCLUÍDA
   ------------------------------------------------------------------------ */

let completeModalTargetId = null;

function initCompleteModal() {
  const overlay = document.getElementById('complete-modal-overlay');
  const dataVisitaInput = document.getElementById('complete-data-visita-input');
  const valorInput = document.getElementById('complete-valor-input');
  const notesInput = document.getElementById('complete-notes-input');

  document.getElementById('complete-modal-cancel').addEventListener('click', () => {
    overlay.classList.remove('open');
    completeModalTargetId = null;
    refreshSidebarIfOpen(); // desfaz a troca visual do select do sidebar, se aberto
  });

  document.getElementById('complete-modal-confirm').addEventListener('click', () => {
    if (!dataVisitaInput.value) {
      dataVisitaInput.style.borderColor = '#d63b3b';
      dataVisitaInput.focus();
      return;
    }
    const valor = parseFloat(String(valorInput.value).replace(',', '.'));
    if (valorInput.value === '' || isNaN(valor) || valor < 0) {
      valorInput.style.borderColor = '#d63b3b';
      valorInput.focus();
      return;
    }
    const dataVisita = dataVisitaInput.value;
    const notes = notesInput.value.trim();
    const id = completeModalTargetId;
    overlay.classList.remove('open');
    completeModalTargetId = null;
    if (id != null) completeSchool(id, valor, notes, dataVisita);
  });
}

function openCompleteModal(id) {
  const st = getState(id);
  if (st.followup_stage !== 'visitado') {
    alert('Só é possível concluir uma escola que já passou pela etapa "Visita Realizada".');
    return;
  }
  completeModalTargetId = id;
  const overlay = document.getElementById('complete-modal-overlay');
  const dataVisitaInput = document.getElementById('complete-data-visita-input');
  const valorInput = document.getElementById('complete-valor-input');
  const notesInput = document.getElementById('complete-notes-input');
  dataVisitaInput.style.borderColor = '';
  // pré-preenche com a data que já havia sido agendada (se houver) - o usuário
  // ainda pode ajustar caso a visita tenha acontecido em outro dia
  dataVisitaInput.value = st.data_visita_realizada || st.data_visita_agendada || '';
  valorInput.style.borderColor = '';
  valorInput.value = st.valor_pago != null ? String(st.valor_pago) : '';
  notesInput.value = st.conclusion_notes || '';
  overlay.classList.add('open');
}

/* ------------------------------------------------------------------------
   MODAL: AGENDAR VISITA
   ------------------------------------------------------------------------ */

let scheduleModalTargetId = null;

function initScheduleModal() {
  const overlay = document.getElementById('schedule-modal-overlay');
  const dateInput = document.getElementById('schedule-date-input');

  document.getElementById('schedule-modal-cancel').addEventListener('click', () => {
    overlay.classList.remove('open');
    scheduleModalTargetId = null;
    // desfaz a troca visual do select (kanban ou sidebar), se algum estiver aberto
    refreshSidebarIfOpen();
    renderKanban();
  });

  document.getElementById('schedule-modal-confirm').addEventListener('click', () => {
    if (!dateInput.value) {
      dateInput.style.borderColor = '#d63b3b';
      dateInput.focus();
      return;
    }
    const date = dateInput.value;
    const id = scheduleModalTargetId;
    overlay.classList.remove('open');
    scheduleModalTargetId = null;
    if (id != null) scheduleVisit(id, date);
  });
}

function openScheduleModal(id) {
  scheduleModalTargetId = id;
  const st = getState(id);
  const overlay = document.getElementById('schedule-modal-overlay');
  const dateInput = document.getElementById('schedule-date-input');
  dateInput.style.borderColor = '';
  dateInput.value = st.data_visita_agendada || '';
  overlay.classList.add('open');
}

/* ==========================================================================
   REJEITADOS / SEM RESPOSTA
   ========================================================================== */

function schoolsRejected() {
  return SCHOOLS.filter(s => {
    const st = getState(s.codigo_inep);
    return st.followup_stage === 'rejeitado' || st.followup_stage === 'nao_respondeu';
  });
}

function renderRejeitados() {
  const tbody = document.getElementById('rejeitados-tbody');
  tbody.innerHTML = '';
  schoolsRejected().forEach(s => {
    const st = getState(s.codigo_inep);
    const lastHist = (st.followup_history || []).slice(-1)[0];
    const date = lastHist ? new Date(lastHist.ts).toLocaleString('pt-BR') : '—';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${s.nome}</td>
      <td>${s.municipio}</td>
      <td>${s.telefone || '—'}</td>
      <td>${TERMINAL_LABELS[st.followup_stage]}</td>
      <td>${st.rejection_category || '—'}</td>
      <td>${st.rejection_notes || '—'}</td>
      <td>${date}</td>
      <td><button class="btn-reactivate" data-id="${s.codigo_inep}">Reativar</button></td>
    `;
    tr.querySelector('td:not(:last-child)').parentElement.addEventListener('click', (e) => {
      if (e.target.classList.contains('btn-reactivate')) return;
      openSidebar(s.codigo_inep);
    });
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll('.btn-reactivate').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      reactivateSchool(Number(btn.dataset.id));
    });
  });
}

/* ==========================================================================
   CONCLUÍDOS
   ========================================================================== */

function schoolsConcluded() {
  return SCHOOLS.filter(s => getState(s.codigo_inep).followup_stage === CONCLUDED_STAGE);
}

function formatCurrencyBR(valor) {
  const n = Number(valor);
  if (!isFinite(n)) return '—';
  return n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Formata uma data "pura" no formato do <input type="date"> (YYYY-MM-DD) para DD/MM/YYYY.
// Faz isso via split de string em vez de `new Date(str)` de propósito: um "YYYY-MM-DD" é
// interpretado pelo JS como UTC-meia-noite, e ao converter pra horário local (ex: UTC-3)
// isso viraria o dia anterior às 21h — um bug clássico de "data volta um dia".
function formatDateOnlyBR(dateStr) {
  if (!dateStr) return '—';
  const parts = String(dateStr).split('-');
  if (parts.length !== 3) return dateStr;
  const [y, m, d] = parts;
  return `${d}/${m}/${y}`;
}

function renderConcluidos() {
  const tbody = document.getElementById('concluidos-tbody');
  tbody.innerHTML = '';
  schoolsConcluded().forEach(s => {
    const st = getState(s.codigo_inep);
    const lastHist = (st.followup_history || []).slice(-1)[0];
    const date = lastHist ? new Date(lastHist.ts).toLocaleString('pt-BR') : '—';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${s.nome}</td>
      <td>${s.municipio}</td>
      <td>${s.telefone || '—'}</td>
      <td>${st.valor_pago != null ? 'R$ ' + formatCurrencyBR(st.valor_pago) : '—'}</td>
      <td>${st.conclusion_notes || '—'}</td>
      <td>${formatDateOnlyBR(st.data_visita_realizada)}</td>
      <td>${date}</td>
      <td><button class="btn-reactivate" data-id="${s.codigo_inep}">Reverter</button></td>
    `;
    tr.querySelector('td:not(:last-child)').parentElement.addEventListener('click', (e) => {
      if (e.target.classList.contains('btn-reactivate')) return;
      openSidebar(s.codigo_inep);
    });
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll('.btn-reactivate').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      revertConclusion(Number(btn.dataset.id));
    });
  });
}

/* ==========================================================================
   AGENDA (escolas em "Visita Agendada", ordenadas pela data mais próxima)
   ========================================================================== */

function schoolsAgenda() {
  return SCHOOLS
    .filter(s => getState(s.codigo_inep).followup_stage === 'visita_agendada')
    // "YYYY-MM-DD" ordena corretamente como string, sem precisar parsear Date;
    // escolas sem data (não deveria acontecer, mas por segurança) vão pro final.
    .slice()
    .sort((a, b) => {
      const da = getState(a.codigo_inep).data_visita_agendada || '9999-99-99';
      const db_ = getState(b.codigo_inep).data_visita_agendada || '9999-99-99';
      return da < db_ ? -1 : da > db_ ? 1 : 0;
    });
}

function renderAgenda() {
  const tbody = document.getElementById('agenda-tbody');
  tbody.innerHTML = '';
  schoolsAgenda().forEach(s => {
    const st = getState(s.codigo_inep);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="agenda-date-cell">${formatDateOnlyBR(st.data_visita_agendada)}</td>
      <td>${s.nome}</td>
      <td>${s.municipio}</td>
      <td>${s.endereco || '—'}</td>
      <td>${s.telefone || '—'}</td>
      <td>${st.last_updated_by || '—'}</td>
      <td><button class="btn-reactivate btn-reschedule-agenda" data-id="${s.codigo_inep}">Reagendar</button></td>
    `;
    tr.querySelector('td:not(:last-child)').parentElement.addEventListener('click', (e) => {
      if (e.target.classList.contains('btn-reschedule-agenda')) return;
      openSidebar(s.codigo_inep);
    });
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll('.btn-reschedule-agenda').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openScheduleModal(Number(btn.dataset.id));
    });
  });
}

/* ==========================================================================
   SIDEBAR DE DETALHES
   ========================================================================== */

let sidebarOpenId = null;

function refreshSidebarIfOpen() {
  if (sidebarOpenId != null && document.getElementById('sidebar-overlay').classList.contains('open')) {
    openSidebar(sidebarOpenId);
  }
}

function openSidebar(id) {
  sidebarOpenId = id;
  const s = SCHOOLS_BY_ID[id];
  const st = getState(id);
  const overlay = document.getElementById('sidebar-overlay');
  const content = document.getElementById('sidebar-content');

  const historyHtml = renderHistoryList(st.followup_history, { deletable: true, schoolId: id });

  const rejectionBlock = (st.followup_stage === 'rejeitado' || st.followup_stage === 'nao_respondeu') ? `
    <hr>
    <div class="info-label" style="margin-bottom:6px;">Detalhes da rejeição</div>
    <div class="info-grid">
      <div><div class="info-label">Motivo</div><div class="info-value">${st.rejection_category || '—'}</div></div>
      <div class="full"><div class="info-label">Observações</div><div class="info-value">${st.rejection_notes || '—'}</div></div>
    </div>
  ` : '';

  const conclusionBlock = st.followup_stage === CONCLUDED_STAGE ? `
    <hr>
    <div class="info-label" style="margin-bottom:6px;">Detalhes da conclusão</div>
    <div class="info-grid">
      <div><div class="info-label">Data da visita</div><div class="info-value">${formatDateOnlyBR(st.data_visita_realizada)}</div></div>
      <div><div class="info-label">Valor (R$)</div><div class="info-value">${st.valor_pago != null ? formatCurrencyBR(st.valor_pago) : '—'}</div></div>
      <div class="full"><div class="info-label">Observações</div><div class="info-value">${st.conclusion_notes || '—'}</div></div>
    </div>
  ` : '';

  const scheduleBlock = st.followup_stage === 'visita_agendada' ? `
    <hr>
    <div class="info-label" style="margin-bottom:6px;">Agendamento</div>
    <div class="info-grid">
      <div><div class="info-label">Data agendada</div><div class="info-value">${formatDateOnlyBR(st.data_visita_agendada)}</div></div>
    </div>
    <button class="schedule-inline-edit" type="button" id="sidebar-reschedule">✎ Editar data</button>
  ` : '';

  content.innerHTML = `
    <h2>${s.nome}</h2>
    <div class="muted-line">${s.municipio} · ${s.regiao_estado}${s.municipio === 'Rio de Janeiro' ? ' · ' + s.zona_rio : ''}</div>

    <div class="info-grid">
      <div><div class="info-label">Telefone</div><div class="info-value">${s.telefone || '—'}</div></div>
      <div><div class="info-label">Categoria</div><div class="info-value">${s.categoria_privada}</div></div>
      <div class="full"><div class="info-label">Endereço</div><div class="info-value">${s.endereco}</div></div>
      <div><div class="info-label">Bairro</div><div class="info-value">${s.bairro || '—'}</div></div>
      <div><div class="info-label">Porte</div><div class="info-value">${s.porte}</div></div>
      <div class="full"><div class="info-label">Modalidades de Ensino</div><div class="info-value">${s.etapas.join(', ')}</div></div>
      <div><div class="info-label">Conveniada c/ poder público</div><div class="info-value">${s.conveniada_poder_publico}</div></div>
      <div><div class="info-label">Regulamentação</div><div class="info-value">${s.regulamentacao}</div></div>
    </div>

    <label class="check-row" style="margin-bottom:14px;">
      <input type="checkbox" id="sidebar-contacted" ${st.contacted ? 'checked' : ''}> Marcar como contactada
    </label>

    <hr>
    <div class="info-label" style="margin-bottom:6px;">Etapa de Follow-up</div>
    <select class="stage-select" id="sidebar-stage">
      <option value="" ${!st.followup_stage ? 'selected' : ''}>Sem follow-up iniciado</option>
      ${STAGES.map(stg => `<option value="${stg}" ${st.followup_stage === stg ? 'selected' : ''}>${STAGE_LABELS[stg]}</option>`).join('')}
      ${Object.keys(TERMINAL_LABELS).map(stg => `<option value="${stg}" ${st.followup_stage === stg ? 'selected' : ''}>${TERMINAL_LABELS[stg]}</option>`).join('')}
      <option value="${CONCLUDED_STAGE}" ${st.followup_stage === CONCLUDED_STAGE ? 'selected' : ''}>${CONCLUDED_LABEL}</option>
    </select>
    ${rejectionBlock}
    ${conclusionBlock}
    ${scheduleBlock}

    <hr>
    <div class="info-label" style="margin-bottom:6px;">Notas internas</div>
    <textarea id="sidebar-notes" placeholder="Anotações do time comercial...">${st.notes || ''}</textarea>
    <button class="btn-primary" id="sidebar-save-notes">Salvar notas</button>

    <hr>
    <div class="info-label" style="margin-bottom:6px;">Histórico de contato</div>
    ${historyHtml}
  `;

  content.querySelector('#sidebar-contacted').addEventListener('change', (e) => markContacted(id, e.target.checked));
  content.querySelector('#sidebar-stage').addEventListener('change', (e) => {
    const val = e.target.value;
    if (!val) { clearFollowup(id); return; }
    if (val === 'rejeitado' || val === 'nao_respondeu') {
      openRejectModal(id, val);
      return;
    }
    if (val === CONCLUDED_STAGE) {
      if (st.followup_stage !== 'visitado') {
        alert('Só é possível concluir uma escola que já passou pela etapa "Visita Realizada".');
        openSidebar(id); // reverte o select pro valor real
        return;
      }
      openCompleteModal(id);
      return;
    }
    if (val === 'visita_agendada') {
      openScheduleModal(id);
      return;
    }
    moveStage(id, val);
  });
  const rescheduleLink = content.querySelector('#sidebar-reschedule');
  if (rescheduleLink) {
    rescheduleLink.addEventListener('click', () => openScheduleModal(id));
  }
  content.querySelector('#sidebar-save-notes').addEventListener('click', () => {
    setState(id, { notes: content.querySelector('#sidebar-notes').value });
    refreshAll();
  });
  content.querySelectorAll('.history-delete').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const index = Number(btn.dataset.index);
      const ok = confirm('Excluir esta entrada do histórico? Essa ação não pode ser desfeita.');
      if (ok) deleteHistoryEntry(id, index);
    });
  });

  overlay.classList.add('open');
}

document.getElementById('sidebar-close').addEventListener('click', () => {
  document.getElementById('sidebar-overlay').classList.remove('open');
});
document.getElementById('sidebar-overlay').addEventListener('click', (e) => {
  if (e.target.id === 'sidebar-overlay') e.target.classList.remove('open');
});

/* ==========================================================================
   TABS
   ========================================================================== */

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('panel-' + btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab === 'mapa' && map) setTimeout(() => map.invalidateSize(), 50);
  });
});

/* ==========================================================================
   EXPORTAÇÕES CSV (uma por aba, cada uma com as colunas relevantes daquela base)
   ========================================================================== */

// Escapa um valor para uso seguro em CSV com delimitador ";" (padrão Excel PT-BR):
// - envolve em aspas se contiver ";", aspas, quebra de linha, ou começar/terminar com espaço
// - duplica aspas internas (RFC4180)
function csvEscape(value) {
  const s = (value === null || value === undefined) ? '' : String(value);
  if (/[;"\n\r]/.test(s) || s !== s.trim()) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// Gera e baixa um arquivo CSV. Usa ";" como delimitador (não "," ) e BOM UTF-8
// no início, porque o Excel em PT-BR usa "," como separador decimal e só faz o
// auto-split de colunas corretamente com ";"; sem o BOM, acentos vêm corrompidos.
function downloadCSV(filename, headers, rows) {
  const lines = [headers.map(csvEscape).join(';')];
  rows.forEach(row => lines.push(row.map(csvEscape).join(';')));
  const csvContent = '﻿' + lines.join('\r\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function todayStamp() {
  return new Date().toISOString().slice(0, 10);
}

function geoSourceLabel(s) {
  const map = {
    exato: 'Exata',
    geocodificado: 'Geocodificada',
    aproximado_bairro: 'Aproximada (nível bairro)',
    aproximado_zona: 'Aproximada (nível zona/região)',
    aproximado_municipio: 'Aproximada (nível município)',
  };
  return map[s.geo_source] || s.geo_source || '—';
}

function stageAtualLabel(school) {
  const st = getState(school.codigo_inep);
  if (!st.followup_stage) return 'Sem contato';
  return ALL_LABELS[st.followup_stage] || st.followup_stage;
}

// Concatena o histórico completo de contato em uma única célula (usado no export de Follow Up)
function historyToCSVCell(history) {
  const hist = history || [];
  if (hist.length === 0) return '—';
  return hist.map(h => {
    const label = ALL_LABELS[h.stage] || h.stage;
    const author = h.by ? ` (${h.by})` : '';
    return `${new Date(h.ts).toLocaleString('pt-BR')} — ${label}${author}`;
  }).join(' | ');
}

function exportMapaCSV() {
  const headers = [
    'Código INEP', 'Escola', 'Município', 'Região do Estado', 'Zona (Rio)',
    'Modalidades de Ensino', 'Telefone', 'Endereço', 'Bairro',
    'Latitude', 'Longitude', 'Precisão da Localização', 'Contactada', 'Etapa Atual',
  ];
  const rows = filteredMapa().map(s => {
    const st = getState(s.codigo_inep);
    return [
      s.codigo_inep, s.nome, s.municipio, s.regiao_estado,
      s.municipio === 'Rio de Janeiro' ? s.zona_rio : '—',
      s.etapas.join(', '), s.telefone || '—', s.endereco || '—', s.bairro || '—',
      s.lat != null ? String(s.lat).replace('.', ',') : '—',
      s.lon != null ? String(s.lon).replace('.', ',') : '—',
      geoSourceLabel(s), st.contacted ? 'Sim' : 'Não', stageAtualLabel(s),
    ];
  });
  downloadCSV(`educa-bondinho-mapa-${todayStamp()}.csv`, headers, rows);
}

function exportLeadsCSV() {
  const headers = [
    'Código INEP', 'Escola', 'Município', 'Região do Estado', 'Zona (Rio)',
    'Modalidades de Ensino', 'Telefone', 'Endereço', 'Bairro',
    'Contactada', 'Status',
  ];
  const rows = filteredLeads().map(s => {
    const st = getState(s.codigo_inep);
    return [
      s.codigo_inep, s.nome, s.municipio, s.regiao_estado,
      s.municipio === 'Rio de Janeiro' ? s.zona_rio : '—',
      s.etapas.join(', '), s.telefone || '—', s.endereco || '—', s.bairro || '—',
      st.contacted ? 'Sim' : 'Não', stageAtualLabel(s),
    ];
  });
  downloadCSV(`educa-bondinho-leads-${todayStamp()}.csv`, headers, rows);
}

function exportFollowupCSV() {
  const headers = [
    'Escola', 'Telefone', 'Município', 'Etapa Atual', 'Responsável',
    'Data do Primeiro Contato', 'Data da Última Atualização', 'Histórico Completo', 'Notas Internas',
  ];
  const rows = schoolsInFollowup().map(s => {
    const st = getState(s.codigo_inep);
    const hist = st.followup_history || [];
    const first = hist.length > 0 ? new Date(hist[0].ts).toLocaleString('pt-BR') : '—';
    const lastUpdate = st.updated_at ? new Date(st.updated_at).toLocaleString('pt-BR') : '—';
    return [
      s.nome, s.telefone || '—', s.municipio, stageAtualLabel(s),
      st.last_updated_by || '—', first, lastUpdate,
      historyToCSVCell(hist), st.notes || '—',
    ];
  });
  downloadCSV(`educa-bondinho-followup-${todayStamp()}.csv`, headers, rows);
}

function exportRejeitadosCSV() {
  const headers = ['Escola', 'Telefone', 'Município', 'Status', 'Motivo', 'Observações', 'Data', 'Responsável'];
  const rows = schoolsRejected().map(s => {
    const st = getState(s.codigo_inep);
    const lastHist = (st.followup_history || []).slice(-1)[0];
    const date = lastHist ? new Date(lastHist.ts).toLocaleString('pt-BR') : '—';
    return [
      s.nome, s.telefone || '—', s.municipio, TERMINAL_LABELS[st.followup_stage] || '—',
      st.rejection_category || '—', st.rejection_notes || '—', date, st.last_updated_by || '—',
    ];
  });
  downloadCSV(`educa-bondinho-rejeitados-${todayStamp()}.csv`, headers, rows);
}

function exportConcluidosCSV() {
  const headers = ['Escola', 'Telefone', 'Município', 'Valor (R$)', 'Observações', 'Data da Visita', 'Data de Conclusão', 'Responsável'];
  const rows = schoolsConcluded().map(s => {
    const st = getState(s.codigo_inep);
    const lastHist = (st.followup_history || []).slice(-1)[0];
    const date = lastHist ? new Date(lastHist.ts).toLocaleString('pt-BR') : '—';
    return [
      s.nome, s.telefone || '—', s.municipio,
      st.valor_pago != null ? formatCurrencyBR(st.valor_pago) : '—',
      st.conclusion_notes || '—', formatDateOnlyBR(st.data_visita_realizada), date, st.last_updated_by || '—',
    ];
  });
  downloadCSV(`educa-bondinho-concluidos-${todayStamp()}.csv`, headers, rows);
}

function exportAgendaCSV() {
  const headers = ['Data Agendada', 'Escola', 'Telefone', 'Município', 'Endereço', 'Responsável'];
  const rows = schoolsAgenda().map(s => {
    const st = getState(s.codigo_inep);
    return [
      formatDateOnlyBR(st.data_visita_agendada), s.nome, s.telefone || '—', s.municipio,
      s.endereco || '—', st.last_updated_by || '—',
    ];
  });
  downloadCSV(`educa-bondinho-agenda-${todayStamp()}.csv`, headers, rows);
}

document.getElementById('btn-export-mapa').addEventListener('click', exportMapaCSV);
document.getElementById('btn-export-leads').addEventListener('click', exportLeadsCSV);
document.getElementById('btn-export-followup').addEventListener('click', exportFollowupCSV);
document.getElementById('btn-export-agenda').addEventListener('click', exportAgendaCSV);
document.getElementById('btn-export-rejeitados').addEventListener('click', exportRejeitadosCSV);
document.getElementById('btn-export-concluidos').addEventListener('click', exportConcluidosCSV);


/* ==========================================================================
   INIT
   ========================================================================== */

function refreshAll() {
  renderMap();
  renderLeads();
  renderKanban();
  renderAgenda();
  renderRejeitados();
  renderConcluidos();
  refreshSidebarIfOpen();
}

function init() {
  initNameModal();
  initRejectModal();
  initCompleteModal();
  initScheduleModal();
  initFirebase();
  initMap();
  buildMultiselect('modalidade-filter-mapa', selectedEtapasMapa, renderMap);
  buildMultiselect('modalidade-filter-leads', selectedEtapasLeads, renderLeads);
  populateLeadsSelects();
  populateSubFilter(currentLevel);

  document.querySelectorAll('#level-selector .seg-btn').forEach(b => {
    b.addEventListener('click', () => setLevel(b.dataset.level));
  });
  document.getElementById('mapa-subfilter').addEventListener('change', (e) => {
    currentSubFilter = e.target.value;
    renderMap();
  });
  document.getElementById('legend-toggle').addEventListener('click', () => {
    document.getElementById('map-legend').classList.toggle('open');
  });
  document.getElementById('contacted-filter-mapa').addEventListener('change', renderMap);
  document.getElementById('contacted-filter-leads').addEventListener('change', renderLeads);
  document.getElementById('search-leads').addEventListener('input', renderLeads);
  document.getElementById('filter-regiao-estado').addEventListener('change', renderLeads);
  document.getElementById('filter-zona').addEventListener('change', renderLeads);
  document.getElementById('search-followup').addEventListener('input', renderKanban);

  refreshAll();
}

init();
