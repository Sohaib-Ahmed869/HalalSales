// Live truck positions pushed to the Logistics map over socket.io.
// Rides on the app's main socket.io server (socket.js), whose handshake
// middleware already requires the portal JWT. The Traccar Client phones never
// touch the socket, they POST to the ingest route.
let io = null;

function init(existingIo) {
  io = existingIo;
  if (!io) return null;

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

// A stop's GPS arrival / delivery changed (utils/autoDelivery.js), so open
// Logistics pages reload their routes.
function emitStopUpdate(tenant, payload) {
  if (io) io.to(`tracking:${tenant}`).emit("truck:stop", payload);
}

// A truck's live ETAs were recomputed (utils/liveEta.js).
function emitEtaUpdate(tenant, payload) {
  if (io) io.to(`tracking:${tenant}`).emit("truck:eta", payload);
}

module.exports = { init, emitPosition, emitStopUpdate, emitEtaUpdate };
