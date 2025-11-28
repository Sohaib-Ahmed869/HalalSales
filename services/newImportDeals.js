// importDealsCSV.js
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const Deal = require("../models/Deal");
const cheerio = require("cheerio");
const csv = require("csv-parser"); // You'll need to install this: npm install csv-parser

// Connect to MongoDB
mongoose
  .connect(
    process.env.MONGODB_URI
  )
  .then(() => console.log("MongoDB connected"))
  .catch((err) => {
    console.error("MongoDB connection error:", err);
    process.exit(1);
  });

async function importDealsFromCSV() {
  try {
    // Point to the CSV file - make sure to save your Excel as CSV first!
    const filePath = path.join(__dirname, "all-deals.csv");
    console.log(`Opening CSV file: ${filePath}`);

    // Check if file exists
    if (!fs.existsSync(filePath)) {
      throw new Error(`File does not exist: ${filePath}`);
    }

    // Track progress
    let processedCount = 0;
    let successCount = 0;
    let errorCount = 0;
    let startTime = Date.now();

    // Process in batches
    const BATCH_SIZE = 100;
    let currentBatch = [];
    let lastLogTime = Date.now();

    // Create a promise to track completion
    const importComplete = new Promise((resolve, reject) => {
      const stream = fs.createReadStream(filePath).pipe(
        csv({
          // Use relaxed parsing for potentially messy CSV files
          separator: ",",
          quote: '"',
          escape: '"',
          skipLines: 0,
          headers: true,
          skipEmptyLines: true,
        })
      );

      let streamPaused = false;

      stream.on("data", async (dealData) => {
        processedCount++;
        currentBatch.push(dealData);

        // Log progress periodically (every 5 seconds) rather than per row
        const currentTime = Date.now();
        if (currentTime - lastLogTime > 5000) {
          const elapsedSeconds = Math.round((currentTime - startTime) / 1000);
          const rowsPerSecond = Math.round(processedCount / elapsedSeconds);
          console.log(
            `⏳ Processed ${processedCount} rows in ${elapsedSeconds} seconds (${rowsPerSecond} rows/sec)`
          );
          lastLogTime = currentTime;
        }

        // Process batch when it reaches the batch size
        if (currentBatch.length >= BATCH_SIZE && !streamPaused) {
          // Pause the stream while we process the batch
          streamPaused = true;
          stream.pause();

          try {
            await processBatch([...currentBatch]); // Process a copy of the batch
            currentBatch = []; // Clear the batch

            // Resume the stream
            streamPaused = false;
            stream.resume();
          } catch (batchError) {
            console.error("Error processing batch:", batchError);
            reject(batchError);
          }
        }
      });

      stream.on("end", async () => {
        // Process any remaining records in the last batch
        if (currentBatch.length > 0) {
          try {
            await processBatch(currentBatch);
          } catch (finalBatchError) {
            console.error("Error processing final batch:", finalBatchError);
            reject(finalBatchError);
            return;
          }
        }

        const totalTime = Math.round((Date.now() - startTime) / 1000);
        console.log("\n🎉 === IMPORT SUMMARY ===");
        console.log(`📈 Total rows processed: ${processedCount}`);
        console.log(`✅ Successful imports: ${successCount}`);
        console.log(`❌ Errors: ${errorCount}`);
        console.log(`⏱️  Total time: ${totalTime} seconds`);
        console.log(
          `🚀 Average speed: ${Math.round(processedCount / totalTime)} rows/sec`
        );
        console.log("🏁 Import completed successfully!");
        resolve();
      });

      stream.on("error", (err) => {
        console.error("CSV parsing error:", err);
        reject(err);
      });
    });

    // Function to process a batch of records
    async function processBatch(batch) {
      console.log(`\n🔄 Processing batch of ${batch.length} records...`);

      for (const dealData of batch) {
        try {
          // Extract products HTML if available - Fix encoding issue
          let products = [];
          const productsHTML =
            dealData["Panier abandonné Produits HTML"] ||
            dealData["Panier abandonn� Produits HTML"];
          if (productsHTML) {
            console.log(`📦 Parsing products for deal...`);
            products = parseProductsHTML(productsHTML);
            console.log(
              `✅ Found ${products.length} products:`,
              products.map((p) => `${p.name} (${p.quantity}x)`)
            );
          } else {
            console.log(`⚠️  No products HTML found for this deal`);
          }

          // Create a simplified deal object
          const dealObj = {
            recordId:
              dealData["Record ID"] ||
              dealData["RecordID"] ||
              dealData["Id"] ||
              null,
            abandonedCartUrl:
              dealData["Abandoned cart URL"] || dealData["Cart URL"] || null,
            billingAddress: {
              line1:
                dealData["Adresse de facturation ligne 1)"] ||
                dealData["Billing Address Line 1"] ||
                null,
              line2:
                dealData["Adresse de facturation, ligne 2)"] ||
                dealData["Billing Address Line 2"] ||
                null,
              city:
                dealData["Ville de facturation"] ||
                dealData["Billing City"] ||
                null,
              state:
                dealData["État/province de facturation"] ||
                dealData["Billing State"] ||
                null,
              postalCode:
                dealData["Code postal de facturation"] ||
                dealData["Billing Postal Code"] ||
                null,
              country:
                dealData["Pays de facturation"] ||
                dealData["Billing Country"] ||
                null,
              phone:
                dealData["Téléphone de contact de facturation"] ||
                dealData["Billing Phone"] ||
                null,
              mobilePhone:
                dealData["Contact facturation téléphone portable"] ||
                dealData["Billing Mobile"] ||
                null,
            },
            shippingAddress: {
              line1:
                dealData["Adresse de livraison (ligne 1)"] ||
                dealData["Shipping Address Line 1"] ||
                null,
              line2:
                dealData["Adresse de livraison (ligne 2)"] ||
                dealData["Shipping Address Line 2"] ||
                null,
              city:
                dealData["Ville d¨expédition"] ||
                dealData["Shipping City"] ||
                null,
              state:
                dealData["État/province d¨expédition"] ||
                dealData["Shipping State"] ||
                null,
              postalCode:
                dealData["Code postal d¨expédition"] ||
                dealData["Shipping Postal Code"] ||
                null,
              country:
                dealData["Pays de livraison"] ||
                dealData["Shipping Country"] ||
                null,
              phone:
                dealData["Téléphone de contact d¨expédition"] ||
                dealData["Shipping Phone"] ||
                null,
              mobilePhone:
                dealData["Téléphone portable de contact d¨expédition"] ||
                dealData["Shipping Mobile"] ||
                null,
            },
            amount: parseFloat(dealData["Amount"] || 0) || 0,
            amountInCompanyCurrency:
              parseFloat(dealData["Amount in company currency"] || 0) || 0,
            currency: dealData["Currency"] || "EUR",
            createDate: dealData["Create Date"]
              ? new Date(dealData["Create Date"])
              : null,
            closeDate: dealData["Close Date"]
              ? new Date(dealData["Close Date"])
              : null,
            dealName: dealData["Deal Name"] || null,
            dealOwner: dealData["Deal owner"] || null,
            dealProbability: parseFloat(dealData["Deal probability"] || 0) || 0,
            dealStage: dealData["Deal Stage"] || null,
            dealType: dealData["Deal Type"] || null,
            orderNumber: dealData["Order number"] || null,
            products: products,
            isPaid:
              dealData["Payé"] === "true" ||
              dealData["Payé"] === "1" ||
              dealData["Paid"] === "true" ||
              dealData["Paid"] === "1",
            isClosedWon:
              dealData["Is Closed Won"] === "true" ||
              dealData["Is Closed Won"] === "1",
            isClosedLost:
              dealData["Is closed lost"] === "true" ||
              dealData["Is closed lost"] === "1",
            isClosed:
              dealData["Is Deal Closed?"] === "true" ||
              dealData["Is Deal Closed?"] === "1",
            pipeline: dealData["Pipeline"] || "Ecommerce Pipeline",
            totalProductsWithTaxes:
              parseFloat(dealData["Total des produits avec taxes"] || 0) || 0,
            totalExcludingTaxes:
              parseFloat(dealData["Total hors taxes"] || 0) || 0,
            totalIncludingTaxes:
              parseFloat(dealData["Total taxes incluses"] || 0) || 0,
            taxPrice: parseFloat(dealData["Tax price"] || 0) || 0,
            paymentMethod:
              dealData["Mode de paiement de la commande"] ||
              dealData["Payment Method"] ||
              null,
            customerName: dealData["Associated Contact"] || null, // This field doesn't exist in CSV
            customerEmail:
              extractEmailFromContact(dealData["Associated Contact"]) ||
              dealData["Email"] ||
              null,
            lastModifiedDate: dealData["Last Modified Date"]
              ? new Date(dealData["Last Modified Date"])
              : null,
            contactInfo: {
              phone:
                dealData["Téléphone de contact de facturation"] ||
                dealData["Phone"] ||
                null,
              mobilePhone:
                dealData["Contact facturation téléphone portable"] ||
                dealData["Mobile"] ||
                null,
              email:
                extractEmailFromContact(dealData["Associated Contact"]) ||
                dealData["Email"] ||
                null, // Associated Contact doesn't exist
            },
            source:
              dealData["Original Traffic Source"] || dealData["Source"] || null,
            sourceDetail:
              dealData["Original Traffic Source Drill-Down 1"] ||
              dealData["Source Detail"] ||
              null,
          };

          // Log the deal object being stored
          console.log(`\n💾 STORING DEAL:`);
          console.log(`📋 Deal ID: ${dealObj.recordId || "NEW"}`);
          console.log(
            `🛒 Order Number: ${dealObj.orderNumber || "N/A"} (from CSV: ${
              dealData["Order number"] || "N/A"
            })`
          );
          console.log(
            `💰 Amount: ${dealObj.amount} ${dealObj.currency} (from CSV: ${
              dealData["Amount"] || "N/A"
            })`
          );
          console.log(`👤 Customer: ${dealObj.customerName || "N/A"}`);
          console.log(`📧 Email: ${dealObj.customerEmail || "N/A"}`);
          console.log(
            `📍 City: ${
              dealObj.shippingAddress?.city ||
              dealObj.billingAddress?.city ||
              "N/A"
            }`
          );
          console.log(`📦 Products: ${dealObj.products.length} items`);
          if (dealObj.products.length > 0) {
            dealObj.products.forEach((product, idx) => {
              console.log(
                `   ${idx + 1}. ${product.name} - ${product.quantity}x €${
                  product.price
                } = €${product.totalPrice}`
              );
            });
          }
          console.log(`💳 Payment Method: ${dealObj.paymentMethod || "N/A"}`);
          console.log(`✅ Is Paid: ${dealObj.isPaid}`);
          console.log(`🏢 Pipeline: ${dealObj.pipeline}`);
          console.log(`📊 Stage: ${dealObj.dealStage || "N/A"}`);
          console.log(`📈 Source: ${dealObj.source || "N/A"}`);
          console.log(`🔍 DEBUG - Raw CSV fields:`);
          console.log(`   - Record ID: "${dealData["Record ID"]}"`);
          console.log(`   - Amount: "${dealData["Amount"]}"`);
          console.log(`   - Order number: "${dealData["Order number"]}"`);
          console.log(`   - Deal Name: "${dealData["Deal Name"]}"`);
          console.log(
            `   - Products HTML: ${productsHTML ? "EXISTS" : "MISSING"}`
          );
          console.log(`---`);

          // Validate if deal has meaningful data before storing
          const hasValidData =
            dealObj.recordId ||
            dealObj.orderNumber ||
            dealObj.amount > 0 ||
            dealObj.products.length > 0 ||
            dealObj.customerName ||
            dealObj.customerEmail ||
            dealObj.dealName;

          if (!hasValidData) {
            console.log(`🚫 SKIPPING empty deal - no meaningful data found`);
            console.log(
              `   Raw data check: recordId=${dealObj.recordId}, orderNumber=${dealObj.orderNumber}, amount=${dealObj.amount}, products=${dealObj.products.length}, customer=${dealObj.customerName}`
            );
            continue; // Skip this deal entirely
          }

          // Only process records with meaningful data
          if (dealObj.recordId) {
            // Use updateOne with upsert option to avoid _id issues
            const result = await Deal.updateOne(
              { recordId: dealObj.recordId },
              { $set: dealObj },
              { upsert: true, runValidators: true }
            );

            if (result.upsertedCount > 0) {
              console.log(`✨ NEW deal created with ID: ${dealObj.recordId}`);
            } else {
              console.log(
                `🔄 UPDATED existing deal with ID: ${dealObj.recordId}`
              );
            }
            successCount++;
          } else if (
            dealObj.orderNumber ||
            dealObj.dealName ||
            dealObj.customerName
          ) {
            // Only create deals without recordId if they have other identifying info
            const newDeal = new Deal(dealObj);
            const savedDeal = await newDeal.save();
            console.log(
              `✨ NEW deal created without recordID: ${savedDeal._id} (has: ${
                dealObj.orderNumber || dealObj.dealName || dealObj.customerName
              })`
            );
            successCount++;
          } else {
            console.log(
              `🚫 SKIPPING deal - no recordId and no other identifying information`
            );
          }
        } catch (saveError) {
          console.error(`❌ ERROR saving deal: ${saveError.message}`);
          console.error(`📋 Deal data that failed:`, {
            recordId: dealData["Record ID"] || "N/A",
            orderNumber: dealData["Order number"] || "N/A",
            customerName: dealData["Associated Contact"] || "N/A",
          });
          errorCount++;
        }
      }

      console.log(
        `\n📊 Batch complete. Progress: ${processedCount} rows processed, ${successCount} successful, ${errorCount} errors`
      );
    }

    // Wait for import to complete
    await importComplete;
    process.exit(0);
  } catch (error) {
    console.error("Import error:", error);
    process.exit(1);
  }
}

function parseProductsHTML(html) {
  const products = [];
  try {
    if (!html) return products;

    const $ = cheerio.load(html);

    // Process each row in the HTML table
    $("tr").each((i, row) => {
      const productCells = $(row).find("td");

      // Check if we have cells to extract product info
      if (productCells.length > 0) {
        // Process cells in groups of 6 (each product has 6 cells)
        for (let j = 0; j < productCells.length; j += 6) {
          // Skip if not enough cells left for a complete product
          if (j + 5 >= productCells.length) break;

          try {
            // Extract image URL from first cell
            const imageUrl = $(productCells[j]).find("img").attr("src") || null;

            // Extract product name from second cell
            const name = $(productCells[j + 1])
              .find("a")
              .text()
              .trim();

            // Skip if no product name found
            if (!name) continue;

            // Extract price from third cell - remove € symbol and convert comma to dot
            const priceText = $(productCells[j + 2])
              .find(".price")
              .text()
              .replace("€", "")
              .replace(",", ".")
              .trim();
            const price = parseFloat(priceText) || 0;

            // Extract quantity from fifth cell
            const quantityText = $(productCells[j + 4])
              .find(".quantity")
              .text()
              .trim();
            const quantity = parseInt(quantityText) || 1;

            // Extract total price from sixth cell
            const totalPriceText = $(productCells[j + 5])
              .find("strong")
              .text()
              .replace("€", "")
              .replace(",", ".")
              .trim();
            const totalPrice = parseFloat(totalPriceText) || 0;

            // Only add product if we have essential data
            if (name && (price > 0 || totalPrice > 0)) {
              console.log(
                `   ✅ Product parsed: ${name} - ${quantity}x €${price} = €${totalPrice}`
              );
              products.push({
                name,
                price,
                quantity,
                totalPrice,
                imageUrl,
              });
            } else {
              console.log(
                `   ⚠️  Skipped product (missing data): ${name || "No name"}`
              );
            }
          } catch (productError) {
            console.error(
              `   ❌ Error parsing individual product at position ${j}:`,
              productError.message
            );
            // Continue processing other products even if one fails
          }
        }
      }
    });
  } catch (error) {
    console.error("Error parsing product HTML:", error);
  }

  return products;
}

// Helper function to extract email from contact string like "Name (email@domain.com)"
function extractEmailFromContact(contactString) {
  if (!contactString) return null;

  const emailMatch = contactString.match(/\(([^)]+)\)/);
  if (emailMatch && emailMatch[1] && emailMatch[1].includes("@")) {
    return emailMatch[1];
  }
  return null;
}

// Run the import function
importDealsFromCSV();
