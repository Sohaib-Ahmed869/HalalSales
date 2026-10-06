// middleware/serviceAuth.js
//
// Machine-to-machine auth for internal services (the hfs-intelligence AI
// WhatsApp agent). The caller sends `x-api-key`, compared in constant time
// against INTELLIGENCE_SERVICE_KEY. No key configured means the route is off.

const crypto = require("crypto");

const serviceAuth = (req, res, next) => {
  const expected = process.env.INTELLIGENCE_SERVICE_KEY;
  if (!expected) {
    return res
      .status(503)
      .json({ success: false, message: "Service access is not configured" });
  }

  const given = String(req.header("x-api-key") || "");
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  if (!given || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ success: false, message: "Invalid service key" });
  }

  req.serviceClient = "hfs-intelligence";
  next();
};

module.exports = { serviceAuth };
