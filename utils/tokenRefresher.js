// tokenRefresher.js
const axios = require("axios");

let cachedToken = process.env.WHATSAPP_ACCESS_TOKEN;
let tokenExpiry = Date.now() + (55 * 24 * 60 * 60 * 1000); // assume 60 days

const getValidToken = async () => {
    if (Date.now() < tokenExpiry) return cachedToken;

    try {
        const res = await axios.get("https://graph.facebook.com/oauth/access_token", {
            params: {
                grant_type: "fb_exchange_token",
                client_id: process.env.FACEBOOK_APP_ID,
                client_secret: process.env.FACEBOOK_APP_SECRET,
                fb_exchange_token: cachedToken,
            }
        });

        cachedToken = res.data.access_token;
        tokenExpiry = Date.now() + (55 * 24 * 60 * 60 * 1000); // refresh 5 days early
        console.log("[Token] Refreshed successfully");
        return cachedToken;
    } catch (err) {
        console.error("[Token] Refresh failed:", err.message);
        return cachedToken; // use old one, will fail soon
    }
};

module.exports = { getValidToken };