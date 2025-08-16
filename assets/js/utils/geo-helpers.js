// utils/geo-helpers.js
import { CONT_BBOX, COAST_STROKE_SCALE } from "../config/constants.js";

export const gp = (f, keys) => {
  for(const k of keys){
    const v = f.getProperty ? f.getProperty(k) : (f.properties ? f.properties[k] : null);
    if(v!=null && v!=='-99') return v;
  }
  return null;
};

export const getName = (f) => gp(f, ['NAME','ADMIN','ADMIN_NAME','SOVEREIGNT','name']) || 'Inconnu';

export const getISO2 = (f) => {
  let v = gp(f, ['ISO_A2','iso_a2','ISO 3166-1 Alpha-2','ALPHA2','ALPHA_2']);
  if(!v || v==='-99'){
    const n=(gp(f,['NAME','ADMIN','ADMIN_NAME'])||'').toLowerCase();
    const fb={'france':'FR','norway':'NO','kingdom of norway':'NO','norvège':'NO','sweden':'SE','suède':'SE'};
    if(fb[n]) v=fb[n];
  }
  return v && v!=='-99' ? v : null;
};

export const inBox = (lat,lng,[S,W,N,E]) =>
  (W<=E) ? (lat>=S && lat<=N && lng>=W && lng<=E)
         : ((lat>=S && lat<=N) && (lng>=W || lng<=E));

export const clipLineToBoxes = (coords, boxes)=>{
  const parts=[]; let cur=null;
  const inside=(lng,lat)=>boxes.some(b=>inBox(lat,lng,b));
  for(const [lng,lat] of coords){
    if(inside(lng,lat)){ if(!cur) cur=[[lng,lat]]; else cur.push([lng,lat]); }
    else { if(cur && cur.length>1) parts.push(cur); cur=null; }
  }
  if(cur && cur.length>1) parts.push(cur);
  return parts;
};

export const clipCoastGeoJSONByContinent = (gj, continent)=>{
  if (continent === 'ALL') return gj;
  const boxes = CONT_BBOX[continent] || CONT_BBOX.ALL;
  const out = { type:'FeatureCollection', features:[] };
  for(const feat of (gj.features || [])){
    const g = feat.geometry; if(!g) continue;
    if(g.type==='LineString'){
      const parts = clipLineToBoxes(g.coordinates, boxes);
      if(parts.length===1) out.features.push({ type:'Feature', properties:feat.properties||{}, geometry:{ type:'LineString', coordinates:parts[0] }});
      else if(parts.length>1) out.features.push({ type:'Feature', properties:feat.properties||{}, geometry:{ type:'MultiLineString', coordinates:parts }});
    }else if(g.type==='MultiLineString'){
      let acc=[]; for(const line of g.coordinates){ acc = acc.concat( clipLineToBoxes(line, boxes) ); }
      if(acc.length===1) out.features.push({ type:'Feature', properties:feat.properties||{}, geometry:{ type:'LineString', coordinates:acc[0] }});
      else if(acc.length>1) out.features.push({ type:'Feature', properties:feat.properties||{}, geometry:{ type:'MultiLineString', coordinates:acc }});
    }
  }
  return out;
};

export const strokeForZoom = (z)=>{
  // 3 paliers stables pour limiter les restyles
  const base = (z<3)?1.2:(z<6)?1.8:2.6;
  return Math.max(0.6, +(base*COAST_STROKE_SCALE).toFixed(2));
};

export const lodForZoom = (z)=>{ if (z>=5) return "10m"; if (z>=3) return "50m"; return "110m"; };

export function bboxIntersects(bbox, viewBounds){
  if(!bbox || !viewBounds) return true;
  const [S,W,N,E] = bbox;
  const south = viewBounds.getSouthWest().lat();
  const north = viewBounds.getNorthEast().lat();
  if (N < south || S > north) return false;
  const west = viewBounds.getSouthWest().lng();
  const east = viewBounds.getNorthEast().lng();
  if (west <= east){ return !(E < west || W > east); }
  return (W <= east) || (E >= west);
}

export function addPolygonToPath(path, rings, proj, step, originX, originY){
  const JUMP = 256;
  for(const ring of rings){
    let first = true;
    let prevX = 0, prevY = 0;
    for(let i=0;i<ring.length;i+=step){
      const [lng,lat] = ring[i];
      const p = proj.fromLatLngToDivPixel(new google.maps.LatLng(lat,lng));
      const x = p.x - originX;
      const y = p.y - originY;
      if(first){
        path.moveTo(x,y);
        first=false;
      }else{
        const dx = x - prevX, dy = y - prevY;
        if (Math.abs(dx) > JUMP || Math.abs(dy) > JUMP){
          path.moveTo(x,y);
        }else{
          path.lineTo(x,y);
        }
      }
      prevX = x; prevY = y;
    }
    if(!first && ring.length){
      const [lng0,lat0] = ring[0];
      const p0 = proj.fromLatLngToDivPixel(new google.maps.LatLng(lat0,lng0));
      const x0 = p0.x - originX, y0 = p0.y - originY;
      const dx0 = x0 - prevX, dy0 = y0 - prevY;
      if (Math.abs(dx0) <= JUMP && Math.abs(dy0) <= JUMP){
        path.lineTo(x0,y0);
      }
    }
  }
}
