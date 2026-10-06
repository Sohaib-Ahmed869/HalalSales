// Live truck positions pushed to the Logistics map over socket.io.
// Only logged-in portal users may connect (same JWT as the REST API). The
// positions come from MyGeotab (services/geotabSync.js).
const { Server } = require("socket.io");
const { verifyToken } = require("../middleware/auth");

let io = null;

function init(httpServer) {
  io = new Server(httpServer, {
    cors: { origin: "*" },
    // the Logistics page also refetches over REST, so a short-lived hiccup is harmless
    pingInterval: 20000,
    pingTimeout: 20000,
  });

  io.use(async (socket, next) => {
    try {
      const user = await verifyToken(socket.handshake.auth?.token);
      if (!user) return next(new Error("Authentication required"));
      socket.data.userId = String(user._id);
      next();
    } catch (err) {
      next(new Error("Authentication failed"));
    }
  });

  io.on("connection", (socket) => {
    // one room per tenant so a tenant's map never receives another's trucks
    socket.on("tracking:join", (tenant) => {
      socket.join(`tracking:${tenant || "halal-food-sales"}`);
    });
  });

  return io;
}

function emitPosition(tenant, payload) {
  if (io) io.to(`tracking:${tenant}`).emit("truck:position", payload);
}

// The truck reached or left a stop (utils/stopVisits.js), so open
// Logistics pages reload their routes.
function emitStopUpdate(tenant, payload) {
  if (io) io.to(`tracking:${tenant}`).emit("truck:stop", payload);
}

// A truck's live ETAs were recomputed (utils/liveEta.js).
function emitEtaUpdate(tenant, payload) {
  if (io) io.to(`tracking:${tenant}`).emit("truck:eta", payload);
}

module.exports = { init, emitPosition, emitStopUpdate, emitEtaUpdate };
