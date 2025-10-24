const Customer = require("../models/Customer");
const Invoice = require("../models/Invoice");
const SalesOrder = require("../models/SalesOrder");
const Cart = require("../models/Cart");
const ExcelJS = require("exceljs");

// Configuration
const BATCH_SIZE = 1000; // Process 1000 records at a time
const MAX_MEMORY_RECORDS = 10000; // Maximum records to hold in memory

/**
 * Export all clients data with comprehensive sales information
 * OPTIMIZED VERSION - Uses streaming and pagination for large datasets
 */
exports.exportClientsData = async (req, res) => {
    try {
        const { startDate, endDate, salesAgentId, status } = req.query;

        // Build customer filter
        const customerFilter = {};
        if (salesAgentId) {
            customerFilter.assignedTo = salesAgentId;
        }
        if (status) {
            customerFilter.status = status;
        }

        // First, count total customers to determine strategy
        const totalCustomers = await Customer.countDocuments(customerFilter);
        console.log(`Total customers to export: ${totalCustomers}`);

        // Set response headers immediately
        res.setHeader(
            "Content-Type",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        );
        res.setHeader(
            "Content-Disposition",
            `attachment; filename=clients_export_${new Date()
                .toISOString()
                .split("T")[0]}.xlsx`
        );

        // Create workbook with streaming
        const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
            stream: res,
            useStyles: true,
            useSharedStrings: false, // Important for memory
        });

        const worksheet = workbook.addWorksheet("Clients Data");

        // Define columns
        worksheet.columns = [
            { header: "Code", key: "code", width: 15 },
            { header: "Name", key: "name", width: 30 },
            { header: "Email", key: "email", width: 30 },
            { header: "Phone", key: "phone", width: 15 },
            { header: "Address", key: "address", width: 40 },
            { header: "City", key: "city", width: 20 },
            { header: "Country", key: "country", width: 15 },
            { header: "Sales Agent", key: "salesAgent", width: 25 },
            { header: "SAP Turnover", key: "sapTurnover", width: 15 },
            { header: "Invoice Count", key: "invoiceCount", width: 15 },
            { header: "Last Invoice Date", key: "lastInvoiceDate", width: 20 },
            { header: "Quotation Count", key: "quotationCount", width: 15 },
            { header: "Quotation Value", key: "quotationValue", width: 15 },
            { header: "Last Quotation Date", key: "lastQuotationDate", width: 20 },
            { header: "Abandoned Cart Count", key: "abandonedCartCount", width: 20 },
            { header: "Abandoned Cart Value", key: "abandonedCartValue", width: 20 },
            { header: "Last Abandoned Cart", key: "lastAbandonedCart", width: 20 },
            { header: "Customer Type", key: "customerType", width: 15 },
            { header: "Status", key: "status", width: 15 },
            { header: "Created Date", key: "createdAt", width: 20 },
        ];

        // Style the header row
        worksheet.getRow(1).font = { bold: true, size: 12 };
        worksheet.getRow(1).fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FF4472C4" },
        };
        worksheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };

        // Commit the header row
        worksheet.getRow(1).commit();

        // Build date filter for aggregations
        const dateFilter = {};
        if (startDate && endDate) {
            dateFilter.DocDate = {
                $gte: new Date(startDate),
                $lte: new Date(endDate),
            };
        } else if (startDate) {
            dateFilter.DocDate = { $gte: new Date(startDate) };
        } else if (endDate) {
            dateFilter.DocDate = { $lte: new Date(endDate) };
        }

        // Process customers in batches
        let skip = 0;
        let processedCount = 0;

        while (skip < totalCustomers) {
            console.log(`Processing batch: ${skip} to ${skip + BATCH_SIZE}`);

            // Fetch customer batch
            const customerBatch = await Customer.find(customerFilter)
                .populate("assignedTo", "firstName lastName email")
                .skip(skip)
                .limit(BATCH_SIZE)
                .lean();

            if (customerBatch.length === 0) break;

            // Get card codes for this batch
            const cardCodes = customerBatch
                .filter((c) => c.CardCode)
                .map((c) => c.CardCode);

            const customerEmails = customerBatch
                .filter((c) => c.Email)
                .map((c) => c.Email);

            // Fetch aggregated data for this batch only
            const [
                invoiceData,
                quotationData,
                abandonedOrderData,
                abandonedCartData,
            ] = await Promise.all([
                // Invoice aggregation
                Invoice.aggregate([
                    {
                        $match: {
                            CardCode: { $in: cardCodes },
                            ...dateFilter,
                        },
                    },
                    {
                        $group: {
                            _id: "$CardCode",
                            totalTurnover: { $sum: "$DocTotal" },
                            lastInvoiceDate: { $max: "$DocDate" },
                            invoiceCount: { $sum: 1 },
                        },
                    },
                ]),

                // Quotation aggregation
                SalesOrder.aggregate([
                    {
                        $match: {
                            CardCode: { $in: cardCodes },
                            DocumentStatus: "bost_Open",
                            ...dateFilter,
                        },
                    },
                    {
                        $group: {
                            _id: "$CardCode",
                            lastQuotationDate: { $max: "$DocDate" },
                            quotationCount: { $sum: 1 },
                            totalQuotationValue: { $sum: "$DocTotal" },
                        },
                    },
                ]),

                // Abandoned orders aggregation
                SalesOrder.aggregate([
                    {
                        $match: {
                            CardCode: { $in: cardCodes },
                            $or: [
                                { DocumentStatus: "bost_Close" },
                                { Cancelled: "tYES" },
                                { CancelDate: { $exists: true, $ne: null } },
                            ],
                            ...dateFilter,
                        },
                    },
                    {
                        $group: {
                            _id: "$CardCode",
                            lastAbandonedOrderDate: {
                                $max: { $ifNull: ["$CancelDate", "$DocDate"] },
                            },
                            abandonedOrderCount: { $sum: 1 },
                            totalAbandonedOrderValue: { $sum: "$DocTotal" },
                        },
                    },
                ]),

                // Abandoned carts aggregation
                Cart.aggregate([
                    {
                        $match: {
                            customerEmail: { $in: customerEmails },
                            status: "abandoned",
                            isAbandoned: true,
                            ...(startDate || endDate
                                ? {
                                    createDate: {
                                        ...(startDate && { $gte: new Date(startDate) }),
                                        ...(endDate && { $lte: new Date(endDate) }),
                                    },
                                }
                                : {}),
                        },
                    },
                    {
                        $group: {
                            _id: "$customerEmail",
                            lastAbandonedCartDate: { $max: "$createDate" },
                            abandonedCartCount: { $sum: 1 },
                            totalAbandonedValue: { $sum: "$totalIncludingTaxes" },
                        },
                    },
                ]),
            ]);

            // Create maps for quick lookup
            const invoiceMap = new Map(invoiceData.map((item) => [item._id, item]));
            const quotationMap = new Map(
                quotationData.map((item) => [item._id, item])
            );
            const abandonedOrderMap = new Map(
                abandonedOrderData.map((item) => [item._id, item])
            );
            const abandonedCartMap = new Map(
                abandonedCartData.map((item) => [item._id, item])
            );

            // Write rows for this batch
            for (const customer of customerBatch) {
                const cardCode = customer.CardCode || customer.tempCardCode;
                const customerEmail = customer.Email;

                const invoiceDataItem = invoiceMap.get(cardCode) || {};
                const quotationDataItem = quotationMap.get(cardCode) || {};
                const abandonedOrderDataItem = abandonedOrderMap.get(cardCode) || {};
                const abandonedCartDataItem = abandonedCartMap.get(customerEmail) || {};

                // Combine abandoned cart and order data
                const totalAbandonedCount =
                    (abandonedOrderDataItem.abandonedOrderCount || 0) +
                    (abandonedCartDataItem.abandonedCartCount || 0);

                const totalAbandonedValue =
                    (abandonedOrderDataItem.totalAbandonedOrderValue || 0) +
                    (abandonedCartDataItem.totalAbandonedValue || 0);

                // Get the most recent abandoned date
                const dates = [
                    abandonedOrderDataItem.lastAbandonedOrderDate,
                    abandonedCartDataItem.lastAbandonedCartDate,
                ].filter(Boolean);

                const lastAbandonedDate =
                    dates.length > 0 ? new Date(Math.max(...dates.map((d) => new Date(d)))) : null;

                // Format address
                let fullAddress = "";
                if (customer.address) {
                    const parts = [
                        customer.address.street,
                        customer.address.zipCode,
                        customer.address.city,
                    ].filter(Boolean);
                    fullAddress = parts.join(", ");
                }

                // Get sales agent name
                let salesAgentName = "Unassigned";
                if (customer.assignedTo) {
                    salesAgentName = `${customer.assignedTo.firstName || ""} ${customer.assignedTo.lastName || ""
                        }`.trim();
                }

                // Add row and commit immediately
                const row = worksheet.addRow({
                    code: cardCode || "N/A",
                    name: customer.CardName || "",
                    email: customer.Email || "",
                    phone: customer.phoneNumber || "",
                    address: fullAddress,
                    city: customer.address?.city || "",
                    country: customer.address?.country || "",
                    salesAgent: salesAgentName,
                    sapTurnover: invoiceDataItem.totalTurnover || 0,
                    invoiceCount: invoiceDataItem.invoiceCount || 0,
                    lastInvoiceDate: invoiceDataItem.lastInvoiceDate
                        ? new Date(invoiceDataItem.lastInvoiceDate)
                            .toISOString()
                            .split("T")[0]
                        : "N/A",
                    quotationCount: quotationDataItem.quotationCount || 0,
                    quotationValue: quotationDataItem.totalQuotationValue || 0,
                    lastQuotationDate: quotationDataItem.lastQuotationDate
                        ? new Date(quotationDataItem.lastQuotationDate)
                            .toISOString()
                            .split("T")[0]
                        : "N/A",
                    abandonedCartCount: totalAbandonedCount,
                    abandonedCartValue: totalAbandonedValue,
                    lastAbandonedCart: lastAbandonedDate
                        ? lastAbandonedDate.toISOString().split("T")[0]
                        : "N/A",
                    customerType: customer.customerType || "N/A",
                    status: customer.status || "N/A",
                    createdAt: customer.createdAt
                        ? new Date(customer.createdAt).toISOString().split("T")[0]
                        : "N/A",
                });

                row.commit();
                processedCount++;
            }

            skip += BATCH_SIZE;

            // Clear maps to free memory
            invoiceMap.clear();
            quotationMap.clear();
            abandonedOrderMap.clear();
            abandonedCartMap.clear();

            console.log(`Processed ${processedCount} / ${totalCustomers} customers`);
        }

        // Commit the worksheet
        await worksheet.commit();

        // Finalize the workbook
        await workbook.commit();

        console.log("Export completed successfully");
    } catch (error) {
        console.error("Error exporting clients data:", error);

        // If headers not sent yet, send error response
        if (!res.headersSent) {
            return res.status(500).json({
                success: false,
                message: "Failed to export clients data",
                error: error.message,
            });
        }
    }
};

/**
 * Export detailed sales insights data
 * OPTIMIZED VERSION - Uses streaming for large datasets
 */
exports.exportSalesInsights = async (req, res) => {
    try {
        const { startDate, endDate, cardCode } = req.query;

        // Build date filter
        const dateFilter = {};
        if (startDate && endDate) {
            dateFilter.DocDate = {
                $gte: new Date(startDate),
                $lte: new Date(endDate),
            };
        } else if (startDate) {
            dateFilter.DocDate = { $gte: new Date(startDate) };
        } else if (endDate) {
            dateFilter.DocDate = { $lte: new Date(endDate) };
        }

        // Build card filter
        const cardFilter = cardCode ? { CardCode: cardCode } : {};

        // Set response headers
        res.setHeader(
            "Content-Type",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        );
        res.setHeader(
            "Content-Disposition",
            `attachment; filename=sales_insights_${new Date()
                .toISOString()
                .split("T")[0]}.xlsx`
        );

        // Create streaming workbook
        const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
            stream: res,
            useStyles: true,
            useSharedStrings: false,
        });

        // ========== INVOICES SHEET ==========
        const invoiceSheet = workbook.addWorksheet("Invoices");
        invoiceSheet.columns = [
            { header: "Doc Entry", key: "docEntry", width: 12 },
            { header: "Doc Num", key: "docNum", width: 12 },
            { header: "Date", key: "docDate", width: 15 },
            { header: "Customer Code", key: "cardCode", width: 15 },
            { header: "Customer Name", key: "cardName", width: 30 },
            { header: "Sales Agent", key: "salesAgent", width: 25 },
            { header: "Total (Gross)", key: "docTotal", width: 15 },
            { header: "VAT", key: "vatSum", width: 12 },
            { header: "Total (Net)", key: "netTotal", width: 15 },
            { header: "Paid Amount", key: "paidAmount", width: 15 },
            { header: "Balance", key: "balance", width: 15 },
            { header: "Payment Status", key: "paymentStatus", width: 15 },
            { header: "Payment Method", key: "paymentMethod", width: 15 },
            { header: "Tag", key: "tag", width: 15 },
            { header: "Status", key: "documentStatus", width: 15 },
        ];

        invoiceSheet.getRow(1).font = { bold: true };
        invoiceSheet.getRow(1).fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FF70AD47" },
        };
        invoiceSheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
        invoiceSheet.getRow(1).commit();

        // Stream invoices
        const invoiceCursor = Invoice.find({ ...dateFilter, ...cardFilter })
            .populate("salesAgent", "firstName lastName email")
            .cursor();

        for (let invoice = await invoiceCursor.next(); invoice != null; invoice = await invoiceCursor.next()) {
            const salesAgentName = invoice.salesAgent
                ? `${invoice.salesAgent.firstName || ""} ${invoice.salesAgent.lastName || ""
                    }`.trim()
                : "N/A";

            const row = invoiceSheet.addRow({
                docEntry: invoice.DocEntry,
                docNum: invoice.DocNum,
                docDate: invoice.DocDate
                    ? new Date(invoice.DocDate).toISOString().split("T")[0]
                    : "N/A",
                cardCode: invoice.CardCode,
                cardName: invoice.CardName,
                salesAgent: salesAgentName,
                docTotal: invoice.DocTotal || 0,
                vatSum: invoice.VatSum || 0,
                netTotal: (invoice.DocTotal || 0) - (invoice.VatSum || 0),
                paidAmount: invoice.totalPaidAmount || 0,
                balance: invoice.remainingBalance || 0,
                paymentStatus: invoice.paymentStatus || "Unknown",
                paymentMethod: invoice.paymentMethod || "Unknown",
                tag: invoice.tag || "None",
                documentStatus: invoice.DocumentStatus || "N/A",
            });
            row.commit();
        }

        await invoiceSheet.commit();

        // ========== QUOTATIONS SHEET ==========
        const quotationSheet = workbook.addWorksheet("Quotations");
        quotationSheet.columns = [
            { header: "Doc Entry", key: "docEntry", width: 12 },
            { header: "Doc Num", key: "docNum", width: 12 },
            { header: "Date", key: "docDate", width: 15 },
            { header: "Due Date", key: "docDueDate", width: 15 },
            { header: "Customer Code", key: "cardCode", width: 15 },
            { header: "Customer Name", key: "cardName", width: 30 },
            { header: "Sales Agent", key: "salesAgent", width: 25 },
            { header: "Total (Gross)", key: "docTotal", width: 15 },
            { header: "VAT", key: "vatSum", width: 12 },
            { header: "Total (Net)", key: "netTotal", width: 15 },
            { header: "Status", key: "documentStatus", width: 15 },
            { header: "Comments", key: "comments", width: 30 },
        ];

        quotationSheet.getRow(1).font = { bold: true };
        quotationSheet.getRow(1).fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FF5B9BD5" },
        };
        quotationSheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
        quotationSheet.getRow(1).commit();

        // Stream quotations
        const quotationCursor = SalesOrder.find({
            ...dateFilter,
            ...cardFilter,
            DocumentStatus: "bost_Open",
        })
            .populate("salesAgent", "firstName lastName email")
            .cursor();

        for (let quotation = await quotationCursor.next(); quotation != null; quotation = await quotationCursor.next()) {
            const salesAgentName = quotation.salesAgent
                ? `${quotation.salesAgent.firstName || ""} ${quotation.salesAgent.lastName || ""
                    }`.trim()
                : "N/A";

            const row = quotationSheet.addRow({
                docEntry: quotation.DocEntry,
                docNum: quotation.DocNum,
                docDate: quotation.DocDate
                    ? new Date(quotation.DocDate).toISOString().split("T")[0]
                    : "N/A",
                docDueDate: quotation.DocDueDate
                    ? new Date(quotation.DocDueDate).toISOString().split("T")[0]
                    : "N/A",
                cardCode: quotation.CardCode,
                cardName: quotation.CardName,
                salesAgent: salesAgentName,
                docTotal: quotation.DocTotal || 0,
                vatSum: quotation.VatSum || 0,
                netTotal: (quotation.DocTotal || 0) - (quotation.VatSum || 0),
                documentStatus: quotation.DocumentStatus || "N/A",
                comments: quotation.Comments || "",
            });
            row.commit();
        }

        await quotationSheet.commit();

        // ========== ABANDONED CARTS SHEET ==========
        const abandonedSheet = workbook.addWorksheet("Abandoned Carts & Orders");
        abandonedSheet.columns = [
            { header: "Source", key: "source", width: 15 },
            { header: "ID", key: "id", width: 20 },
            { header: "Doc Entry", key: "docEntry", width: 12 },
            { header: "Doc Num", key: "docNum", width: 12 },
            { header: "Date", key: "docDate", width: 15 },
            { header: "Cancel/Abandon Date", key: "cancelDate", width: 20 },
            { header: "Customer Code", key: "cardCode", width: 15 },
            { header: "Customer Name", key: "cardName", width: 30 },
            { header: "Customer Email", key: "customerEmail", width: 30 },
            { header: "Sales Agent", key: "salesAgent", width: 25 },
            { header: "Total (Gross)", key: "docTotal", width: 15 },
            { header: "VAT", key: "vatSum", width: 12 },
            { header: "Total (Net)", key: "netTotal", width: 15 },
            { header: "Reason/Status", key: "reason", width: 30 },
            { header: "Products Count", key: "productsCount", width: 15 },
            { header: "Recovery Email Sent", key: "recoveryEmailSent", width: 18 },
        ];

        abandonedSheet.getRow(1).font = { bold: true };
        abandonedSheet.getRow(1).fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FFED7D31" },
        };
        abandonedSheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
        abandonedSheet.getRow(1).commit();

        // Stream abandoned orders
        const abandonedOrderCursor = SalesOrder.find({
            ...dateFilter,
            ...cardFilter,
            $or: [
                { DocumentStatus: "bost_Close" },
                { Cancelled: "tYES" },
                { CancelDate: { $exists: true, $ne: null } },
            ],
        })
            .populate("salesAgent", "firstName lastName email")
            .cursor();

        for (let order = await abandonedOrderCursor.next(); order != null; order = await abandonedOrderCursor.next()) {
            const salesAgentName = order.salesAgent
                ? `${order.salesAgent.firstName || ""} ${order.salesAgent.lastName || ""
                    }`.trim()
                : "N/A";

            const row = abandonedSheet.addRow({
                source: "Sales Order",
                id: order._id.toString(),
                docEntry: order.DocEntry,
                docNum: order.DocNum,
                docDate: order.DocDate
                    ? new Date(order.DocDate).toISOString().split("T")[0]
                    : "N/A",
                cancelDate: order.CancelDate
                    ? new Date(order.CancelDate).toISOString().split("T")[0]
                    : "N/A",
                cardCode: order.CardCode,
                cardName: order.CardName,
                customerEmail: "N/A",
                salesAgent: salesAgentName,
                docTotal: order.DocTotal || 0,
                vatSum: order.VatSum || 0,
                netTotal: (order.DocTotal || 0) - (order.VatSum || 0),
                reason: order.CancelReason || order.DocumentStatus || "Not specified",
                productsCount: order.DocumentLines?.length || 0,
                recoveryEmailSent: "N/A",
            });
            row.commit();
        }

        // Stream abandoned carts
        const cartDateFilter = {};
        if (startDate && endDate) {
            cartDateFilter.createDate = {
                $gte: new Date(startDate),
                $lte: new Date(endDate),
            };
        } else if (startDate) {
            cartDateFilter.createDate = { $gte: new Date(startDate) };
        } else if (endDate) {
            cartDateFilter.createDate = { $lte: new Date(endDate) };
        }

        let cartEmailFilter = {};
        if (cardCode) {
            const customer = await Customer.findOne({ CardCode: cardCode }).lean();
            if (customer && customer.Email) {
                cartEmailFilter.customerEmail = customer.Email;
            }
        }

        const cartCursor = Cart.find({
            ...cartDateFilter,
            ...cartEmailFilter,
            status: "abandoned",
            isAbandoned: true,
        }).cursor();

        for (let cart = await cartCursor.next(); cart != null; cart = await cartCursor.next()) {
            const row = abandonedSheet.addRow({
                source: "Website Cart",
                id: cart.cartId || cart._id.toString(),
                docEntry: "N/A",
                docNum: "N/A",
                docDate: cart.createDate
                    ? new Date(cart.createDate).toISOString().split("T")[0]
                    : "N/A",
                cancelDate: cart.lastModifiedDate
                    ? new Date(cart.lastModifiedDate).toISOString().split("T")[0]
                    : "N/A",
                cardCode: cart.clientId || "N/A",
                cardName: cart.customerName,
                customerEmail: cart.customerEmail || "N/A",
                salesAgent: "N/A",
                docTotal: cart.totalIncludingTaxes || 0,
                vatSum: cart.estimatedTaxAmount || 0,
                netTotal: cart.totalExcludingTaxes || 0,
                reason: cart.status || "Abandoned",
                productsCount: cart.products?.length || 0,
                recoveryEmailSent: cart.recoveryEmailSent ? "Yes" : "No",
            });
            row.commit();
        }

        await abandonedSheet.commit();

        // Finalize workbook
        await workbook.commit();

        console.log("Sales insights export completed successfully");
    } catch (error) {
        console.error("Error exporting sales insights:", error);

        if (!res.headersSent) {
            return res.status(500).json({
                success: false,
                message: "Failed to export sales insights",
                error: error.message,
            });
        }
    }
};

module.exports = exports;