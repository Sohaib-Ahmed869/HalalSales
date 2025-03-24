// utils/sapB1Integration.js
const axios = require("axios");

// SAP B1 Service Layer configuration
const getSAPConfig = () => ({
  baseURL: process.env.SAP_SERVICE_LAYER_URL,
  headers: {
    "Content-Type": "application/json",
  },
});

// Login to SAP B1 Service Layer
const loginToSAP = async () => {
  const sapConfig = getSAPConfig();
  try {
    const response = await axios.post(
      `${sapConfig.baseURL}/Login`,
      {
        CompanyDB: process.env.COMPANY_DB,
        UserName: process.env.USER_NAME,
        Password: process.env.PASSWORD,
      },
      sapConfig
    );

    // Extract session ID from cookies
    const cookies = response.headers["set-cookie"];
    if (!cookies) {
      throw new Error("Failed to authenticate with SAP B1");
    }

    return cookies.join("; ");
  } catch (error) {
    console.error("Error logging into SAP B1:", error.message);
    throw new Error(`SAP B1 Login Failed: ${error.message}`);
  }
};

// Logout from SAP B1 Service Layer
const logoutFromSAP = async (sessionCookie) => {
  const sapConfig = getSAPConfig();
  sapConfig.headers.Cookie = sessionCookie;

  try {
    await axios.post(`${sapConfig.baseURL}/Logout`, {}, sapConfig);
    return true;
  } catch (error) {
    console.error("Error logging out from SAP B1:", error.message);
    return false;
  }
};

// Create a sales order in SAP B1
const createSalesOrderInSAP = async (orderData) => {
  const sessionCookie = await loginToSAP();
  const sapConfig = getSAPConfig();
  sapConfig.headers.Cookie = sessionCookie;

  try {
    const response = await axios.post(
      `${sapConfig.baseURL}/Orders`,
      orderData,
      sapConfig
    );
    await logoutFromSAP(sessionCookie);
    return response.data;
  } catch (error) {
    await logoutFromSAP(sessionCookie);

    // Extract detailed error information from SAP B1 response if available
    const sapError =
      error.response?.data?.error?.message?.value || error.message;
    throw new Error(`SAP B1 Order Creation Failed: ${sapError}`);
  }
};

// Format a MongoDB order document to SAP B1 format
const formatOrderForSAP = (order) => {
  // Base document
  const sapOrder = {
    CardCode: order.CardCode,
    CardName: order.CardName,
    DocDate: order.DocDate
      ? new Date(order.DocDate).toISOString().split("T")[0]
      : new Date().toISOString().split("T")[0],
    DocDueDate: order.DocDueDate
      ? new Date(order.DocDueDate).toISOString().split("T")[0]
      : new Date().toISOString().split("T")[0],
    Comments: order.Comments || "",
    SalesPersonCode: order.SalesPersonCode || 0,
    DocumentLines: [],
  };

  // Optional fields if they exist
  if (order.NumAtCard) sapOrder.NumAtCard = order.NumAtCard;
  if (order.ShipToCode) sapOrder.ShipToCode = order.ShipToCode;
  if (order.PaymentGroupCode)
    sapOrder.PaymentGroupCode = order.PaymentGroupCode;
  if (order.ContactPersonCode)
    sapOrder.ContactPersonCode = order.ContactPersonCode;
  if (order.U_Route) sapOrder.U_Route = order.U_Route;

  // Format document lines
  if (order.DocumentLines && order.DocumentLines.length > 0) {
    sapOrder.DocumentLines = order.DocumentLines.map((line) => {
      const sapLine = {
        ItemCode: line.ItemCode,
        Quantity: line.Quantity,
        Price: line.Price,
        DiscountPercent: line.DiscountPercent || 0,
      };

      // Add optional line fields if they exist
      if (line.WarehouseCode) sapLine.WarehouseCode = line.WarehouseCode;
      if (line.TaxCode) sapLine.TaxCode = line.TaxCode;
      if (line.ItemDescription) sapLine.ItemDescription = line.ItemDescription;
      if (line.FreeText) sapLine.FreeText = line.FreeText;

      return sapLine;
    });
  }

  return sapOrder;
};

// Fetch a sales order from SAP B1
const getSalesOrderFromSAP = async (docEntry) => {
  const sessionCookie = await loginToSAP();
  const sapConfig = getSAPConfig();
  sapConfig.headers.Cookie = sessionCookie;

  try {
    const response = await axios.get(
      `${sapConfig.baseURL}/Orders(${docEntry})`,
      sapConfig
    );
    await logoutFromSAP(sessionCookie);
    return response.data;
  } catch (error) {
    await logoutFromSAP(sessionCookie);
    throw new Error(`Failed to fetch order from SAP B1: ${error.message}`);
  }
};

module.exports = {
  loginToSAP,
  logoutFromSAP,
  createSalesOrderInSAP,
  formatOrderForSAP,
  getSalesOrderFromSAP,
};
