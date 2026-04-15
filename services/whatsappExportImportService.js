/**
 * Parse WhatsApp "Export chat" ZIP (US-style lines: M/D/YY, H:MM - Author: body)
 * and persist WhatsAppMessage documents + optional S3 uploads for referenced attachments.
 */

const crypto = require("crypto");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const unzipper = require("unzipper");
const WhatsAppMessage = require("../models/WhatsAppMessage");
const { uploadBufferWithKey } = require("./whatsappS3Upload");
const { convertInboundAudioToMp3 } = require("../utils/whatsappInboundAudio");

const MAX_ZIP_ENTRIES = 5000;
const MAX_SINGLE_ENTRY_BYTES = 80 * 1024 * 1024;
const MAX_TOTAL_UNCOMPRESSED_BYTES = 450 * 1024 * 1024;

/** Primary message line: date, time - Author: body */
const MESSAGE_LINE_RE =
    /^(\d{1,2}\/\d{1,2}\/\d{2,4}),\s(\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AP]M)?)\s-\s([^:]+):\s(.*)$/;

/** Timestamped line that is not Author:body (system / encryption notice, etc.) */
const TIMESTAMPED_NON_MESSAGE_RE =
    /^(\d{1,2}\/\d{1,2}\/\d{2,4}),\s(\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AP]M)?)\s-\s([^:]+)$/;

const ATTACH_RE = /^(.+?)\s\(file attached\)$/i;

const EDITED_SUFFIX = /<this message was edited>$/i;

function normalizePhone(p) {
    const digits = String(p).replace(/\D/g, "");
    if (!digits) return null;
    return "+" + digits;
}

function normName(s) {
    return String(s || "")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, " ");
}

function parseUsDateTime(datePart, timePart) {
    const [mo, da, yr] = datePart.split("/").map((x) => parseInt(x, 10));
    let year = yr;
    if (year < 100) year += 2000;
    const tm = String(timePart).trim();
    let meridiem = null;
    let clock = tm;
    const ampm = /^(.*?)\s+([AP]M)$/i.exec(tm);
    if (ampm) {
        clock = ampm[1].trim();
        meridiem = ampm[2].toUpperCase();
    }
    const parts = clock.split(":").map((p) => parseInt(p, 10));
    let hours = parts[0] || 0;
    const minutes = parts[1] || 0;
    const seconds = parts[2] || 0;
    if (meridiem === "PM" && hours < 12) hours += 12;
    if (meridiem === "AM" && hours === 12) hours = 0;
    return new Date(year, mo - 1, da, hours, minutes, seconds);
}

function stableMessageId(phone, ts, author, body) {
    const raw = `${phone}|${ts.toISOString()}|${author}|${String(body).slice(0, 200)}`;
    const hash = crypto.createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 32);
    return `wexp_${hash}`;
}

function extOf(filename) {
    const e = path.extname(filename).replace(/^\./, "").toLowerCase();
    return e;
}

function mimeForExt(ext) {
    const m = {
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        png: "image/png",
        webp: "image/webp",
        opus: "audio/ogg",
        ogg: "audio/ogg",
        mp3: "audio/mpeg",
        m4a: "audio/mp4",
        mp4: "video/mp4",
        mov: "video/quicktime",
        avi: "video/x-msvideo",
        pdf: "application/pdf",
        docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        json: "application/json",
        csv: "text/csv",
        js: "application/javascript",
        jsx: "application/javascript",
        env: "text/plain",
        pem: "application/x-pem-file",
        zip: "application/zip",
        vcf: "text/vcard",
    };
    return m[ext] || "application/octet-stream";
}

function messageTypeForFile(filename) {
    const ext = extOf(filename);
    const base = path.basename(filename).toUpperCase();
    if (base.startsWith("STK-") && ext === "webp") return "sticker";
    if (["jpg", "jpeg", "png", "webp"].includes(ext)) return "image";
    if (["opus", "ogg", "mp3", "m4a"].includes(ext)) return "audio";
    if (base.startsWith("AUD-") && ext === "opus") return "audio";
    if (["mp4", "mov", "avi"].includes(ext)) return "video";
    if (ext === "vcf") return "contacts";
    return "document";
}

function sanitizeKeyFilename(name) {
    return path.basename(name).replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 180) || "file";
}

/**
 * @param {string} zipPath — path on disk (prefer multer diskStorage)
 * @param {object} opts
 * @param {string} opts.phoneNumber — E.164 customer
 * @param {string} opts.myDisplayName — exact export spelling (for direction)
 * @param {string} opts.phoneNumberId — Meta phone_number_id string
 * @param {string} opts.salesAgentId
 * @param {string} [opts.salesAgentPhone]
 * @param {string} [opts.exportFileName]
 * @param {string} opts.importBatchId — UUID
 */
async function importWhatsAppChatExportFromFile(zipPath, opts) {
    const {
        phoneNumber: phoneRaw,
        myDisplayName,
        phoneNumberId,
        salesAgentId,
        salesAgentPhone = null,
        exportFileName = null,
        importBatchId,
    } = opts;

    const phoneNumber = normalizePhone(phoneRaw);
    if (!phoneNumber) throw new Error("Invalid phoneNumber");
    if (!myDisplayName || !String(myDisplayName).trim()) throw new Error("myDisplayName is required");
    if (!phoneNumberId) throw new Error("WhatsApp phoneNumberId is not configured for this agent");
    if (!importBatchId) throw new Error("importBatchId is required");

    const directory = await unzipper.Open.file(zipPath);
    const entries = directory.files.filter((f) => f.type !== "Directory");
    if (entries.length > MAX_ZIP_ENTRIES) {
        throw new Error(`ZIP exceeds maximum file count (${MAX_ZIP_ENTRIES})`);
    }

    let totalUncompressed = 0;
    for (const e of entries) {
        const sz = e.uncompressedSize || 0;
        totalUncompressed += sz;
        if (sz > MAX_SINGLE_ENTRY_BYTES) {
            throw new Error(`ZIP entry too large: ${e.path}`);
        }
    }
    if (totalUncompressed > MAX_TOTAL_UNCOMPRESSED_BYTES) {
        throw new Error("ZIP uncompressed size exceeds limit");
    }

    const byBasename = new Map();
    for (const f of entries) {
        const normPath = f.path.replace(/\\/g, "/");
        if (normPath.includes("..") || path.isAbsolute(normPath)) continue;
        const base = path.basename(normPath).toLowerCase();
        if (!byBasename.has(base)) byBasename.set(base, f);
    }

    const chatEntry =
        entries.find((f) => /(^|\/)_chat\.txt$/i.test(f.path.replace(/\\/g, "/"))) ||
        entries.find((f) => /\.txt$/i.test(f.path.replace(/\\/g, "/")));

    if (!chatEntry) throw new Error("No chat text file (_chat.txt) found in ZIP");

    const textBuf = await chatEntry.buffer();
    let text = textBuf.toString("utf8");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

    let parsedChatTitle = null;
    const titleMatch = text.match(/^WhatsApp Chat with (.+)$/m);
    if (titleMatch) parsedChatTitle = titleMatch[1].trim();

    const lines = text.split(/\r?\n/);
    const rawMessages = [];
    let current = null;

    const flush = () => {
        if (!current) return;
        rawMessages.push({ ...current });
        current = null;
    };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const msgMatch = line.match(MESSAGE_LINE_RE);
        if (msgMatch) {
            flush();
            const [, dPart, tPart, author, body] = msgMatch;
            current = {
                datePart: dPart,
                timePart: tPart,
                author: author.trim(),
                body: body == null ? "" : body,
            };
            continue;
        }
        if (TIMESTAMPED_NON_MESSAGE_RE.test(line) && !MESSAGE_LINE_RE.test(line)) {
            flush();
            current = null;
            continue;
        }
        if (current) {
            current.body += "\n" + line;
        }
    }
    flush();

    const authors = new Set();
    for (const m of rawMessages) authors.add(normName(m.author));
    const nonEmptyAuthors = [...authors].filter((a) => a.length > 0);
    if (nonEmptyAuthors.length > 2) {
        const err = new Error("Group chat exports are not supported in v1");
        err.code = "group_chat_not_supported";
        throw err;
    }

    const myNorm = normName(myDisplayName);
    const importedAt = new Date();
    const breakdown = {
        text: 0,
        audio: 0,
        image: 0,
        video: 0,
        document: 0,
        sticker: 0,
        contacts: 0,
    };

    let mediaUploaded = 0;
    let mediaUnavailable = 0;
    const errors = [];
    const docs = [];

    const phoneFolder = phoneNumber.replace(/[^\d+]/g, "") || "unknown";
    const s3Prefix = `whatsapp-imports/${salesAgentId}/${phoneFolder}/${importBatchId}`;

    for (const rm of rawMessages) {
        let importMediaS3Key = null;
        let body = rm.body;
        let wasEdited = false;
        if (EDITED_SUFFIX.test(body)) {
            wasEdited = true;
            body = body.replace(EDITED_SUFFIX, "").trimEnd();
        }

        const ts = parseUsDateTime(rm.datePart, rm.timePart);
        const author = rm.author;
        const direction = normName(author) === myNorm ? "outbound" : "inbound";
        const from = direction === "outbound" ? phoneNumberId : phoneNumber;
        const to = direction === "outbound" ? phoneNumber : phoneNumberId;

        const baseMeta = {
            importedFromWhatsAppExport: true,
            importBatchId,
            importedAt,
            originalAuthor: author,
            exportFileName: exportFileName || null,
        };
        if (wasEdited) baseMeta.wasEdited = true;

        let messageType = "text";
        let content = {};
        let metaExtra = {};

        const trimmed = body.trim();
        const deletedPhrases = /^(this message was deleted|you deleted this message)\.?$/i;
        if (deletedPhrases.test(trimmed)) {
            messageType = "text";
            content = { text: "[Message deleted]" };
            metaExtra.deleted = true;
        } else if (/^<media omitted>$/i.test(trimmed)) {
            messageType = "text";
            content = { text: "[Media not included in export]" };
            metaExtra.mediaOmitted = true;
        } else {
            const attachMatch = trimmed.match(ATTACH_RE);
            if (attachMatch) {
                const innerName = attachMatch[1].trim();
                const baseKey = path.basename(innerName).toLowerCase();
                const zipFile = byBasename.get(baseKey);
                messageType = messageTypeForFile(innerName);

                if (zipFile) {
                    try {
                        let buf = await zipFile.buffer();
                        const ext = extOf(innerName);
                        let mime = mimeForExt(ext);
                        const safeName = sanitizeKeyFilename(innerName);
                        let fileKeyName = safeName;
                        if (messageType === "audio") {
                            try {
                                buf = await convertInboundAudioToMp3(buf);
                                mime = "audio/mpeg";
                                fileKeyName = safeName.replace(/\.[^.]+$/i, ".mp3") || `voice-${uuidv4().slice(0, 8)}.mp3`;
                            } catch (convErr) {
                                errors.push({
                                    file: innerName,
                                    phase: "audio_convert",
                                    error: convErr.message || String(convErr),
                                });
                            }
                        }
                        const key = `${s3Prefix}/${uuidv4().slice(0, 8)}_${fileKeyName}`;
                        const url = await uploadBufferWithKey({ key, buffer: buf, contentType: mime });
                        importMediaS3Key = key;
                        if (messageType === "document" || messageType === "contacts") {
                            content = { mediaUrl: url, filename: path.basename(innerName), mimeType: mime };
                        } else {
                            content = { mediaUrl: url, mimeType: mime };
                        }
                        mediaUploaded += 1;
                    } catch (e) {
                        errors.push({ file: innerName, error: e.message });
                        content = { text: `[Attachment upload failed: ${path.basename(innerName)}]` };
                        messageType = "text";
                        metaExtra.mediaUnavailable = true;
                        mediaUnavailable += 1;
                    }
                } else {
                    content = { text: `[Attachment file not included: ${path.basename(innerName)}]` };
                    metaExtra.mediaUnavailable = true;
                    mediaUnavailable += 1;
                    messageType = "text";
                }
            } else {
                content = { text: body };
            }
        }

        const bKey = Object.prototype.hasOwnProperty.call(breakdown, messageType) ? messageType : "text";
        breakdown[bKey] += 1;

        const messageId = stableMessageId(phoneNumber, ts, author, body);
        docs.push({
            messageId,
            conversationId: phoneNumber,
            from,
            to,
            direction,
            messageType,
            content,
            status: "read",
            timestamp: ts,
            salesAgent: salesAgentId,
            salesAgentPhone: salesAgentPhone || undefined,
            metadata: {
                ...baseMeta,
                ...metaExtra,
                profileName: author,
                ...(importMediaS3Key ? { importMediaS3Key } : {}),
            },
        });
    }

    let inserted = 0;
    let skippedDuplicates = 0;
    if (docs.length) {
        try {
            const res = await WhatsAppMessage.insertMany(docs, { ordered: false });
            inserted = Array.isArray(res) ? res.length : 0;
        } catch (err) {
            inserted = Array.isArray(err.insertedDocs) ? err.insertedDocs.length : 0;
            skippedDuplicates = Math.max(0, docs.length - inserted);
            const w = err.writeErrors || [];
            const onlyDup =
                w.length > 0 && w.every((x) => x.err && (x.err.code === 11000 || x.err.code === 11001));
            if (!onlyDup && inserted === 0) {
                errors.push({ phase: "insertMany", error: err.message || String(err) });
                throw err;
            }
        }
    }

    return {
        importBatchId,
        inserted,
        skippedDuplicates,
        mediaUploaded,
        mediaUnavailable,
        messageBreakdown: breakdown,
        errors,
        parsedChatTitle,
    };
}

module.exports = { importWhatsAppChatExportFromFile, normalizePhone };
