// assets/js/main.js
import {
  MAP_ID, START, FLAG_URL,
  CITIES,
  COAST_SOURCES, COUNTRY_SOURCES, LAND_SOURCES,
  MAX_FOCUS_ZOOM
} from "./config/constants.js";

import {
  gp, getName, getISO2,
  clipCoastGeoJSONByContinent,
  strokeForZoom, lodForZoom
} from "./utils/geo-helpers.js";

/* ---------------- Service Worker ---------------- */
(async function registerSW(){
  if (!('serviceWorker' in navigator)) return;
  try { await navigator.serviceWorker.register('./sw.js', { scope: './' }); } catch {}
})();
async function precacheViaSW(urls){
  if (!('serviceWorker' in navigator)) return false;
  try{
    const reg = await navigator.serviceWorker.ready;
    (reg.active || navigator.serviceWorker.controller)?.postMessage({ type: 'PRECACHE_URLS', urls });
    return true;
  }catch{ return false; }
}

/* ---------------- Fetch utils ---------------- */
const _fetchControllers = new Map();
async function fetchJSONWithAbort(url, opts={}){
  const prev = _fetchControllers.get(url);
  if (prev) { try{ prev.abort(); }catch{} }
  const ctrl = new AbortController();
  _fetchControllers.set(url, ctrl);
  try{
    const r = await fetch(url, { mode:'cors', cache:'force-cache', signal: ctrl.signal, ...opts });
    return await r.json();
  } finally {}
}
async function fetchGeoOrTopo(url, opts={}){
  const json = await fetchJSONWithAbort(url, opts);
  if (json && json.type === 'Topology' && json.objects) {
    const topo = await import('https://cdn.jsdelivr.net/npm/topojson-client@3/dist/topojson-client.min.js');
    const firstKey = Object.keys(json.objects)[0];
    const fc = topo.feature(json, json.objects[firstKey]);
    return fc && fc.type === 'FeatureCollection' ? fc : { type:'FeatureCollection', features: (Array.isArray(fc)? fc : [fc]) };
  }
  return json;
}
class LRUCache {
  constructor(maxEntries=12, ttlMs=10*60*1000){ this.max=maxEntries; this.ttl=ttlMs; this.map=new Map(); }
  _isExpired(ts){ return this.ttl && (performance.now()-ts)>this.ttl; }
  get(k){
    const e=this.map.get(k); if(!e) return;
    if(this._isExpired(e.ts)){ this.map.delete(k); return; }
    this.map.delete(k); this.map.set(k, e);
    return e.v;
  }
  set(k,v){
    if(this.map.has(k)) this.map.delete(k);
    this.map.set(k,{v,ts:performance.now()});
    if(this.map.size>this.max){ const oldest=this.map.keys().next().value; this.map.delete(oldest); }
  }
  clear(){ this.map.clear(); }
}

/* ---------------- Helpers: island filtering ---------------- */
function toMercator([lng, lat]){
  const R=6378137, x=R*(lng*Math.PI/180), y=R*Math.log(Math.tan(Math.PI/4+(lat*Math.PI/180)/2));
  return [x,y];
}
function polygonAreaM2(ring){
  let a=0;
  for(let i=0,n=ring.length,j=n-1;i<n;j=i++){
    const [x1,y1]=toMercator(ring[j]); const [x2,y2]=toMercator(ring[i]);
    a += (x1*y2 - x2*y1);
  }
  return Math.abs(a)/2;
}
function mainlandOnlyGeometry(geom){
  if(!geom) return geom;
  if(geom.type==='Polygon'){ return geom; }
  if(geom.type==='MultiPolygon'){
    let best=null, bestA=0;
    for(const poly of geom.coordinates){
      const ring = poly[0];
      if(!ring || ring.length<3) continue;
      const A = polygonAreaM2(ring);
      if(A>bestA){ bestA=A; best=poly; }
    }
    return best ? { type:'Polygon', coordinates: best } : geom;
  }
  return geom;
}
function filterIslandsFC(fc){
  return {
    ...fc,
    features: fc.features.map(f=>({ ...f, geometry: mainlandOnlyGeometry(f.geometry) }))
  };
}

/* ---------------- Island countries list (ISO2) ---------------- */
// Pays sans frontière terrestre. Ajustable selon ton besoin.
const ISLAND_ISO2 = new Set([
  // Europe
  "IS","MT","CY",
  // Océanie
  "AU","NZ","NR","PW","FM","MH","KI","TV","TO","WS","VU","SB","FJ","PG", // PG a une frontière avec ID, retire-le si tu veux l’inclure
  // Asie
  "JP","PH","LK","MV","SG","BH","TW",
  // Afrique (îles)
  "MG","MU","SC","KM","CV","ST",
  // Caraïbes / Amériques
  "CU","JM","BS","BB","TT","AG","KN","DM","LC","VC","GD"
]);

/* ---------------- App ---------------- */
window.initMap = async function initMap(){
  const targetNameEl    = document.getElementById('targetName');
  const flagImgEl       = document.getElementById('flagImg');
  const attemptsPill    = document.getElementById('attemptsPill');
  const continentSelect = document.getElementById('continentSelect');
  const modeSelect      = document.getElementById('modeSelect');
  const resetBtn        = document.getElementById('resetBtn');
  const nextBtn         = document.getElementById('nextBtn');
  const scopeStatsEl    = document.getElementById('scopeStats');
  const screenFlashEl   = document.getElementById('screenFlash');
  const hideIslandsSel  = document.getElementById('hideIslandsSelect');
  const distanceDialogEl= document.getElementById('distanceDialog');

  let map;
  let coastData = null;
  let lastCoastLOD = null;
  let _lastCoastStrokeWeight = null;

  const coastLayersByKey = new Map();
  const countryLayers = { "110m": null, "50m": null };
  let countryData = null;
  let lastCountryLOD = null;

  const LAND_CACHE = { "110m": null, "50m": null };
  let LAND_CURRENT = null;
  let lastLandLOD = null;

  let mode = 'name', currentContinent = 'ALL';
  let attemptsLeft = 3, locked = false;
  const foundCountries = new Set(), failedCountries = new Set();
  const foundCities = new Set(), failedCities = new Set();
  let target = null, hoveredId = null;

  // défaut: Yes -> on masque les îles
  let hideIslands = true;
  if (hideIslandsSel) hideIslandsSel.value = 'yes';

  const FR_CENTER = { lat: 46.6, lng: 2.2 };
  const FR_ZOOM   = 5;

  let isDragging = false, isZooming = false, suspendHover = false, needsHeavyUpdate = false;

  // Markers
  let AdvancedMarkerElement, PinElement;
  async function ensureMarkerLib(){
    if(AdvancedMarkerElement && PinElement) return {AdvancedMarkerElement, PinElement};
    const lib = await google.maps.importLibrary("marker");
    AdvancedMarkerElement = lib.AdvancedMarkerElement; PinElement = lib.PinElement;
    return lib;
  }

  // Caches
  const COAST_CACHE = { "110m": null, "50m": null, "10m": null };
  const COAST_FILTER_CACHE = new LRUCache(12, 10*60*1000);

  const _css = getComputedStyle(document.documentElement);
  const COLOR_OK = (_css.getPropertyValue('--ok') || '#19c37d').trim();
  const COLOR_KO = (_css.getPropertyValue('--ko') || '#ff3b30').trim();

  const _preloadedFlags = new Set();
  function preloadFlag(iso){
    if(!iso) return;
    const href = FLAG_URL(iso);
    if (_preloadedFlags.has(href)) return;
    const l = document.createElement('link');
    l.rel='prefetch';
    l.href=href;
    document.head.appendChild(l);
    _preloadedFlags.add(href);
  }

  function flashScreen(){ screenFlashEl.classList.remove('show'); void screenFlashEl.offsetWidth; screenFlashEl.classList.add('show'); }

  function correctCount(){ return mode==='city' ? foundCities.size : foundCountries.size; }
  function updateAttempts(){ attemptsPill.textContent=`Attempts: ${attemptsLeft} · Correct: ${correctCount()}`; }

  function getContinentCached(f){ return f.__continent ?? gp(f, ['CONTINENT','REGION_UN','continent']) ?? 'Unknown'; }
  function iso2Cached(f){ return f.__iso2 ?? getISO2(f); }
  function isFeatureInScope(f){ const cont = getContinentCached(f); return currentContinent==='ALL' || cont===currentContinent; }
  function updateStats(){
    const label = currentContinent==='ALL' ? 'World' : continentSelect.options[continentSelect.selectedIndex].textContent;
    if(mode==='city'){
      const pool = getCityPool(); const total=pool.length;
      const done = pool.filter(c=>foundCities.has(c.id)||failedCities.has(c.id)).length;
      scopeStatsEl.textContent = `${label} — Cities: ${done} / ${total}`;
    }else{
      let total=0, done=0;
      countryData && countryData.forEach(f=>{
        const inScope = (currentContinent==='ALL') || getContinentCached(f)===currentContinent;
        if(!inScope) return;
        const iso = iso2Cached(f); if(!iso) return;
        if(hideIslands && ISLAND_ISO2.has(iso)) return; // exclure du total
        total++;
        if(foundCountries.has(iso) || failedCountries.has(iso)) done++;
      });
      scopeStatsEl.textContent = `${label} — Countries: ${done} / ${total}`;
    }
  }

  function countryStyle(f){
    const z = map.getZoom()||1;
    const cont = getContinentCached(f);
    const hovered = f.getId()===hoveredId;
    const iso = iso2Cached(f);

    if (iso && (foundCountries.has(iso) || failedCountries.has(iso))) {
      const success = foundCountries.has(iso);
      const fillColor = success ? COLOR_OK : COLOR_KO;
      const fillOpacity = (z<3)?0.28:(z<5)?0.36:(z<8)?0.42:0.5;
      const strokeOpacity = 0.9;
      return {
        fillColor, fillOpacity,
        strokeColor: fillColor, strokeOpacity,
        strokeWeight: (z<3)?0.8:(z<5)?1.2:(z<8)?1.6:2.0,
        clickable: (mode!=='city'),
        zIndex: 950
      };
    }

    let fillOpacity = 0, fillColor = '#fff', strokeOpacity=0;
    if(!suspendHover && hovered && (currentContinent==='ALL' || cont===currentContinent) && mode!=='city'){
      fillColor = "#ffd7b0";
      fillOpacity = (z<3)?0.06:(z<5)?0.09:(z<8)?0.12:0.16;
      strokeOpacity = 0.32;
    }
    return {
      fillColor, fillOpacity,
      strokeColor:"#ff8a2a", strokeOpacity,
      strokeWeight: (z<3)?0.7:(z<5)?1.1:(z<8)?1.5:1.9,
      clickable: (mode!=='city'),
      zIndex: 900
    };
  }

  function annotateFeatureMeta(f){
    const b = new google.maps.LatLngBounds();
    f.getGeometry().forEachLatLng(ll => b.extend(ll));
    const sw = b.getSouthWest(), ne = b.getNorthEast();
    f.__bbox = [sw.lat(), sw.lng(), ne.lat(), ne.lng()];
    f.__iso2 = getISO2(f) || null;
    f.__continent = gp(f, ['CONTINENT','REGION_UN','continent']) || null;
    f.__name = getName(f) || null;
  }

  function countryBounds(feature){
    const b = new google.maps.LatLngBounds();
    feature.getGeometry().forEachLatLng(ll=>b.extend(ll));
    return b;
  }
  function focusFeatureRobust(f){
    const b = countryBounds(f);
    if(!b || b.isEmpty()) return;
    const cT = b.getCenter();
    const ZMIN = 3;
    const ZMAX = MAX_FOCUS_ZOOM;
    map.panTo(cT);
    const z = map.getZoom() || 1;
    if (z < ZMIN) map.setZoom(ZMIN);
    if (z > ZMAX) map.setZoom(ZMAX);
  }

  /* -------------- COASTS -------------- */
  async function buildCoastLayer(level, continent){
    const key = `${level}:${continent}`;
    if (coastLayersByKey.has(key)) return coastLayersByKey.get(key);

    if (!COAST_CACHE[level]) COAST_CACHE[level] = await fetchGeoOrTopo(COAST_SOURCES[level]);
    let filtered = COAST_FILTER_CACHE.get(key);
    if (!filtered) {
      filtered = clipCoastGeoJSONByContinent(COAST_CACHE[level], continent);
      COAST_FILTER_CACHE.set(key, filtered);
    }

    const layer = new google.maps.Data({ map: null });
    const styleFn = () => ({
      strokeColor: "#ff7f2a",
      strokeOpacity: 1,
      strokeWeight: _lastCoastStrokeWeight ?? strokeForZoom(map.getZoom() || 1),
      fillOpacity: 0,
      clickable: false,
      zIndex: 1000
    });
    _lastCoastStrokeWeight = strokeForZoom(map.getZoom() || 1);
    layer.setStyle(styleFn);
    layer.addGeoJson(filtered, { idPropertyName: "ne_id" });

    coastLayersByKey.set(key, layer);
    return layer;
  }
  async function useCoastLOD(level){
    const next = await buildCoastLayer(level, currentContinent);
    if (coastData) coastData.setMap(null);
    next.setMap(map);
    coastData = next;
    lastCoastLOD = level;
  }

  /* -------------- COUNTRIES -------------- */
  const _countryBuildToken = { "110m": 0, "50m": 0 };
  async function buildCountryLayer(level){
    if(countryLayers[level]) return countryLayers[level];

    const layer = new google.maps.Data({ map: null });
    layer.setStyle(countryStyle);
    layer.addListener('mouseover', (e)=>{ if(suspendHover) return; hoveredId=e.feature.getId(); layer.overrideStyle(e.feature, countryStyle(e.feature)); });
    layer.addListener('mouseout',  ()=>{ if(suspendHover) return; hoveredId=null; layer.revertStyle(); });
    layer.addListener('click', onCountryClick);

    const token = ++_countryBuildToken[level];
    let gj = await fetchGeoOrTopo(COUNTRY_SOURCES[level]);
    if (_countryBuildToken[level] !== token) return layer;

    if (hideIslands) gj = filterIslandsFC(gj);

    layer.addGeoJson(gj, { idPropertyName: "ADM0_A3" });
    layer.forEach(f => annotateFeatureMeta(f));
    countryLayers[level] = layer;
    return layer;
  }
  async function useCountryLOD(level){
    if(lastCountryLOD===level && countryData) return;
    const next = await buildCountryLayer(level);
    if(countryData) countryData.setMap(null);
    next.setMap(map);
    countryData = next;
    lastCountryLOD = level;
    countryData.setStyle(countryStyle);
    updateStats(); updateAttempts();
  }

  // Pools
  let _poolCacheKey = null, _poolCacheList = [], _poolCacheTS = 0;
  const POOL_TTL = 30_000;
  function getCountryPool(){
    if(!countryData) return [];
    const key = `${lastCountryLOD}|${currentContinent}|${foundCountries.size}|${failedCountries.size}|${hideIslands}`;
    const fresh = (performance.now()-_poolCacheTS) < POOL_TTL;
    if(key === _poolCacheKey && fresh) return _poolCacheList;
    const list = [];
    countryData.forEach(f=>{
      if(!isFeatureInScope(f)) return;
      const iso = iso2Cached(f); if(!iso) return;
      if(hideIslands && ISLAND_ISO2.has(iso)) return; // exclure du pool
      if(foundCountries.has(iso) || failedCountries.has(iso)) return;
      list.push(f);
    });
    _poolCacheKey = key; _poolCacheList = list; _poolCacheTS = performance.now();
    return list;
  }
  function getCityPool(){ return currentContinent==='ALL' ? CITIES.slice() : CITIES.filter(c=>c.continent===currentContinent); }

  /* -------------- LAND (preload only) -------------- */
  let _landReqToken = 0;
  async function ensureLandLOD(level){
    if (LAND_CURRENT && lastLandLOD===level) return;
    const token = ++_landReqToken;
    if(!LAND_CACHE[level]){
      LAND_CACHE[level] = await fetchGeoOrTopo(LAND_SOURCES[level]);
      if (_landReqToken !== token) return;
    }
    LAND_CURRENT = LAND_CACHE[level];
    lastLandLOD = level;
  }

  /* -------------- MAP -------------- */
  map = new google.maps.Map(document.getElementById("map"), {
    center: START.center, zoom: START.zoom, tilt: START.tilt, heading: START.heading,
    mapId: MAP_ID,
    gestureHandling: "greedy", disableDefaultUI: true, clickableIcons: false,
    draggableCursor: "none", draggingCursor: "none",
    maxZoom: 22,
    restriction: { latLngBounds:{ north:85, south:-85, west:-179.999, east:179.999 }, strictBounds:true }
  });

  map.setCenter(FR_CENTER);
  map.setZoom(FR_ZOOM);

  if (location.hash.includes('3d')) {
    map.setCenter({lat:48.85837, lng:2.294481});
    map.moveCamera({ zoom: 18, tilt: 45, heading: 25 });
  }

  await useCoastLOD(lodForZoom(map.getZoom() || 1));
  await useCountryLOD((map.getZoom()||1) >=3 ? "50m" : "110m");
  await ensureLandLOD((map.getZoom()||1) >=3 ? "50m" : "110m");

  async function runHeavyUpdate(){
    if (document.hidden) return;
    const z = map.getZoom()||1;
    const w = strokeForZoom(z);
    if (w !== _lastCoastStrokeWeight) {
      _lastCoastStrokeWeight = w;
      if (coastData) coastData.setStyle(() => ({
        strokeColor: "#ff7f2a",
        strokeOpacity: 1,
        strokeWeight: _lastCoastStrokeWeight,
        fillOpacity: 0,
        clickable: false,
        zIndex: 1000
      }));
    }
    const coastNext   = lodForZoom(z);
    const countryNext = (z>=3) ? "50m" : "110m";
    const landNext    = (z>=3) ? "50m" : "110m";
    if(coastNext !== lastCoastLOD){ await useCoastLOD(coastNext); }
    if(countryNext !== lastCountryLOD){ await useCountryLOD(countryNext); }
    if(landNext !== lastLandLOD){ await ensureLandLOD(landNext); }
  }
  function requestHeavyUpdate(){ needsHeavyUpdate = true; }
  function maybeRunHeavyUpdate(){ if (needsHeavyUpdate){ needsHeavyUpdate=false; runHeavyUpdate(); } }

  map.addListener('dragstart', ()=>{ isDragging = true; suspendHover = true; });
  map.addListener('dragend',   ()=>{ isDragging = false; suspendHover = false; requestHeavyUpdate(); });
  map.addListener('zoom_changed', ()=>{ isZooming = true; suspendHover = true; requestHeavyUpdate(); });
  map.addListener('idle', ()=>{ isZooming = false; suspendHover = false; maybeRunHeavyUpdate(); });

  /* ---------------- GAME UI ---------------- */
  function setModeUI(){
    mode = modeSelect.value;
    if(mode==='flag' && target && target.type==='country'){
      const iso = iso2Cached(target.feature);
      if(iso){
        preloadFlag(iso);
        flagImgEl.onerror=()=>{flagImgEl.style.display='none'; targetNameEl.textContent=getName(target.feature);};
        flagImgEl.src=FLAG_URL(iso);
        flagImgEl.style.display='block';
        targetNameEl.textContent='';
      }
    }else{
      flagImgEl.style.display='none';
      targetNameEl.textContent = target ? (target.type==='country' ? getName(target.feature) : target.name) : '…';
    }
    countryData && countryData.setStyle(countryStyle);
    updateStats(); updateAttempts();
  }

  function onCountryClick(e){
    if(mode==='city' || locked) return;
    const f = e.feature;
    if(!isFeatureInScope(f)) return;
    const isoClick = iso2Cached(f); if(!isoClick) return;
    if(foundCountries.has(isoClick) || failedCountries.has(isoClick)) return;

    const correct = target && target.type==='country' && iso2Cached(target.feature) === isoClick;
    if(correct){
      locked=true;
      foundCountries.add(isoClick);
      countryData.setStyle(countryStyle);
      targetNameEl.textContent = getName(target.feature)+' ✔';
      flagImgEl.style.display='none';
      updateStats(); updateAttempts();
      setTimeout(pickNextTarget, 450);
    }else{
      attemptsLeft = Math.max(0, attemptsLeft-1); updateAttempts();
      countryData.overrideStyle(f, { fillColor: COLOR_KO, fillOpacity: 0.35, clickable: true, zIndex: 960 });
      setTimeout(()=> countryData.revertStyle(f), 180);
      flashScreen();

      if(attemptsLeft===0 && target && target.type==='country'){
        locked=true;
        const isoT = iso2Cached(target.feature);
        if(isoT) failedCountries.add(isoT);
        countryData.setStyle(countryStyle);
        targetNameEl.textContent = getName(target.feature)+' ✖';
        flagImgEl.style.display='none';
        updateStats(); updateAttempts();
        focusFeatureRobust(target.feature);
        setTimeout(pickNextTarget, 1100);
      }
    }
  }

  // Haversine km
  function kmBetween(lat1,lng1,lat2,lng2){
    const toRad = (d)=>d*Math.PI/180, R=6371;
    const dLat=toRad(lat2-lat1), dLng=toRad(lng2-lng1);
    const a=Math.sin(dLat/2)**2+Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLng/2)**2;
    return 2*R*Math.asin(Math.sqrt(a));
  }

  let guessPin=null, answerPin=null;
  function clearPins(){ if(guessPin){guessPin.map=null; guessPin=null;} if(answerPin){answerPin.map=null; answerPin=null;} }

  let distanceHideTO=null;
  function showDistanceAt(px, py, text){
    distanceDialogEl.textContent = text;
    distanceDialogEl.style.left = px + 'px';
    distanceDialogEl.style.top  = (py - 16) + 'px';
    distanceDialogEl.classList.add('show');
    clearTimeout(distanceHideTO);
    distanceHideTO = setTimeout(()=> distanceDialogEl.classList.remove('show'), 1500);
  }

  async function cityMapClick(e){
    if(mode!=='city' || !target || locked) return;
    await ensureMarkerLib();
    const dkm = Math.round(kmBetween(e.latLng.lat(), e.latLng.lng(), target.lat, target.lon));
    const pin = new PinElement({ background:'#ff8a2a', borderColor:'#ffd6b3', glyphColor:'#fff' });
    if(guessPin) guessPin.map=null;
    guessPin = new AdvancedMarkerElement({ map, position:e.latLng, content:pin.element });

    const px = e.domEvent?.clientX ?? window.innerWidth/2;
    const py = e.domEvent?.clientY ?? window.innerHeight/2;
    showDistanceAt(px, py, `~${dkm} km`);

    const success = dkm <= 50;
    if(success){
      locked=true; foundCities.add(target.id);
      const pinOk = new PinElement({ background: COLOR_OK, borderColor:'#d7ffd6', glyphColor:'#fff' });
      if(answerPin) answerPin.map=null;
      answerPin = new AdvancedMarkerElement({ map, position:{lat:target.lat, lng:target.lon}, content:pinOk.element });
      targetNameEl.textContent=`${target.name} ✔ (±${dkm} km)`; updateStats(); updateAttempts();
      setTimeout(pickNextTarget, 600);
    }else{
      attemptsLeft=Math.max(0, attemptsLeft-1); updateAttempts(); flashScreen();
      targetNameEl.textContent=`${target.name} — ${dkm} km away`;
      if(attemptsLeft===0){
        locked=true; failedCities.add(target.id);
        const pinKo = new PinElement({ background: COLOR_KO, borderColor:'#ffd0d0', glyphColor:'#fff' });
        if(answerPin) answerPin.map=null;
        answerPin = new AdvancedMarkerElement({ map, position:{lat:target.lat, lng:target.lon}, content:pinKo.element });
        updateStats(); updateAttempts();
        map.panTo({lat:target.lat, lng:target.lon});
        if ((map.getZoom()||1) < 5) map.setZoom(5);
        setTimeout(pickNextTarget, 900);
      }
    }
  }

  function pickRandomCountryFeature(){
    const pool = getCountryPool();
    return pool.length ? pool[Math.floor(Math.random()*pool.length)] : null;
  }
  function pickRandomCity(){
    const pool=getCityPool().filter(c=>!foundCities.has(c.id) && !failedCities.has(c.id));
    return pool.length? pool[Math.floor(Math.random()*pool.length)] : null;
  }

  function pickNextTarget(){
    locked=false; nextBtn.disabled=true;
    if(mode==='city'){
      clearPins();
      const next = pickRandomCity();
      if(!next){ target=null; targetNameEl.textContent='Done ✔'; attemptsPill.textContent='—'; updateStats(); return; }
      target = { type:'city', ...next };
      attemptsLeft=3; updateAttempts(); targetNameEl.textContent=target.name;
    }else{
      clearPins();
      const f = pickRandomCountryFeature();
      if(!f){ target=null; targetNameEl.textContent='Done ✔'; attemptsPill.textContent='—'; updateStats(); return; }
      target = { type:'country', feature:f };
      const iso = iso2Cached(f); if(iso) preloadFlag(iso);
      attemptsLeft=3; setModeUI(); updateAttempts();
    }
  }

  continentSelect.addEventListener('change', async ()=>{
    currentContinent = continentSelect.value;
    if(countryLayers["110m"]) countryLayers["110m"].setStyle(countryStyle);
    if(countryLayers["50m"])  countryLayers["50m"].setStyle(countryStyle);
    await useCoastLOD(lastCoastLOD || lodForZoom(map.getZoom()||1));
    _poolCacheKey = null; _poolCacheTS = 0;
    updateStats(); updateAttempts();
    pickNextTarget();
  }, {passive:true});

  modeSelect.addEventListener('change', ()=>{ setModeUI(); pickNextTarget(); }, {passive:true});

  // Yes/No îles -> reconstruit la couche et met à jour pool + stats
  hideIslandsSel.addEventListener('change', async ()=>{
    hideIslands = hideIslandsSel.value === 'yes';
    countryLayers["110m"] = null;
    countryLayers["50m"]  = null;
    await useCountryLOD((map.getZoom()||1) >=3 ? "50m" : "110m");
    _poolCacheKey = null; _poolCacheTS = 0;
    updateStats(); updateAttempts();
    // Si la cible actuelle est une île et qu'on masque, on tire une nouvelle cible
    if (hideIslands && target && target.type==='country') {
      const iso = iso2Cached(target.feature);
      if (iso && ISLAND_ISO2.has(iso)) pickNextTarget();
    }
  }, {passive:true});

  resetBtn.addEventListener('click', ()=>{
    foundCountries.clear(); failedCountries.clear();
    foundCities.clear(); failedCities.clear();
    _poolCacheKey = null; _poolCacheTS = 0;
    attemptsLeft=3; updateAttempts(); clearPins();
    countryData && countryData.setStyle(countryStyle);
    map.setCenter(FR_CENTER); map.setZoom(FR_ZOOM);
    map.setHeading(START.heading); map.setTilt(START.tilt);
    pickNextTarget(); updateStats(); updateAttempts();
  });

  nextBtn.addEventListener('click', pickNextTarget);
  google.maps.event.addListener(map,'click', cityMapClick);

  document.getElementById('btnReset').onclick = ()=>{
    map.setCenter(FR_CENTER); map.setZoom(FR_ZOOM);
    map.setHeading(START.heading); map.setTilt(START.tilt);
  };

  setModeUI();
  pickNextTarget();

  // Crosshair
  (function initCrosshair(){
    const aim = document.getElementById('aim');
    if(!aim) return;
    const v = aim.querySelector('.aim-line.v');
    const h = aim.querySelector('.aim-line.h');
    const dot = aim.querySelector('.aim-dot');
    const mapDiv = document.getElementById('map');
    aim.style.pointerEvents = 'none';
    aim.style.contain = 'layout paint size';
    v.style.willChange = 'transform';
    h.style.willChange = 'transform';
    dot.style.willChange = 'transform';
    let x=window.innerWidth/2, y=window.innerHeight/2, rafId=null, lastX=-1, lastY=-1;
    function draw(){ v.style.transform=`translate3d(${x}px,0,0)`; h.style.transform=`translate3d(0,${y}px,0)`; dot.style.transform=`translate3d(${x-9}px,${y-9}px,0)`; rafId=null; }
    function requestDraw(){ if(rafId==null){ rafId=requestAnimationFrame(draw); } }
    mapDiv.addEventListener('pointermove', (e)=>{ if(Math.abs(e.clientX-lastX)<0.5 && Math.abs(e.clientY-lastY)<0.5) return;
      lastX=e.clientX; lastY=e.clientY; aim.style.opacity='1'; x=e.clientX; y=e.clientY; requestDraw(); }, {passive:true});
    mapDiv.addEventListener('pointerleave', ()=>{ aim.style.opacity='0'; }, {passive:true});
    window.addEventListener('resize', ()=>{ requestDraw(); }, {passive:true});
  })();

  (window.requestIdleCallback||function(fn){setTimeout(fn,500)})(async ()=>{
    try{
      const urls = [];
      if(!COAST_CACHE["110m"]) urls.push(COAST_SOURCES["110m"]);
      if(!COAST_CACHE["50m"])  urls.push(COAST_SOURCES["50m"]);
      if(!COAST_CACHE["10m"])  urls.push(COAST_SOURCES["10m"]);
      if(!countryLayers["110m"]) urls.push(COUNTRY_SOURCES["110m"]);
      if(!countryLayers["50m"])  urls.push(COUNTRY_SOURCES["50m"]);
      if(!LAND_CACHE["110m"]) urls.push(LAND_SOURCES["110m"]);
      if(!LAND_CACHE["50m"])  urls.push(LAND_SOURCES["50m"]);
      const sentToSW = await precacheViaSW(urls);
      if(!sentToSW){ await Promise.all(urls.map(u=>fetch(u, {mode:'cors', cache:'force-cache'}))); }
    }catch{}
  });
};
