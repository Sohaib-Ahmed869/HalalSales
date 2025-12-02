// services/sapPaymentService.js
const axios = require('axios');

class SAPPaymentService {
    constructor() {
        this.baseURL = process.env.SAP_SERVICE_LAYER_URL;
        this.sessionId = null;
        this.sessionTimeout = null;
    }

    /**
     * Login to SAP Service Layer
     */
    async login() {
        try {
            const response = await axios.post(`${this.baseURL}/Login`, {
                CompanyDB: process.env.COMPANY_DB,
                UserName: process.env.USER_NAME,
                Password: process.env.PASSWORD,
            });

            this.sessionId = response.data.SessionId;

            // Set session timeout (SAP sessions typically last 30 minutes)
            this.sessionTimeout = setTimeout(() => {
                this.sessionId = null;
            }, 25 * 60 * 1000); // Refresh before 30 min

            return this.sessionId;
        } catch (error) {
            console.error('SAP Login Error:', error.response?.data || error.message);
            throw new Error('Failed to login to SAP');
        }
    }

    /**
     * Ensure valid session
     */
    async ensureSession() {
        if (!this.sessionId) {
            await this.login();
        }
        return this.sessionId;
    }

    /**
     * Get config with session cookie
     */
    async getConfig() {
        await this.ensureSession();
        return {
            headers: {
                'Content-Type': 'application/json',
                'Cookie': `B1SESSION=${this.sessionId}`,
            },
        };
    }

    /**
     * Create Incoming Payment in SAP
     * @param {Object} paymentData - Payment information
     * @returns {Promise<Object>} Created payment response
     */
    async createIncomingPayment(paymentData) {
        try {
            const config = await this.getConfig();

            // ✅ Start with base payment object
            const sapPayment = {
                CardCode: paymentData.CardCode,
                DocType: "rCustomer",
                DocDate: paymentData.DocDate || new Date().toISOString().split('T')[0],
                TaxDate: paymentData.TaxDate || new Date().toISOString().split('T')[0],
                Remarks: paymentData.Remarks || "Payment from reconciliation module",
                PaymentInvoices: paymentData.PaymentInvoices || [],
            };

            // ✅ Only add payment fields that are actually provided
            if (paymentData.CashSum) {
                sapPayment.CashSum = paymentData.CashSum;
                if (paymentData.CashAccount) {
                    sapPayment.CashAccount = paymentData.CashAccount;
                }
            }

            if (paymentData.CheckSum) {
                sapPayment.CheckSum = paymentData.CheckSum;
                sapPayment.PaymentChecks = paymentData.PaymentChecks || [];
            }

            if (paymentData.TransferSum) {
                sapPayment.TransferSum = paymentData.TransferSum;
                if (paymentData.TransferAccount) {
                    sapPayment.TransferAccount = paymentData.TransferAccount;
                }
            }

            if (paymentData.CreditSum) {
                sapPayment.CreditSum = paymentData.CreditSum;
                sapPayment.PaymentCreditCards = paymentData.PaymentCreditCards || [];
            }

            console.log('Creating SAP Incoming Payment:', JSON.stringify(sapPayment, null, 2));

            const response = await axios.post(
                `${this.baseURL}/IncomingPayments`,
                sapPayment,
                config
            );

            console.log('SAP Payment Created:', response.data);
            return response.data;

        } catch (error) {
            console.error('SAP Payment Creation Error:', error.response?.data || error.message);

            // If session expired, retry once
            if (error.response?.status === 401) {
                this.sessionId = null;
                return await this.createIncomingPayment(paymentData);
            }

            throw new Error(
                error.response?.data?.error?.message?.value ||
                'Failed to create payment in SAP'
            );
        }
    }

    /**
     * Update invoice payment status in SAP
     * @param {Number} docEntry - Invoice DocEntry
     * @param {Object} updateData - Update information
     */
    async updateInvoicePaymentStatus(docEntry, updateData) {
        try {
            const config = await this.getConfig();

            // PATCH the invoice
            const response = await axios.patch(
                `${this.baseURL}/Invoices(${docEntry})`,
                updateData,
                config
            );

            console.log(`SAP Invoice ${docEntry} updated`);
            return response.data;

        } catch (error) {
            console.error('SAP Invoice Update Error:', error.response?.data || error.message);

            if (error.response?.status === 401) {
                this.sessionId = null;
                return await this.updateInvoicePaymentStatus(docEntry, updateData);
            }

            throw new Error('Failed to update invoice in SAP');
        }
    }

    /**
     * Close invoice in SAP (mark as paid)
     * @param {Number} docEntry - Invoice DocEntry
     */
    async closeInvoice(docEntry) {
        try {
            const config = await this.getConfig();

            // Close the document
            await axios.post(
                `${this.baseURL}/Invoices(${docEntry})/Close`,
                {},
                config
            );

            console.log(`SAP Invoice ${docEntry} closed`);
            return true;

        } catch (error) {
            console.error('SAP Invoice Close Error:', error.response?.data || error.message);

            if (error.response?.status === 401) {
                this.sessionId = null;
                return await this.closeInvoice(docEntry);
            }

            throw new Error('Failed to close invoice in SAP');
        }
    }

    /**
     * Get invoice details from SAP
     * @param {Number} docEntry - Invoice DocEntry
     */
    async getInvoice(docEntry) {
        try {
            const config = await this.getConfig();

            const response = await axios.get(
                `${this.baseURL}/Invoices(${docEntry})`,
                config
            );

            return response.data;

        } catch (error) {
            console.error('SAP Invoice Fetch Error:', error.response?.data || error.message);

            if (error.response?.status === 401) {
                this.sessionId = null;
                return await this.getInvoice(docEntry);
            }

            throw new Error('Failed to fetch invoice from SAP');
        }
    }

    /**
     * Get payment means for customer
     * @param {String} cardCode - Customer CardCode
     */
    async getCustomerPaymentMeans(cardCode) {
        try {
            const config = await this.getConfig();

            const response = await axios.get(
                `${this.baseURL}/BusinessPartners('${cardCode}')`,
                {
                    ...config,
                    params: {
                        $select: 'CardCode,CardName,Currency,PayTermsGrpCode,CreditLimit'
                    }
                }
            );

            return response.data;

        } catch (error) {
            console.error('SAP Customer Fetch Error:', error.response?.data || error.message);

            if (error.response?.status === 401) {
                this.sessionId = null;
                return await this.getCustomerPaymentMeans(cardCode);
            }

            throw new Error('Failed to fetch customer from SAP');
        }
    }

    /**
     * Logout from SAP
     */
    async logout() {
        try {
            if (this.sessionId) {
                const config = await this.getConfig();
                await axios.post(`${this.baseURL}/Logout`, {}, config);

                if (this.sessionTimeout) {
                    clearTimeout(this.sessionTimeout);
                }

                this.sessionId = null;
            }
        } catch (error) {
            console.error('SAP Logout Error:', error.message);
        }
    }
}

module.exports = new SAPPaymentService();