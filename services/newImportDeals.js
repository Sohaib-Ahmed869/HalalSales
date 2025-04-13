// importDealsCSV.js
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const Deal = require("../models/Deal");
const cheerio = require("cheerio");
const csv = require("csv-parser"); // You'll need to install this: npm install csv-parser

// Connect to MongoDB
mongoose
  .connect(process.env.MONGODB_URI || "mongodb://localhost:27017/salesHalal")
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
            `Processed ${processedCount} rows in ${elapsedSeconds} seconds (${rowsPerSecond} rows/sec)`
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
        console.log("\n--- Import Summary ---");
        console.log(`Total rows processed: ${processedCount}`);
        console.log(`Successful imports: ${successCount}`);
        console.log(`Errors: ${errorCount}`);
        console.log(`Total time: ${totalTime} seconds`);
        console.log(
          `Average speed: ${Math.round(processedCount / totalTime)} rows/sec`
        );
        console.log("Import completed");
        resolve();
      });

      stream.on("error", (err) => {
        console.error("CSV parsing error:", err);
        reject(err);
      });
    });

    // Function to process a batch of records
    async function processBatch(batch) {
      console.log(`Processing batch of ${batch.length} records...`);

      for (const dealData of batch) {
        try {
          // Extract products HTML if available
          let products = [];
          if (dealData["Panier abandonné Produits HTML"]) {
            products = parseProductsHTML(
              dealData["Panier abandonné Produits HTML"]
            );
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
            pipeline: dealData["Pipeline"] || null,
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
            customerName: dealData["Associated Contact"] || null,
            customerEmail: dealData["Associated Contact"]?.match(/\(([^)]+)\)/)
              ? dealData["Associated Contact"].match(/\(([^)]+)\)/)[1]
              : dealData["Email"] || null,
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
              email: dealData["Associated Contact"]?.match(/\(([^)]+)\)/)
                ? dealData["Associated Contact"].match(/\(([^)]+)\)/)[1]
                : dealData["Email"] || null,
            },
            source:
              dealData["Original Traffic Source"] || dealData["Source"] || null,
            sourceDetail:
              dealData["Original Traffic Source Drill-Down 1"] ||
              dealData["Source Detail"] ||
              null,
          };

          // Only process records with a valid ID or necessary fields
        
            if (dealObj.recordId) {
              // Use updateOne with upsert option to avoid _id issues
              await Deal.updateOne(
                { recordId: dealObj.recordId },
                { $set: dealObj },
                { upsert: true, runValidators: true }
              );
              successCount++;
            } else {
              // If no recordId, create a new deal with dealName
              const newDeal = new Deal(dealObj);
              await newDeal.save();
              successCount++;
            }
          
        } catch (saveError) {
          console.error(`Error saving deal: ${saveError.message}`);
          errorCount++;
        }
      }

      console.log(
        `Batch complete. Progress: ${processedCount} rows processed, ${successCount} successful, ${errorCount} errors`
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

      // Check if we have enough cells to extract product info
      if (productCells.length >= 6) {
        // Process cells in pairs (image/name/price/details/quantity/total)
        for (let j = 0; j < productCells.length; j += 6) {
          // Skip if not enough cells left
          if (j + 5 >= productCells.length) break;

          const imageUrl = $(productCells[j]).find("img").attr("src");
          const name = $(productCells[j + 1])
            .find("a")
            .text()
            .trim();
          const price =
            parseFloat(
              $(productCells[j + 2])
                .find(".price")
                .text()
                .replace("€", "")
                .replace(",", ".")
                .trim()
            ) || 0;
          const quantity =
            parseInt(
              $(productCells[j + 4])
                .find(".quantity")
                .text()
                .trim()
            ) || 1;
          const totalPrice =
            parseFloat(
              $(productCells[j + 5])
                .find("strong")
                .text()
                .replace("€", "")
                .replace(",", ".")
                .trim()
            ) || 0;

          products.push({
            name,
            price,
            quantity,
            totalPrice,
            imageUrl,
          });
        }
      }
    });
  } catch (error) {
    console.error("Error parsing product HTML:", error);
  }

  return products;
}

// Run the import function
importDealsFromCSV();
