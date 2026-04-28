function createPaymentController(deps) {
    const {
        db,
        paymentClient,
        paymentService,
        logPaymentEvent
    } = deps;

    function parseMultipartFormData(rawText) {
        const text = String(rawText || '');
        if (!text) return {};
        const parsed = {};
        const regex = /name="([^"]+)"\r?\n\r?\n([\s\S]*?)(?=\r?\n--)/g;
        let match;
        while ((match = regex.exec(text)) !== null) {
            const key = String(match[1] || '').trim();
            const value = String(match[2] || '').trim();
            if (!key) continue;
            if (!(key in parsed)) {
                parsed[key] = value;
            } else if (Array.isArray(parsed[key])) {
                parsed[key].push(value);
            } else {
                parsed[key] = [parsed[key], value];
            }
        }
        return parsed;
    }

    function parseRawWebhookBody(rawText, contentType = '') {
        const text = String(rawText || '').trim();
        if (!text) return {};
        const type = String(contentType || '').toLowerCase();

        if (type.includes('multipart/form-data') || text.includes('Content-Disposition: form-data; name=')) {
            const multipartParsed = parseMultipartFormData(text);
            if (Object.keys(multipartParsed).length > 0) return multipartParsed;
        }

        try {
            const parsedJson = JSON.parse(text);
            if (parsedJson && typeof parsedJson === 'object') return parsedJson;
        } catch (_) {
            // keep fallback parsing
        }
        const params = new URLSearchParams(text);
        const data = {};
        for (const [key, value] of params.entries()) {
            if (!(key in data)) {
                data[key] = value;
                continue;
            }
            if (Array.isArray(data[key])) {
                data[key].push(value);
            } else {
                data[key] = [data[key], value];
            }
        }
        return data;
    }

    function normalizeNewebpayWebhookPayload(req) {
        const recoverJsonKeyPayload = (input) => {
            if (!input || typeof input !== 'object' || Array.isArray(input)) return input || {};
            const keys = Object.keys(input);
            if (keys.length !== 1) return input;
            const onlyKey = String(keys[0] || '').trim();
            const onlyValue = input[keys[0]];
            const isEmptyValue = onlyValue == null || String(onlyValue).trim() === '';
            if (!isEmptyValue) return input;
            if (!(onlyKey.startsWith('{') && onlyKey.endsWith('}'))) return input;
            try {
                const parsed = JSON.parse(onlyKey);
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                    return parsed;
                }
            } catch (_) {
                // keep original input
            }
            return input;
        };

        const body = req.body;
        const contentType = String(req.headers?.['content-type'] || '');
        let fromBody = {};
        if (body && typeof body === 'object' && !Buffer.isBuffer(body) && Object.keys(body).length > 0) {
            fromBody = body;
        } else if (typeof body === 'string' && body.trim()) {
            fromBody = parseRawWebhookBody(body, contentType);
        } else if (Buffer.isBuffer(body) && body.length > 0) {
            fromBody = parseRawWebhookBody(body.toString('utf8'), contentType);
        }

        const fromRaw = parseRawWebhookBody(req.rawBody, contentType);
        const fromQuery = (req.query && typeof req.query === 'object') ? req.query : {};

        const merged = {
            ...fromQuery,
            ...fromRaw,
            ...fromBody
        };
        return recoverJsonKeyPayload(merged);
    }

    async function resolveTenantHomeUrl(context = {}) {
        const {
            tenantId: tenantIdFromContext,
            bookingId
        } = context;

        let tenantId = tenantIdFromContext;
        if (!tenantId && bookingId && typeof db.resolveTenantIdByBookingId === 'function') {
            tenantId = await db.resolveTenantIdByBookingId(bookingId);
        }

        if (!tenantId) return '/';

        const tenant = await db.getTenantById(tenantId);
        const tenantCode = String(tenant?.code || '').trim().toLowerCase();
        const publicBaseDomain = String(process.env.PUBLIC_BASE_DOMAIN || '').trim().toLowerCase();
        if (!tenantCode || !publicBaseDomain) {
            return '/';
        }

        const tenantSubdomainLabel = tenantCode.replace(/_/g, '-');
        return `https://${tenantSubdomainLabel}.${publicBaseDomain}/`;
    }

    async function createPayment(req, res) {
        try {
            const { bookingId } = req.body;

            if (!bookingId) {
                return res.status(400).json({
                    success: false,
                    message: '請提供訂房編號'
                });
            }

            const booking = await db.getBookingById(bookingId, req.tenantId);
            const tenant = await db.getTenantById(req.tenantId);

            if (!booking) {
                return res.status(404).json({
                    success: false,
                    message: '找不到該訂房記錄'
                });
            }

            const ecpayConfig = await paymentService.getEcpayConfigFromSettings(['MerchantID', 'HashKey', 'HashIV']);
            const paymentData = paymentClient.createPaymentForm({
                bookingId: booking.booking_id,
                finalAmount: booking.final_amount,
                guestName: booking.guest_name,
                guestEmail: booking.guest_email,
                guestPhone: booking.guest_phone,
                tenantCode: String(tenant?.code || '').trim().toLowerCase()
            }, {
                amount: booking.final_amount,
                description: `訂房編號：${booking.booking_id}`
            }, {
                MerchantID: ecpayConfig.MerchantID,
                HashKey: ecpayConfig.HashKey,
                HashIV: ecpayConfig.HashIV
            });

            return res.json({
                success: true,
                data: paymentData
            });
        } catch (error) {
            console.error('建立支付表單錯誤:', error);
            return res.status(500).json({
                success: false,
                message: '建立支付表單失敗'
            });
        }
    }

    async function paymentReturn(req, res) {
        const requestId = req.requestId || null;
        const route = '/api/payment/return';
        try {
            logPaymentEvent('info', 'payment.return.received', {
                requestId,
                route,
                method: req.method,
                bookingId: req.body?.MerchantTradeNo || null,
                tradeNo: req.body?.TradeNo || null,
                result: 'received'
            });

            const ecpayConfig = await paymentService.getEcpayConfigFromSettings(['HashKey', 'HashIV']);
            const isValid = paymentClient.verifyReturnData(req.body, {
                HashKey: ecpayConfig.HashKey,
                HashIV: ecpayConfig.HashIV
            });

            if (!isValid) {
                logPaymentEvent('error', 'ALERT_PAYMENT_SIGNATURE_VERIFY_FAILED', {
                    requestId,
                    route,
                    bookingId: req.body?.MerchantTradeNo || null,
                    tradeNo: req.body?.TradeNo || null,
                    result: 'invalid_signature'
                });
                return res.status(400).send('驗證失敗');
            }

            const paymentResult = paymentClient.parseReturnData(req.body);
            logPaymentEvent('info', 'payment.return.verified', {
                requestId,
                route,
                bookingId: paymentResult?.merchantTradeNo || null,
                tradeNo: paymentResult?.tradeNo || null,
                rtnCode: paymentResult?.rtnCode || null,
                result: 'verified'
            });

            if (paymentResult.rtnCode === '1') {
                await paymentService.handleCardPaymentSuccessByCallback(paymentResult.merchantTradeNo, {
                    requestId,
                    tradeNo: paymentResult.tradeNo,
                    tenantId: req.tenantId,
                    subdomainTenantId: req.subdomainTenantId
                });
            }

            logPaymentEvent('info', 'payment.return.ack', {
                requestId,
                route,
                bookingId: paymentResult?.merchantTradeNo || null,
                tradeNo: paymentResult?.tradeNo || null,
                result: 'ack_1_OK'
            });
            return res.send('1|OK');
        } catch (error) {
            console.error('處理付款回傳錯誤:', error);
            logPaymentEvent('error', 'ALERT_PAYMENT_CALLBACK_PROCESSING_ERROR', {
                requestId,
                route,
                bookingId: req.body?.MerchantTradeNo || null,
                tradeNo: req.body?.TradeNo || null,
                result: 'error',
                error: error.message
            });
            return res.status(500).send('處理失敗');
        }
    }

    async function paymentResult(req, res) {
        const requestId = req.requestId || null;
        const route = '/api/payment/result';
        try {
            const returnData = req.method === 'POST' ? req.body : req.query;
            logPaymentEvent('info', 'payment.result.received', {
                requestId,
                route,
                method: req.method,
                bookingId: returnData?.MerchantTradeNo || null,
                tradeNo: returnData?.TradeNo || null,
                result: 'received'
            });

            const ecpayConfig = await paymentService.getEcpayConfigFromSettings(['HashKey', 'HashIV']);
            const isValid = paymentClient.verifyReturnData(returnData, {
                HashKey: ecpayConfig.HashKey,
                HashIV: ecpayConfig.HashIV
            });

            if (!isValid) {
                const isTestEnv = process.env.NODE_ENV !== 'production';
                logPaymentEvent('warn', 'ALERT_PAYMENT_RESULT_SIGNATURE_VERIFY_FAILED', {
                    requestId,
                    route,
                    bookingId: returnData?.MerchantTradeNo || null,
                    tradeNo: returnData?.TradeNo || null,
                    result: 'invalid_signature'
                });
                if (!(isTestEnv && returnData.RtnCode === '1')) {
                    return res.status(400).send('付款驗證失敗');
                }
            }

            const paymentResult = paymentClient.parseReturnData(returnData);
            const tenantHomeUrl = await resolveTenantHomeUrl({
                tenantId: req.tenantId || req.subdomainTenantId,
                bookingId: paymentResult?.merchantTradeNo || returnData?.MerchantTradeNo || null
            });
            logPaymentEvent('info', 'payment.result.parsed', {
                requestId,
                route,
                bookingId: paymentResult?.merchantTradeNo || null,
                tradeNo: paymentResult?.tradeNo || null,
                rtnCode: paymentResult?.rtnCode || null,
                result: 'parsed'
            });

            if (paymentResult.rtnCode === '1') {
                // 補償機制：若綠界後端回調未成功，使用結果頁請求再執行一次（具冪等性）
                await paymentService.handleCardPaymentSuccessByCallback(paymentResult.merchantTradeNo, {
                    requestId,
                    tradeNo: paymentResult.tradeNo,
                    tenantId: req.tenantId,
                    subdomainTenantId: req.subdomainTenantId
                });

                logPaymentEvent('info', 'payment.result.render_success', {
                    requestId,
                    route,
                    bookingId: paymentResult?.merchantTradeNo || null,
                    tradeNo: paymentResult?.tradeNo || null,
                    result: 'render_success_page'
                });
                return res.send(`
                    <!DOCTYPE html>
                    <html>
                        <head>
                            <meta charset="UTF-8">
                            <meta name="viewport" content="width=device-width, initial-scale=1.0">
                            <title>付款成功</title>
                            <style>
                                :root {
                                    --primary-color: #2C8EC4;
                                    --card-bg: #ffffff;
                                    --header-bg: #262A33;
                                }
                                body {
                                    font-family: 'Noto Sans TC', -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
                                    display: flex;
                                    justify-content: center;
                                    align-items: center;
                                    min-height: 100vh;
                                    margin: 0;
                                    background-image: url('/Background%20image.jpg');
                                    background-size: cover;
                                    background-position: center;
                                    background-repeat: no-repeat;
                                    background-attachment: fixed;
                                    padding: 20px;
                                }
                                .container {
                                    background: var(--card-bg);
                                    border-radius: 24px;
                                    box-shadow: 0 20px 60px rgba(0,0,0,0.3);
                                    text-align: center;
                                    max-width: 480px;
                                    width: 100%;
                                    overflow: hidden;
                                }
                                .container-header {
                                    background: var(--header-bg);
                                    color: #fff;
                                    padding: 24px 20px 16px;
                                }
                                .container-header h1 {
                                    color: #fff !important;
                                    margin: 0 0 16px;
                                    font-size: 24px;
                                }
                                .success-icon {
                                    font-size: 56px;
                                    color: #4caf50;
                                    margin-bottom: 8px;
                                }
                                .container-body {
                                    padding: 24px 28px 28px;
                                }
                                h1 { color: #333; margin: 0 0 16px; font-size: 24px; }
                                p { color: #555; margin: 6px 0; font-size: 14px; }
                                .btn {
                                    display: inline-block;
                                    margin-top: 20px;
                                    padding: 10px 28px;
                                    background: var(--primary-color);
                                    color: #fff;
                                    text-decoration: none;
                                    border-radius: 999px;
                                    font-size: 14px;
                                }
                            </style>
                        </head>
                        <body>
                            <div class="container">
                                <div class="container-header">
                                <div class="success-icon">✓</div>
                                <h1>付款成功！</h1>
                                </div>
                                <div class="container-body">
                                <p>訂單編號：${paymentResult.merchantTradeNo}</p>
                                <p>交易編號：${paymentResult.tradeNo}</p>
                                <p>付款金額：NT$ ${paymentResult.tradeAmt.toLocaleString()}</p>
                                <p>付款時間：${paymentResult.paymentDate}</p>
                                <a href="${tenantHomeUrl}" class="btn">返回首頁</a>
                                </div>
                            </div>
                        </body>
                    </html>
                `);
            }

            logPaymentEvent('warn', 'payment.result.render_failed', {
                requestId,
                route,
                bookingId: paymentResult?.merchantTradeNo || null,
                tradeNo: paymentResult?.tradeNo || null,
                rtnCode: paymentResult?.rtnCode || null,
                result: 'render_failed_page'
            });
            return res.send(`
                <!DOCTYPE html>
                <html>
                    <head>
                        <meta charset="UTF-8">
                        <meta name="viewport" content="width=device-width, initial-scale=1.0">
                        <title>付款失敗</title>
                        <style>
                            body {
                                font-family: 'Noto Sans TC', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
                                display: flex;
                                justify-content: center;
                                align-items: center;
                                min-height: 100vh;
                                margin: 0;
                                padding: 20px;
                                background-image: url('Background%20image.jpg');
                                background-size: cover;
                                background-position: center;
                                background-repeat: no-repeat;
                                background-attachment: fixed;
                            }
                            .container {
                                background: white;
                                padding: 40px;
                                border-radius: 24px;
                                box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
                                text-align: center;
                                max-width: 500px;
                                animation: slideUp 0.5s ease-out;
                            }
                            @keyframes slideUp {
                                from {
                                    opacity: 0;
                                    transform: translateY(30px);
                                }
                                to {
                                    opacity: 1;
                                    transform: translateY(0);
                                }
                            }
                            .error-icon {
                                font-size: 80px;
                                color: #f44336;
                                margin-bottom: 20px;
                            }
                            h1 { 
                                color: #333; 
                                margin-bottom: 10px; 
                                font-size: 24px;
                                font-weight: 600;
                            }
                            p { 
                                color: #666; 
                                margin: 10px 0; 
                                font-size: 16px;
                            }
                            .btn {
                                display: inline-block;
                                margin-top: 20px;
                                padding: 12px 30px;
                                background: #262A33;
                                color: white;
                                text-decoration: none;
                                border-radius: 8px;
                                font-weight: 500;
                                transition: background 0.3s;
                            }
                            .btn:hover {
                                background: #1a1d24;
                            }
                        </style>
                    </head>
                    <body>
                        <div class="container">
                            <div class="error-icon">✗</div>
                            <h1>付款失敗</h1>
                            <p>${paymentResult.rtnMsg || '付款處理失敗'}</p>
                            <a href="${tenantHomeUrl}" class="btn">返回首頁</a>
                        </div>
                    </body>
                </html>
            `);
        } catch (error) {
            console.error('處理付款導向錯誤:', error);
            logPaymentEvent('error', 'ALERT_PAYMENT_RESULT_PROCESSING_ERROR', {
                requestId,
                route,
                result: 'error',
                error: error.message
            });
            return res.status(500).send('處理失敗');
        }
    }

    async function newebpaySubscriptionWebhook(req, res) {
        const requestId = req.requestId || null;
        const route = '/api/payment/newebpay/subscription/webhook';
        try {
            const payload = normalizeNewebpayWebhookPayload(req);
            logPaymentEvent('info', 'payment.newebpay.webhook.received', {
                requestId,
                route,
                result: 'received',
                bodyKeys: Object.keys(payload || {}),
                hasRawBody: !!String(req.rawBody || '').trim(),
                queryKeys: Object.keys(req.query || {}),
                contentType: String(req.headers?.['content-type'] || ''),
                contentLength: String(req.headers?.['content-length'] || ''),
                bodyType: Buffer.isBuffer(req.body) ? 'buffer' : typeof req.body
            });
            const result = await paymentService.handleNewebpaySubscriptionWebhook(payload, {
                requestId,
                queryTenantId: req.query?.tenant_id || req.query?.tenantId || null
            });
            if (result.duplicate) {
                return res.json({ success: true, duplicate: true, message: 'duplicate event ignored' });
            }
            return res.json({ success: true, duplicate: false, tenantId: result.tenantId, status: result.status });
        } catch (error) {
            logPaymentEvent('error', 'ALERT_NEWEBPAY_WEBHOOK_PROCESSING_ERROR', {
                requestId,
                route,
                result: 'error',
                error: error.message
            });
            return res.status(400).json({ success: false, message: '藍新 webhook 處理失敗: ' + error.message });
        }
    }

    async function newebpayCreateSubscription(req, res) {
        try {
            const admin = req.session?.admin;
            if (!admin) {
                return res.status(401).json({ success: false, message: '請先登入管理後台' });
            }
            const tenantId = admin.tenant_id || parseInt(process.env.DEFAULT_TENANT_ID || '1', 10);
            const { planCode, returnUrl, notifyUrl, customerEmail, customerName } = req.body || {};
            const data = await paymentService.createNewebpaySubscriptionRequest({
                tenantId,
                planCode,
                returnUrl,
                notifyUrl,
                customerEmail,
                customerName
            });
            // 記錄目前使用者選擇的方案（不改變狀態與使用期限），
            // 避免授權完成後 UI 仍顯示舊方案名稱。
            if (planCode && typeof db.updateLatestSubscriptionPlan === 'function') {
                await db.updateLatestSubscriptionPlan(tenantId, String(planCode).trim());
            }
            // 不在授權前提前切換訂閱狀態；僅記錄待授權的 provider_order_no，
            // 由藍新 callback/webhook 確認成功後再切換為 active，避免「返回商店」時誤顯示試用中。
            await db.updateTenantSubscriptionRecurringState(tenantId, {
                provider: 'newebpay',
                providerCustomerId: customerEmail || null,
                providerOrderNo: data?.merchantOrderNo || null,
                paymentStatus: 'pending',
                subscriptionStatus: null
            });
            return res.json({ success: true, data });
        } catch (error) {
            return res.status(400).json({ success: false, message: '建立藍新定期定額請求失敗: ' + error.message });
        }
    }

    async function newebpayAlterSubscriptionStatus(req, res) {
        try {
            const admin = req.session?.admin;
            if (!admin) {
                return res.status(401).json({ success: false, message: '請先登入管理後台' });
            }
            const tenantId = admin.tenant_id || parseInt(process.env.DEFAULT_TENANT_ID || '1', 10);
            const { merOrderNo, periodNo, alterType } = req.body || {};
            const data = await paymentService.alterNewebpaySubscriptionStatus({
                tenantId,
                merOrderNo,
                periodNo,
                alterType
            });
            return res.json({ success: true, data });
        } catch (error) {
            return res.status(400).json({ success: false, message: '修改藍新定期定額狀態失敗: ' + error.message });
        }
    }

    async function newebpayAlterSubscriptionContent(req, res) {
        try {
            const admin = req.session?.admin;
            if (!admin) {
                return res.status(401).json({ success: false, message: '請先登入管理後台' });
            }
            const tenantId = admin.tenant_id || parseInt(process.env.DEFAULT_TENANT_ID || '1', 10);
            const {
                merOrderNo,
                periodNo,
                alterAmt,
                periodType,
                periodPoint,
                periodTimes,
                extday,
                notifyUrl
            } = req.body || {};
            const data = await paymentService.alterNewebpaySubscriptionContent({
                tenantId,
                merOrderNo,
                periodNo,
                alterAmt,
                periodType,
                periodPoint,
                periodTimes,
                extday,
                notifyUrl
            });
            return res.json({ success: true, data });
        } catch (error) {
            return res.status(400).json({ success: false, message: '修改藍新定期定額內容失敗: ' + error.message });
        }
    }

    return {
        createPayment,
        paymentReturn,
        paymentResult,
        newebpaySubscriptionWebhook,
        newebpayCreateSubscription,
        newebpayAlterSubscriptionStatus,
        newebpayAlterSubscriptionContent
    };
}

module.exports = {
    createPaymentController
};
