// utils/sapB1Integration.js - Complete rewrite with minimal approach
const axios = require("axios");
const dotenv = require("dotenv");

// Load environment variables
dotenv.config();

// SAP B1 Service Layer Configuration
const SAP_CONFIG = {
  serviceLayerUrl: process.env.SAP_SERVICE_LAYER_URL,
  companyDB: process.env.COMPANY_DB,
  username: process.env.USER_NAME,
  password: process.env.PASSWORD,
};

// Set this to true to enable automatic SAP sync
const ENABLE_SAP_SYNC = true;

// Session management
let sessionId = null;
let sessionTimeout = null;

// Login to SAP B1 Service Layer and get session ID
async function loginToSAP() {
  try {
    console.log("Logging in to SAP B1 Service Layer...");

    // Clear any existing session timeout
    if (sessionTimeout) {
      clearTimeout(sessionTimeout);
    }

    const loginData = {
      CompanyDB: SAP_CONFIG.companyDB,
      UserName: SAP_CONFIG.username,
      Password: SAP_CONFIG.password,
    };

    const response = await axios.post(
      `${SAP_CONFIG.serviceLayerUrl}/Login`,
      loginData,
      {
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    // Extract session ID from cookies
    const cookies = response.headers["set-cookie"];
    if (!cookies) {
      throw new Error("No cookies returned from SAP B1 login");
    }

    // Parse session ID from cookies
    const sessionCookie = cookies.find((cookie) =>
      cookie.includes("B1SESSION=")
    );
    if (!sessionCookie) {
      throw new Error("B1SESSION cookie not found");
    }

    sessionId = sessionCookie.split(";")[0].replace("B1SESSION=", "");

    // Set session timeout (SAP B1 sessions typically expire after 30 minutes)
    // We'll set it to refresh after 25 minutes to be safe
    sessionTimeout = setTimeout(() => {
      sessionId = null;
    }, 25 * 60 * 1000);

    console.log("Successfully logged in to SAP B1 Service Layer");
    return sessionId;
  } catch (error) {
    console.error("Error logging in to SAP B1:", error.message);
    if (error.response) {
      console.error("SAP Error details:", error.response.data);
    }
    throw new Error(`SAP Login Error: ${error.message}`);
  }
}

// Get a valid session ID (login if necessary)
async function getSessionId() {
  if (!sessionId) {
    return await loginToSAP();
  }
  return sessionId;
}

// Check if a business partner exists in SAP
exports.checkBusinessPartnerExists = async (cardCode) => {
  try {
    const sessionId = await getSessionId();

    console.log(`Checking if business partner ${cardCode} exists in SAP...`);

    const response = await axios.get(
      `${SAP_CONFIG.serviceLayerUrl}/BusinessPartners('${cardCode}')`,
      {
        headers: {
          "Content-Type": "application/json",
          Cookie: `B1SESSION=${sessionId}`,
        },
      }
    );

    // If we get here, the business partner exists
    console.log(`Business partner ${cardCode} exists in SAP`);
    return true;
  } catch (error) {
    if (error.response && error.response.status === 404) {
      console.log(`Business partner ${cardCode} does not exist in SAP`);
      return false;
    }

    // If unauthorized, try to login again and retry once
    if (error.response && error.response.status === 401) {
      console.log("Session expired, attempting to login again...");
      sessionId = null;
      await getSessionId();
      return exports.checkBusinessPartnerExists(cardCode);
    }

    console.error("Error checking business partner in SAP:", error.message);
    throw new Error(`SAP Error: ${error.message}`);
  }
};

// Add this function to utils/sapB1Integration.js

// Get the next available DocNum from SAP B1
exports.getNextDocNumFromSAP = async () => {
  try {
    const sessionId = await getSessionId();

    console.log("Fetching next DocNum from SAP B1...");

    // Get the last order to find the highest DocNum
    const response = await axios.get(
      `${SAP_CONFIG.serviceLayerUrl}/Orders?$select=DocNum&$orderby=DocNum desc&$top=1`,
      {
        headers: {
          "Content-Type": "application/json",
          Cookie: `B1SESSION=${sessionId}`,
        },
      }
    );

    let nextDocNum = 1; // Default if no orders exist

    if (
      response.data &&
      response.data.value &&
      response.data.value.length > 0
    ) {
      const lastDocNum = response.data.value[0].DocNum;
      nextDocNum = lastDocNum + 1;
      console.log(
        `Last DocNum in SAP: ${lastDocNum}, Next DocNum: ${nextDocNum}`
      );
    } else {
      console.log("No existing orders found in SAP, starting with DocNum: 1");
    }

    return nextDocNum;
  } catch (error) {
    console.error("Error getting next DocNum from SAP B1:", error.message);

    // If unauthorized, try to login again and retry once
    if (error.response && error.response.status === 401) {
      console.log("Session expired, attempting to login again...");
      sessionId = null;
      await getSessionId();
      return exports.getNextDocNumFromSAP();
    }

    // If we can't get DocNum from SAP, fall back to local calculation
    console.warn("Falling back to local DocNum calculation");
    return null;
  }
};

// Alternative function to get series information if you want to use a specific numbering series
exports.getNextDocNumFromSeries = async (seriesCode = null) => {
  try {
    const sessionId = await getSessionId();

    console.log("Fetching next DocNum from SAP B1 series...");

    let url = `${SAP_CONFIG.serviceLayerUrl}/SeriesService_GetDocumentSeries?DocumentTypeParams='13'`; // 13 = Sales Order

    if (seriesCode) {
      url += `&SeriesParams='${seriesCode}'`;
    }

    const response = await axios.get(url, {
      headers: {
        "Content-Type": "application/json",
        Cookie: `B1SESSION=${sessionId}`,
      },
    });

    if (
      response.data &&
      response.data.value &&
      response.data.value.length > 0
    ) {
      const series = response.data.value[0];
      const nextDocNum = series.NextNumber;
      console.log(`Next DocNum from SAP series: ${nextDocNum}`);
      return nextDocNum;
    }

    return null;
  } catch (error) {
    console.error("Error getting next DocNum from SAP series:", error.message);

    // If unauthorized, try to login again and retry once
    if (error.response && error.response.status === 401) {
      console.log("Session expired, attempting to login again...");
      sessionId = null;
      await getSessionId();
      return exports.getNextDocNumFromSeries(seriesCode);
    }

    return null;
  }
};

exports.formatOrderForSAP = async (order) => {
  const today = new Date();

  // Create SAP order with price list information
  const sapOrder = {
    CardCode: order.CardCode,
    DocDate: order.DocDate || today,
    DocDueDate: order.DocDueDate || today,
    Comments: order.Comments || "",
    U_Notes: order.U_Notes || "",

    // CRITICAL FIX: Include price list at document level
    PriceList: order.PriceList ? parseInt(order.PriceList, 10) : 2,

    // *** NEW: Let SAP handle DocNum automatically ***
    // Don't specify DocNum - let SAP assign it according to its numbering series
    // This ensures alignment with SAP's internal numbering

    DocumentLines: [],
  };

  // Process document lines with price list information
  if (order.DocumentLines && Array.isArray(order.DocumentLines)) {
    sapOrder.DocumentLines = order.DocumentLines.map((line, index) => {
      const sapLine = {
        ItemCode: line.ItemCode,
        Quantity: Number(line.Quantity || 0),
        UnitPrice: Number(line.Price || 0),
        ItemDescription: line.ItemDescription || "",

        // CRITICAL FIX: Include price list for each line
        PriceList: line.PriceList
          ? parseInt(line.PriceList, 10)
          : order.PriceList
            ? parseInt(order.PriceList, 10)
            : 2,

        // Optional: Include line number for tracking
        LineNum: index,
      };

      return sapLine;
    });
  }

  // Add custom field if salesAgent exists
  if (order.salesAgent) {
    sapOrder.U_SalesAgentId = order.salesAgent.toString();
  }

  // Add reference to local DocNum for tracking
  if (order.DocNum) {
    sapOrder.U_LocalDocNum = order.DocNum.toString();
  }

  // Log detailed information for debugging
  console.log("SAP Order formatted:", {
    CardCode: sapOrder.CardCode,
    PriceList: sapOrder.PriceList,
    U_LocalDocNum: sapOrder.U_LocalDocNum,
    DocumentLines: sapOrder.DocumentLines.map((line) => ({
      ItemCode: line.ItemCode,
      UnitPrice: line.UnitPrice,
      PriceList: line.PriceList,
      Quantity: line.Quantity,
    })),
  });

  return sapOrder;
};

// NEW FUNCTION - Add this after formatOrderForSAP
exports.formatDeliveryNoteForSAP = async (deliveryNote, salesOrderDocEntry = null) => {
  const today = new Date();

  const sapDeliveryNote = {
    CardCode: deliveryNote.CardCode,
    DocDate: deliveryNote.DocDate || today,
    DocDueDate: deliveryNote.DocDueDate || today,
    Comments: deliveryNote.Comments || "",
    U_Notes: deliveryNote.U_Notes || "",
    PriceList: deliveryNote.PriceList ? parseInt(deliveryNote.PriceList, 10) : 2,
    DocumentLines: [],
  };

  // Process document lines
  if (deliveryNote.DocumentLines && Array.isArray(deliveryNote.DocumentLines)) {
    sapDeliveryNote.DocumentLines = deliveryNote.DocumentLines.map((line, index) => {
      const sapLine = {
        ItemCode: line.ItemCode,
        Quantity: Number(line.Quantity || 0),
        UnitPrice: Number(line.UnitPrice || line.Price || 0),
        ItemDescription: line.ItemDescription || "",
        PriceList: line.PriceList ? parseInt(line.PriceList, 10) :
          deliveryNote.PriceList ? parseInt(deliveryNote.PriceList, 10) : 2,
        LineNum: index,
      };

      // CRITICAL FIX: Only add base document reference if we have a valid DocEntry
      if (salesOrderDocEntry && salesOrderDocEntry > 0) {
        sapLine.BaseType = 17; // 17 = Sales Order
        sapLine.BaseEntry = salesOrderDocEntry;
        sapLine.BaseLine = line.BaseLine || index;
      }
      // If no BaseEntry, SAP will create a standalone delivery note

      return sapLine;
    });
  }

  // Add custom fields for tracking
  if (deliveryNote.U_LocalDocNum) {
    sapDeliveryNote.U_LocalDocNum = deliveryNote.U_LocalDocNum.toString();
  }

  if (deliveryNote.U_SourceOrderNum) {
    sapDeliveryNote.U_SourceOrderNum = deliveryNote.U_SourceOrderNum.toString();
  }

  console.log("SAP Delivery Note formatted:", {
    CardCode: sapDeliveryNote.CardCode,
    BaseEntry: salesOrderDocEntry,
    DocumentLines: sapDeliveryNote.DocumentLines.length,
  });

  return sapDeliveryNote;
};

// Create a sales order in SAP B1
exports.createSalesOrderInSAP = async (orderData) => {
  try {
    // Skip SAP sync if disabled (for testing/debugging purposes)
    if (!ENABLE_SAP_SYNC) {
      console.log("SAP sync is disabled. Skipping order creation in SAP.");
      return {
        simulated: true,
        message: "SAP sync is disabled",
        DocEntry: Math.floor(Math.random() * 10000), // Simulate a DocEntry
        DocNum: Math.floor(Math.random() * 10000), // Simulate a DocNum
      };
    }

    const sessionId = await getSessionId();

    console.log("Creating sales order in SAP B1...");
    console.log("Order data being sent:", JSON.stringify(orderData, null, 2));

    const response = await axios.post(
      `${SAP_CONFIG.serviceLayerUrl}/Orders`,
      orderData,
      {
        headers: {
          "Content-Type": "application/json",
          Cookie: `B1SESSION=${sessionId}`,
        },
      }
    );

    console.log("Sales order created successfully in SAP B1");
    console.log("SAP Response:", {
      DocEntry: response.data.DocEntry,
      DocNum: response.data.DocNum,
      CardCode: response.data.CardCode,
    });

    return response.data;
  } catch (error) {
    console.error("Error creating sales order in SAP B1:", error.message);
    if (error.response) {
      console.error("SAP Error details:", error.response.data);

      // For debugging, log the full error details
      if (
        error.response.data &&
        error.response.data.error &&
        error.response.data.error.message
      ) {
        console.error(
          "Error field details:",
          error.response.data.error.message.value
        );
      }
    }

    // If unauthorized, try to login again and retry once
    if (error.response && error.response.status === 401) {
      console.log("Session expired, attempting to login again...");
      sessionId = null;
      await getSessionId();
      return exports.createSalesOrderInSAP(orderData);
    }

    throw new Error(`SAP Error: ${error.message}`);
  }
};

// Get a sales order from SAP B1 by DocEntry
exports.getSalesOrderFromSAP = async (docEntry) => {
  try {
    const sessionId = await getSessionId();

    console.log(`Fetching sales order ${docEntry} from SAP B1...`);

    const response = await axios.get(
      `${SAP_CONFIG.serviceLayerUrl}/Orders(${docEntry})`,
      {
        headers: {
          "Content-Type": "application/json",
          Cookie: `B1SESSION=${sessionId}`,
        },
      }
    );

    console.log("Sales order fetched successfully from SAP B1");
    return response.data;
  } catch (error) {
    console.error("Error fetching sales order from SAP B1:", error.message);

    // If unauthorized, try to login again and retry once
    if (error.response && error.response.status === 401) {
      console.log("Session expired, attempting to login again...");
      sessionId = null;
      await getSessionId();
      return exports.getSalesOrderFromSAP(docEntry);
    }

    throw new Error(`SAP Error: ${error.message}`);
  }
};

// Add these functions at the end of your utils/sapB1Integration.js file
// (after the getSalesOrderFromSAP function)

// Create a delivery note in SAP B1
exports.createDeliveryNoteInSAP = async (deliveryNoteData) => {
  try {
    // Skip SAP sync if disabled (for testing/debugging purposes)
    if (!ENABLE_SAP_SYNC) {
      console.log("SAP sync is disabled. Skipping delivery note creation in SAP.");
      return {
        simulated: true,
        message: "SAP sync is disabled",
        DocEntry: Math.floor(Math.random() * 10000), // Simulate a DocEntry
        DocNum: Math.floor(Math.random() * 10000), // Simulate a DocNum
      };
    }

    const sessionId = await getSessionId();

    console.log("Creating delivery note in SAP B1...");
    console.log("Delivery note data being sent:", JSON.stringify(deliveryNoteData, null, 2));

    const response = await axios.post(
      `${SAP_CONFIG.serviceLayerUrl}/DeliveryNotes`,
      deliveryNoteData,
      {
        headers: {
          "Content-Type": "application/json",
          Cookie: `B1SESSION=${sessionId}`,
        },
      }
    );

    console.log("Delivery note created successfully in SAP B1");
    console.log("SAP Response:", {
      DocEntry: response.data.DocEntry,
      DocNum: response.data.DocNum,
      CardCode: response.data.CardCode,
    });

    return response.data;
  } catch (error) {
    console.error("Error creating delivery note in SAP B1:", error.message);
    if (error.response) {
      console.error("SAP Error details:", error.response.data);

      // For debugging, log the full error details
      if (
        error.response.data &&
        error.response.data.error &&
        error.response.data.error.message
      ) {
        console.error(
          "Error field details:",
          error.response.data.error.message.value
        );
      }
    }

    // If unauthorized, try to login again and retry once
    if (error.response && error.response.status === 401) {
      console.log("Session expired, attempting to login again...");
      sessionId = null;
      await getSessionId();
      return exports.createDeliveryNoteInSAP(deliveryNoteData);
    }

    throw new Error(`SAP Error: ${error.message}`);
  }
};

// Get a delivery note from SAP B1 by DocEntry
exports.getDeliveryNoteFromSAP = async (docEntry) => {
  try {
    const sessionId = await getSessionId();

    console.log(`Fetching delivery note ${docEntry} from SAP B1...`);

    const response = await axios.get(
      `${SAP_CONFIG.serviceLayerUrl}/DeliveryNotes(${docEntry})`,
      {
        headers: {
          "Content-Type": "application/json",
          Cookie: `B1SESSION=${sessionId}`,
        },
      }
    );

    console.log("Delivery note fetched successfully from SAP B1");
    return response.data;
  } catch (error) {
    console.error("Error fetching delivery note from SAP B1:", error.message);

    // If unauthorized, try to login again and retry once
    if (error.response && error.response.status === 401) {
      console.log("Session expired, attempting to login again...");
      sessionId = null;
      await getSessionId();
      return exports.getDeliveryNoteFromSAP(docEntry);
    }

    throw new Error(`SAP Error: ${error.message}`);
  }
};

// Get the next available DocNum for Delivery Notes from SAP B1
exports.getNextDeliveryNoteDocNumFromSAP = async () => {
  try {
    const sessionId = await getSessionId();

    console.log("Fetching next Delivery Note DocNum from SAP B1...");

    // Get the last delivery note to find the highest DocNum
    const response = await axios.get(
      `${SAP_CONFIG.serviceLayerUrl}/DeliveryNotes?$select=DocNum&$orderby=DocNum desc&$top=1`,
      {
        headers: {
          "Content-Type": "application/json",
          Cookie: `B1SESSION=${sessionId}`,
        },
      }
    );

    let nextDocNum = 1; // Default if no delivery notes exist

    if (
      response.data &&
      response.data.value &&
      response.data.value.length > 0
    ) {
      const lastDocNum = response.data.value[0].DocNum;
      nextDocNum = lastDocNum + 1;
      console.log(
        `Last Delivery Note DocNum in SAP: ${lastDocNum}, Next DocNum: ${nextDocNum}`
      );
    } else {
      console.log("No existing delivery notes found in SAP, starting with DocNum: 1");
    }

    return nextDocNum;
  } catch (error) {
    console.error("Error getting next Delivery Note DocNum from SAP B1:", error.message);

    // If unauthorized, try to login again and retry once
    if (error.response && error.response.status === 401) {
      console.log("Session expired, attempting to login again...");
      sessionId = null;
      await getSessionId();
      return exports.getNextDeliveryNoteDocNumFromSAP();
    }

    // If we can't get DocNum from SAP, fall back to local calculation
    console.warn("Falling back to local DocNum calculation for Delivery Note");
    return null;
  }
};

// Batch create delivery notes in SAP B1 (for bulk operations)
exports.bulkCreateDeliveryNotesInSAP = async (deliveryNotesData) => {
  try {
    const sessionId = await getSessionId();

    console.log(`Creating ${deliveryNotesData.length} delivery notes in SAP B1...`);

    const results = {
      successful: [],
      failed: [],
    };

    // Process each delivery note
    for (let i = 0; i < deliveryNotesData.length; i++) {
      const deliveryNote = deliveryNotesData[i];

      try {
        console.log(`Processing delivery note ${i + 1}/${deliveryNotesData.length}...`);

        // ✅ FIX: Format the delivery note properly BEFORE sending to SAP
        const formattedDeliveryNote = await exports.formatDeliveryNoteForSAP(deliveryNote, null);

        const response = await axios.post(
          `${SAP_CONFIG.serviceLayerUrl}/DeliveryNotes`,
          formattedDeliveryNote,  // ✅ Send formatted data instead of raw data
          {
            headers: {
              "Content-Type": "application/json",
              Cookie: `B1SESSION=${sessionId}`,
            },
          }
        );

        results.successful.push({
          localDocNum: deliveryNote.U_LocalDocNum,
          sapDocEntry: response.data.DocEntry,
          sapDocNum: response.data.DocNum,
          cardCode: response.data.CardCode,
        });

        console.log(`✅ Delivery note created: DocEntry ${response.data.DocEntry}`);

      } catch (error) {
        console.error(`❌ Failed to create delivery note:`, error.message);

        results.failed.push({
          localDocNum: deliveryNote.U_LocalDocNum,
          cardCode: deliveryNote.CardCode,
          error: error.message,
        });

        // If unauthorized, re-login and continue
        if (error.response && error.response.status === 401) {
          console.log("Session expired during batch, re-logging in...");
          sessionId = null;
          await getSessionId();
        }
      }

      // Small delay between requests to avoid overwhelming SAP
      if (i < deliveryNotesData.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    return results;
  } catch (error) {
    console.error("Error in bulk delivery note creation:", error.message);
    throw new Error(`SAP Bulk Error: ${error.message}`);
  }
};

// Get the next available DocNum for Invoices from SAP B1
exports.getNextInvoiceDocNumFromSAP = async () => {
  try {
    const sessionId = await getSessionId();

    console.log("Fetching next Invoice DocNum from SAP B1...");

    // Get the last invoice to find the highest DocNum
    const response = await axios.get(
      `${SAP_CONFIG.serviceLayerUrl}/Invoices?$select=DocNum&$orderby=DocNum desc&$top=1`,
      {
        headers: {
          "Content-Type": "application/json",
          Cookie: `B1SESSION=${sessionId}`,
        },
      }
    );

    let nextDocNum = 1; // Default if no invoices exist

    if (
      response.data &&
      response.data.value &&
      response.data.value.length > 0
    ) {
      const lastDocNum = response.data.value[0].DocNum;
      nextDocNum = lastDocNum + 1;
      console.log(
        `Last Invoice DocNum in SAP: ${lastDocNum}, Next DocNum: ${nextDocNum}`
      );
    } else {
      console.log("No existing invoices found in SAP, starting with DocNum: 1");
    }

    return nextDocNum;
  } catch (error) {
    console.error("Error getting next Invoice DocNum from SAP B1:", error.message);

    // If unauthorized, try to login again and retry once
    if (error.response && error.response.status === 401) {
      console.log("Session expired, attempting to login again...");
      sessionId = null;
      await getSessionId();
      return exports.getNextInvoiceDocNumFromSAP();
    }

    // If we can't get DocNum from SAP, fall back to local calculation
    console.warn("Falling back to local DocNum calculation for Invoice");
    return null;
  }
};

// Create an invoice in SAP B1
exports.createInvoiceInSAP = async (invoiceData) => {
  try {
    // Skip SAP sync if disabled (for testing/debugging purposes)
    if (!ENABLE_SAP_SYNC) {
      console.log("SAP sync is disabled. Skipping invoice creation in SAP.");
      return {
        simulated: true,
        message: "SAP sync is disabled",
        DocEntry: Math.floor(Math.random() * 10000), // Simulate a DocEntry
        DocNum: Math.floor(Math.random() * 10000), // Simulate a DocNum
      };
    }

    const sessionId = await getSessionId();

    console.log("Creating invoice in SAP B1...");
    console.log("Invoice data being sent:", JSON.stringify(invoiceData, null, 2));

    const response = await axios.post(
      `${SAP_CONFIG.serviceLayerUrl}/Invoices`,
      invoiceData,
      {
        headers: {
          "Content-Type": "application/json",
          Cookie: `B1SESSION=${sessionId}`,
        },
      }
    );

    console.log("Invoice created successfully in SAP B1");
    console.log("SAP Response:", {
      DocEntry: response.data.DocEntry,
      DocNum: response.data.DocNum,
      CardCode: response.data.CardCode,
    });

    return response.data;
  } catch (error) {
    console.error("Error creating invoice in SAP B1:", error.message);
    if (error.response) {
      console.error("SAP Error details:", error.response.data);

      // For debugging, log the full error details
      if (
        error.response.data &&
        error.response.data.error &&
        error.response.data.error.message
      ) {
        console.error(
          "Error field details:",
          error.response.data.error.message.value
        );
      }
    }

    // If unauthorized, try to login again and retry once
    if (error.response && error.response.status === 401) {
      console.log("Session expired, attempting to login again...");
      sessionId = null;
      await getSessionId();
      return exports.createInvoiceInSAP(invoiceData);
    }

    throw new Error(`SAP Error: ${error.message}`);
  }
};

// Get an invoice from SAP B1 by DocEntry
exports.getInvoiceFromSAP = async (docEntry) => {
  try {
    const sessionId = await getSessionId();

    console.log(`Fetching invoice ${docEntry} from SAP B1...`);

    const response = await axios.get(
      `${SAP_CONFIG.serviceLayerUrl}/Invoices(${docEntry})`,
      {
        headers: {
          "Content-Type": "application/json",
          Cookie: `B1SESSION=${sessionId}`,
        },
      }
    );

    console.log("Invoice fetched successfully from SAP B1");
    return response.data;
  } catch (error) {
    console.error("Error fetching invoice from SAP B1:", error.message);

    // If unauthorized, try to login again and retry once
    if (error.response && error.response.status === 401) {
      console.log("Session expired, attempting to login again...");
      sessionId = null;
      await getSessionId();
      return exports.getInvoiceFromSAP(docEntry);
    }

    throw new Error(`SAP Error: ${error.message}`);
  }
};

// Batch create invoices in SAP B1 (for bulk operations)
exports.bulkCreateInvoicesInSAP = async (invoicesData) => {
  try {
    const sessionId = await getSessionId();

    console.log(`Creating ${invoicesData.length} invoices in SAP B1...`);

    const results = {
      successful: [],
      failed: [],
    };

    // Process each invoice
    for (let i = 0; i < invoicesData.length; i++) {
      const invoice = invoicesData[i];

      try {
        console.log(`Processing invoice ${i + 1}/${invoicesData.length}...`);

        const response = await axios.post(
          `${SAP_CONFIG.serviceLayerUrl}/Invoices`,
          invoice,
          {
            headers: {
              "Content-Type": "application/json",
              Cookie: `B1SESSION=${sessionId}`,
            },
          }
        );

        results.successful.push({
          localDocNum: invoice.U_LocalDocNum,
          sapDocEntry: response.data.DocEntry,
          sapDocNum: response.data.DocNum,
          cardCode: response.data.CardCode,
        });

        console.log(`✅ Invoice created: DocEntry ${response.data.DocEntry}`);

      } catch (error) {
        console.error(`❌ Failed to create invoice:`, error.message);

        results.failed.push({
          localDocNum: invoice.U_LocalDocNum,
          cardCode: invoice.CardCode,
          error: error.message,
        });

        // If unauthorized, re-login and continue
        if (error.response && error.response.status === 401) {
          console.log("Session expired during batch, re-logging in...");
          sessionId = null;
          await getSessionId();
        }
      }

      // Small delay between requests to avoid overwhelming SAP
      if (i < invoicesData.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    return results;
  } catch (error) {
    console.error("Error in bulk invoice creation:", error.message);
    throw new Error(`SAP Bulk Error: ${error.message}`);
  }
};