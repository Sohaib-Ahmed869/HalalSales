// routes/creditNoteRoutes.js
const express = require("express");
const router = express.Router();
const creditNoteController = require("../controllers/creditNoteController");
const { auth } = require("../middleware/auth");

router.get("/", auth, creditNoteController.getAllCreditNotes);
router.post("/from-invoice/:invoiceDocEntry", auth, creditNoteController.createCreditNoteFromInvoice);
router.post("/:docEntry/push-to-sap", auth, creditNoteController.pushCreditNoteToSAP);

module.exports = router;