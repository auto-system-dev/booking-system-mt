function createPaymentService(deps) {
    const crypto = require('crypto');
    const {
        db,
        notificationService,
        logPaymentEvent,
        processEnv
    } = deps;
    const defaultTenantId = parseInt(processEnv.DEFAULT_TENANT_ID || '1', 10);

    async function getEcpayConfigFromSettings(requiredKeys = ['MerchantID', 'HashKey', 'HashIV']) {
        const isProductionEnv = processEnv.NODE_ENV === 'production';
        const envKeyMap = isProductionEnv
            ? {
                MerchantID: 'ECPAY_MERCHANT_ID_PROD',
                HashKey: 'ECPAY_HASH_KEY_PROD',
                HashIV: 'ECPAY_HASH_IV_PROD'
            }
            : {
                MerchantID: 'ECPAY_MERCHANT_ID',
                HashKey: 'ECPAY_HASH_KEY',
                HashIV: 'ECPAY_HASH_IV'
            };

        const dbConfig = {
            MerchantID: ((await db.getSetting('ecpay_merchant_id', defaultTenantId)) || '').trim(),
            HashKey: ((await db.getSetting('ecpay_hash_key', defaultTenantId)) || '').trim(),
            HashIV: ((await db.getSetting('ecpay_hash_iv', defaultTenantId)) || '').trim()
        };

        const config = {
            isProduction: isProductionEnv,
            MerchantID: dbConfig.MerchantID || (processEnv[envKeyMap.MerchantID] || '').trim(),
            HashKey: dbConfig.HashKey || (processEnv[envKeyMap.HashKey] || '').trim(),
            HashIV: dbConfig.HashIV || (processEnv[envKeyMap.HashIV] || '').trim()
        };

        const missing = requiredKeys.filter((key) => !config[key]);
        if (missing.length > 0) {
            const envNames = missing.map((key) => envKeyMap[key]).join('、');
            throw new Error(
                `綠界支付設定不完整，缺少：${missing.join(', ')}。請在系統設定的「綠界支付設定」中設定，或使用環境變數 ${envNames}`
            );
        }

        return config;
    }

    async function getNewebpayConfigFromSettings(requiredKeys = ['MerchantID', 'HashKey', 'HashIV']) {
        const isProduction =
            String((await db.getSetting('newebpay_is_production', defaultTenantId)) || processEnv.NEWEBPAY_IS_PRODUCTION || '')
                .toLowerCase() === 'true';
        const config = {
            MerchantID: ((await db.getSetting('newebpay_merchant_id', defaultTenantId)) || processEnv.NEWEBPAY_MERCHANT_ID || '').trim(),
            HashKey: ((await db.getSetting('newebpay_hash_key', defaultTenantId)) || processEnv.NEWEBPAY_HASH_KEY || '').trim(),
            HashIV: ((await db.getSetting('newebpay_hash_iv', defaultTenantId)) || processEnv.NEWEBPAY_HASH_IV || '').trim(),
            isProduction
        };
        const missing = requiredKeys.filter((key) => !config[key]);
        if (missing.length > 0) {
            throw new Error(`藍新支付設定不完整，缺少：${missing.join(', ')}`);
        }
        return config;
    }

    function encryptNewebpayTradeInfo(params, config) {
        const qs = new URLSearchParams();
        Object.entries(params).forEach(([key, value]) => {
            if (value !== undefined && value !== null) {
                qs.append(key, String(value));
            }
        });
        const raw = qs.toString();
        const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(config.HashKey), Buffer.from(config.HashIV));
        cipher.setAutoPadding(true);
        let encrypted = cipher.update(raw, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        return encrypted;
    }

    function decryptNewebpayPeriod(encryptedHex, config) {
        const cipherHex = String(encryptedHex || '').trim();
        if (!cipherHex) {
            throw new Error('缺少藍新回傳 Period 參數');
        }
        const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(config.HashKey), Buffer.from(config.HashIV));
        decipher.setAutoPadding(true);
        let decrypted = decipher.update(cipherHex, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    }

    function parseNewebpayPeriodPayload(raw) {
        const text = String(raw || '').trim();
        if (!text) {
            throw new Error('藍新回傳內容為空');
        }

        try {
            const obj = JSON.parse(text);
            if (obj && typeof obj.Result === 'string') {
                try {
                    obj.Result = JSON.parse(obj.Result);
                } catch (_) {
                    // keep original string when not JSON
                }
            }
            return obj;
        } catch (_) {
            const parsed = Object.fromEntries(new URLSearchParams(text).entries());
            if (parsed && typeof parsed.Result === 'string') {
                try {
                    parsed.Result = JSON.parse(parsed.Result);
                } catch (_) {
                    // keep original string when not JSON
                }
            }
            if (!parsed || Object.keys(parsed).length === 0) {
                throw new Error('藍新回傳 Period 解密內容格式無法解析');
            }
            return parsed;
        }
    }

    function buildNewebpayTradeSha(tradeInfo, config) {
        return crypto
            .createHash('sha256')
            .update(`HashKey=${config.HashKey}&${tradeInfo}&HashIV=${config.HashIV}`)
            .digest('hex')
            .toUpperCase();
    }

    async function postNewebpayPeriodApi(actionUrl, payload) {
        const body = new URLSearchParams();
        Object.entries(payload || {}).forEach(([key, value]) => {
            if (value !== undefined && value !== null) {
                body.append(key, String(value));
            }
        });
        const response = await fetch(actionUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body
        });
        const text = await response.text();
        if (!response.ok) {
            throw new Error(`藍新 API 呼叫失敗，HTTP ${response.status}`);
        }

        let parsed;
        try {
            parsed = JSON.parse(text);
        } catch (_) {
            parsed = Object.fromEntries(new URLSearchParams(text).entries());
        }

        return parsed;
    }

    async function createNewebpaySubscriptionRequest(params = {}) {
        const {
            tenantId,
            planCode,
            returnUrl,
            notifyUrl,
            customerEmail,
            customerName
        } = params;

        const safeTenantId = parseInt(tenantId, 10) || defaultTenantId;
        const config = await getNewebpayConfigFromSettings(['MerchantID', 'HashKey', 'HashIV']);
        const plans = await db.getSubscriptionPlans();
        const selectedPlan = plans.find((p) => p.code === planCode) || plans.find((p) => p.code === 'pro_monthly') || plans[0];
        if (!selectedPlan) {
            throw new Error('找不到可用方案，請先建立訂閱方案');
        }

        const amount = Math.max(1, parseInt(selectedPlan.price_amount || 0, 10) || 1);
        const billingCycle = selectedPlan.billing_cycle === 'yearly' ? 'yearly' : 'monthly';
        const periodType = billingCycle === 'yearly' ? 'Y' : 'M';
        const periodPoint = '1';
        const periodAmt = String(amount);
        const ts = Math.floor(Date.now() / 1000);
        const merchantOrderNo = `T${safeTenantId}-${Date.now()}`.slice(0, 30);
        const itemDesc = `訂閱方案-${selectedPlan.code}`;
        const version = '1.5';
        const actionUrl = config.isProduction
            ? 'https://core.newebpay.com/MPG/period'
            : 'https://ccore.newebpay.com/MPG/period';

        const tradeParams = {
            MerchantID: config.MerchantID,
            RespondType: 'JSON',
            TimeStamp: String(ts),
            Version: version,
            LangType: 'zh-tw',
            MerOrderNo: merchantOrderNo,
            ProdDesc: itemDesc,
            PeriodAmt: periodAmt,
            PeriodType: periodType,
            PeriodPoint: periodPoint,
            PeriodStartType: '2',
            PeriodTimes: '12',
            ReturnURL: notifyUrl || processEnv.NEWEBPAY_SUBSCRIPTION_NOTIFY_URL || '',
            NotifyURL: notifyUrl || processEnv.NEWEBPAY_SUBSCRIPTION_NOTIFY_URL || '',
            BackURL: returnUrl || processEnv.NEWEBPAY_SUBSCRIPTION_RETURN_URL || '',
            PayerEmail: customerEmail || '',
            PayerName: customerName || ''
        };
        if (!tradeParams.ReturnURL && !tradeParams.NotifyURL) {
            throw new Error('缺少藍新 webhook 通知網址，請設定 NEWEBPAY_SUBSCRIPTION_NOTIFY_URL');
        }

        const tradeInfo = encryptNewebpayTradeInfo(tradeParams, config);
        return {
            actionUrl,
            merchantOrderNo,
            planCode: selectedPlan.code,
            billingCycle,
            amount,
            payload: {
                MerchantID_: config.MerchantID,
                PostData_: tradeInfo
            }
        };
    }

    function verifyNewebpayTradeSha(payload = {}, config = {}) {
        const tradeInfo = String(payload.TradeInfo || payload.tradeInfo || '');
        const tradeSha = String(payload.TradeSha || payload.tradeSha || '').toUpperCase();
        if (!tradeInfo || !tradeSha) return false;
        const source = `HashKey=${config.HashKey}&${tradeInfo}&HashIV=${config.HashIV}`;
        const digest = crypto.createHash('sha256').update(source).digest('hex').toUpperCase();
        return digest === tradeSha;
    }

    function inferNewebpaySubscriptionStatus(payload = {}) {
        const rawStatus = String(payload.Status || payload.status || payload.PeriodStatus || payload.periodStatus || '').toUpperCase();
        const rtnCode = String(payload.RtnCode || payload.rtnCode || '');
        if (rawStatus.includes('SUCCESS') || rtnCode === '1') return 'active';
        if (rawStatus.includes('CANCEL')) return 'canceled';
        return 'past_due';
    }

    function inferNewebpayPaymentStatus(payload = {}) {
        const rtnCode = String(payload.RtnCode || payload.rtnCode || '');
        if (rtnCode === '1') return 'success';
        return 'failed';
    }

    function parseNewebpayDateValue(raw) {
        const text = String(raw || '').trim();
        if (!text) return null;
        const parsed = new Date(text);
        if (!Number.isNaN(parsed.getTime())) {
            return parsed.toISOString();
        }
        const compact = text.match(/^(\d{4})(\d{2})(\d{2})$/);
        if (compact) {
            const dt = new Date(`${compact[1]}-${compact[2]}-${compact[3]}T00:00:00+08:00`);
            if (!Number.isNaN(dt.getTime())) return dt.toISOString();
        }
        return null;
    }

    function resolveTenantIdFromNewebpayPayload(payload = {}) {
        const direct = parseInt(payload.tenant_id || payload.tenantId || payload.TenantId, 10);
        if (Number.isInteger(direct) && direct > 0) return direct;
        const merchantOrderNo = String(
            payload.MerchantOrderNo ||
            payload.merchantOrderNo ||
            payload.MerOrderNo ||
            payload.merOrderNo ||
            ''
        );
        const match = merchantOrderNo.match(/T(\d{1,10})/i);
        if (match) {
            const parsed = parseInt(match[1], 10);
            if (Number.isInteger(parsed) && parsed > 0) return parsed;
        }
        return null;
    }

    async function handleNewebpaySubscriptionWebhook(rawPayload = {}, context = {}) {
        const config = await getNewebpayConfigFromSettings(['HashKey', 'HashIV']);
        if (rawPayload.TradeInfo && rawPayload.TradeSha) {
            const validTradeSha = verifyNewebpayTradeSha(rawPayload, config);
            if (!validTradeSha) {
                throw new Error('藍新 webhook 驗簽失敗（TradeSha 不一致）');
            }
        }
        const encryptedPeriod = String(rawPayload.Period || rawPayload.period || '');
        const decrypted = decryptNewebpayPeriod(encryptedPeriod, config);
        const periodPayload = parseNewebpayPeriodPayload(decrypted);
        const resultPayload = (periodPayload && typeof periodPayload.Result === 'object' && periodPayload.Result) || {};

        const tenantId = resolveTenantIdFromNewebpayPayload(resultPayload);
        if (!tenantId) {
            throw new Error('無法從藍新 webhook 解析 tenant_id');
        }

        const eventId = String(
            rawPayload.PeriodNo ||
            rawPayload.periodNo ||
            rawPayload.TradeNo ||
            rawPayload.tradeNo ||
            resultPayload.PeriodNo ||
            resultPayload.periodNo ||
            resultPayload.TradeNo ||
            resultPayload.tradeNo ||
            rawPayload.MerchantOrderNo ||
            rawPayload.merchantOrderNo ||
            resultPayload.MerchantOrderNo ||
            resultPayload.merchantOrderNo ||
            resultPayload.MerOrderNo ||
            resultPayload.merOrderNo ||
            context.requestId ||
            Date.now()
        );
        const eventType = String(rawPayload.EventType || rawPayload.eventType || 'subscription.renewal');
        const saveResult = await db.insertPaymentEventIfAbsent({
            tenantId,
            provider: 'newebpay',
            eventId,
            eventType,
            payload: {
                rawPayload,
                period: periodPayload
            },
            signature: encryptedPeriod
        });
        if (!saveResult.inserted) {
            return { duplicate: true, tenantId, eventId };
        }

        const statusSource = Object.keys(resultPayload || {}).length > 0 ? resultPayload : periodPayload;
        const status = inferNewebpaySubscriptionStatus(statusSource);
        const paymentStatus = inferNewebpayPaymentStatus(statusSource);
        const nextBillingAt = parseNewebpayDateValue(
            resultPayload.NextPeriodDate || resultPayload.NextPeriod || periodPayload.NextPeriodDate || periodPayload.NextPeriod
        );
        const periodEnd = nextBillingAt || parseNewebpayDateValue(
            resultPayload.PeriodEndDate || resultPayload.PeriodEnd || periodPayload.PeriodEndDate || periodPayload.PeriodEnd
        );
        const snapshot = await db.updateTenantSubscriptionRecurringState(tenantId, {
            provider: 'newebpay',
            providerSubscriptionId: resultPayload.PeriodNo || resultPayload.periodNo || null,
            providerCustomerId: resultPayload.PayerEmail || resultPayload.Email || null,
            providerOrderNo: resultPayload.MerchantOrderNo || resultPayload.MerOrderNo || null,
            paymentStatus,
            subscriptionStatus: status,
            nextBillingAt,
            nextPeriodEnd: periodEnd
        });
        logPaymentEvent('info', 'payment.newebpay.subscription.synced', {
            requestId: context.requestId || null,
            tenantId,
            eventId,
            status,
            result: 'ok'
        });
        return { duplicate: false, tenantId, eventId, status, snapshot };
    }

    async function alterNewebpaySubscriptionStatus(params = {}) {
        const {
            merOrderNo,
            periodNo,
            alterType
        } = params;
        if (!merOrderNo || !periodNo || !alterType) {
            throw new Error('缺少必要欄位：merOrderNo、periodNo、alterType');
        }

        const normalizedAlterType = String(alterType).toLowerCase();
        if (!['suspend', 'restart', 'terminate'].includes(normalizedAlterType)) {
            throw new Error('alterType 僅接受 suspend、restart、terminate');
        }

        const config = await getNewebpayConfigFromSettings(['MerchantID', 'HashKey', 'HashIV']);
        const isProduction = Boolean(config.isProduction);
        const actionUrl = isProduction
            ? 'https://core.newebpay.com/MPG/period/AlterStatus'
            : 'https://ccore.newebpay.com/MPG/period/AlterStatus';

        const data = {
            RespondType: 'JSON',
            Version: '1.0',
            TimeStamp: String(Math.floor(Date.now() / 1000)),
            MerOrderNo: String(merOrderNo),
            PeriodNo: String(periodNo),
            AlterType: normalizedAlterType
        };
        const postData = encryptNewebpayTradeInfo(data, config);
        const responsePayload = await postNewebpayPeriodApi(actionUrl, {
            MerchantID_: config.MerchantID,
            PostData_: postData
        });
        const encryptedPeriod = responsePayload.Period || responsePayload.period;
        if (!encryptedPeriod) {
            throw new Error('藍新 AlterStatus 回應缺少 Period');
        }
        const decrypted = decryptNewebpayPeriod(encryptedPeriod, config);
        const result = parseNewebpayPeriodPayload(decrypted);
        if (String(result.Status || '').toUpperCase() !== 'SUCCESS') {
            throw new Error(result.Message || result.Status || '修改委託狀態失敗');
        }
        return result;
    }

    async function alterNewebpaySubscriptionContent(params = {}) {
        const {
            merOrderNo,
            periodNo,
            alterAmt,
            periodType,
            periodPoint,
            periodTimes,
            extday,
            notifyUrl
        } = params;
        if (!merOrderNo || !periodNo) {
            throw new Error('缺少必要欄位：merOrderNo、periodNo');
        }

        const data = {
            RespondType: 'JSON',
            Version: '1.2',
            TimeStamp: String(Math.floor(Date.now() / 1000)),
            MerOrderNo: String(merOrderNo),
            PeriodNo: String(periodNo)
        };

        if (alterAmt !== undefined && alterAmt !== null && String(alterAmt) !== '') data.AlterAmt = String(alterAmt);
        if (periodType) data.PeriodType = String(periodType).toUpperCase();
        if (periodPoint) data.PeriodPoint = String(periodPoint);
        if (periodTimes !== undefined && periodTimes !== null && String(periodTimes) !== '') data.PeriodTimes = String(periodTimes);
        if (extday) data.Extday = String(extday);
        if (notifyUrl) data.NotifyURL = String(notifyUrl);

        if (!data.AlterAmt && !data.PeriodType && !data.PeriodPoint && !data.PeriodTimes && !data.Extday && !data.NotifyURL) {
            throw new Error('至少需提供一個可修改欄位：alterAmt/periodType/periodPoint/periodTimes/extday/notifyUrl');
        }

        const config = await getNewebpayConfigFromSettings(['MerchantID', 'HashKey', 'HashIV']);
        const isProduction = Boolean(config.isProduction);
        const actionUrl = isProduction
            ? 'https://core.newebpay.com/MPG/period/AlterAmt'
            : 'https://ccore.newebpay.com/MPG/period/AlterAmt';

        const postData = encryptNewebpayTradeInfo(data, config);
        const responsePayload = await postNewebpayPeriodApi(actionUrl, {
            MerchantID_: config.MerchantID,
            PostData_: postData
        });
        const encryptedPeriod = responsePayload.Period || responsePayload.period;
        if (!encryptedPeriod) {
            throw new Error('藍新 AlterAmt 回應缺少 Period');
        }
        const decrypted = decryptNewebpayPeriod(encryptedPeriod, config);
        const result = parseNewebpayPeriodPayload(decrypted);
        if (String(result.Status || '').toUpperCase() !== 'SUCCESS') {
            throw new Error(result.Message || result.Status || '修改委託內容失敗');
        }
        return result;
    }

    async function handleCardPaymentSuccessByCallback(bookingId, context = {}) {
        if (!bookingId) {
            throw new Error('缺少 bookingId，無法處理付款成功回調');
        }

        logPaymentEvent('info', 'payment.callback.process.start', {
            requestId: context.requestId || null,
            route: '/api/payment/return',
            bookingId: bookingId,
            tradeNo: context.tradeNo || null,
            result: 'processing'
        });

        let tenantId = context.tenantId || context.subdomainTenantId;
        if (!tenantId && typeof db.resolveTenantIdByBookingId === 'function') {
            tenantId = await db.resolveTenantIdByBookingId(bookingId);
        }

        const booking = tenantId ? await db.getBookingById(bookingId, tenantId) : null;
        if (!booking) {
            logPaymentEvent('error', 'ALERT_PAYMENT_CALLBACK_BOOKING_NOT_FOUND', {
                requestId: context.requestId || null,
                route: '/api/payment/return',
                bookingId: bookingId,
                tradeNo: context.tradeNo || null,
                tenantId: tenantId || null,
                result: 'failed'
            });
            throw new Error(`找不到訂房記錄: ${bookingId}`);
        }

        if (booking.payment_status === 'paid') {
            logPaymentEvent('info', 'payment.callback.idempotent_skip', {
                requestId: context.requestId || null,
                route: '/api/payment/return',
                bookingId: bookingId,
                tradeNo: context.tradeNo || null,
                result: 'already_processed'
            });
            return { alreadyProcessed: true };
        }

        await db.updateBooking(bookingId, {
            payment_status: 'paid',
            status: 'active'
        }, tenantId);
        console.log('✅ 付款狀態已更新為「已付款」，訂房狀態已更新為「有效」');

        if (!(booking.payment_method && booking.payment_method.includes('刷卡'))) {
            logPaymentEvent('info', 'payment.callback.process.done', {
                requestId: context.requestId || null,
                route: '/api/payment/return',
                bookingId: bookingId,
                tradeNo: context.tradeNo || null,
                result: 'paid_updated_non_card'
            });
            return { alreadyProcessed: false };
        }

        await notificationService.sendCardPaymentSuccessNotifications(booking);

        logPaymentEvent('info', 'payment.callback.process.done', {
            requestId: context.requestId || null,
            route: '/api/payment/return',
            bookingId: bookingId,
            tradeNo: context.tradeNo || null,
            result: 'paid_updated_notified'
        });
        return { alreadyProcessed: false };
    }

    return {
        getEcpayConfigFromSettings,
        handleCardPaymentSuccessByCallback,
        getNewebpayConfigFromSettings,
        handleNewebpaySubscriptionWebhook,
        createNewebpaySubscriptionRequest,
        alterNewebpaySubscriptionStatus,
        alterNewebpaySubscriptionContent
    };
}

module.exports = {
    createPaymentService
};
