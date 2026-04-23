// whatsappAgentController.js — full replacement
// ─────────────────────────────────────────────────────────────────────────────
// SOCKET.JS PATCH REQUIRED
// Add the following to your socket.js and export it:
//
//   const emitToAgent = (agentId, event, data) =>
//       io.to(agentId.toString()).emit(event, data);
//
//   module.exports = { emitNewMessage, emitMessageStatus, emitToAgent };
//
// Also make sure each connecting socket joins its own agent room:
//   socket.join(decodedUserId.toString());
// ─────────────────────────────────────────────────────────────────────────────

const WhatsAppMessage = require("../models/WhatsAppMessage");
const { getValidToken } = require("../utils/tokenRefresher");
const WhatsAppContact = require("../models/WhatsAppContact");
const Customer = require("../models/Customer");
const Vendor = require("../models/Vendor");
const User = require("../models/User");
const axios = require("axios");
const multer = require("multer");
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { pipeline } = require("stream/promises");
const { v4: uuidv4 } = require("uuid");
const path = require("path");
const os = require("os");
const fs = require("fs");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const { emitNewMessage, emitMessageStatus, emitToAgent } = require("../socket");
const {
    importWhatsAppChatExportFromFile,
    normalizePhone: normalizeImportPhone,
} = require("../services/whatsappExportImportService");
const { resolveWhatsAppS3Bucket, s3Region } = require("../services/whatsappS3Upload");

// Point fluent-ffmpeg at the bundled static binary
if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);

// Convert WebM/other audio to ogg/opus (WhatsApp-accepted voice note format).
// Returns { buffer, mimetype, extension } suitable for upload.
const convertAudioToOggOpus = (inputBuffer, inputMimeType) => {
    return new Promise((resolve, reject) => {
        const tmpIn = path.join(os.tmpdir(), `wa-in-${uuidv4()}`);
        const tmpOut = path.join(os.tmpdir(), `wa-out-${uuidv4()}.ogg`);
        try {
            fs.writeFileSync(tmpIn, inputBuffer);
        } catch (err) {
            return reject(err);
        }

        ffmpeg(tmpIn)
            .audioCodec("libopus")
            .audioChannels(1)         // WhatsApp requires mono
            .audioFrequency(48000)    // opus native
            .audioBitrate("64k")
            .format("ogg")
            .on("error", (err) => {
                try { fs.unlinkSync(tmpIn); } catch (_) {}
                try { fs.unlinkSync(tmpOut); } catch (_) {}
                reject(err);
            })
            .on("end", () => {
                try {
                    const outBuffer = fs.readFileSync(tmpOut);
                    resolve({ buffer: outBuffer, mimetype: "audio/ogg", extension: ".ogg" });
                } catch (err) {
                    reject(err);
                } finally {
                    try { fs.unlinkSync(tmpIn); } catch (_) {}
                    try { fs.unlinkSync(tmpOut); } catch (_) {}
                }
            })
            .save(tmpOut);
    });
};

// ── AWS S3 (same bucket + region as whatsappS3Upload / inbound media) ───────────
const s3 = new S3Client({
    region: s3Region,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || process.env.AWS_SECRET_KEY,
    },
});

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 },
});

const importZipMiddleware = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, os.tmpdir()),
        filename: (req, file, cb) => cb(null, `wa-import-${uuidv4()}.zip`),
    }),
    limits: { fileSize: 350 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const name = (file.originalname || "").toLowerCase();
        const ok =
            name.endsWith(".zip") ||
            file.mimetype === "application/zip" ||
            file.mimetype === "application/x-zip-compressed";
        if (!ok) return cb(new Error("Only .zip WhatsApp exports are allowed"));
        cb(null, true);
    },
}).single("file");

/** Derive S3 object key from our public virtual-hosted URL (for older imports without importMediaS3Key). */
function extractS3KeyFromPublicUrl(url) {
    if (!url || typeof url !== "string") return null;
    try {
        const u = new URL(url);
        if (!String(u.hostname || "").includes("amazonaws.com")) return null;
        return u.pathname.replace(/^\/+/, "") || null;
    } catch {
        return null;
    }
}

/**
 * Agent may read S3 objects under whatsapp-imports/* (ZIP imports) or whatsapp-media/* (uploads / outbound).
 * @returns {{ ok: true, msg, key, bucket }} | {{ ok: false, status: number, error: string }}
 */
async function assertAgentCanAccessMessageMedia(agentId, messageId) {
    const msg = await WhatsAppMessage.findOne({ messageId }).lean();
    if (!msg) return { ok: false, status: 404, error: "Not found" };

    const key =
        msg.metadata?.importMediaS3Key || extractS3KeyFromPublicUrl(msg.content?.mediaUrl);
    if (!key) return { ok: false, status: 404, error: "No media key" };

    const agent = await User.findById(agentId).select("phone").lean();
    const canAccess =
        String(msg.salesAgent) === String(agentId) ||
        msg.salesAgent === null ||
        msg.salesAgent === undefined ||
        (agent?.phone && msg.salesAgentPhone === agent.phone);
    if (!canAccess) return { ok: false, status: 403, error: "Forbidden" };

    const bucket = resolveWhatsAppS3Bucket();
    if (!bucket) return { ok: false, status: 500, error: "S3 not configured" };

    if (key.startsWith("whatsapp-imports/")) {
        const mediaUrl = typeof msg.content?.mediaUrl === "string" ? msg.content.mediaUrl : "";
        const isZipImportMedia =
            msg?.metadata?.importedFromWhatsAppExport === true ||
            (typeof msg.messageId === "string" && msg.messageId.startsWith("wexp_")) ||
            mediaUrl.includes("/whatsapp-imports/");
        if (!isZipImportMedia) return { ok: false, status: 404, error: "Not found" };
    } else if (!key.startsWith("whatsapp-media/")) {
        return { ok: false, status: 404, error: "Not found" };
    }

    return { ok: true, msg, key, bucket };
}

/**
 * Same access rules as streamImportedMedia / signed-url: only whatsapp-imports/* for ZIP-import messages.
 */
async function assertAgentCanAccessImportedMedia(agentId, messageId) {
    const g = await assertAgentCanAccessMessageMedia(agentId, messageId);
    if (!g.ok) return g;
    if (!String(g.key).startsWith("whatsapp-imports/")) {
        return { ok: false, status: 404, error: "Not found" };
    }
    return g;
}

const uploadToS3 = async (file) => {
    const bucket = resolveWhatsAppS3Bucket();
    const ext = path.extname(file.originalname);
    const key = `whatsapp-media/${uuidv4()}${ext}`;
    await s3.send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype,
        ACL: "public-read",
    }));
    return `https://${bucket}.s3.${s3Region}.amazonaws.com/${key}`;
};

const WHATSAPP_API_URL = `https://graph.facebook.com/${process.env.WHATSAPP_API_VERSION}`;

const resolveBusinessTargetForAgent = async (agentId) => {
    if (!agentId) return process.env.WHATSAPP_PHONE_NUMBER_ID || null;
    const agent = await User.findById(agentId).select("whatsappSettings.phoneNumberId").lean();
    return agent?.whatsappSettings?.phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID || null;
};

// ── Agent resolver (used by webhook controller) ───────────────────────────────
const resolveAgentForConversation = async (conversationId) => {
    const sample = await WhatsAppMessage.findOne({
        conversationId,
        salesAgent: { $exists: true, $ne: null },
    }).lean();
    return sample?.salesAgent || null;
};

// ── Claim an unassigned contact when an agent replies ─────────────────────────
// If there's an unassigned contact doc for this phone number, migrate it to the
// claiming agent (or merge with their existing doc). Keeps the (phone, agent)
// unique index intact.
const claimUnassignedContact = async (phoneNumber, agentId) => {
    try {
        const unassigned = await WhatsAppContact.findOne({ phoneNumber, salesAgent: null });
        if (!unassigned) return;

        const existing = await WhatsAppContact.findOne({ phoneNumber, salesAgent: agentId });
        if (existing) {
            // Merge counters + latest inbound timestamp into the agent's own doc, then drop the unassigned one.
            await WhatsAppContact.findByIdAndUpdate(existing._id, {
                $inc: { totalMessages: unassigned.totalMessages || 0 },
                $set: {
                    lastMessageAt: unassigned.lastMessageAt || existing.lastMessageAt,
                    lastInboundMessageAt: unassigned.lastInboundMessageAt || existing.lastInboundMessageAt,
                },
            });
            await WhatsAppContact.deleteOne({ _id: unassigned._id });
        } else {
            await WhatsAppContact.findByIdAndUpdate(unassigned._id, { $set: { salesAgent: agentId } });
        }
    } catch (err) {
        console.warn("[claimUnassignedContact] failed:", err.message);
    }
};

// ── Resolve phone numbers to customer/contact names ──────────────────────────
// Priority: 1) SAP Customer (CardCode + CardName), 2) Vendor, 3) WhatsApp Contact, 4) phone number
const resolveContactNames = async (phoneNumbers, agentId) => {
    const result = {};
    if (!phoneNumbers.length) return result;

    // Normalize: strip leading + and non-digits for flexible matching
    const normalized = phoneNumbers.map(p => p.replace(/\D/g, ""));

    // 1) SAP Customers — highest priority
    const customers = await Customer.find({
        $or: [
            { phoneNumber: { $in: phoneNumbers } },
            { phoneNumber: { $in: normalized } },
            { phoneNumber: { $in: phoneNumbers.map(p => "+" + p.replace(/\D/g, "")) } },
            { additionalPhoneNumbers: { $in: [...phoneNumbers, ...normalized] } },
        ],
    }).select("CardCode CardName phoneNumber additionalPhoneNumbers").lean();

    for (const c of customers) {
        const matchPhones = [c.phoneNumber, ...(c.additionalPhoneNumbers || [])].map(p => (p || "").replace(/\D/g, ""));
        for (const origPhone of phoneNumbers) {
            const digits = origPhone.replace(/\D/g, "");
            if (matchPhones.some(mp => mp && (mp.includes(digits) || digits.includes(mp)))) {
                result[origPhone] = {
                    name: c.CardName,
                    cardCode: c.CardCode,
                    source: "sap_customer",
                };
            }
        }
    }

    // 2) Vendors
    const unresolvedVendor = phoneNumbers.filter(p => !result[p]);
    if (unresolvedVendor.length) {
        const vendorNorms = unresolvedVendor.map(p => p.replace(/\D/g, ""));
        const vendors = await Vendor.find({
            $or: [
                { phone: { $in: [...unresolvedVendor, ...vendorNorms] } },
                { mobile: { $in: [...unresolvedVendor, ...vendorNorms] } },
            ],
        }).select("CardCode CardName phone mobile").lean();

        for (const v of vendors) {
            const vPhones = [v.phone, v.mobile].map(p => (p || "").replace(/\D/g, ""));
            for (const origPhone of unresolvedVendor) {
                const digits = origPhone.replace(/\D/g, "");
                if (vPhones.some(vp => vp && (vp.includes(digits) || digits.includes(vp)))) {
                    result[origPhone] = {
                        name: v.CardName,
                        cardCode: v.CardCode,
                        source: "sap_vendor",
                    };
                }
            }
        }
    }

    // 3) WhatsApp Contacts (saved by agent)
    const unresolvedWa = phoneNumbers.filter(p => !result[p]);
    if (unresolvedWa.length) {
        const filter = { phoneNumber: { $in: unresolvedWa } };
        if (agentId) filter.salesAgent = agentId;
        const contacts = await WhatsAppContact.find(filter).select("phoneNumber name company customerId").lean();
        for (const c of contacts) {
            if (!result[c.phoneNumber]) {
                result[c.phoneNumber] = {
                    name: c.company ? `${c.name} (${c.company})` : c.name,
                    customerId: c.customerId || null,
                    source: "whatsapp_contact",
                };
            }
        }
    }

    // 4) Fill remaining with just phone number
    for (const p of phoneNumbers) {
        if (!result[p]) result[p] = { name: p, source: "unknown" };
    }

    return result;
};

const whatsappAgentController = {

    // ── Upload ────────────────────────────────────────────────────────────────
    uploadMiddleware: upload.single("file"),

    uploadMedia: async (req, res) => {
        try {
            if (!req.file) return res.status(400).json({ error: "No file provided" });

            let fileToUpload = req.file;
            let messageType = "document";
            if (req.file.mimetype.startsWith("image/")) messageType = "image";
            else if (req.file.mimetype.startsWith("video/")) messageType = "video";
            else if (req.file.mimetype.startsWith("audio/")) messageType = "audio";

            // WhatsApp only accepts these audio formats: aac, mp4, mpeg, amr, ogg (opus only)
            // Browser MediaRecorder typically produces webm/opus (Chrome/Edge) which is NOT supported.
            // Auto-convert unsupported audio containers to ogg/opus.
            if (messageType === "audio") {
                const accepted = ["audio/aac", "audio/mp4", "audio/mpeg", "audio/amr", "audio/ogg"];
                const isAccepted = accepted.some(t => req.file.mimetype.toLowerCase().startsWith(t));
                if (!isAccepted) {
                    console.log(`[Upload] Converting ${req.file.mimetype} to audio/ogg (opus) for WhatsApp...`);
                    try {
                        const converted = await convertAudioToOggOpus(req.file.buffer, req.file.mimetype);
                        const origBase = path.basename(req.file.originalname, path.extname(req.file.originalname)) || "voice";
                        fileToUpload = {
                            ...req.file,
                            buffer: converted.buffer,
                            mimetype: converted.mimetype,
                            originalname: `${origBase}${converted.extension}`,
                            size: converted.buffer.length,
                        };
                        console.log(`[Upload] Audio conversion complete. New size: ${converted.buffer.length} bytes`);
                    } catch (err) {
                        console.error("[Upload] Audio conversion failed:", err.message);
                        return res.status(500).json({ error: "Audio conversion failed", details: err.message });
                    }
                }
            }

            const url = await uploadToS3(fileToUpload);
            return res.status(200).json({
                success: true, url, messageType,
                filename: fileToUpload.originalname,
                mimetype: fileToUpload.mimetype,
                size: fileToUpload.size,
            });
        } catch (error) {
            console.error("S3 upload error:", error);
            return res.status(500).json({ error: "Upload failed", details: error.message });
        }
    },

    importZipMiddleware,

    importChatExport: async (req, res) => {
        const cleanupFile = () => {
            try {
                if (req.file?.path) fs.unlinkSync(req.file.path);
            } catch (_) {}
        };
        try {
            const agentId = req.user.id;
            if (!req.file?.path) {
                cleanupFile();
                return res.status(400).json({ error: "ZIP file is required (field name: file)" });
            }

            const phoneNumber = req.body.phoneNumber;
            const myDisplayName = req.body.myDisplayName;
            const contactName = req.body.contactName;

            if (!phoneNumber || !String(phoneNumber).trim()) {
                cleanupFile();
                return res.status(400).json({ error: "phoneNumber is required (customer E.164)" });
            }
            if (!myDisplayName || !String(myDisplayName).trim()) {
                cleanupFile();
                return res.status(400).json({ error: "myDisplayName is required (your name exactly as in the export)" });
            }

            const agent = await User.findById(agentId).select("phone whatsappSettings").lean();
            if (!agent?.whatsappSettings?.enabled) {
                cleanupFile();
                return res.status(403).json({ error: "WhatsApp not enabled" });
            }
            const phoneNumberId =
                agent.whatsappSettings?.phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID;
            if (!phoneNumberId) {
                cleanupFile();
                return res.status(400).json({ error: "WhatsApp phone number ID is not configured" });
            }

            const normPhone = normalizeImportPhone(phoneNumber);
            if (!normPhone) {
                cleanupFile();
                return res.status(400).json({ error: "Invalid phone number" });
            }

            const importBatchId = uuidv4();
            const result = await importWhatsAppChatExportFromFile(req.file.path, {
                phoneNumber: normPhone,
                myDisplayName: String(myDisplayName).trim(),
                phoneNumberId: String(phoneNumberId),
                salesAgentId: agentId,
                salesAgentPhone: agent.phone || null,
                exportFileName: req.file.originalname || null,
                importBatchId,
            });

            // Do not overwrite an existing saved contact name on import unless the user
            // explicitly passes contactName. New contacts still get a name from the export title or phone.
            const trimmedContactName = contactName && String(contactName).trim();
            const update = {
                $set: { lastMessageAt: new Date() },
                $inc: { totalMessages: result.inserted },
            };
            if (trimmedContactName) {
                update.$set.name = trimmedContactName;
            } else {
                update.$setOnInsert = {
                    name: result.parsedChatTitle || normPhone,
                };
            }

            await WhatsAppContact.findOneAndUpdate(
                { phoneNumber: normPhone, salesAgent: agentId },
                update,
                { upsert: true, setDefaultsOnInsert: true }
            );

            cleanupFile();
            return res.status(200).json({ success: true, data: result });
        } catch (error) {
            cleanupFile();
            if (error.code === "group_chat_not_supported") {
                return res.status(400).json({
                    error: "group_chat_not_supported",
                    message: error.message || "Group chat exports are not supported",
                });
            }
            console.error("importChatExport error:", error);
            return res.status(500).json({
                error: "Import failed",
                details: error.message || String(error),
            });
        }
    },

    // ── Settings ──────────────────────────────────────────────────────────────
    getAgentSettings: async (req, res) => {
        try {
            const agent = await User.findById(req.user.id).select("whatsappSettings phone firstName lastName");
            if (!agent) return res.status(404).json({ error: "Agent not found" });
            return res.status(200).json({ success: true, data: agent });
        } catch (error) {
            return res.status(500).json({ error: "Error fetching settings", details: error.message });
        }
    },

    updateAgentSettings: async (req, res) => {
        try {
            const { agentId } = req.params;
            const { enabled, phoneNumberId, businessAccountId, verifiedName } = req.body;
            const agent = await User.findById(agentId);
            if (!agent) return res.status(404).json({ error: "Agent not found" });
            agent.whatsappSettings = { ...agent.whatsappSettings, enabled, phoneNumberId, businessAccountId, verifiedName };
            await agent.save();
            return res.status(200).json({ success: true, data: agent.whatsappSettings });
        } catch (error) {
            return res.status(500).json({ error: "Error updating settings", details: error.message });
        }
    },

    // ── Contacts ──────────────────────────────────────────────────────────────
    // Visibility rule: an agent sees their OWN contacts plus any UNASSIGNED contact
    // (salesAgent === null). Unassigned contacts are claimed on reply.
    getContacts: async (req, res) => {
        try {
            const agentId = req.user.id;
            const { search, tags, isFavorite, isCustomer, page = 1, limit = 50 } = req.query;
            const filter = {
                isBlocked: false,
                $or: [{ salesAgent: agentId }, { salesAgent: null }],
            };
            if (search) filter.$and = [{
                $or: [
                    { name: new RegExp(search, "i") },
                    { phoneNumber: new RegExp(search, "i") },
                    { company: new RegExp(search, "i") },
                ],
            }];
            if (tags) filter.tags = { $in: tags.split(",") };
            if (isFavorite !== undefined) filter.isFavorite = isFavorite === "true";
            if (isCustomer !== undefined) filter.isCustomer = isCustomer === "true";
            const skip = (page - 1) * limit;
            const contacts = await WhatsAppContact.find(filter)
                .sort({ lastMessageAt: -1, createdAt: -1 })
                .skip(skip).limit(parseInt(limit)).lean();
            const total = await WhatsAppContact.countDocuments(filter);
            const contactsWithUnread = await Promise.all(contacts.map(async (c) => {
                const unreadFilter = {
                    from: c.phoneNumber, direction: "inbound", status: { $ne: "read" },
                };
                if (c.salesAgent) unreadFilter.salesAgent = c.salesAgent;
                else unreadFilter.$or = [{ salesAgent: null }, { salesAgent: { $exists: false } }];
                return {
                    ...c,
                    isUnassigned: !c.salesAgent,
                    unreadCount: await WhatsAppMessage.countDocuments(unreadFilter),
                };
            }));
            return res.status(200).json({
                success: true, data: contactsWithUnread,
                pagination: { total, page: parseInt(page), limit: parseInt(limit), pages: Math.ceil(total / limit) },
            });
        } catch (error) {
            return res.status(500).json({ error: "Error fetching contacts", details: error.message });
        }
    },

    saveContact: async (req, res) => {
        try {
            const agentId = req.user.id;
            const { phoneNumber, name, company, email, tags, notes, isFavorite } = req.body;
            if (!phoneNumber || !name) return res.status(400).json({ error: "Phone number and name are required" });
            const contact = await WhatsAppContact.findOneAndUpdate(
                { phoneNumber, salesAgent: agentId },
                { name, company, email, tags: tags || [], notes, isFavorite: isFavorite || false },
                { upsert: true, new: true }
            );
            return res.status(200).json({ success: true, data: contact });
        } catch (error) {
            return res.status(500).json({ error: "Error saving contact", details: error.message });
        }
    },

    deleteContact: async (req, res) => {
        try {
            await WhatsAppContact.findOneAndDelete({ _id: req.params.contactId, salesAgent: req.user.id });
            return res.status(200).json({ success: true });
        } catch (error) {
            return res.status(500).json({ error: "Error deleting contact", details: error.message });
        }
    },

    // ── Conversations ─────────────────────────────────────────────────────────
    // Include messages that belong to this agent OR are unassigned (no agent match yet).
    getAgentConversations: async (req, res) => {
        try {
            const agentId = req.user.id;
            const { page = 1, limit = 20, unreadOnly } = req.query;
            const agent = await User.findById(agentId).select("phone whatsappSettings");
            if (!agent?.whatsappSettings?.enabled) return res.status(403).json({ error: "WhatsApp not enabled" });
            const matchFilter = {
                $or: [
                    { salesAgent: require("mongoose").Types.ObjectId.isValid(agentId) ? new (require("mongoose").Types.ObjectId)(agentId) : agentId },
                    { salesAgentPhone: agent.phone },
                    { salesAgent: null },
                    { salesAgent: { $exists: false } },
                ],
            };
            if (unreadOnly === "true") { matchFilter.direction = "inbound"; matchFilter.status = { $ne: "read" }; }
            const skip = (parseInt(page) - 1) * parseInt(limit);
            const conversations = await WhatsAppMessage.aggregate([
                { $match: matchFilter },
                { $sort: { timestamp: -1 } },
                {
                    $group: {
                        _id: "$conversationId",
                        lastMessage: { $first: "$$ROOT" },
                        unreadCount: { $sum: { $cond: [{ $and: [{ $eq: ["$direction", "inbound"] }, { $ne: ["$status", "read"] }] }, 1, 0] } },
                        totalMessages: { $sum: 1 },
                        lastInboundAt: { $max: { $cond: [{ $eq: ["$direction", "inbound"] }, "$timestamp", null] } },
                        hasAssignedAgent: { $max: { $cond: [{ $eq: ["$salesAgent", agentId] }, 1, 0] } },
                    },
                },
                { $sort: { "lastMessage.timestamp": -1 } },
                { $skip: skip },
                { $limit: parseInt(limit) },
            ]);
            const conversationsWithContacts = await Promise.all(conversations.map(async (conv) => {
                // Prefer the agent-owned contact record; fall back to the unassigned one
                let contact = await WhatsAppContact.findOne({ phoneNumber: conv._id, salesAgent: agentId }).lean();
                if (!contact) contact = await WhatsAppContact.findOne({ phoneNumber: conv._id, salesAgent: null }).lean();
                const isUnassigned = !contact?.salesAgent;
                const windowExpired = conv.lastInboundAt
                    ? (Date.now() - new Date(conv.lastInboundAt).getTime()) > 24 * 60 * 60 * 1000
                    : true;
                return {
                    ...conv,
                    isUnassigned,
                    windowExpired,
                    contact: contact || {
                        phoneNumber: conv._id,
                        name: conv.lastMessage.metadata?.profileName || conv._id,
                        isUnassigned: true,
                    },
                };
            }));
            const total = await WhatsAppMessage.distinct("conversationId", matchFilter).then(ids => ids.length);
            return res.status(200).json({
                success: true, data: conversationsWithContacts,
                pagination: { total, page: parseInt(page), limit: parseInt(limit), pages: Math.ceil(total / parseInt(limit)) },
            });
        } catch (error) {
            return res.status(500).json({ error: "Error fetching conversations", details: error.message });
        }
    },

    getConversationMessages: async (req, res) => {
        try {
            const agentId = req.user.id;
            const { phoneNumber } = req.params;
            const { page = 1, limit = 50 } = req.query;
            const skip = (parseInt(page) - 1) * parseInt(limit);
            const messages = await WhatsAppMessage.find({
                conversationId: phoneNumber,
                $or: [{ salesAgent: agentId }, { salesAgent: { $exists: false } }, { salesAgent: null }],
            }).sort({ timestamp: -1 }).skip(skip).limit(parseInt(limit)).lean();
            const total = await WhatsAppMessage.countDocuments({ conversationId: phoneNumber });
            // Try agent-owned contact first, then unassigned
            let contact = await WhatsAppContact.findOne({ phoneNumber, salesAgent: agentId }).lean();
            if (!contact) contact = await WhatsAppContact.findOne({ phoneNumber, salesAgent: null }).lean();

            // Compute 24h window status from last INBOUND message
            const lastInbound = await WhatsAppMessage.findOne({
                conversationId: phoneNumber,
                direction: "inbound",
            }).sort({ timestamp: -1 }).select("timestamp").lean();
            const lastInboundAt = lastInbound?.timestamp || contact?.lastInboundMessageAt || null;
            const windowExpired = lastInboundAt
                ? (Date.now() - new Date(lastInboundAt).getTime()) > 24 * 60 * 60 * 1000
                : true;

            return res.status(200).json({
                success: true,
                data: messages.reverse(),
                contact: contact || { phoneNumber, name: messages[0]?.metadata?.profileName || "Unknown", isUnassigned: true },
                isUnassigned: !contact?.salesAgent,
                windowExpired,
                lastInboundAt,
                pagination: { total, page: parseInt(page), limit: parseInt(limit), pages: Math.ceil(total / parseInt(limit)) },
            });
        } catch (error) {
            return res.status(500).json({ error: "Error fetching messages", details: error.message });
        }
    },

    /**
     * Short-lived presigned GET for imported ZIP media so the browser can stream video (range requests).
     * Avoids downloading the whole file into Node or the SPA as one blob (which could take minutes).
     */
    getImportedMediaSignedUrl: async (req, res) => {
        try {
            const gate = await assertAgentCanAccessImportedMedia(req.user.id, req.params.messageId);
            if (!gate.ok) return res.status(gate.status).json({ error: gate.error });

            const getParams = { Bucket: gate.bucket, Key: gate.key };
            const mime = gate.msg.content?.mimeType;
            if (mime) getParams.ResponseContentType = mime;
            const cmd = new GetObjectCommand(getParams);
            const url = await getSignedUrl(s3, cmd, { expiresIn: 3600 });
            return res.status(200).json({ success: true, url, expiresIn: 3600 });
        } catch (error) {
            return res.status(500).json({ error: "Could not create media URL", details: error.message || String(error) });
        }
    },

    /**
     * Stream imported-chat media through the API (fallback). Prefer signed-url from the client for large video.
     */
    streamImportedMedia: async (req, res) => {
        try {
            const gate = await assertAgentCanAccessImportedMedia(req.user.id, req.params.messageId);
            if (!gate.ok) return res.status(gate.status).json({ error: gate.error });

            const { msg, key, bucket } = gate;
            const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
            const ct = out.ContentType || msg.content?.mimeType || "application/octet-stream";
            res.setHeader("Content-Type", ct);
            res.setHeader("Cache-Control", "private, max-age=300");
            if (out.ContentLength != null) res.setHeader("Content-Length", String(out.ContentLength));

            await pipeline(out.Body, res);
        } catch (error) {
            if (!res.headersSent) {
                return res.status(500).json({ error: "Media stream failed", details: error.message || String(error) });
            }
        }
    },

    /**
     * Same-origin CSV/text preview for the web app (avoids S3 CORS blocking fetch() from the browser).
     */
    getMessageTextPreview: async (req, res) => {
        try {
            const gate = await assertAgentCanAccessMessageMedia(req.user.id, req.params.messageId);
            if (!gate.ok) return res.status(gate.status).json({ error: gate.error });

            const { msg, key, bucket } = gate;
            const mime = String(msg.content?.mimeType || "").toLowerCase();
            const fname = String(msg.content?.filename || "").toLowerCase();
            const isCsv =
                mime.includes("csv") || fname.endsWith(".csv") || mime === "text/csv";
            const isTxt = mime.includes("text/plain") || fname.endsWith(".txt");
            if (!isCsv && !isTxt) {
                return res.status(400).json({ error: "Preview only supports CSV and plain text files" });
            }

            const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
            const chunks = [];
            for await (const chunk of out.Body) chunks.push(chunk);
            const buf = Buffer.concat(chunks);
            const maxLen = 85_000;
            const sliced = buf.slice(0, maxLen);
            const preview = sliced.toString("utf8");
            const truncated = buf.length > maxLen;
            return res.status(200).json({ success: true, preview, truncated });
        } catch (error) {
            return res.status(500).json({ error: "Could not read preview", details: error.message || String(error) });
        }
    },

    // ── Send message ──────────────────────────────────────────────────────────
    sendMessage: async (req, res) => {
        try {
            const agentId = req.user.id;
            const { to, message, messageType = "text", mediaUrl, filename, replyToMessageId } = req.body;
            if (!to) return res.status(400).json({ error: "Recipient is required" });
            const agent = await User.findById(agentId).select("whatsappSettings phone firstName lastName");
            if (!agent?.whatsappSettings?.enabled) return res.status(403).json({ error: "WhatsApp not enabled" });
            const phoneNumberId = agent.whatsappSettings.phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID;

            // ── 24-hour customer-service-window pre-check ─────────────────────
            // Meta only allows free-form messages within 24h of the last inbound message.
            // If the window has expired, tell the frontend to send a template instead.
            const lastInbound = await WhatsAppMessage.findOne({
                conversationId: to, direction: "inbound",
            }).sort({ timestamp: -1 }).select("timestamp").lean();
            const windowExpired = lastInbound
                ? (Date.now() - new Date(lastInbound.timestamp).getTime()) > 24 * 60 * 60 * 1000
                : true;
            if (windowExpired) {
                return res.status(409).json({
                    error: "re_engagement_required",
                    code: "WINDOW_EXPIRED",
                    message: "The 24-hour window has expired. Send an approved template to re-engage this customer.",
                    windowExpired: true,
                    lastInboundAt: lastInbound?.timestamp || null,
                });
            }

            let payload = { messaging_product: "whatsapp", recipient_type: "individual", to };
            if (messageType === "text") {
                if (!message) return res.status(400).json({ error: "Message text required" });
                payload.type = "text";
                payload.text = { preview_url: true, body: message };
            } else if (["image", "video", "audio", "document"].includes(messageType)) {
                if (!mediaUrl) return res.status(400).json({ error: "mediaUrl required for media messages" });
                payload.type = messageType;
                payload[messageType] = { link: mediaUrl };
                if (message) payload[messageType].caption = message;
                if (filename && messageType === "document") payload[messageType].filename = filename;
            }
            if (replyToMessageId) payload.context = { message_id: replyToMessageId };
            const response = await axios.post(`${WHATSAPP_API_URL}/${phoneNumberId}/messages`, payload, {
                headers: { Authorization: `Bearer ${await getValidToken()}`, "Content-Type": "application/json" },
            });
            let outboundContent =
                messageType === "text" ? { text: message } : { mediaUrl, caption: message, filename };
            if (messageType === "document" && filename) {
                const ext = path.extname(filename).replace(/^\./, "").toLowerCase();
                const docMime = {
                    pdf: "application/pdf",
                    csv: "text/csv",
                    doc: "application/msword",
                    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                    xls: "application/vnd.ms-excel",
                    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    ppt: "application/vnd.ms-powerpoint",
                    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
                    txt: "text/plain",
                    zip: "application/zip",
                };
                outboundContent = {
                    ...outboundContent,
                    mimeType: docMime[ext] || "application/octet-stream",
                };
            }

            const newMessage = new WhatsAppMessage({
                messageId: response.data.messages[0].id,
                conversationId: to,
                from: phoneNumberId,
                to,
                direction: "outbound",
                messageType,
                content: outboundContent,
                status: "sent",
                salesAgent: agentId,
                salesAgentPhone: agent.phone,
                metadata: { context: replyToMessageId ? { messageId: replyToMessageId } : null },
            });
            await newMessage.save();
            await User.findByIdAndUpdate(agentId, {
                $inc: { "whatsappSettings.totalMessagesSent": 1 },
                $set: { "whatsappSettings.lastMessageAt": new Date() },
            });

            // ── Claim the contact: migrate the unassigned record to this agent ────
            await claimUnassignedContact(to, agentId);

            await WhatsAppContact.findOneAndUpdate(
                { phoneNumber: to, salesAgent: agentId },
                { $inc: { totalMessages: 1 }, $set: { lastMessageAt: new Date() } },
                { upsert: true, setDefaultsOnInsert: true }
            );

            // Also backfill the salesAgent on historical unassigned messages
            await WhatsAppMessage.updateMany(
                { conversationId: to, $or: [{ salesAgent: null }, { salesAgent: { $exists: false } }] },
                { $set: { salesAgent: agentId, salesAgentPhone: agent.phone } }
            );

            return res.status(200).json({ success: true, messageId: response.data.messages[0].id, data: newMessage });
        } catch (error) {
            console.error("Send message error:", error.response?.data || error.message);
            return res.status(500).json({ error: "Error sending message", details: error.response?.data || error.message });
        }
    },

    // ── Approved WhatsApp templates ───────────────────────────────────────────
    // GET /templates?status=APPROVED — returns Meta-approved templates for this business
    listTemplates: async (req, res) => {
        try {
            const agentId = req.user.id;
            const agent = await User.findById(agentId).select("whatsappSettings");
            if (!agent?.whatsappSettings?.enabled) return res.status(403).json({ error: "WhatsApp not enabled" });
            const wabaId = agent.whatsappSettings.businessAccountId || process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
            if (!wabaId) return res.status(400).json({ error: "WhatsApp Business Account ID not configured" });

            const status = req.query.status || "APPROVED";
            const url = `${WHATSAPP_API_URL}/${wabaId}/message_templates?status=${encodeURIComponent(status)}&limit=100`;
            const response = await axios.get(url, {
                headers: { Authorization: `Bearer ${await getValidToken()}` },
            });
            return res.status(200).json({ success: true, data: response.data.data || [] });
        } catch (error) {
            console.error("[Templates] Error:", error.response?.data || error.message);
            return res.status(500).json({
                error: "Error fetching templates",
                details: error.response?.data || error.message,
            });
        }
    },

    // POST /messages/send-template   { to, templateName, languageCode, components }
    // Templates can be sent regardless of the 24h window (re-engagement).
    sendTemplateMessage: async (req, res) => {
        try {
            const agentId = req.user.id;
            const { to, templateName, languageCode = "en_US", components } = req.body;
            if (!to || !templateName) return res.status(400).json({ error: "Recipient and templateName required" });
            const agent = await User.findById(agentId).select("whatsappSettings phone");
            if (!agent?.whatsappSettings?.enabled) return res.status(403).json({ error: "WhatsApp not enabled" });
            const phoneNumberId = agent.whatsappSettings.phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID;

            const payload = {
                messaging_product: "whatsapp",
                recipient_type: "individual",
                to,
                type: "template",
                template: { name: templateName, language: { code: languageCode } },
            };
            if (components) payload.template.components = components;

            const response = await axios.post(
                `${WHATSAPP_API_URL}/${phoneNumberId}/messages`,
                payload,
                { headers: { Authorization: `Bearer ${await getValidToken()}`, "Content-Type": "application/json" } }
            );

            const newMessage = new WhatsAppMessage({
                messageId: response.data.messages[0].id,
                conversationId: to,
                from: phoneNumberId,
                to,
                direction: "outbound",
                messageType: "template",
                content: { template: { name: templateName, language: languageCode, components } },
                status: "sent",
                salesAgent: agentId,
                salesAgentPhone: agent.phone,
            });
            await newMessage.save();

            await claimUnassignedContact(to, agentId);
            await WhatsAppContact.findOneAndUpdate(
                { phoneNumber: to, salesAgent: agentId },
                { $inc: { totalMessages: 1 }, $set: { lastMessageAt: new Date() } },
                { upsert: true, setDefaultsOnInsert: true }
            );

            return res.status(200).json({ success: true, messageId: response.data.messages[0].id, data: newMessage });
        } catch (error) {
            console.error("[SendTemplate] Error:", error.response?.data || error.message);
            return res.status(500).json({
                error: "Error sending template",
                details: error.response?.data || error.message,
            });
        }
    },

    // ── Mark as read ──────────────────────────────────────────────────────────
    markAsRead: async (req, res) => {
        try {
            const agentId = req.user.id;
            const { messageId, phoneNumber } = req.body;
            const agent = await User.findById(agentId).select("whatsappSettings");
            if (!agent?.whatsappSettings?.enabled) return res.status(403).json({ error: "WhatsApp not enabled" });
            const phoneNumberId = agent.whatsappSettings.phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID;

            // Match messages owned by this agent OR still unassigned (salesAgent null/missing).
            // Needed because an inbound may arrive unassigned, be read by the agent, and then
            // get salesAgent backfilled when the agent replies — without this broader match the
            // read state would be lost and the conversation would reappear as "unread".
            const agentOrUnassigned = [
                { salesAgent: agentId },
                { salesAgent: null },
                { salesAgent: { $exists: false } },
            ];

            if (messageId) {
                await axios.post(`${WHATSAPP_API_URL}/${phoneNumberId}/messages`,
                    { messaging_product: "whatsapp", status: "read", message_id: messageId },
                    { headers: { Authorization: `Bearer ${await getValidToken()}`, "Content-Type": "application/json" } }
                );
                await WhatsAppMessage.findOneAndUpdate(
                    { messageId, $or: agentOrUnassigned },
                    { status: "read" }
                );
            } else if (phoneNumber) {
                await WhatsAppMessage.updateMany(
                    {
                        conversationId: phoneNumber,
                        direction: "inbound",
                        status: { $ne: "read" },
                        $or: agentOrUnassigned,
                    },
                    { status: "read" }
                );
            }
            return res.status(200).json({ success: true });
        } catch (error) {
            return res.status(500).json({ error: "Error marking as read", details: error.message });
        }
    },

    // ── Stats ─────────────────────────────────────────────────────────────────
    getAgentStats: async (req, res) => {
        try {
            const agentId = req.user.id;
            const { startDate, endDate } = req.query;
            const dateFilter = {};
            if (startDate && endDate) dateFilter.timestamp = { $gte: new Date(startDate), $lte: new Date(endDate) };

            // Message stats
            const [msgStats] = await WhatsAppMessage.aggregate([
                { $match: { salesAgent: agentId, messageType: { $ne: "call" }, ...dateFilter } },
                {
                    $group: {
                        _id: null,
                        totalMessages: { $sum: 1 },
                        sentMessages: { $sum: { $cond: [{ $eq: ["$direction", "outbound"] }, 1, 0] } },
                        receivedMessages: { $sum: { $cond: [{ $eq: ["$direction", "inbound"] }, 1, 0] } },
                        unreadMessages: { $sum: { $cond: [{ $and: [{ $eq: ["$direction", "inbound"] }, { $ne: ["$status", "read"] }] }, 1, 0] } },
                    },
                },
            ]);

            // Call stats
            const [callStats] = await WhatsAppMessage.aggregate([
                { $match: { salesAgent: agentId, messageType: "call", ...dateFilter } },
                {
                    $group: {
                        _id: null,
                        totalCalls: { $sum: 1 },
                        outboundCalls: { $sum: { $cond: [{ $eq: ["$content.callDirection", "outbound"] }, 1, 0] } },
                        inboundCalls: { $sum: { $cond: [{ $eq: ["$content.callDirection", "inbound"] }, 1, 0] } },
                        answeredCalls: { $sum: { $cond: [{ $in: ["$content.callStatus", ["ended", "active"]] }, 1, 0] } },
                        missedCalls: { $sum: { $cond: [{ $eq: ["$content.callStatus", "missed"] }, 1, 0] } },
                        failedCalls: { $sum: { $cond: [{ $eq: ["$content.callStatus", "failed"] }, 1, 0] } },
                        totalDuration: { $sum: { $ifNull: ["$content.duration", 0] } },
                        avgDuration: { $avg: { $cond: [{ $gt: ["$content.duration", 0] }, "$content.duration", null] } },
                        longestCall: { $max: "$content.duration" },
                    },
                },
            ]);

            const totalContacts = await WhatsAppContact.countDocuments({ salesAgent: agentId });
            const activeConversations = await WhatsAppMessage.distinct("conversationId", {
                salesAgent: agentId,
                timestamp: { $gte: new Date(Date.now() - 86400000) },
            }).then(ids => ids.length);

            const defaultCallStats = {
                totalCalls: 0, outboundCalls: 0, inboundCalls: 0,
                answeredCalls: 0, missedCalls: 0, failedCalls: 0,
                totalDuration: 0, avgDuration: 0, longestCall: 0,
            };

            return res.status(200).json({
                success: true,
                data: {
                    ...(msgStats || { totalMessages: 0, sentMessages: 0, receivedMessages: 0, unreadMessages: 0 }),
                    totalContacts,
                    activeConversations,
                    callStats: {
                        ...(callStats ? { ...defaultCallStats, ...callStats, _id: undefined } : defaultCallStats),
                        answerRate: callStats?.totalCalls > 0
                            ? Math.round((callStats.answeredCalls / callStats.totalCalls) * 100)
                            : 0,
                    },
                },
            });
        } catch (error) {
            return res.status(500).json({ error: "Error fetching stats", details: error.message });
        }
    },

    // ══════════════════════════════════════════════════════════════════════════
    // CALLING API — Meta WhatsApp Business Calling API + WebRTC
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * Step 1 (outbound): Send a call permission template to the customer.
     * Meta requires explicit consent before a business can call a user.
     * The customer's acceptance fires a 'call_permission_granted' webhook action.
     *
     * POST /calls/permission   { to }
     */
    requestCallPermission: async (req, res) => {
        try {
            const agentId = req.user.id;
            const { to } = req.body;
            if (!to) return res.status(400).json({ error: "Recipient required" });
            const agent = await User.findById(agentId).select("whatsappSettings");
            if (!agent?.whatsappSettings?.enabled) return res.status(403).json({ error: "WhatsApp not enabled" });
            const phoneNumberId = agent.whatsappSettings.phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID;

            // Send the pre-approved call permission template
            const templateName = process.env.WHATSAPP_CALL_PERMISSION_TEMPLATE || "call_perm";
            const token = await getValidToken();
            console.log(`[CallPermission] Sending template "${templateName}" to ${to} via phoneNumberId ${phoneNumberId}`);

            const response = await axios.post(
                `${WHATSAPP_API_URL}/${phoneNumberId}/messages`,
                {
                    messaging_product: "whatsapp",
                    recipient_type: "individual",
                    to,
                    type: "template",
                    template: {
                        name: templateName,
                        language: { code: process.env.WHATSAPP_CALL_PERMISSION_LANG || "en_US" },
                        components: [{
                            type: "button",
                            sub_type: "voice_call",
                            index: "0",
                            parameters: [{
                                type: "payload",
                                payload: "CALL_PERMISSION"
                            }],
                        }],
                    },
                },
                { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }
            );

            // Log as a call-type message in the conversation thread
            const msg = new WhatsAppMessage({
                messageId: response.data.messages[0].id,
                conversationId: to,
                from: phoneNumberId,
                to,
                direction: "outbound",
                messageType: "call",
                content: {
                    callStatus: "permission_sent",
                    callDirection: "outbound",
                    text: "Call permission requested — waiting for customer to accept.",
                },
                status: "sent",
                salesAgent: agentId,
            });
            await msg.save();

            return res.status(200).json({ success: true, messageId: response.data.messages[0].id, data: msg });
        } catch (error) {
            console.error("[CallPermission] Error:", JSON.stringify(error.response?.data || error.message, null, 2));
            return res.status(500).json({ error: "Error requesting call permission", details: error.response?.data || error.message });
        }
    },

    /**
     * Step 2 (outbound): After permission is granted, the frontend creates a
     * WebRTC SDP offer and posts it here. We forward to Meta's Calling API.
     * Meta returns a call_id; the SDP answer arrives via webhook → processCallWebhook.
     *
     * POST /calls/initiate   { to, sdpOffer }
     */
    initiateCall: async (req, res) => {
        try {
            const agentId = req.user.id;
            const { to, sdpOffer } = req.body;
            if (!to || !sdpOffer) return res.status(400).json({ error: "Recipient and SDP offer required" });
            const agent = await User.findById(agentId).select("whatsappSettings");
            if (!agent?.whatsappSettings?.enabled) return res.status(403).json({ error: "WhatsApp not enabled" });
            const phoneNumberId = agent.whatsappSettings.phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID;

            console.log(`[InitiateCall] Calling ${to} via phoneNumberId ${phoneNumberId}`);
            const response = await axios.post(
                `${WHATSAPP_API_URL}/${phoneNumberId}/calls`,
                {
                    messaging_product: "whatsapp",
                    to,
                    action: "connect",
                    session: { sdp_type: "offer", sdp: sdpOffer },
                },
                { headers: { Authorization: `Bearer ${await getValidToken()}`, "Content-Type": "application/json" } }
            );

            console.log("[InitiateCall] Meta response:", JSON.stringify(response.data, null, 2));
            const callId = response.data.calls?.[0]?.id || response.data.call_id || response.data.id || `call_${Date.now()}`;

            // Log call initiation in thread
            const msg = new WhatsAppMessage({
                messageId: callId,
                conversationId: to,
                from: phoneNumberId,
                to,
                direction: "outbound",
                messageType: "call",
                content: { callId, callStatus: "connecting", callDirection: "outbound" },
                status: "sent",
                salesAgent: agentId,
            });
            await msg.save();

            return res.status(200).json({ success: true, callId, data: msg });
        } catch (error) {
            console.error("[InitiateCall] Error:", JSON.stringify(error.response?.data || error.message, null, 2));
            return res.status(500).json({ error: "Error initiating call", details: error.response?.data || error.message });
        }
    },

    /**
     * Handle a call action: accept (inbound with SDP answer) | reject | terminate.
     *
     * POST /calls/action   { callId, action, sdpAnswer? }
     *   action: "accept" | "reject" | "terminate"
     */
    handleCallAction: async (req, res) => {
        try {
            const agentId = req.user.id;
            const { callId, action, sdpAnswer } = req.body;
            if (!callId || !action) return res.status(400).json({ error: "callId and action required" });
            const agent = await User.findById(agentId).select("whatsappSettings");
            const phoneNumberId = agent.whatsappSettings.phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID;

            let payload;
            if (action === "accept") {
                payload = {
                    messaging_product: "whatsapp",
                    action: "connect",
                    session: { sdp_type: "answer", sdp: sdpAnswer },
                };
            } else {
                // reject or terminate
                payload = { messaging_product: "whatsapp", action: "disconnect" };
            }

            await axios.post(
                `${WHATSAPP_API_URL}/${phoneNumberId}/calls/${callId}`,
                payload,
                { headers: { Authorization: `Bearer ${await getValidToken()}`, "Content-Type": "application/json" } }
            );

            const statusMap = { accept: "active", reject: "missed", terminate: "ended" };
            const update = { "content.callStatus": statusMap[action] || action };
            if (action === "accept") update["content.startedAt"] = new Date();
            if (action === "terminate" || action === "reject") update["content.endedAt"] = new Date();

            await WhatsAppMessage.findOneAndUpdate({ messageId: callId }, update);

            return res.status(200).json({ success: true });
        } catch (error) {
            return res.status(500).json({ error: "Error handling call action", details: error.response?.data || error.message });
        }
    },

    /**
     * GET /calls/logs?phoneNumber=&page=
     * Returns call-type messages for a conversation (or all conversations).
     */
    /**
     * GET /calls/:callId/status — poll for call status + SDP answer (fallback if socket misses it)
     */
    getCallStatus: async (req, res) => {
        try {
            const { callId } = req.params;
            const msg = await WhatsAppMessage.findOne({ messageId: callId }).lean();
            if (!msg) return res.status(404).json({ error: "Call not found" });
            return res.status(200).json({
                success: true,
                callId,
                status: msg.content?.callStatus,
                sdpAnswer: msg.content?.sdpAnswer || null,
            });
        } catch (error) {
            return res.status(500).json({ error: "Error fetching call status", details: error.message });
        }
    },

    getCallLogs: async (req, res) => {
        try {
            const agentId = req.user.id;
            const { phoneNumber, page = 1, limit = 20 } = req.query;
            const filter = { salesAgent: agentId, messageType: "call" };
            if (phoneNumber) filter.conversationId = phoneNumber;
            const logs = await WhatsAppMessage.find(filter)
                .sort({ timestamp: -1 })
                .skip((parseInt(page) - 1) * parseInt(limit))
                .limit(parseInt(limit))
                .lean();
            const total = await WhatsAppMessage.countDocuments(filter);

            // Resolve contact/customer names for each call log
            const phoneNumbers = [...new Set(logs.map(l => l.conversationId || l.to || l.from).filter(Boolean))];
            const contactMap = await resolveContactNames(phoneNumbers, agentId);

            const enrichedLogs = logs.map(log => {
                const phone = log.conversationId || log.to || log.from;
                return { ...log, contactInfo: contactMap[phone] || { name: phone, source: "unknown" } };
            });

            return res.status(200).json({
                success: true, data: enrichedLogs,
                pagination: { total, page: parseInt(page), limit: parseInt(limit), pages: Math.ceil(total / parseInt(limit)) },
            });
        } catch (error) {
            return res.status(500).json({ error: "Error fetching call logs", details: error.message });
        }
    },
};

// ── Webhook call processor ────────────────────────────────────────────────────
// Call this from your webhook controller whenever value.calls is present:
//
//   if (value.calls) {
//     for (const callEvent of value.calls) {
//       const agentId = await resolveAgentForConversation(callEvent.from);
//       if (agentId) await processCallWebhook(callEvent, agentId.toString());
//     }
//   }
// ─────────────────────────────────────────────────────────────────────────────
const processCallWebhook = async (callEvent, agentId) => {
    try {
        console.log("[CallWebhook] Received event:", JSON.stringify(callEvent, null, 2));

        const callId = callEvent.call_id || callEvent.id;
        const from = callEvent.from;
        const action = callEvent.event || callEvent.action; // Meta uses "event", not "action"
        const session = callEvent.session;
        const sdpType = session?.sdp_type;
        const sdp = session?.sdp;

        switch (action) {

            // ── "connect" can be inbound (sdp_type=offer) or outbound answer (sdp_type=answer) ──
            case "connect": {
                if (sdpType === "offer") {
                    // Inbound call: Meta sends SDP offer
                    emitToAgent(agentId, "inbound_call", { callId, from, sdpOffer: sdp });

                    // Persist call entry (idempotent)
                    const exists = await WhatsAppMessage.findOne({ messageId: callId });
                    if (!exists) {
                        const businessTo = callEvent.to || await resolveBusinessTargetForAgent(agentId);
                        await WhatsAppMessage.create({
                            messageId: callId,
                            conversationId: from,
                            from,
                            to: businessTo,
                            direction: "inbound",
                            messageType: "call",
                            content: { callId, callStatus: "ringing", callDirection: "inbound" },
                            status: "delivered",
                            salesAgent: agentId,
                        });
                    }
                } else if (sdpType === "answer") {
                    // Outbound call: Meta sends SDP answer after customer picks up
                    console.log(`[CallWebhook] SDP answer received for call ${callId}, forwarding to agent`);
                    emitToAgent(agentId, "call_sdp_answer", { callId, sdpAnswer: sdp });
                    await WhatsAppMessage.findOneAndUpdate(
                        { messageId: callId },
                        { "content.callStatus": "active", "content.startedAt": new Date(), "content.sdpAnswer": sdp }
                    );
                }
                break;
            }

            // ── Customer ended / disconnected ─────────────────────────────────
            case "disconnect":
            case "terminate": {
                const duration = callEvent.duration || 0;
                const finalStatus = callEvent.status === "COMPLETED" ? "ended" : "failed";
                const errorInfo = callEvent.errors?.[0] || null;

                emitToAgent(agentId, "call_ended", { callId, reason: "remote_ended", duration, status: finalStatus });

                await WhatsAppMessage.findOneAndUpdate(
                    { messageId: callId },
                    {
                        "content.callStatus": finalStatus,
                        "content.endedAt": callEvent.end_time ? new Date(parseInt(callEvent.end_time) * 1000) : new Date(),
                        "content.startedAt": callEvent.start_time ? new Date(parseInt(callEvent.start_time) * 1000) : undefined,
                        "content.duration": duration,
                        "content.metaStatus": callEvent.status,
                        "content.error": errorInfo ? { code: errorInfo.code, message: errorInfo.message } : undefined,
                    }
                );

                // Update agent call counters
                const incFields = { "whatsappSettings.totalCalls": 1 };
                if (finalStatus === "ended" && duration > 0) {
                    incFields["whatsappSettings.totalCallDuration"] = duration;
                    incFields["whatsappSettings.answeredCalls"] = 1;
                } else {
                    incFields["whatsappSettings.failedCalls"] = 1;
                }
                await User.findByIdAndUpdate(agentId, {
                    $inc: incFields,
                    $set: { "whatsappSettings.lastCallAt": new Date() },
                });

                break;
            }

            // ── Customer granted call permission ──────────────────────────────
            case "call_permission_granted": {
                emitToAgent(agentId, "call_permission_granted", { to: from });
                break;
            }

            default:
                console.log(`[CallWebhook] Unhandled action: ${action}`, callEvent);
        }
    } catch (err) {
        console.error("[CallWebhook] Error processing call event:", err.message);
    }
};

module.exports = { ...whatsappAgentController, resolveAgentForConversation, processCallWebhook };