const Customer = require("../models/Customer"); // Adjust path as needed
const {
    generateNextCardCode,
    formatCustomerForSAP,
    createCustomerInSAP,
    createCustomerInSAPWithUniqueCode,
    checkCustomerExistsInSAP,
} = require("../utils/sapB1CustomerIntegration");

// Sync all customers with SAP and assign proper CardCodes
exports.syncAllCustomersWithSAP = async (req, res) => {
    try {
        console.log("Starting bulk customer sync with SAP...");

        // Find all customers that need syncing
        // Either they have duplicate C6001 or are not synced with SAP
        const customersToSync = await Customer.find({
            $and: [
                { CardCode: "C6001" },
                { SyncedWithSAP: { $ne: true } }
            ],
        }).sort({ createdAt: 1 }); // Oldest first to maintain order

        console.log(`Found ${customersToSync.length} customers to sync`);

        if (customersToSync.length === 0) {
            return res.status(200).json({
                success: true,
                message: "No customers need syncing",
                stats: {
                    total: 0,
                    synced: 0,
                    failed: 0,
                },
            });
        }

        const results = {
            total: customersToSync.length,
            synced: 0,
            failed: 0,
            errors: [],
            syncedCustomers: [],
        };

        // Process each customer
        for (const customer of customersToSync) {
            try {
                console.log(`\n--- Processing customer: ${customer.CardName} ---`);

                // Allocate a unique CardCode and create in SAP atomically. This
                // self-heals against collisions instead of skipping the customer.
                const sapResponse = await createCustomerInSAPWithUniqueCode(customer);
                console.log(`Synced ${customer.CardName} as ${sapResponse.CardCode}`);

                // Update customer in database
                customer.SyncedWithSAP = true;
                customer.LocalStatus = "Synced";
                customer.LastSyncAttempt = new Date();
                customer.SAPSyncDisabled = false;

                await customer.save();

                results.synced++;
                results.syncedCustomers.push({
                    name: customer.CardName,
                    email: customer.Email,
                    oldCardCode: "C6001",
                    newCardCode: newCardCode,
                });

                console.log(`✓ Successfully synced ${customer.CardName} with CardCode ${newCardCode}`);

                // Add a small delay to avoid overwhelming SAP (optional)
                await new Promise((resolve) => setTimeout(resolve, 500));
            } catch (error) {
                console.error(`✗ Failed to sync customer ${customer.CardName}:`, error.message);

                results.failed++;
                results.errors.push({
                    customer: customer.CardName,
                    email: customer.Email,
                    error: error.message,
                });

                // Update customer with failed status
                try {
                    customer.LocalStatus = "SyncFailed";
                    customer.LastSyncAttempt = new Date();
                    await customer.save();
                } catch (saveError) {
                    console.error("Error saving failed sync status:", saveError.message);
                }
            }
        }

        console.log("\n=== Sync Complete ===");
        console.log(`Total: ${results.total}`);
        console.log(`Synced: ${results.synced}`);
        console.log(`Failed: ${results.failed}`);

        return res.status(200).json({
            success: true,
            message: "Bulk sync completed",
            stats: results,
        });
    } catch (error) {
        console.error("Error in bulk sync:", error.message);
        return res.status(500).json({
            success: false,
            message: "Failed to sync customers with SAP",
            error: error.message,
        });
    }
};

// Sync a single customer with SAP
exports.syncSingleCustomer = async (req, res) => {
    try {
        const { customerId } = req.params;

        const customer = await Customer.findById(customerId);

        if (!customer) {
            return res.status(404).json({
                success: false,
                message: "Customer not found",
            });
        }

        console.log(`Syncing customer: ${customer.CardName}`);

        // A customer needs a freshly allocated CardCode if it has none or still
        // carries the placeholder "C6001".
        const needsNewCardCode =
            !customer.CardCode || customer.CardCode === "C6001";

        if (needsNewCardCode) {
            // Allocate a unique CardCode and create in SAP atomically.
            await createCustomerInSAPWithUniqueCode(customer);
        } else {
            // Already has an intended CardCode — create with it, unless it is
            // already present in SAP (then just mark it synced locally).
            const existsInSAP = await checkCustomerExistsInSAP(customer.CardCode);

            if (existsInSAP) {
                customer.SyncedWithSAP = true;
                customer.LocalStatus = "Synced";
                customer.LastSyncAttempt = new Date();
                await customer.save();

                return res.status(200).json({
                    success: true,
                    message: "Customer already exists in SAP",
                    customer: {
                        name: customer.CardName,
                        cardCode: customer.CardCode,
                    },
                });
            }

            const sapCustomerData = await formatCustomerForSAP(customer);
            await createCustomerInSAP(sapCustomerData);
        }

        // Update database
        customer.SyncedWithSAP = true;
        customer.LocalStatus = "Synced";
        customer.LastSyncAttempt = new Date();
        customer.SAPSyncDisabled = false;
        await customer.save();

        return res.status(200).json({
            success: true,
            message: "Customer synced successfully with SAP",
            customer: {
                name: customer.CardName,
                cardCode: customer.CardCode,
                email: customer.Email,
            },
        });
    } catch (error) {
        console.error("Error syncing single customer:", error.message);
        return res.status(500).json({
            success: false,
            message: "Failed to sync customer with SAP",
            error: error.message,
        });
    }
};

// Get sync status for all customers
exports.getSyncStatus = async (req, res) => {
    try {
        const totalCustomers = await Customer.countDocuments();
        const syncedCustomers = await Customer.countDocuments({ SyncedWithSAP: true });
        const duplicateCardCodes = await Customer.countDocuments({ CardCode: "C6001" });
        const notSynced = await Customer.countDocuments({
            $or: [
                { SyncedWithSAP: { $ne: true } },
                { CardCode: "C6001" },
            ]
        });

        const failedSyncs = await Customer.find({ LocalStatus: "SyncFailed" })
            .select("CardName Email CardCode LastSyncAttempt")
            .limit(20);

        return res.status(200).json({
            success: true,
            stats: {
                total: totalCustomers,
                synced: syncedCustomers,
                notSynced: notSynced,
                duplicateCardCodes: duplicateCardCodes,
                failedSyncs: failedSyncs.length,
            },
            failedSyncs,
        });
    } catch (error) {
        console.error("Error getting sync status:", error.message);
        return res.status(500).json({
            success: false,
            message: "Failed to get sync status",
            error: error.message,
        });
    }
};