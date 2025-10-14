const mongoose = require("mongoose");
const Schema = mongoose.Schema;

// Line Tax Jurisdiction Schema
const LineTaxJurisdictionSchema = new Schema({}, { strict: false });

// Export Process Schema
const ExportProcessSchema = new Schema({}, { strict: false });

// Document Line Additional Expenses Schema
const DocumentLineAdditionalExpenseSchema = new Schema({}, { strict: false });

// Withholding Tax Line Schema
const WithholdingTaxLineSchema = new Schema({}, { strict: false });

// Serial Number Schema
const SerialNumberSchema = new Schema({}, { strict: false });

// Batch Number Schema
const BatchNumberSchema = new Schema({}, { strict: false });

// CCD Number Schema
const CCDNumberSchema = new Schema({}, { strict: false });

// Document Lines Bin Allocation Schema
const DocumentLinesBinAllocationSchema = new Schema({}, { strict: false });

// Document Line Schema for Delivery Notes
const DeliveryNoteLineSchema = new Schema({
    LineNum: Number,
    ItemCode: String,
    ItemDescription: String,
    Quantity: Number,
    ShipDate: Date,
    Price: Number,
    PriceAfterVAT: Number,
    Currency: String,
    Rate: Number,
    DiscountPercent: Number,
    VendorNum: String,
    SerialNum: String,
    WarehouseCode: String,
    SalesPersonCode: Number,
    CommisionPercent: Number,
    TreeType: String,
    AccountCode: String,
    UseBaseUnits: String,
    SupplierCatNum: String,
    CostingCode: String,
    ProjectCode: String,
    BarCode: String,
    VatGroup: String,
    Height1: Number,
    Hight1Unit: Number,
    Height2: Number,
    Height2Unit: Number,
    Lengh1: Number,
    Lengh1Unit: Number,
    Lengh2: Number,
    Lengh2Unit: Number,
    Weight1: Number,
    Weight1Unit: Number,
    Weight2: Number,
    Weight2Unit: Number,
    Factor1: Number,
    Factor2: Number,
    Factor3: Number,
    Factor4: Number,
    BaseType: Number,
    BaseEntry: Number,
    BaseLine: Number,
    Volume: Number,
    VolumeUnit: Number,
    Width1: Number,
    Width1Unit: Number,
    Width2: Number,
    Width2Unit: Number,
    Address: String,
    TaxCode: String,
    TaxType: String,
    TaxLiable: String,
    PickStatus: String,
    PickQuantity: Number,
    PickListIdNumber: Number,
    OriginalItem: String,
    BackOrder: String,
    FreeText: String,
    ShippingMethod: Number,
    POTargetNum: Number,
    POTargetEntry: String,
    POTargetRowNum: Number,
    CorrectionInvoiceItem: String,
    CorrInvAmountToStock: Number,
    CorrInvAmountToDiffAcct: Number,
    AppliedTax: Number,
    AppliedTaxFC: Number,
    AppliedTaxSC: Number,
    WTLiable: String,
    DeferredTax: String,
    EqualizationTaxPercent: Number,
    TotalEqualizationTax: Number,
    TotalEqualizationTaxFC: Number,
    TotalEqualizationTaxSC: Number,
    NetTaxAmount: Number,
    NetTaxAmountFC: Number,
    NetTaxAmountSC: Number,
    MeasureUnit: String,
    UnitsOfMeasurment: Number,
    LineTotal: Number,
    TaxPercentagePerRow: Number,
    TaxTotal: Number,
    ConsumerSalesForecast: String,
    ExciseAmount: Number,
    TaxPerUnit: Number,
    TotalInclTax: Number,
    CountryOrg: String,
    SWW: String,
    TransactionType: Number,
    DistributeExpense: String,
    RowTotalFC: Number,
    RowTotalSC: Number,
    LastBuyInmPrice: Number,
    LastBuyDistributeSumFc: Number,
    LastBuyDistributeSumSc: Number,
    LastBuyDistributeSum: Number,
    StockDistributesumForeign: Number,
    StockDistributesumSystem: Number,
    StockDistributesum: Number,
    StockInmPrice: Number,
    PickStatusEx: String,
    TaxBeforeDPM: Number,
    TaxBeforeDPMFC: Number,
    TaxBeforeDPMSC: Number,
    CFOPCode: String,
    CSTCode: String,
    Usage: String,
    TaxOnly: String,
    VisualOrder: Number,
    BaseOpenQuantity: Number,
    UnitPrice: Number,
    LineStatus: String,
    PackageQuantity: Number,
    Text: String,
    LineType: String,
    COGSCostingCode: String,
    COGSAccountCode: String,
    ChangeAssemlyBoMWarehouse: String,
    GrossBuyPrice: Number,
    GrossBase: Number,
    GrossProfitTotalBasePrice: Number,
    CostingCode2: String,
    CostingCode3: String,
    CostingCode4: String,
    CostingCode5: String,
    ItemDetails: String,
    LocationCode: String,
    ActualDeliveryDate: Date,
    RemainingOpenQuantity: Number,
    OpenAmount: Number,
    OpenAmountFC: Number,
    OpenAmountSC: Number,
    ExLineNo: String,
    RequiredDate: Date,
    RequiredQuantity: Number,
    COGSCostingCode2: String,
    COGSCostingCode3: String,
    COGSCostingCode4: String,
    COGSCostingCode5: String,
    CSTforIPI: String,
    CSTforPIS: String,
    CSTforCOFINS: String,
    CreditOriginCode: String,
    WithoutInventoryMovement: String,
    AgreementNo: String,
    AgreementRowNumber: Number,
    ActualBaseEntry: Number,
    ActualBaseLine: Number,
    DocEntry: Number,
    Surpluses: Number,
    DefectAndBreakup: Number,
    Shortages: Number,
    ConsiderQuantity: String,
    PartialRetirement: String,
    RetirementQuantity: Number,
    RetirementAPC: Number,
    ThirdParty: String,
    PoNum: String,
    PoItmNum: String,
    ExpenseType: String,
    ReceiptNumber: String,
    ExpenseOperationType: String,
    FederalTaxID: String,
    GrossProfit: Number,
    GrossProfitFC: Number,
    GrossProfitSC: Number,
    PriceSource: String,
    StgSeqNum: Number,
    StgEntry: Number,
    StgDesc: String,
    UoMEntry: Number,
    UoMCode: String,
    InventoryQuantity: Number,
    RemainingOpenInventoryQuantity: Number,
    ParentLineNum: Number,
    Incoterms: Number,
    TransportMode: Number,
    NatureOfTransaction: String,
    DestinationCountryForImport: String,
    DestinationRegionForImport: String,
    OriginCountryForExport: String,
    OriginRegionForExport: String,
    ItemType: String,
    ChangeInventoryQuantityIndependently: String,
    FreeOfChargeBP: String,
    SACEntry: Number,
    HSNEntry: Number,
    GrossPrice: Number,
    GrossTotal: Number,
    GrossTotalFC: Number,
    GrossTotalSC: Number,
    NCMCode: Number,
    NVECode: String,
    IndEscala: String,
    CtrSealQty: Number,
    CNJPMan: String,
    CESTCode: String,
    UFFiscalBenefitCode: String,
    ShipToCode: String,
    ShipToDescription: String,
    ExternalCalcTaxRate: Number,
    ExternalCalcTaxAmount: Number,
    ExternalCalcTaxAmountFC: Number,
    ExternalCalcTaxAmountSC: Number,
    StandardItemIdentification: String,
    CommodityClassification: String,
    UnencumberedReason: String,
    CUSplit: String,
    // Custom fields
    U_PromotionName: String,
    U_PromotionExpiry: Date,
    U_FreeStock: String,
    U_CATEID: String,
    // Nested arrays
    LineTaxJurisdictions: [LineTaxJurisdictionSchema],
    ExportProcesses: [ExportProcessSchema],
    DocumentLineAdditionalExpenses: [DocumentLineAdditionalExpenseSchema],
    WithholdingTaxLines: [WithholdingTaxLineSchema],
    SerialNumbers: [SerialNumberSchema],
    BatchNumbers: [BatchNumberSchema],
    CCDNumbers: [CCDNumberSchema],
    DocumentLinesBinAllocations: [DocumentLinesBinAllocationSchema],
});

// Document Approval Request Schema
const DocumentApprovalRequestSchema = new Schema({}, { strict: false });

// EWay Bill Details Schema
const EWayBillDetailsSchema = new Schema({}, { strict: false });

// Electronic Protocol Schema
const ElectronicProtocolSchema = new Schema({}, { strict: false });

// Document Additional Expenses Schema
const DocumentAdditionalExpenseSchema = new Schema({}, { strict: false });

// Withholding Tax Data WTX Collection Schema
const WithholdingTaxDataWTXSchema = new Schema({}, { strict: false });

// Withholding Tax Data Collection Schema
const WithholdingTaxDataSchema = new Schema({}, { strict: false });

// Document Package Schema
const DocumentPackageSchema = new Schema({}, { strict: false });

// Document Special Line Schema
const DocumentSpecialLineSchema = new Schema({}, { strict: false });

// Tax Extension Schema
const TaxExtensionSchema = new Schema({
    TaxId0: String,
    TaxId1: String,
    TaxId2: String,
    TaxId3: String,
    TaxId4: String,
    TaxId5: String,
    TaxId6: String,
    TaxId7: String,
    TaxId8: String,
    TaxId9: String,
    State: String,
    County: String,
    Incoterms: String,
    Vehicle: String,
    VehicleState: String,
    NFRef: String,
    Carrier: String,
    PackQuantity: Number,
    PackDescription: String,
    Brand: String,
    ShipUnitNo: Number,
    NetWeight: Number,
    GrossWeight: Number,
    StreetS: String,
    BlockS: String,
    BuildingS: String,
    CityS: String,
    ZipCodeS: String,
    CountyS: String,
    StateS: String,
    CountryS: String,
    StreetB: String,
    BlockB: String,
    BuildingB: String,
    CityB: String,
    ZipCodeB: String,
    CountyB: String,
    StateB: String,
    CountryB: String,
    ImportOrExport: String,
    MainUsage: String,
    GlobalLocationNumberS: String,
    GlobalLocationNumberB: String,
    TaxId12: String,
    TaxId13: String,
    BillOfEntryNo: String,
    BillOfEntryDate: Date,
    OriginalBillOfEntryNo: String,
    OriginalBillOfEntryDate: Date,
    ImportOrExportType: String,
    PortCode: String,
    DocEntry: Number,
    BoEValue: Number,
    ClaimRefund: String,
    DifferentialOfTaxRate: Number,
    IsIGSTAccount: String,
});

// Address Extension Schema
const AddressExtensionSchema = new Schema({
    ShipToStreet: String,
    ShipToStreetNo: String,
    ShipToBlock: String,
    ShipToBuilding: String,
    ShipToCity: String,
    ShipToZipCode: String,
    ShipToCounty: String,
    ShipToState: String,
    ShipToCountry: String,
    ShipToAddressType: String,
    BillToStreet: String,
    BillToStreetNo: String,
    BillToBlock: String,
    BillToBuilding: String,
    BillToCity: String,
    BillToZipCode: String,
    BillToCounty: String,
    BillToState: String,
    BillToCountry: String,
    BillToAddressType: String,
    ShipToGlobalLocationNumber: String,
    BillToGlobalLocationNumber: String,
    ShipToAddress2: String,
    ShipToAddress3: String,
    BillToAddress2: String,
    BillToAddress3: String,
    PlaceOfSupply: String,
    PurchasePlaceOfSupply: String,
    DocEntry: Number,
    GoodsIssuePlaceBP: String,
    GoodsIssuePlaceCNPJ: String,
    GoodsIssuePlaceCPF: String,
    GoodsIssuePlaceStreet: String,
    GoodsIssuePlaceStreetNo: String,
    GoodsIssuePlaceBuilding: String,
    GoodsIssuePlaceZip: String,
    GoodsIssuePlaceBlock: String,
    GoodsIssuePlaceCity: String,
    GoodsIssuePlaceCounty: String,
    GoodsIssuePlaceState: String,
    GoodsIssuePlaceCountry: String,
    GoodsIssuePlacePhone: String,
    GoodsIssuePlaceEMail: String,
    GoodsIssuePlaceDepartureDate: Date,
    DeliveryPlaceBP: String,
    DeliveryPlaceCNPJ: String,
    DeliveryPlaceCPF: String,
    DeliveryPlaceStreet: String,
    DeliveryPlaceStreetNo: String,
    DeliveryPlaceBuilding: String,
    DeliveryPlaceZip: String,
    DeliveryPlaceBlock: String,
    DeliveryPlaceCity: String,
    DeliveryPlaceCounty: String,
    DeliveryPlaceState: String,
    DeliveryPlaceCountry: String,
    DeliveryPlacePhone: String,
    DeliveryPlaceEMail: String,
    DeliveryPlaceDepartureDate: Date,
});

// Document Reference Schema
const DocumentReferenceSchema = new Schema({}, { strict: false });

// Main Delivery Note Schema
const DeliveryNoteSchema = new Schema(
    {
        // Document identification
        DocEntry: {
            type: Number,
            required: true,
            unique: true,
        },
        DocNum: Number,
        DocType: String,
        HandWritten: String,
        Printed: String,

        // Dates
        DocDate: Date,
        DocDueDate: Date,
        TaxDate: Date,
        CreationDate: Date,
        UpdateDate: Date,
        DocTime: String,
        UpdateTime: String,

        // Customer information
        CardCode: {
            type: String,
            required: true,
            index: true,
        },
        CardName: String,
        Address: String,
        Address2: String,
        NumAtCard: String,
        ContactPersonCode: Number,

        // Financial information
        DocTotal: Number,
        DocTotalFc: Number,
        DocTotalSys: Number,
        VatSum: Number,
        VatSumSys: Number,
        VatSumFc: Number,
        VatPercent: Number,
        DiscountPercent: Number,
        TotalDiscount: Number,
        TotalDiscountFC: Number,
        TotalDiscountSC: Number,
        RoundingDiffAmount: Number,
        RoundingDiffAmountFC: Number,
        RoundingDiffAmountSC: Number,

        // Currency
        DocCurrency: String,
        DocRate: Number,

        // References
        Reference1: String,
        Reference2: String,
        Comments: String,
        JournalMemo: String,
        AttachmentEntry: Number,

        // Payment information
        PaymentGroupCode: Number,
        PaymentMethod: String,
        PaymentReference: String,
        PaymentBlock: String,
        PaymentBlockEntry: Number,

        // Personnel
        SalesPersonCode: {
            type: Number,
            index: true,
        },
        salesAgent: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            index: true,
        },
        DocumentsOwner: Number,
        UserSign: Number,

        // Shipping information
        TransportationCode: Number,
        ShipToCode: String,
        ShipFrom: String,
        TrackingNumber: String,
        PickStatus: String,
        Pick: String,
        PickRemark: String,

        // Document status
        Confirmed: String,
        DocumentStatus: {
            type: String,
            index: true,
        },
        LineStatus: String,
        Cancelled: String,
        CancelStatus: String,

        // Document settings
        ImportFileNum: Number,
        SummeryType: String,
        ShowSCN: String,
        Series: Number,
        PartialSupply: String,
        DocObjectCode: String,
        Indicator: String,
        FederalTaxID: String,

        // Accounting
        FinancialPeriod: Number,
        TransNum: Number,
        NetProcedure: String,
        Form1099: Number,
        Box1099: String,
        ControlAccount: String,

        // Warehouse and inventory
        WareHouseUpdateType: String,
        Rounding: String,
        UseShpdGoodsAct: String,
        OpenForLandedCosts: String,

        // Revisions and corrections
        RevisionPo: String,
        ExternalCorrectedDocNum: String,
        InternalCorrectedDocNum: Number,
        NextCorrectingDocument: Number,

        // Dates (additional)
        RequriedDate: Date,
        CancelDate: Date,
        ClosingDate: Date,
        StartDeliveryDate: Date,
        StartDeliveryTime: String,
        EndDeliveryDate: Date,
        EndDeliveryTime: String,
        AssetValueDate: Date,

        // Dunning and blocking
        BlockDunning: String,
        Submitted: String,
        Segment: Number,

        // Bank and payment
        CentralBankIndicator: String,
        MaximumCashDiscount: String,
        Reserve: String,
        ReserveInvoice: String,
        IsPayToBank: String,
        PayToBankCountry: String,
        PayToBankCode: String,
        PayToBankAccountNo: String,
        PayToBankBranch: String,
        PayToCode: String,

        // Project and costing
        Project: String,

        // Tax
        DeferredTax: String,
        TaxExemptionLetterNum: String,
        TaxExemptionValidityDateFrom: Date,
        TaxExemptionValidityDateTo: Date,
        VatDate: Date,
        UseCorrectionVATGroup: String,
        UseBillToAddrToDetermineTax: String,
        ExcludeFromTaxReportControlStatementVAT: String,

        // Withholding tax
        WTApplied: Number,
        WTAppliedFC: Number,
        WTAppliedSC: Number,
        WTNonSubjectAmount: Number,
        WTNonSubjectAmountSC: Number,
        WTNonSubjectAmountFC: Number,
        WTExemptedAmount: Number,
        WTExemptedAmountSC: Number,
        WTExemptedAmountFC: Number,
        BaseAmount: Number,
        BaseAmountSC: Number,
        BaseAmountFC: Number,
        WTAmount: Number,
        WTAmountSC: Number,
        WTAmountFC: Number,

        // Equalization tax
        TotalEqualizationTax: Number,
        TotalEqualizationTaxFC: Number,
        TotalEqualizationTaxSC: Number,

        // Bill of exchange
        BillOfExchangeReserved: String,
        AgentCode: String,

        // Installments
        NumberOfInstallments: Number,
        ApplyTaxOnFirstInstallment: String,

        // Document sub-type and channel
        DocumentSubType: String,
        BPChannelCode: String,
        BPChannelContact: Number,

        // Period indicator
        PeriodIndicator: String,

        // Manual number
        ManualNumber: String,

        // Branch
        BPL_IDAssignedToInvoice: Number,
        BPLName: String,

        // Down payment
        DownPayment: Number,
        DownPaymentAmount: Number,
        DownPaymentPercentage: Number,
        DownPaymentType: String,
        DownPaymentAmountSC: Number,
        DownPaymentAmountFC: Number,
        DownPaymentStatus: String,
        ApplyCurrentVATRatesForDownPaymentsToDraw: String,

        // Language
        LanguageCode: Number,

        // Sequence
        SequenceCode: Number,
        SequenceSerial: Number,
        SeriesString: String,
        SubSeriesString: String,
        SequenceModel: String,

        // Profit
        ServiceGrossProfitPercent: Number,

        // Remarks
        OpeningRemarks: String,
        ClosingRemarks: String,

        // Signature
        SignatureInputMessage: String,
        SignatureDigest: String,
        CertificationNumber: String,
        PrivateKeyVersion: Number,

        // Insurance
        InsuranceOperation347: String,

        // Archive
        ArchiveNonremovableSalesQuotation: String,

        // GTS
        GTSChecker: Number,
        GTSPayee: Number,
        RelevantToGTS: String,

        // Extra days
        ExtraMonth: Number,
        ExtraDays: Number,
        CashDiscountDateOffset: Number,
        StartFrom: String,

        // E-document
        NTSApproved: String,
        ETaxWebSite: Number,
        ETaxNumber: String,
        NTSApprovedNumber: String,
        EDocGenerationType: String,
        EDocSeries: Number,
        EDocNum: String,
        EDocExportFormat: Number,
        EDocStatus: String,
        EDocErrorCode: String,
        EDocErrorMessage: String,

        // Group
        GroupSeries: Number,
        GroupNumber: Number,
        GroupHandWritten: String,

        // Reopen
        ReopenOriginalDocument: String,
        ReopenManuallyClosedOrCanceledDocument: String,

        // Online quotation
        CreateOnlineQuotation: String,

        // POS
        POSEquipmentNumber: String,
        POSManufacturerSerialNumber: String,
        POSCashierNumber: String,
        POS_CashRegister: Number,
        POSDailySummaryNo: String,
        POSReceiptNo: String,

        // Closing
        ClosingOption: String,
        SpecifiedClosingDate: Date,

        // Authorization
        AuthorizationStatus: String,
        AuthorizationCode: String,

        // VAT
        VATRegNum: String,
        AnnualInvoiceDeclarationReference: String,

        // Supplier and receiver
        Supplier: String,
        Releaser: String,
        Receiver: String,

        // Blanket agreement
        BlanketAgreementNumber: String,

        // Alteration
        IsAlteration: String,

        // Delivery
        DocumentDelivery: String,

        // Vehicle
        VehiclePlate: String,

        // AT
        ATDocumentType: String,

        // Electronic communication
        ElecCommStatus: String,
        ElecCommMessage: String,

        // Reuse
        ReuseDocumentNum: String,
        ReuseNotaFiscalNum: String,

        // SEPA
        PrintSEPADirect: String,

        // Fiscal
        FiscalDocNum: String,

        // Point of issue
        PointOfIssueCode: String,
        Letter: String,
        FolioNumberFrom: String,
        FolioNumberTo: String,
        FolioPrefixString: String,
        FolioNumber: Number,

        // Interim
        InterimType: String,
        RelatedType: Number,
        RelatedEntry: Number,

        // SAP Passport
        SAPPassport: String,

        // Tax ID
        DocumentTaxID: String,

        // Reporting
        DateOfReportingControlStatementVAT: Date,
        ReportingSectionControlStatementVAT: String,

        // QR Code
        CreateQRCodeFrom: String,

        // Price mode
        PriceMode: String,

        // Commission
        CommissionTrade: String,
        CommissionTradeReturn: String,

        // Italian localization
        Cig: String,
        Cup: String,

        // Father
        FatherCard: String,
        FatherType: String,

        // Ship location
        ShipState: String,
        ShipPlace: String,

        // Customer office
        CustOffice: String,

        // Brazilian localization
        FCI: String,
        AddLegIn: String,
        LegTextF: String,
        DANFELgTxt: String,
        IndFinal: String,

        // Data version
        DataVersion: Number,

        // Custom fields (User-defined fields)
        U_Route: String,
        U_Notes: String,
        U_CCSurcharge: String,
        U_SurchargeRate: Number,
        U_PrintedDate: Date,
        U_HHEmpID: String,
        U_EPOSNo: String,
        U_B1IFDocEntry: String,
        U_U_ROUTENUMBER: String,
        U_U_ROUTEPAYMETHOD: String,
        U_U_ROUTEORDER: String,
        U_U_ROUTEPAYAMOUNT: String,

        // Related documents
        OriginatingOrder: Number,
        OriginatingQuotation: Number,

        // SAP Integration fields
        SyncedWithSAP: {
            type: Boolean,
            default: false,
        },
        SAPDocEntry: Number,
        LocalStatus: {
            type: String,
            enum: ["Created", "Synced", "SyncFailed"],
            default: "Created",
        },
        SyncErrors: String,
        LastSyncAttempt: Date,
        SAPSyncDisabled: {
            type: Boolean,
            default: false,
        },

        // Nested documents
        Document_ApprovalRequests: [DocumentApprovalRequestSchema],
        DocumentLines: [DeliveryNoteLineSchema],
        EWayBillDetails: EWayBillDetailsSchema,
        ElectronicProtocols: [ElectronicProtocolSchema],
        DocumentAdditionalExpenses: [DocumentAdditionalExpenseSchema],
        WithholdingTaxDataWTXCollection: [WithholdingTaxDataWTXSchema],
        WithholdingTaxDataCollection: [WithholdingTaxDataSchema],
        DocumentPackages: [DocumentPackageSchema],
        DocumentSpecialLines: [DocumentSpecialLineSchema],
        TaxExtension: TaxExtensionSchema,
        AddressExtension: AddressExtensionSchema,
        DocumentReferences: [DocumentReferenceSchema],
    },
    {
        timestamps: true,
        collection: "DeliveryNotes",
    }
);

// Indexes for optimal query performance
DeliveryNoteSchema.index({ DocEntry: 1 });
DeliveryNoteSchema.index({ DocNum: 1 }, { unique: true });
DeliveryNoteSchema.index({ CardCode: 1 });
DeliveryNoteSchema.index({ DocDate: -1 }); // Descending for most recent first
DeliveryNoteSchema.index({ DocumentStatus: 1 });
DeliveryNoteSchema.index({ SalesPersonCode: 1 });
DeliveryNoteSchema.index({ salesAgent: 1 });
DeliveryNoteSchema.index({ BaseEntry: 1 }); // For finding delivery notes from orders
DeliveryNoteSchema.index({ CreationDate: -1 });

// Compound indexes for common queries
DeliveryNoteSchema.index({ CardCode: 1, DocDate: -1 });
DeliveryNoteSchema.index({ DocumentStatus: 1, DocDate: -1 });
DeliveryNoteSchema.index({ salesAgent: 1, DocDate: -1 });
DeliveryNoteSchema.index({ SyncedWithSAP: 1, LocalStatus: 1 });
DeliveryNoteSchema.index({ "DocumentLines.BaseEntry": 1 }); // For linking to source orders

// Text index for search functionality
DeliveryNoteSchema.index({
    CardName: "text",
    Comments: "text",
    "DocumentLines.ItemDescription": "text",
});

const DeliveryNote = mongoose.model("DeliveryNote", DeliveryNoteSchema);
module.exports = DeliveryNote;