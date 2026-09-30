// controllers/mapTiles.controller.js
//
// Google Map Tiles API (2D roadmap) for the Logistics map, proxied through
// the backend so GOOGLE_MAPS_API_KEY never reaches the browser.
//
//   GET /api/map/tiles/config       (login required) -> { provider, tileToken }
//       provider "google" when the Map Tiles API is configured, else null
//       (the frontend then uses its own fallback tiles).
//   GET /api/map/tiles/:z/:x/:y?t=  (public URL, needs the 12 h "tiles" token
//       from /config: <img> tile requests can't send an Authorization header)
//   GET /api/map/tiles/attribution  (login required) -> { copyright } for the
//       visible area, which Google requires to be shown on the map.
//
// One Google tile session is shared by all users and renewed before it
// expires (sessions last about two weeks). Tiles are sent with Google's own
// cache headers, so browsers don't re-download them.
//
// Env: GOOGLE_MAPS_API_KEY, GOOGLE_TILES_ENABLED ("false" = off),
//      GOOGLE_TILES_LANGUAGE (default "en-GB"), GOOGLE_TILES_REGION (default "FR").

const axios = require("axios");
const google = require("../utils/googleMapsClient");
const { signScopedToken, verifyScopedToken } = require("../middleware/auth");

let session = null; // { id, expiresAt }
let sessionPromise = null;

async function getSession(forceNew = false) {
  if (!forceNew && session && session.expiresAt - Date.now() > 60 * 60 * 1000) return session.id;
  if (!sessionPromise) {
    const cfg = google.config();
    sessionPromise = axios
      .post(
        `${cfg.tilesUrl}/v1/createSession`,
        {
          mapType: "roadmap",
          language: process.env.GOOGLE_TILES_LANGUAGE || "en-GB",
          region: process.env.GOOGLE_TILES_REGION || "FR",
        },
        { params: { key: cfg.key }, headers: { "Content-Type": "application/json" }, timeout: cfg.timeout }
      )
      .then(({ data }) => {
        if (!data?.session) throw new Error("Google returned no tile session");
        const expirySec = Number(data.expiry);
        session = {
          id: data.session,
          expiresAt: Number.isFinite(expirySec) ? expirySec * 1000 : Date.now() + 24 * 60 * 60 * 1000,
        };
        return session.id;
      })
      .finally(() => {
        sessionPromise = null;
      });
  }
  return sessionPromise;
}

exports.getTileConfig = async (req, res) => {
  if (!google.config().tilesEnabled) return res.json({ provider: null });
  try {
    await getSession();
    res.json({ provider: "google", tileToken: signScopedToken(req.user, "tiles") });
  } catch (error) {
    console.warn("[mapTiles] Google tiles unavailable:", google.errorText(error));
    res.json({ provider: null });
  }
};

const isInt = (v) => /^\d{1,8}$/.test(String(v));

exports.getTile = async (req, res) => {
  const { z, x, y } = req.params;
  if (!verifyScopedToken(req.query.t, "tiles")) return res.status(401).end();
  if (![z, x, y].every(isInt) || Number(z) > 22) return res.status(400).end();
  if (!google.config().tilesEnabled) return res.status(404).end();

  const cfg = google.config();
  const fetchTile = async (sessionId) =>
    axios.get(`${cfg.tilesUrl}/v1/2dtiles/${z}/${x}/${y}`, {
      params: { session: sessionId, key: cfg.key },
      responseType: "arraybuffer",
      timeout: cfg.timeout,
    });

  try {
    let response;
    try {
      response = await fetchTile(await getSession());
    } catch (error) {
      // Expired / invalidated session: renew once and retry.
      if (![400, 401, 403].includes(error.response?.status)) throw error;
      response = await fetchTile(await getSession(true));
    }
    // helmet() sends "Cross-Origin-Resource-Policy: same-origin" on every
    // response, which makes browsers refuse these images on the portal's own
    // (different) origin. Tiles are meant to be embedded, so allow it here only.
    res.set("Cross-Origin-Resource-Policy", "cross-origin");
    res.set("Content-Type", response.headers["content-type"] || "image/png");
    res.set("Cache-Control", response.headers["cache-control"] || "private, max-age=86400");
    res.send(Buffer.from(response.data));
  } catch (error) {
    const status = error.response?.status;
    if (status !== 404) console.warn(`[mapTiles] tile ${z}/${x}/${y} failed:`, error.message);
    res.status(status === 404 ? 404 : 502).end();
  }
};

const attributionCache = new Map();

exports.getAttribution = async (req, res) => {
  if (!google.config().tilesEnabled) return res.json({ copyright: "" });
  const zoom = Math.max(0, Math.min(22, Math.round(Number(req.query.zoom) || 0)));
  const box = ["north", "south", "east", "west"].map((k) => Number(req.query[k]));
  if (!box.every(Number.isFinite)) return res.status(400).json({ message: "north, south, east, west required" });
  const [north, south, east, west] = box.map((v) => Math.round(v * 100) / 100);
  const cacheKey = `${zoom}|${north}|${south}|${east}|${west}`;
  if (attributionCache.has(cacheKey)) return res.json({ copyright: attributionCache.get(cacheKey) });

  try {
    const cfg = google.config();
    const { data } = await axios.get(`${cfg.tilesUrl}/tile/v1/viewport`, {
      params: { session: await getSession(), key: cfg.key, zoom, north, south, east, west },
      timeout: cfg.timeout,
    });
    const copyright = data?.copyright || "Map data ©Google";
    attributionCache.set(cacheKey, copyright);
    if (attributionCache.size > 500) attributionCache.delete(attributionCache.keys().next().value);
    res.json({ copyright });
  } catch (error) {
    console.warn("[mapTiles] attribution failed:", google.errorText(error));
    res.json({ copyright: "Map data ©Google" });
  }
};
