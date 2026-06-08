// controllers/newSupplier.controller.js
// Handles uploaded supplier database used for RFQs with new suppliers.

const NewSupplier = require("../models/NewSupplier");
const RFQ = require("../models/RFQ");
const discoveryAgent = require("../agents/discoveryAgent");
const multer = require("multer");
const XLSX = require("xlsx");
const { v4: uuidv4 } = require("uuid");

// A supplier "needs" a contact lookup when it has no email yet.
const needsContact = (s) => !s?.email;

// Fire-and-forget AI contact discovery for suppliers missing an email.
// Never blocks the request — errors are logged inside the agent.
const triggerAutoDiscovery = (suppliers) => {
    const targets = (suppliers || []).filter(needsContact);
    if (!targets.length) return;
    setImmediate(() => {
        discoveryAgent
            .enrichNewSuppliers(targets)
            .catch((err) => console.error("[NewSupplier] Auto-discovery failed:", err.message));
    });
};

// Multer for in-memory Excel upload (keeps things simple; no disk IO)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

// Normalise an Excel header row to a canonical field name
const normaliseHeader = (h) => String(h || "").toLowerCase().trim().replace(/[\s_-]+/g, "");

// Map of common header aliases → canonical field
const HEADER_MAP = {
    // Name
    supplier: "supplierName", suppliername: "supplierName", name: "supplierName",
    vendor: "supplierName", vendorname: "supplierName",
    // Company
    company: "companyName", companyname: "companyName", business: "companyName", businessname: "companyName",
    // Contact
    email: "email", emailaddress: "email", mail: "email", contactemail: "email",
    phone: "phone", phonenumber: "phone", contact: "phone", contactphone: "phone", tel: "phone", mobile: "phone",
    // Location
    country: "country",
    city: "city",
    address: "address", location: "address",
    website: "website", url: "website", site: "website",
    // Products
    products: "productCategories", productcategories: "productCategories",
    category: "productCategories", categories: "productCategories",
    product: "productCategories", offers: "productCategories",
    // Notes
    notes: "notes", note: "notes", description: "notes", remarks: "notes",
};

const parseProductCategories = (value) => {
    if (!value) return [];
    if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
    return String(value)
        .split(/[,;|\n]+/)
        .map(s => s.trim())
        .filter(Boolean);
};

const newSupplierController = {
    uploadMiddleware: upload.single("file"),

    /**
     * POST /api/new-suppliers/preview
     * Peek into an uploaded Excel to extract headers and sample rows, so the
     * frontend can present a field-mapping step before persisting.
     * Returns: { headers, sampleRows, autoMapping }
     */
    previewExcel: async (req, res) => {
        try {
            if (!req.file) return res.status(400).json({ error: "No file provided" });
            const workbook = XLSX.read(req.file.buffer, { type: "buffer" });
            const sheetName = workbook.SheetNames[0];
            if (!sheetName) return res.status(400).json({ error: "Workbook has no sheets" });
            const sheet = workbook.Sheets[sheetName];
            const rows = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false, header: 1 });
            if (!rows.length) return res.status(400).json({ error: "Sheet is empty" });

            const headers = (rows[0] || []).map(h => String(h || "").trim()).filter(Boolean);
            const sampleRows = rows.slice(1, 6).map(r => {
                const obj = {};
                headers.forEach((h, i) => { obj[h] = r[i] ?? ""; });
                return obj;
            });

            // Auto-detect mapping for user (they can override in UI)
            const autoMapping = {};
            headers.forEach(h => {
                const canonical = HEADER_MAP[normaliseHeader(h)];
                if (canonical) autoMapping[h] = canonical;
            });

            // Stash the raw file content in memory via a temporary token so frontend doesn't re-upload.
            // Simplest: we just return the file base64 for client to send back on commit.
            const fileBase64 = req.file.buffer.toString("base64");

            return res.status(200).json({
                success: true,
                headers,
                sampleRows,
                totalRows: rows.length - 1,
                autoMapping,
                fileToken: fileBase64, // client re-sends on commit
                mimetype: req.file.mimetype,
                filename: req.file.originalname,
            });
        } catch (error) {
            console.error("[NewSupplier] Preview error:", error);
            return res.status(500).json({ error: "Preview failed", details: error.message });
        }
    },

    /**
     * POST /api/new-suppliers/upload
     * Upload an Excel (.xlsx / .xls / .csv) of suppliers and persist them.
     * Supports optional `fieldMapping` (from preview step) to map user headers → canonical fields.
     *
     * Body (multipart/form-data):
     *   file       — Excel file (required unless fileToken is used)
     *   fieldMapping (JSON string) — { "Name column": "supplierName", "Email addr": "email", ... }
     *   fileToken  — base64 content returned by /preview (avoids re-upload)
     *   filename   — original filename (when using fileToken)
     */
    uploadSuppliers: async (req, res) => {
        try {
            let buffer;
            let filename;
            if (req.file) {
                buffer = req.file.buffer;
                filename = req.file.originalname;
            } else if (req.body.fileToken) {
                buffer = Buffer.from(req.body.fileToken, "base64");
                filename = req.body.filename || "upload.xlsx";
            } else {
                return res.status(400).json({ error: "No file provided" });
            }

            // Parse optional field mapping (user-supplied, overrides auto-detection)
            let userMapping = null;
            if (req.body.fieldMapping) {
                try {
                    userMapping = typeof req.body.fieldMapping === "string"
                        ? JSON.parse(req.body.fieldMapping)
                        : req.body.fieldMapping;
                } catch (_) {
                    return res.status(400).json({ error: "Invalid fieldMapping JSON" });
                }
            }

            const workbook = XLSX.read(buffer, { type: "buffer" });
            const sheetName = workbook.SheetNames[0];
            if (!sheetName) return res.status(400).json({ error: "Workbook has no sheets" });
            const sheet = workbook.Sheets[sheetName];
            const rows = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false });

            if (!rows.length) return res.status(400).json({ error: "Sheet is empty" });

            const batchId = uuidv4();
            const uploadedBy = req.user?.id || null;
            const normalisedRows = rows.map(row => {
                const out = {};
                for (const [key, val] of Object.entries(row)) {
                    // Priority: user mapping → auto-map by alias
                    const canonicalField = userMapping?.[key] || HEADER_MAP[normaliseHeader(key)];
                    if (!canonicalField || canonicalField === "__ignore__") continue;
                    if (canonicalField === "productCategories") {
                        out.productCategories = parseProductCategories(val);
                    } else {
                        out[canonicalField] = String(val || "").trim();
                    }
                }
                return out;
            }).filter(r => r.supplierName || r.email);

            if (!normalisedRows.length) {
                return res.status(400).json({
                    error: "No valid supplier rows found",
                    hint: "Each row must have at least 'supplierName' or 'email'. Accepted columns: supplierName, companyName, email, phone, country, city, address, website, productCategories, notes.",
                });
            }

            // Upsert by (email + supplierName) — if email exists, update that supplier; else insert new.
            const results = { inserted: 0, updated: 0, skipped: 0, errors: [] };
            const savedSuppliers = [];

            for (const row of normalisedRows) {
                try {
                    const filter = row.email
                        ? { email: row.email }
                        : { supplierName: row.supplierName, companyName: row.companyName || "" };

                    const existing = await NewSupplier.findOne(filter);
                    if (existing) {
                        Object.assign(existing, {
                            ...row,
                            productCategories: [...new Set([...(existing.productCategories || []), ...(row.productCategories || [])])],
                            uploadBatchId: batchId,
                            uploadedBy: uploadedBy || existing.uploadedBy,
                            isActive: true,
                        });
                        await existing.save();
                        savedSuppliers.push(existing);
                        results.updated++;
                    } else {
                        const created = await NewSupplier.create({
                            ...row,
                            uploadBatchId: batchId,
                            uploadedBy,
                        });
                        savedSuppliers.push(created);
                        results.inserted++;
                    }
                } catch (err) {
                    results.skipped++;
                    results.errors.push({ supplier: row.supplierName || row.email, error: err.message });
                }
            }

            // Auto-find contacts for any supplier uploaded without an email (background)
            triggerAutoDiscovery(savedSuppliers);

            return res.status(200).json({
                success: true,
                batchId,
                results,
                data: savedSuppliers,
            });
        } catch (error) {
            console.error("[NewSupplier] Upload error:", error);
            return res.status(500).json({ error: "Upload failed", details: error.message });
        }
    },

    /**
     * POST /api/new-suppliers
     * Create a single supplier manually (form-based)
     */
    createSupplier: async (req, res) => {
        try {
            const body = req.body || {};
            if (!body.supplierName && !body.email) {
                return res.status(400).json({ error: "Either supplierName or email is required" });
            }
            body.productCategories = parseProductCategories(body.productCategories);
            body.uploadedBy = req.user?.id || null;
            const supplier = await NewSupplier.create(body);

            // Auto-find a contact if none was provided (background)
            triggerAutoDiscovery([supplier]);

            return res.status(201).json({ success: true, data: supplier });
        } catch (error) {
            return res.status(500).json({ error: "Error creating supplier", details: error.message });
        }
    },

    /**
     * POST /api/new-suppliers/discover-contacts
     * Manually trigger AI contact discovery for suppliers missing an email.
     * Body (optional): { ids: [supplierId, ...] }  — if omitted, targets ALL active
     * suppliers without an email.
     * Runs in the background and returns immediately with the number queued.
     */
    discoverContactsBulk: async (req, res) => {
        try {
            const ids = Array.isArray(req.body?.ids) ? req.body.ids : null;

            const filter = { isActive: true, $or: [{ email: { $exists: false } }, { email: "" }, { email: null }] };
            if (ids && ids.length) filter._id = { $in: ids };

            const targets = await NewSupplier.find(filter)
                .select("_id supplierName companyName country productCategories")
                .lean();

            if (!targets.length) {
                return res.status(200).json({
                    success: true,
                    queued: 0,
                    message: "No suppliers are missing a contact email.",
                });
            }

            // Background — discovery is rate-limited and can take a while for big lists.
            setImmediate(() => {
                discoveryAgent
                    .enrichNewSuppliers(targets)
                    .catch((err) => console.error("[NewSupplier] Bulk discovery failed:", err.message));
            });

            return res.status(202).json({
                success: true,
                queued: targets.length,
                message: `Finding contacts for ${targets.length} supplier(s) in the background. Refresh to see results.`,
            });
        } catch (error) {
            return res.status(500).json({ error: "Error starting contact discovery", details: error.message });
        }
    },

    /**
     * GET /api/new-suppliers
     * List suppliers with pagination, search, category filter
     */
    listSuppliers: async (req, res) => {
        try {
            const { search, category, country, page = 1, limit = 50, sortBy = "createdAt", sortOrder = "desc" } = req.query;
            const filter = { isActive: true };

            if (search) {
                const regex = new RegExp(search, "i");
                filter.$or = [
                    { supplierName: regex },
                    { companyName: regex },
                    { email: regex },
                    { productCategories: regex },
                    { country: regex },
                ];
            }
            if (category) {
                filter.productCategories = new RegExp(category, "i");
            }
            if (country) {
                filter.country = new RegExp(country, "i");
            }

            const skip = (parseInt(page) - 1) * parseInt(limit);
            const sort = { [sortBy]: sortOrder === "desc" ? -1 : 1 };

            const [suppliers, total] = await Promise.all([
                NewSupplier.find(filter).sort(sort).skip(skip).limit(parseInt(limit)).lean(),
                NewSupplier.countDocuments(filter),
            ]);

            return res.status(200).json({
                success: true,
                data: suppliers,
                pagination: {
                    total,
                    page: parseInt(page),
                    limit: parseInt(limit),
                    pages: Math.ceil(total / parseInt(limit)),
                },
            });
        } catch (error) {
            return res.status(500).json({ error: "Error fetching suppliers", details: error.message });
        }
    },

    /**
     * GET /api/new-suppliers/:id
     * Get a single supplier with their RFQ history
     */
    getSupplier: async (req, res) => {
        try {
            const { id } = req.params;
            const supplier = await NewSupplier.findById(id).lean();
            if (!supplier) return res.status(404).json({ error: "Supplier not found" });

            // Find RFQs where this supplier appeared in vendorsContacted (matched by email or supplierName)
            const rfqs = await RFQ.find({
                "vendorsContacted.vendorCode": id.toString(),
            }).select("rfqNumber dateIssued status items vendorsContacted").lean();

            return res.status(200).json({
                success: true,
                data: {
                    ...supplier,
                    rfqHistory: rfqs.map(r => {
                        const contact = (r.vendorsContacted || []).find(v => v.vendorCode === id.toString());
                        return {
                            _id: r._id,
                            rfqNumber: r.rfqNumber,
                            dateIssued: r.dateIssued,
                            status: r.status,
                            itemsCount: r.items?.length || 0,
                            vendorStatus: contact?.status,
                            responseDate: contact?.responseDate,
                            quotedTotal: contact?.quotedTotal,
                        };
                    }),
                },
            });
        } catch (error) {
            return res.status(500).json({ error: "Error fetching supplier", details: error.message });
        }
    },

    /**
     * PUT /api/new-suppliers/:id
     */
    updateSupplier: async (req, res) => {
        try {
            const updates = req.body || {};
            if (updates.productCategories) {
                updates.productCategories = parseProductCategories(updates.productCategories);
            }
            const supplier = await NewSupplier.findByIdAndUpdate(req.params.id, updates, { new: true });
            if (!supplier) return res.status(404).json({ error: "Supplier not found" });
            return res.status(200).json({ success: true, data: supplier });
        } catch (error) {
            return res.status(500).json({ error: "Error updating supplier", details: error.message });
        }
    },

    /**
     * DELETE /api/new-suppliers/:id
     * Soft-delete (isActive=false) to preserve RFQ history.
     */
    deleteSupplier: async (req, res) => {
        try {
            const supplier = await NewSupplier.findByIdAndUpdate(
                req.params.id,
                { isActive: false },
                { new: true }
            );
            if (!supplier) return res.status(404).json({ error: "Supplier not found" });
            return res.status(200).json({ success: true, message: "Supplier deactivated" });
        } catch (error) {
            return res.status(500).json({ error: "Error deleting supplier", details: error.message });
        }
    },

    /**
     * GET /api/new-suppliers/match
     * Match new suppliers to a list of products (for RFQ creation flow).
     * Query: ?products=chicken,rice,cheese
     * Returns ranked suppliers matching any of the products.
     */
    matchSuppliersForProducts: async (req, res) => {
        try {
            const products = String(req.query.products || "").split(",").map(p => p.trim()).filter(Boolean);
            if (!products.length) {
                return res.status(400).json({ error: "Provide products query parameter (comma-separated)" });
            }

            // Build regex alternation — case-insensitive partial match
            const productRegex = products.map(p => new RegExp(p, "i"));

            const suppliers = await NewSupplier.find({
                isActive: true,
                $or: [
                    { productCategories: { $in: productRegex } },
                    { notes: { $in: productRegex } },
                    { supplierName: { $in: productRegex } },
                    { companyName: { $in: productRegex } },
                ],
            }).lean();

            // Score each supplier by how many product keywords match
            const scored = suppliers.map(s => {
                const haystack = [
                    ...(s.productCategories || []),
                    s.supplierName, s.companyName, s.notes,
                ].join(" ").toLowerCase();

                const matchedProducts = products.filter(p => haystack.includes(p.toLowerCase()));
                return {
                    supplier: s,
                    matchedProducts,
                    matchScore: matchedProducts.length / products.length,
                };
            }).sort((a, b) => b.matchScore - a.matchScore);

            return res.status(200).json({
                success: true,
                data: scored,
                total: scored.length,
            });
        } catch (error) {
            return res.status(500).json({ error: "Error matching suppliers", details: error.message });
        }
    },

    /**
     * GET /api/new-suppliers/stats/overview
     * Database overview: total suppliers, by country, top categories, recent uploads
     */
    getStatsOverview: async (req, res) => {
        try {
            const [totalActive, totalInactive, byCountry, topCategories, recentUploads] = await Promise.all([
                NewSupplier.countDocuments({ isActive: true }),
                NewSupplier.countDocuments({ isActive: false }),
                NewSupplier.aggregate([
                    { $match: { isActive: true, country: { $exists: true, $ne: "" } } },
                    { $group: { _id: "$country", count: { $sum: 1 } } },
                    { $sort: { count: -1 } },
                    { $limit: 10 },
                ]),
                NewSupplier.aggregate([
                    { $match: { isActive: true } },
                    { $unwind: "$productCategories" },
                    { $group: { _id: "$productCategories", count: { $sum: 1 } } },
                    { $sort: { count: -1 } },
                    { $limit: 15 },
                ]),
                NewSupplier.aggregate([
                    { $match: { isActive: true } },
                    { $group: { _id: "$uploadBatchId", count: { $sum: 1 }, uploadedAt: { $max: "$createdAt" } } },
                    { $sort: { uploadedAt: -1 } },
                    { $limit: 5 },
                ]),
            ]);

            // Aggregate RFQ stats
            const rfqStats = await NewSupplier.aggregate([
                { $match: { isActive: true } },
                {
                    $group: {
                        _id: null,
                        totalRFQsSent: { $sum: "$stats.totalRFQsSent" },
                        totalResponses: { $sum: "$stats.totalResponses" },
                        totalQuotations: { $sum: "$stats.totalQuotations" },
                        totalWins: { $sum: "$stats.totalWins" },
                    },
                },
            ]);

            return res.status(200).json({
                success: true,
                data: {
                    totalActive,
                    totalInactive,
                    byCountry,
                    topCategories,
                    recentUploads,
                    rfqStats: rfqStats[0] || { totalRFQsSent: 0, totalResponses: 0, totalQuotations: 0, totalWins: 0 },
                },
            });
        } catch (error) {
            return res.status(500).json({ error: "Error fetching stats", details: error.message });
        }
    },

    /**
     * GET /api/new-suppliers/template
     * Download a blank Excel template showing the expected columns.
     */
    downloadTemplate: async (req, res) => {
        try {
            const headers = ["supplierName", "companyName", "email", "phone", "country", "city", "address", "website", "productCategories", "notes"];
            const example = [{
                supplierName: "ACME Foods",
                companyName: "ACME Foods SARL",
                email: "contact@acmefoods.com",
                phone: "+33 1 23 45 67 89",
                country: "France",
                city: "Paris",
                address: "12 rue Example, 75001",
                website: "www.acmefoods.com",
                productCategories: "chicken, beef, lamb",
                notes: "Halal certified, delivers EU-wide",
            }];

            const ws = XLSX.utils.json_to_sheet(example, { header: headers });
            const wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, ws, "Suppliers");
            const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

            res.setHeader("Content-Disposition", 'attachment; filename="new_suppliers_template.xlsx"');
            res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
            return res.send(buffer);
        } catch (error) {
            return res.status(500).json({ error: "Error generating template", details: error.message });
        }
    },
};

module.exports = newSupplierController;
