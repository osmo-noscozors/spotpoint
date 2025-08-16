// config/constants.js
export const MAP_ID = "2cedc7ef22b5fe74fdf467c4";

export const START = {
  center:{lat:48.85837, lng:2.294481},
  zoom: 1, tilt:0, heading:0
};

export const FLAG_URL = iso2 => `https://flagcdn.com/w320/${(iso2||'').toLowerCase()}.png`;

export const CITIES = [
  {id:'paris', name:'Paris', lat:48.8566, lon:2.3522, continent:'Europe'},
  {id:'oslo', name:'Oslo', lat:59.9139, lon:10.7522, continent:'Europe'},
  {id:'stockholm', name:'Stockholm', lat:59.3293, lon:18.0686, continent:'Europe'},
  {id:'madrid', name:'Madrid', lat:40.4168, lon:-3.7038, continent:'Europe'},
  {id:'rome', name:'Rome', lat:41.9028, lon:12.4964, continent:'Europe'},
  {id:'berlin', name:'Berlin', lat:52.52, lon:13.405, continent:'Europe'},
  {id:'london', name:'Londres', lat:51.5074, lon:-0.1278, continent:'Europe'},
  {id:'lisbon', name:'Lisbonne', lat:38.7223, lon:-9.1393, continent:'Europe'},
  {id:'vienna', name:'Vienne', lat:48.2082, lon:16.3738, continent:'Europe'},
  {id:'budapest', name:'Budapest', lat:47.4979, lon:19.0402, continent:'Europe'},
  {id:'nyc', name:'New York', lat:40.7128, lon:-74.0060, continent:'North America'},
  {id:'la', name:'Los Angeles', lat:34.0522, lon:-118.2437, continent:'North America'},
  {id:'toronto', name:'Toronto', lat:43.6532, lon:-79.3832, continent:'North America'},
  {id:'mexico', name:'Mexico', lat:19.4326, lon:-99.1332, continent:'North America'},
  {id:'tokyo', name:'Tokyo', lat:35.6762, lon:139.6503, continent:'Asia'},
  {id:'seoul', name:'Séoul', lat:37.5665, lon:126.9780, continent:'Asia'},
  {id:'bangkok', name:'Bangkok', lat:13.7563, lon:100.5018, continent:'Asia'},
  {id:'cairo', name:'Le Caire', lat:30.0444, lon:31.2357, continent:'Africa'},
  {id:'lagos', name:'Lagos', lat:6.5244, lon:3.3792, continent:'Africa'},
  {id:'sydney', name:'Sydney', lat:-33.8688, lon:151.2093, continent:'Oceania'},
  {id:'melbourne', name:'Melbourne', lat:-37.8136, lon:144.9631, continent:'Oceania'}
];

export const CONT_BBOX = {
  "ALL": [[-90,-180,90,180]],
  "Africa": [[-35,-20,38,55]],
  "Europe": [[35,-25,72,60]],
  "Asia": [[5,25,80,180], [5,-180,80,-170]],
  "North America": [[7,-170,85,-50]],
  "South America": [[-56,-82,13,-34]],
  "Oceania": [[-50,110,10,180], [-50,-180,10,-160]],
  "Antarctica": [[-90,-180,-60,180]]
};

export const COAST_SOURCES = {
  "110m": "https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector/geojson/ne_110m_coastline.geojson",
  "50m" : "https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector/geojson/ne_50m_coastline.geojson",
  "10m" : "https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector/geojson/ne_10m_coastline.geojson"
};

export const COUNTRY_SOURCES = {
  "110m": "https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector/geojson/ne_110m_admin_0_countries.geojson",
  "50m" : "https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector/geojson/ne_50m_admin_0_countries.geojson"
};

export const LAND_SOURCES = {
  "110m": "https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector/geojson/ne_110m_land.geojson",
  "50m" : "https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector/geojson/ne_50m_land.geojson"
};

export const COAST_STROKE_SCALE = 0.7;

export const FOCUS_EXPAND_RATIO = 1.6;
export const MAX_FOCUS_ZOOM = 5;
