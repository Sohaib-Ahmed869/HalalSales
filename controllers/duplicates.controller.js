// controllers/duplicates.controller.js
//
// Review queue for accounts that look like the same physical shop, plus the
// confirmed links that come out of it.

const mongoose = require("mongoose");
const Customer = require("../models/Customer");
const CustomerGroup = require("../models/CustomerGroup");
const {
  detectDuplicateGroups,
  invalidateCache,
} = require("../services/duplicateDetection.service");
const { pickMatchAddress, buildAddressKey } = require("../utils/addressNormalization");

const asBool = (value, fallback = false) => {
  if (value === undefined || value === "") return fallback;
  return value === true || value === "true" || value === "1";
};

/**
 * GET /api/duplicates
 * The review queue.
 */
exports.getDuplicateGroups = async (req, res) => {
  try {
    const result = await detectDuplicateGroups({
      matchType: req.query.matchType || "all",
      reviewStatus: req.query.reviewStatus || "new",
      minConfidence: parseFloat(req.query.minConfidence) || 0,
      onlyDifferentNames: asBool(req.query.onlyDifferentNames),
      onlyWithSales: asBool(req.query.onlyWithSales),
      includeProspects: asBool(req.query.includeProspects),
      search: req.query.search || "",
      sortBy: req.query.sortBy || "confidence",
      page: parseInt(req.query.page, 10) || 1,
      limit: parseInt(req.query.limit, 10) || 25,
      refresh: asBool(req.query.refresh),
    });

    res.json({ success: true, ...result });
  } catch (error) {
    console.error("Error detecting duplicate customers:", error);
    res.status(500).json({
      success: false,
      message: "Error detecting duplicate customers",
      error: error.message,
    });
  }
};

/**
 * GET /api/duplicates/hubs
 * Addresses and phone numbers shared by so many accounts that they are clearly
 * a location rather than a business (own depot, shopping centre, accountant).
 */
exports.getHubs = async (req, res) => {
  try {
    const result = await detectDuplicateGroups({
      includeProspects: asBool(req.query.includeProspects),
      limit: 1,
    });
    res.json({ success: true, hubs: result.hubs });
  } catch (error) {
    console.error("Error loading hub locations:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * POST /api/duplicates/link
 * Confirm that a set of accounts are one shop.
 * body: { customerIds: [], primaryCustomerId, name, matchType, matchKey, notes }
 */
exports.linkGroup = async (req, res) => {
  try {
    const { customerIds, primaryCustomerId, name, matchType, matchKey, notes } = req.body;

    if (!Array.isArray(customerIds) || customerIds.length < 2) {
      return res.status(400).json({
        success: false,
        message: "At least two accounts are required to link a shop",
      });
    }

    const customers = await Customer.find({ _id: { $in: customerIds } })
      .select("CardCode CardName address deliveryAddress addresses coordinates")
      .lean();

    if (customers.length !== customerIds.length) {
      return res.status(404).json({
        success: false,
        message: "One or more accounts could not be found",
      });
    }

    // Absorb any group these accounts already belong to, so linking A+B and
    // then B+C leaves one group of three rather than two overlapping ones.
    const existing = await CustomerGroup.find({
      kind: "shop",
      "members.customer": { $in: customerIds },
    });

    const memberMap = new Map();
    existing.forEach((group) =>
      (group.members || []).forEach((m) => memberMap.set(String(m.customer), m))
    );
    customers.forEach((c) =>
      memberMap.set(String(c._id), {
        customer: c._id,
        cardCode: c.CardCode,
        cardName: c.CardName,
        addedAt: new Date(),
      })
    );

    const withCoords = customers.find((c) => c.coordinates && c.coordinates.lat != null);
    const addr = pickMatchAddress(customers.find((c) => pickMatchAddress(c)) || customers[0]);
    const primary = primaryCustomerId || customerIds[0];

    // Reuse the oldest existing group so its id (and any links to it) survive.
    const target = existing.sort((a, b) => a.createdAt - b.createdAt)[0] || new CustomerGroup();

    target.kind = "shop";
    target.name =
      name ||
      target.name ||
      customers.find((c) => String(c._id) === String(primary))?.CardName ||
      customers[0].CardName;
    target.matchType = matchType || "address";
    target.matchKey = matchKey || buildAddressKey(customers[0]) || target.matchKey;
    target.members = [...memberMap.values()];
    target.primaryCustomer = primary;
    target.coordinates = withCoords ? withCoords.coordinates : target.coordinates;
    target.address = addr
      ? { street: addr.street, zipCode: addr.zipCode, city: addr.city }
      : target.address;
    if (notes !== undefined) target.notes = notes;
    target.reviewedBy = req.user?._id || req.user?.id;
    target.reviewedAt = new Date();

    await target.save();

    // Drop any now-absorbed groups.
    const absorbed = existing.filter((g) => String(g._id) !== String(target._id));
    if (absorbed.length) {
      await CustomerGroup.deleteMany({ _id: { $in: absorbed.map((g) => g._id) } });
    }

    const allMemberIds = target.members.map((m) => m.customer);
    await Customer.updateMany(
      { _id: { $in: allMemberIds } },
      { $set: { shopGroup: target._id } }
    );

    invalidateCache();

    res.json({
      success: true,
      message: `Linked ${target.members.length} accounts as one shop`,
      group: target,
    });
  } catch (error) {
    console.error("Error linking customer group:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * POST /api/duplicates/ignore
 * Record that a suggested group is NOT the same shop, so it stops being
 * suggested. It comes back if a new account later joins the same address.
 * body: { customerIds: [], matchKey, matchType, notes }
 */
exports.ignoreGroup = async (req, res) => {
  try {
    const { customerIds, matchKey, matchType, notes } = req.body;

    if (!Array.isArray(customerIds) || customerIds.length < 2 || !matchKey) {
      return res.status(400).json({
        success: false,
        message: "customerIds (2+) and matchKey are required",
      });
    }

    const customers = await Customer.find({ _id: { $in: customerIds } })
      .select("CardCode CardName")
      .lean();

    // One ignore record per match key: merge in whatever was reviewed before.
    const existing = await CustomerGroup.findOne({ kind: "ignored", matchKey });
    const target = existing || new CustomerGroup({ kind: "ignored", matchKey });

    const memberMap = new Map(
      (target.members || []).map((m) => [String(m.customer), m])
    );
    customers.forEach((c) =>
      memberMap.set(String(c._id), {
        customer: c._id,
        cardCode: c.CardCode,
        cardName: c.CardName,
        addedAt: new Date(),
      })
    );

    target.kind = "ignored";
    target.matchKey = matchKey;
    target.matchType = matchType || "address";
    target.members = [...memberMap.values()];
    if (notes !== undefined) target.notes = notes;
    target.reviewedBy = req.user?._id || req.user?.id;
    target.reviewedAt = new Date();

    await target.save();
    invalidateCache();

    res.json({ success: true, message: "Marked as not the same shop", group: target });
  } catch (error) {
    console.error("Error ignoring duplicate group:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * POST /api/duplicates/hub
 * Permanently mark an address or phone as a shared location so it is never
 * suggested as a duplicate, whatever its size.
 * body: { matchKey, matchType, name, notes }
 */
exports.markAsHub = async (req, res) => {
  try {
    const { matchKey, matchType, name, notes } = req.body;
    if (!matchKey) {
      return res.status(400).json({ success: false, message: "matchKey is required" });
    }

    const group = await CustomerGroup.findOneAndUpdate(
      { kind: "hub", matchKey },
      {
        $set: {
          kind: "hub",
          matchKey,
          matchType: matchType || "address",
          name: name || matchKey,
          notes,
          reviewedBy: req.user?._id || req.user?.id,
          reviewedAt: new Date(),
        },
      },
      { new: true, upsert: true }
    );

    invalidateCache();
    res.json({ success: true, message: "Marked as a shared location", group });
  } catch (error) {
    console.error("Error marking hub:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * GET /api/duplicates/groups
 * The confirmed shop links.
 */
exports.getConfirmedGroups = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(parseInt(req.query.limit, 10) || 25, 200);
    const filter = { kind: req.query.kind || "shop" };

    if (req.query.search) {
      filter.$or = [
        { name: { $regex: req.query.search, $options: "i" } },
        { "members.cardName": { $regex: req.query.search, $options: "i" } },
        { "members.cardCode": { $regex: req.query.search, $options: "i" } },
      ];
    }

    const [groups, total] = await Promise.all([
      CustomerGroup.find(filter)
        .populate("reviewedBy", "firstName lastName email")
        .sort({ reviewedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      CustomerGroup.countDocuments(filter),
    ]);

    res.json({
      success: true,
      groups,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 },
    });
  } catch (error) {
    console.error("Error loading customer groups:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * GET /api/duplicates/for-customer/:id
 * The other accounts belonging to the same shop as this one — both confirmed
 * links and, when there is no confirmed link, unreviewed suggestions.
 */
exports.getGroupForCustomer = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid customer id" });
    }

    const group = await CustomerGroup.findOne({ kind: "shop", "members.customer": id })
      .populate("reviewedBy", "firstName lastName")
      .lean();

    if (group) {
      const ids = group.members.map((m) => m.customer);
      const siblings = await Customer.find({ _id: { $in: ids, $ne: id } })
        .select("CardCode CardName status customerType phoneNumber Email address deliveryAddress coordinates")
        .lean();
      return res.json({ success: true, confirmed: true, group, siblings });
    }

    // No confirmed link: fall back to live suggestions for this account.
    const customer = await Customer.findById(id)
      .select("CardCode CardName address deliveryAddress addresses phoneNumber additionalPhoneNumbers")
      .lean();

    if (!customer) {
      return res.status(404).json({ success: false, message: "Customer not found" });
    }

    const addressKey = buildAddressKey(customer);
    if (!addressKey) {
      return res.json({ success: true, confirmed: false, group: null, siblings: [] });
    }

    // Cheap targeted scan rather than the full detection pass.
    const addr = pickMatchAddress(customer);
    const nearby = await Customer.find({
      _id: { $ne: id },
      status: { $ne: "prospect" },
      $or: [
        { "deliveryAddress.zipCode": addr.zipCode },
        { "address.zipCode": addr.zipCode },
      ],
    })
      .select("CardCode CardName status customerType phoneNumber Email address deliveryAddress addresses coordinates")
      .lean();

    const siblings = nearby.filter((c) => buildAddressKey(c) === addressKey);

    res.json({ success: true, confirmed: false, group: null, siblings, addressKey });
  } catch (error) {
    console.error("Error loading group for customer:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * PUT /api/duplicates/groups/:id
 * Rename, re-point the primary account, or add/remove members.
 */
exports.updateGroup = async (req, res) => {
  try {
    const group = await CustomerGroup.findById(req.params.id);
    if (!group) {
      return res.status(404).json({ success: false, message: "Group not found" });
    }

    const { name, primaryCustomerId, notes, addCustomerIds, removeCustomerIds } = req.body;

    if (name !== undefined) group.name = name;
    if (notes !== undefined) group.notes = notes;
    if (primaryCustomerId) group.primaryCustomer = primaryCustomerId;

    if (Array.isArray(addCustomerIds) && addCustomerIds.length) {
      const toAdd = await Customer.find({ _id: { $in: addCustomerIds } })
        .select("CardCode CardName")
        .lean();
      const memberMap = new Map(group.members.map((m) => [String(m.customer), m]));
      toAdd.forEach((c) =>
        memberMap.set(String(c._id), {
          customer: c._id,
          cardCode: c.CardCode,
          cardName: c.CardName,
          addedAt: new Date(),
        })
      );
      group.members = [...memberMap.values()];
      await Customer.updateMany(
        { _id: { $in: addCustomerIds } },
        { $set: { shopGroup: group._id } }
      );
    }

    if (Array.isArray(removeCustomerIds) && removeCustomerIds.length) {
      const removing = new Set(removeCustomerIds.map(String));
      group.members = group.members.filter((m) => !removing.has(String(m.customer)));
      await Customer.updateMany(
        { _id: { $in: removeCustomerIds } },
        { $unset: { shopGroup: "" } }
      );
    }

    group.reviewedBy = req.user?._id || req.user?.id;
    group.reviewedAt = new Date();

    // A group needs at least two accounts to mean anything.
    if (group.members.length < 2) {
      await Customer.updateMany(
        { _id: { $in: group.members.map((m) => m.customer) } },
        { $unset: { shopGroup: "" } }
      );
      await CustomerGroup.deleteOne({ _id: group._id });
      invalidateCache();
      return res.json({
        success: true,
        message: "Group removed — fewer than two accounts remained",
        group: null,
      });
    }

    await group.save();
    invalidateCache();

    res.json({ success: true, group });
  } catch (error) {
    console.error("Error updating customer group:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * DELETE /api/duplicates/groups/:id
 * Undo a link (or an ignore/hub decision).
 */
exports.deleteGroup = async (req, res) => {
  try {
    const group = await CustomerGroup.findById(req.params.id);
    if (!group) {
      return res.status(404).json({ success: false, message: "Group not found" });
    }

    if (group.members?.length) {
      await Customer.updateMany(
        { _id: { $in: group.members.map((m) => m.customer) } },
        { $unset: { shopGroup: "" } }
      );
    }

    await CustomerGroup.deleteOne({ _id: group._id });
    invalidateCache();

    res.json({ success: true, message: "Decision removed" });
  } catch (error) {
    console.error("Error deleting customer group:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * GET /api/duplicates/export
 * CSV of the current review queue, for working through offline.
 */
exports.exportDuplicates = async (req, res) => {
  try {
    const result = await detectDuplicateGroups({
      matchType: req.query.matchType || "all",
      reviewStatus: req.query.reviewStatus || "new",
      minConfidence: parseFloat(req.query.minConfidence) || 0,
      onlyDifferentNames: asBool(req.query.onlyDifferentNames),
      onlyWithSales: asBool(req.query.onlyWithSales),
      includeProspects: asBool(req.query.includeProspects),
      sortBy: req.query.sortBy || "confidence",
      page: 1,
      limit: 200,
    });

    const escape = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
    const rows = [
      [
        "Group", "Confidence", "Match", "Different names", "Street", "Postcode",
        "City", "Card code", "Account name", "Status", "Invoices", "Total sales",
        "Last invoice",
      ].join(","),
    ];

    result.groups.forEach((group, index) => {
      group.members.forEach((member) => {
        rows.push(
          [
            index + 1,
            group.confidence,
            group.matchType,
            group.differentNames ? "yes" : "no",
            escape(group.address?.street),
            escape(group.address?.zipCode),
            escape(group.address?.city),
            escape(member.cardCode),
            escape(member.cardName),
            escape(member.status),
            member.invoiceCount || 0,
            member.totalSales || 0,
            member.lastInvoiceDate
              ? new Date(member.lastInvoiceDate).toISOString().slice(0, 10)
              : "",
          ].join(",")
        );
      });
    });

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="duplicate-accounts.csv"'
    );
    res.send(`﻿${rows.join("\n")}`);
  } catch (error) {
    console.error("Error exporting duplicates:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};
